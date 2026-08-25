import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { chromium } from "playwright-core"
import plugin from "../.opencode/plugins/reindr.ts"
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

async function openReindr(hooks: Awaited<ReturnType<typeof plugin>>, sessionID: string, template?: string) {
  const lifecycle = hooks.tool?.reindr_open
  assert.ok(lifecycle)
  return lifecycle.execute(template ? { template } : {}, {
    sessionID,
    messageID: `message-${sessionID}`,
    agent: "build",
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  })
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
  const workspace = await mkdtemp(path.join(tmpdir(), "reindr-browser-"))
  const canvasDirectory = await mkdtemp(path.join(process.cwd(), ".opencode", "test-ui-browser-"))
  const templateDirectory = path.join(canvasDirectory, "templates")
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
  const pluginOptions = { port, autoOpen: false, canvasDirectory, templateDirectory, stylesheetPath }
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
  await openReindr(hooks, "browser-session")

  const otherEnvironment = await sessionEnvironment(hooks, "second-session")
  await writeFile(otherEnvironment.REINDR_UI_FILE, "<main>Second session content</main>")
  await notifyFileEdit(hooks, "second-session")

  const panelURL = new URL(environment.REINDR_UI_URL)
  await waitForHTTP(panelURL.href)
  const landingPage = await browser.newPage()
  await landingPage.goto(panelURL.origin)
  await landingPage.getByRole("heading", { name: "Reindr" }).waitFor()
  assert.equal(await landingPage.getByText("Start a session to get started.").count(), 1)
  assert.equal(await landingPage.getByRole("navigation", { name: "Running Reindr sessions" }).getByRole("link").count(), 2)
  await landingPage.getByRole("tab", { name: "Templates" }).click()
  const templateNavigation = landingPage.getByRole("navigation", { name: "Saved Reindr templates" })
  assert.equal(await templateNavigation.getByRole("link", { name: /reindr-loading\.html/ }).count(), 1)
  assert.equal(await templateNavigation.getByRole("link", { name: /opencode-controller\.html/ }).count(), 1)
  await templateNavigation.getByRole("link", { name: /reindr-loading\.html/ }).click()
  let preview = landingPage.frameLocator('iframe[title="Template preview: reindr-loading.html"]')
  await preview.getByRole("heading", { name: "Preparing your interface" }).waitFor()
  await landingPage.getByRole("link", { name: "Back to templates" }).click()
  await landingPage.getByRole("navigation", { name: "Saved Reindr templates" }).getByRole("link", { name: /opencode-controller\.html/ }).click()
  preview = landingPage.frameLocator('iframe[title="Template preview: opencode-controller.html"]')
  await preview.locator("#session-title").getByText("Preview: opencode-controller.html").waitFor()
  assert.equal(await landingPage.getByText("Read-only preview").count(), 1)
  await landingPage.getByRole("link", { name: "Back to templates" }).click()
  await landingPage.getByRole("tab", { name: "Sessions" }).click()
  const staleURL = new URL("/s/missing-session", panelURL)
  await landingPage.goto(staleURL.href)
  await landingPage.getByRole("heading", { name: "Reindr" }).waitFor()
  await landingPage.getByRole("link", { name: /Session browser-session/ }).click()
  await landingPage.locator('iframe[title="Session browser-session"]').waitFor({ state: "attached" })
  await landingPage.close()
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
  await frame.getByText("OpenCode controller").waitFor()
  await writeFile(environment.REINDR_UI_FILE, canvasHTML("Original summary"))
  await notifyFileEdit(hooks, "browser-session")
  await frame.getByText("Original summary").waitFor()
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
  assert.equal(await drawer.getByRole("link").count(), 2, "the panel lists every active Reindr session")
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
  await writeFile(environment.REINDR_UI_FILE, canvasHTML("Updated summary"))
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
  await restoredPage.goto(restoredEnvironment.REINDR_UI_URL)
  await restoredPage.getByRole("button", { name: "Activate saved content" }).waitFor()
  assert.equal(await restoredPage.locator("iframe").count(), 0, "restored scripts do not run before activation")
  await restoredPage.getByRole("button", { name: "Activate saved content" }).click()
  await restoredPage.locator('iframe[title="Session browser-session"]').waitFor({ state: "attached" })
  const restoredFrame = restoredPage.frameLocator('iframe[title="Session browser-session"]')
  assert.equal(await restoredFrame.getByText("Updated summary").count(), 1)
  await restoredPage.close()
})

test("OpenCode controller template drives and visualizes its session", async (t) => {
  const restoreBun = installBunServeAdapter()
  const canvasDirectory = await mkdtemp(path.join(process.cwd(), ".opencode", "test-ui-controller-"))
  const templateDirectory = path.join(canvasDirectory, "templates")
  const fake = fakeClient("idle")
  const hooks = await plugin({
    client: fake.client as never,
    project: { id: "controller-project" } as never,
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL("http://127.0.0.1:4096"),
    experimental_workspace: { register() {} },
    $: undefined as never,
  }, { port: await freePort(), autoOpen: false, canvasDirectory, templateDirectory })
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true })

  t.after(async () => {
    await browser.close()
    await hooks.dispose?.()
    restoreBun()
    await rm(canvasDirectory, { recursive: true, force: true })
  })

  const environment = await sessionEnvironment(hooks, "controller-session")
  await openReindr(hooks, "controller-session")
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } })
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto(environment.REINDR_UI_URL)
  const frame = page.frameLocator('iframe[title="Session controller-session"]')
  await frame.locator("#session-title").getByText("Session controller-session").waitFor({ timeout: 5_000 }).catch(async (error) => {
    throw new Error(`${String(error)}\nPage errors: ${pageErrors.join(" | ")}\nFrame body: ${await frame.locator("body").innerText()}`)
  })
  const tailwindStyle = await frame.locator("body").evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    classes: element.className,
    generatedCSSLoaded: document.getElementById("reindr-shared-styles")?.textContent?.includes("090a0c"),
  }))
  assert.equal(tailwindStyle.background, "rgb(9, 10, 12)", JSON.stringify(tailwindStyle))
  await frame.getByText("History prompt").waitFor()
  assert.equal(await frame.locator("#agent option").filter({ hasText: "build [primary]" }).count(), 1)
  assert.equal(await frame.locator("#model option").filter({ hasText: "Test Provider / Test Model [reasoning]" }).count(), 1)
  assert.equal(await frame.locator('details[data-kind="tool"] summary').filter({ hasText: "bash | completed" }).count(), 1)
  assert.equal(await frame.getByText("Explore child").count(), 1)
  await frame.locator("#history").evaluate((history) => {
    for (let index = 0; index < 80; index += 1) history.appendChild(document.createElement("p")).textContent = `Long history row ${index}`
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const composerBounds = await frame.getByPlaceholder("Send the next instruction...").boundingBox()
  const controllerFrameBounds = await page.locator('iframe[title="Session controller-session"]').boundingBox()
  assert.ok(composerBounds && composerBounds.y + composerBounds.height <= 850, "the native input remains visible with long history")
  assert.ok(controllerFrameBounds && controllerFrameBounds.height <= 850, "history scrolls inside the viewport instead of expanding the iframe")
  assert.equal(await page.locator('iframe[title="Session controller-session"]').evaluate((element) => (element as HTMLIFrameElement).style.height), "120px")
  await page.setViewportSize({ width: 390, height: 760 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const mobileComposerBounds = await frame.getByPlaceholder("Send the next instruction...").boundingBox()
  assert.ok(mobileComposerBounds && mobileComposerBounds.y + mobileComposerBounds.height <= 760, "the Tailwind controller keeps its input visible on mobile")
  await page.setViewportSize({ width: 1200, height: 850 })
  assert.equal(await frame.locator('details[data-kind="reasoning"]').evaluate((element) => (element as HTMLDetailsElement).open), false)
  await frame.getByLabel("Show reasoning").check()
  assert.equal(await frame.locator('details[data-kind="reasoning"]').evaluate((element) => (element as HTMLDetailsElement).open), true)
  const rejectedPrompt = await frame.locator("body").evaluate(async () => {
    try {
      await (window as any).opencode.controller.prompt({ prompt: "Unactivated prompt" })
      return "accepted"
    } catch (error) {
      return String(error)
    }
  })
  assert.match(rejectedPrompt, /User activation is required/)

  await frame.getByPlaceholder("Send the next instruction...").fill("Controller prompt")
  await frame.getByPlaceholder("Send the next instruction...").press("Enter")
  for (let attempt = 0; attempt < 100 && !fake.prompts.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fake.prompts.length, 1)
  assert.equal(fake.prompts[0].body.agent, "build")
  assert.deepEqual(fake.prompts[0].body.model, { providerID: "test-provider", modelID: "test-model" })
  for (let attempt = 0; attempt < 100 && await frame.locator("#prompt").inputValue(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(await frame.locator("#prompt").inputValue(), "")

  await new Promise((resolve) => setTimeout(resolve, 300))
  await frame.locator("#command").selectOption("test-command")
  await frame.locator("#arguments").fill("--quick")
  await frame.getByRole("button", { name: "Run" }).click()
  for (let attempt = 0; attempt < 100 && !fake.commands.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fake.commands.length, 1, `command failed: ${await frame.locator("#error").textContent()} (selected: ${await frame.locator("#command").inputValue()})`)
  assert.equal(fake.commands[0].body.command, "test-command")
  assert.equal(fake.commands[0].body.arguments, "--quick")

  await new Promise((resolve) => setTimeout(resolve, 300))
  await frame.getByRole("button", { name: "Abort" }).click()
  await frame.getByRole("button", { name: "Abort turn" }).click()
  for (let attempt = 0; attempt < 100 && !fake.aborts.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(fake.aborts, ["controller-session"])
})

test("Chromium switches between plugin processes in one tab", async (t) => {
  const restoreBun = installBunServeAdapter()
  const canvasDirectory = await mkdtemp(path.join(process.cwd(), ".opencode", "test-ui-cross-port-"))
  const templateDirectory = path.join(canvasDirectory, "templates")
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
  const firstHooks = await plugin(pluginInput(firstFake.client), { port: firstPort, autoOpen: false, canvasDirectory, templateDirectory })
  const secondPort = await freePort()
  const secondHooks = await plugin(pluginInput(secondFake.client), { port: secondPort, autoOpen: false, canvasDirectory, templateDirectory })
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
  const rootURL = new URL("/", firstEnvironment.REINDR_UI_URL)
  rootURL.search = new URL(firstEnvironment.REINDR_UI_URL).search
  await waitingPage.goto(rootURL.href)
  await waitingPage.getByText("Waiting for a session UI file.").waitFor()
  await writeFile(firstEnvironment.REINDR_UI_FILE, "<main>First process UI</main>")
  await notifyFileEdit(firstHooks, "cross-port-a")
  await waitingPage.waitForURL((url) => url.pathname === new URL(firstEnvironment.REINDR_UI_URL).pathname)
  await waitingPage.close()

  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  await page.goto(firstEnvironment.REINDR_UI_URL)
  await page.locator("#session-toggle").click()
  const drawer = page.locator("#session-drawer")
  assert.equal(await drawer.getByRole("link").count(), 1)
  const firstPageURL = page.url()
  await writeFile(secondEnvironment.REINDR_UI_FILE, `<main>Second process UI <button id="send">Send</button></main><script>document.getElementById("send").addEventListener("click", function () { opencode.submit({ prompt: "Second process interaction" }); });</script>`)
  await notifyFileEdit(secondHooks, "cross-port-b")
  await drawer.getByRole("link").nth(1).waitFor()
  assert.equal(page.url(), firstPageURL, "session availability updates without reloading the active panel")
  assert.equal(await drawer.getByRole("link").count(), 2)
  await drawer.getByRole("link", { name: /Session cross-port-b/ }).click()
  await page.waitForURL((url) => url.origin === new URL(secondEnvironment.REINDR_UI_URL).origin)
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
  await page.waitForURL((url) => url.origin === new URL(firstEnvironment.REINDR_UI_URL).origin)
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
