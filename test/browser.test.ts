import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { chromium } from "playwright-core"
import plugin from "../.opencode/plugins/opencode-generative-ui.ts"
import { fakeClient, freePort, installBunServeAdapter, waitForHTTP } from "./harness.ts"

async function sessionEnvironment(hooks: Awaited<ReturnType<typeof plugin>>, sessionID: string) {
  const output = { env: {} as Record<string, string> }
  await hooks["shell.env"]?.({ cwd: process.cwd(), sessionID, callID: `call-${sessionID}` }, output)
  return output.env
}

async function notifyFileEdit(hooks: Awaited<ReturnType<typeof plugin>>, sessionID: string) {
  await hooks["tool.execute.after"]?.(
    { tool: "write", sessionID, callID: `write-${sessionID}`, args: {} },
    { title: "wrote file", output: "", metadata: {} },
  )
}

function canvasHTML(summary: string) {
  return `<!doctype html>
    <html>
      <head><style>body { padding: 24px; } #app { min-height: 1600px; } button { padding: 8px 12px; }</style></head>
      <body>
        <main id="app">
          <form id="form"><label>Name <input name="name" value="CanvasAPI"></label><button>Submit</button></form>
          <aside id="summary">${summary}</aside>
          <div id="network">checking network</div>
        </main>
        <script>
          parent.postMessage({ kind: "submit", prompt: "forged interaction" }, "*");
          opencode.submit({ prompt: "automatic interaction" });
          try {
            Object.defineProperty(Object.getPrototypeOf(navigator.userActivation), "isActive", { get: function () { return true; } });
            var nativeSlice = Array.prototype.slice;
            Function.prototype.call = function (receiver) {
              return Reflect.apply(this, receiver, Reflect.apply(nativeSlice, arguments, [1]));
            };
            Object.defineProperty(MessageEvent.prototype, "data", {
              get: function () { return { kind: "submit", prompt: "forged message getter" }; }
            });
          } catch (_) {}
          setTimeout(function () { opencode.submit({ prompt: "forged activation" }); }, 100);
          fetch("https://example.com/").then(
            function () { document.getElementById("network").textContent = "network allowed"; },
            function () { document.getElementById("network").textContent = "network blocked"; }
          );
          document.getElementById("form").addEventListener("submit", function (event) {
            event.preventDefault();
            opencode.submit({
              prompt: "Apply refactor options",
              data: { name: event.currentTarget.elements.name.value }
            });
          });
        </script>
      </body>
    </html>`
}

test("Chromium live-reloads a sandboxed session UI and sends activated interactions", async (t) => {
  const restoreBun = installBunServeAdapter()
  const workspace = await mkdtemp(path.join(tmpdir(), "opencode-generative-ui-browser-"))
  const canvasDirectory = await mkdtemp(path.join(process.cwd(), ".opencode", "test-ui-browser-"))
  const stylesheetPath = path.join(workspace, "shared.css")
  await writeFile(stylesheetPath, `:root { --test-shared-style: loaded; }`)
  const port = await freePort()
  const fake = fakeClient("idle")
  const pluginInput = {
    client: fake.client as never,
    project: { id: "browser-project" } as never,
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL("http://127.0.0.1:4096"),
    experimental_workspace: { register() {} },
    $: undefined as never,
  }
  const pluginOptions = { port, autoOpen: false, canvasDirectory, stylesheetPath }
  let hooks = await plugin(pluginInput, pluginOptions)
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true })

  t.after(async () => {
    await browser.close()
    await hooks.dispose?.()
    restoreBun()
    await rm(canvasDirectory, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  })

  const environment = await sessionEnvironment(hooks, "browser-session")
  await writeFile(environment.OPENCODE_UI_FILE, canvasHTML("Original summary"))
  await notifyFileEdit(hooks, "browser-session")

  const otherEnvironment = await sessionEnvironment(hooks, "second-session")
  await writeFile(otherEnvironment.OPENCODE_UI_FILE, "<main>Second session content</main>")
  await notifyFileEdit(hooks, "second-session")

  const panelURL = new URL(environment.OPENCODE_UI_URL)
  await waitForHTTP(panelURL.href)
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const pageErrors: string[] = []
  const consoleMessages: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("console", (message) => consoleMessages.push(message.text()))
  await page.goto(panelURL.href)
  await page.locator('iframe[title="Session browser-session"]').waitFor({ state: "attached", timeout: 5_000 }).catch(async (error) => {
    throw new Error(`${String(error)}\nPage errors: ${pageErrors.join(" | ")}\nBody: ${await page.locator("body").innerText()}`)
  })
  const frame = page.frameLocator('iframe[title="Session browser-session"]')
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(fake.prompts.length, 0, "page-load and forged submissions are blocked")
  assert.equal(await page.locator(".card, .bar, .rail").count(), 0, "the shell adds no content chrome")
  assert.equal(await page.locator("#status, #dot").count(), 0, "the header has no connection status chrome")
  const viewBounds = await page.locator(".agent-view").boundingBox()
  assert.equal(viewBounds?.x, 0)
  assert.equal(viewBounds?.width, 1000)
  const iframeBounds = await page.locator('iframe[title="Session browser-session"]').boundingBox()
  assert.ok((iframeBounds?.height ?? 0) >= 752, "the UI fills the region beneath the header")

  const sessionToggle = page.locator("#session-toggle")
  await sessionToggle.click()
  const drawer = page.locator("#session-drawer")
  await drawer.waitFor()
  assert.equal(await drawer.getByRole("link").count(), 2, "the panel lists every project session")
  assert.equal(await drawer.getByText("browser-session", { exact: true }).count(), 1)
  assert.equal(await drawer.locator(".drawer-head, #drawer-close").count(), 0, "the drawer has no heading or close button")
  await sessionToggle.click()
  assert.equal(await sessionToggle.getAttribute("aria-expanded"), "false")

  const networkStatus = await frame.locator("#network").textContent()
  assert.equal(networkStatus, "network blocked", `UI page errors: ${pageErrors.join(" | ")} Console: ${consoleMessages.join(" | ")}`)
  assert.equal(await frame.locator("#app").count(), 1)
  assert.equal(await frame.locator(":root").evaluate((element) => getComputedStyle(element).getPropertyValue("--test-shared-style").trim()), "loaded")

  const nameInput = frame.locator('input[name="name"]')
  await nameInput.fill("PreservedByReload")
  await nameInput.focus()
  await page.evaluate(() => scrollTo(0, 280))
  assert.ok(await page.evaluate(() => scrollY >= 250))
  await writeFile(environment.OPENCODE_UI_FILE, canvasHTML("Updated summary"))
  await frame.getByText("Updated summary").waitFor()
  assert.equal(await frame.locator('input[name="name"]').inputValue(), "PreservedByReload", "form state survives a whole-file update")
  assert.equal(await frame.locator('input[name="name"]').evaluate((element) => document.activeElement === element), true, "focus survives a whole-file update")
  await page.waitForFunction(() => scrollY >= 250)

  await frame.getByRole("button", { name: "Submit" }).click()
  for (let attempt = 0; attempt < 100 && !fake.prompts.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(fake.prompts.length, 1, `submission failed: ${await page.locator("#toast").textContent()} | ${pageErrors.join(" | ")}`)
  assert.equal(fake.prompts.length, 1)
  assert.equal(fake.prompts[0].path.id, "browser-session")
  assert.match(fake.prompts[0].body.parts[0].text, /Apply refactor options/)
  assert.match(fake.prompts[0].body.parts[0].text, /PreservedByReload/)

  await page.close()
  await hooks.dispose?.()
  hooks = await plugin(pluginInput, pluginOptions)
  const restoredEnvironment = await sessionEnvironment(hooks, "browser-session")
  const restoredPage = await browser.newPage()
  await restoredPage.goto(restoredEnvironment.OPENCODE_UI_URL)
  await restoredPage.getByRole("button", { name: "Activate saved content" }).waitFor()
  assert.equal(await restoredPage.locator("iframe").count(), 0, "restored scripts do not run before activation")
  await restoredPage.getByRole("button", { name: "Activate saved content" }).click()
  await restoredPage.locator('iframe[title="Session browser-session"]').waitFor({ state: "attached" })
  const restoredFrame = restoredPage.frameLocator('iframe[title="Session browser-session"]')
  assert.equal(await restoredFrame.getByText("Updated summary").count(), 1)
  await restoredPage.close()
})

test("Chromium switches between plugin processes in one tab", async (t) => {
  const restoreBun = installBunServeAdapter()
  const canvasDirectory = await mkdtemp(path.join(process.cwd(), ".opencode", "test-ui-cross-port-"))
  const firstFake = fakeClient("idle")
  const secondFake = fakeClient("idle")
  const pluginInput = (client: unknown) => ({
    client: client as never,
    project: { id: "cross-port-project" } as never,
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL("http://127.0.0.1:4096"),
    experimental_workspace: { register() {} },
    $: undefined as never,
  })
  const firstPort = await freePort()
  const firstHooks = await plugin(pluginInput(firstFake.client), { port: firstPort, autoOpen: false, canvasDirectory })
  const secondPort = await freePort()
  const secondHooks = await plugin(pluginInput(secondFake.client), { port: secondPort, autoOpen: false, canvasDirectory })
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true })
  let secondDisposed = false

  t.after(async () => {
    await browser.close()
    if (!secondDisposed) await secondHooks.dispose?.()
    await firstHooks.dispose?.()
    restoreBun()
    await rm(canvasDirectory, { recursive: true, force: true })
  })

  const firstEnvironment = await sessionEnvironment(firstHooks, "cross-port-a")
  const secondEnvironment = await sessionEnvironment(secondHooks, "cross-port-b")
  const waitingPage = await browser.newPage()
  const rootURL = new URL("/", firstEnvironment.OPENCODE_UI_URL)
  rootURL.search = new URL(firstEnvironment.OPENCODE_UI_URL).search
  await waitingPage.goto(rootURL.href)
  await waitingPage.getByText("Waiting for a session UI file.").waitFor()
  await writeFile(firstEnvironment.OPENCODE_UI_FILE, "<main>First process UI</main>")
  await notifyFileEdit(firstHooks, "cross-port-a")
  await waitingPage.waitForURL((url) => url.pathname === new URL(firstEnvironment.OPENCODE_UI_URL).pathname)
  await waitingPage.close()

  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  await page.goto(firstEnvironment.OPENCODE_UI_URL)
  await page.locator("#session-toggle").click()
  const drawer = page.locator("#session-drawer")
  assert.equal(await drawer.getByRole("link").count(), 1)
  const firstPageURL = page.url()
  await writeFile(secondEnvironment.OPENCODE_UI_FILE, `<main>Second process UI <button id="send">Send</button></main><script>document.getElementById("send").addEventListener("click", function () { opencode.submit({ prompt: "Second process interaction" }); });</script>`)
  await notifyFileEdit(secondHooks, "cross-port-b")
  await drawer.getByRole("link").nth(1).waitFor()
  assert.equal(page.url(), firstPageURL, "session availability updates without reloading the active panel")
  assert.equal(await drawer.getByRole("link").count(), 2)
  await drawer.getByRole("link", { name: /Session cross-port-b/ }).click()
  await page.waitForURL((url) => url.origin === new URL(secondEnvironment.OPENCODE_UI_URL).origin)
  await page.locator('iframe[title="Session cross-port-b"]').waitFor({ state: "attached" })
  const secondFrame = page.frameLocator('iframe[title="Session cross-port-b"]')
  assert.equal(await secondFrame.getByText(/Second process UI/).count(), 1)
  await secondFrame.getByRole("button", { name: "Send" }).click()
  for (let attempt = 0; attempt < 100 && !secondFake.prompts.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(firstFake.prompts.length, 0)
  assert.equal(secondFake.prompts.length, 1)
  assert.match(secondFake.prompts[0].body.parts[0].text, /Second process interaction/)

  await page.locator("#session-toggle").click()
  await page.locator("#session-drawer").getByRole("link", { name: /Session cross-port-a/ }).click()
  await page.waitForURL((url) => url.origin === new URL(firstEnvironment.OPENCODE_UI_URL).origin)
  await page.locator('iframe[title="Session cross-port-a"]').waitFor({ state: "attached" })
  await page.locator("#session-toggle").click()
  const firstDrawer = page.locator("#session-drawer")
  await firstDrawer.getByRole("link").nth(1).waitFor()
  const stableURL = page.url()
  await secondHooks.dispose?.()
  secondDisposed = true
  await firstDrawer.getByRole("link", { name: /Session cross-port-b/ }).waitFor({ state: "detached" })
  assert.equal(await firstDrawer.getByRole("link").count(), 1)
  assert.equal(page.url(), stableURL, "session removal updates without reloading the active panel")
})
