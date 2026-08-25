import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { chromium } from "playwright-core"
import plugin from "../.opencode/plugins/opencode-generative-ui.ts"
import { fakeClient, fakeContext, freePort, installBunServeAdapter, parsePanelURL, waitForHTTP } from "./harness.ts"

test("Chromium renders a sandboxed view and sends a user-activated interaction", async (t) => {
  const restoreBun = installBunServeAdapter()
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "opencode-generative-ui-browser-"))
  const stylesheetPath = path.join(stateDirectory, "shared.css")
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
  const pluginOptions = { port, autoOpen: false, stateDirectory, stylesheetPath }
  let hooks = await plugin(pluginInput, pluginOptions)
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true })

  t.after(async () => {
    await browser.close()
    await hooks.dispose?.()
    restoreBun()
    await rm(stateDirectory, { recursive: true, force: true })
  })

  const context = fakeContext("browser-session")
  const result = await hooks.tool!.widget_render.execute({
    id: "refactor-form",
    title: "Refactor options",
    html: `
      <style>button { padding: 8px 12px; }</style>
      <form id="form"><label>Name <input name="name" value="WidgetAPI"></label><button>Submit</button></form>
      <div id="network">checking network</div>
      <script>
        fetch("https://example.com/").then(
          function () { document.getElementById("network").textContent = "network allowed"; },
          function () { document.getElementById("network").textContent = "network blocked"; }
        );
        document.getElementById("form").addEventListener("submit", function (event) {
          event.preventDefault();
          sendData({ name: event.currentTarget.elements.name.value });
          sendPrompt("Apply refactor options");
        });
      </script>`,
  }, context.context)
  await hooks.tool!.widget_render.execute({
    id: "summary-panel",
    title: "Summary",
    html: `<aside id="summary">Original summary</aside>`,
  }, context.context)
  await hooks.tool!.widget_layout.execute({
    css: `#oc-root { grid-template-columns: 2fr 1fr; min-height: 1600px; } [data-widget-id="refactor-form"] { min-width: 0; }`,
  }, context.context)
  const otherContext = fakeContext("second-session")
  await hooks.tool!.widget_render.execute({
    id: "secondary-view",
    title: "Secondary view",
    html: "<main>Second session content</main>",
  }, otherContext.context)
  const panelURL = parsePanelURL(result)
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
  assert.equal(await page.locator(".card, .bar, .rail").count(), 0, "the shell adds no widget card chrome")
  const headerText = await page.locator("header").innerText()
  assert.doesNotMatch(headerText, /Session browser-session/, "the active session is not shown in the header")
  const viewBounds = await page.locator(".agent-view").boundingBox()
  assert.equal(viewBounds?.x, 0)
  assert.equal(viewBounds?.width, 1000)
  const iframeBounds = await page.locator('iframe[title="Session browser-session"]').boundingBox()
  assert.ok((iframeBounds?.height ?? 0) >= 752, "a lone generated view fills the region beneath the header")

  const sessionToggle = page.locator("#session-toggle")
  assert.equal(await page.locator("header > :first-child").getAttribute("id"), "session-toggle")
  assert.equal(await sessionToggle.getAttribute("aria-label"), "Open sessions")
  await sessionToggle.click()
  assert.equal(await sessionToggle.getAttribute("aria-expanded"), "true")
  assert.equal(await sessionToggle.getAttribute("aria-label"), "Close sessions")
  const drawer = page.locator("#session-drawer")
  await drawer.waitFor()
  const headerBounds = await page.locator("header").boundingBox()
  const drawerBounds = await drawer.boundingBox()
  assert.equal(headerBounds?.y, 0)
  assert.equal(headerBounds?.height, 48)
  assert.equal(drawerBounds?.y, 48, "the session drawer starts below the header")
  assert.equal(await drawer.getByRole("link").count(), 2)
  await drawer.getByRole("button", { name: "Close sessions" }).click()
  assert.equal(await sessionToggle.getAttribute("aria-expanded"), "false")

  const networkStatus = await frame.locator("#network").textContent()
  assert.equal(networkStatus, "network blocked", `Widget page errors: ${pageErrors.join(" | ")} Console: ${consoleMessages.join(" | ")}`)
  assert.equal(await frame.locator('[data-widget-id="refactor-form"]').count(), 1)
  assert.equal(await frame.locator('[data-widget-id="summary-panel"]').count(), 1)
  assert.equal(await frame.locator("#oc-root").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length), 2)
  assert.equal(await frame.locator(":root").evaluate((element) => getComputedStyle(element).getPropertyValue("--test-shared-style").trim()), "loaded")

  const nameInput = frame.locator('input[name="name"]')
  await nameInput.fill("PreservedByComposer")
  await nameInput.focus()
  await page.evaluate(() => scrollTo(0, 280))
  assert.ok(await page.evaluate(() => scrollY >= 250))
  await hooks.tool!.widget_render.execute({
    id: "summary-panel",
    title: "Summary",
    html: `<aside id="summary">Updated summary</aside>`,
  }, context.context)
  await frame.getByText("Updated summary").waitFor()
  assert.equal(await frame.locator('input[name="name"]').inputValue(), "PreservedByComposer", "form state survives a composed document update")
  assert.equal(await frame.locator('input[name="name"]').evaluate((element) => document.activeElement === element), true, "focus survives a composed document update")
  await page.waitForFunction(() => scrollY >= 250)
  assert.ok(await page.evaluate(() => scrollY >= 250), "page scroll survives a composed document update")

  assert.equal(await page.getByRole("dialog").count(), 0, "the shell has no interaction popup")
  await frame.getByRole("button", { name: "Submit" }).click()
  await page.getByText(/was sent to the agent/).waitFor()
  assert.equal(fake.prompts.length, 1)
  assert.equal(fake.prompts[0].path.id, "browser-session")
  assert.match(fake.prompts[0].body.parts[0].text, /Apply refactor options/)
  assert.match(fake.prompts[0].body.parts[0].text, /PreservedByComposer/)

  await page.close()
  await hooks.dispose?.()
  hooks = await plugin(pluginInput, pluginOptions)
  const list = String(await hooks.tool!.widget_list.execute({}, context.context))
  const restoredURL = list.match(/Panel: (https?:\/\/\S+)/)?.[1]
  assert.ok(restoredURL)
  await waitForHTTP(restoredURL)
  const restoredPage = await browser.newPage()
  await restoredPage.goto(restoredURL)
  await restoredPage.getByRole("button", { name: "Activate saved content" }).waitFor()
  assert.equal(await restoredPage.locator("iframe").count(), 0, "restored scripts do not run before activation")
  await restoredPage.getByRole("button", { name: "Activate saved content" }).click()
  await restoredPage.locator('iframe[title="Session browser-session"]').waitFor({ state: "attached" })
  const restoredFrame = restoredPage.frameLocator('iframe[title="Session browser-session"]')
  assert.equal(await restoredFrame.locator("[data-widget-id]").count(), 2)
  assert.equal(await restoredFrame.locator("#oc-root").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length), 2)
  await restoredPage.close()
})
