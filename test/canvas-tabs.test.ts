import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { chromium } from "playwright-core"
import plugin from "../packages/opencode/src/index.ts"
import { fakeClient, freePort, installBunServeAdapter, nextMessage, openSocket } from "./harness.ts"

async function fixture(t: TestContext) {
  const restore = installBunServeAdapter()
  const directory = await mkdtemp(path.join(process.cwd(), ".opencode", "test-tabs-"))
  const fake = fakeClient("idle")
  const input = { client: fake.client as never, project: { id: "tabs" } as never, directory: process.cwd(), worktree: process.cwd(), serverUrl: new URL("http://127.0.0.1:4096"), experimental_workspace: { register() {} }, $: undefined as never }
  const options = { port: await freePort(), autoOpen: false, canvasDirectory: directory, templateDirectory: path.join(directory, "templates") }
  let hooks = await plugin(input, options)
  t.after(async () => { await hooks.dispose?.(); restore(); await rm(directory, { recursive: true, force: true }) })
  return {
    fake, directory,
    get hooks() { return hooks },
    async restart() { await hooks.dispose?.(); hooks = await plugin(input, options) },
    async env(sessionID = "tabs-a") {
      const output = { env: {} as Record<string, string> }
      await hooks["shell.env"]?.({ cwd: process.cwd(), sessionID, callID: "env" }, output)
      return output.env
    },
    async open(args: { canvasID?: string; title?: string; template?: string } = {}, sessionID = "tabs-a") {
      return await hooks.tool!.reindr_open.execute(args, { sessionID, messageID: "msg", agent: "build", directory: process.cwd(), worktree: process.cwd(), abort: new AbortController().signal, metadata() {}, async ask() {} }) as unknown as { metadata: { file: string; canvasID: string; created: boolean } }
    },
    async edit(file: string, html: string, sessionID = "tabs-a") {
      await writeFile(file, html)
      await hooks["tool.execute.after"]?.({ tool: "write", sessionID, callID: "edit", args: {} }, { title: "edit", output: "", metadata: {} })
    },
    async socket(sessionID = "tabs-a") {
      const env = await this.env(sessionID), url = new URL(env.REINDR_UI_URL)
      const ws = new URL("/ws", url); ws.protocol = "ws:"; ws.search = url.search; ws.searchParams.set("session", sessionID)
      const socket = await openSocket(ws.href, url.origin)
      t.after(() => socket.close())
      return { socket, init: await nextMessage(socket, (message) => message.type === "init") }
    },
  }
}

test("named canvas storage, zero-canvas host access, scoped capabilities and bounded reads", async (t) => {
  const f = await fixture(t)
  const env = await f.env()
  assert.equal((await readdir(f.directory)).some((file) => file.endsWith(".html")), false)
  const { socket, init } = await f.socket()
  assert.equal(init.canvases.length, 0)
  assert.equal(init.sessions.length, 1)
  assert.match(await (await fetch(env.REINDR_UI_URL)).text(), /id="agent-panel"/)
  let reads = 0
  const originalMessages = f.fake.client.session.messages
  f.fake.client.session.messages = async (input) => { reads++; return originalMessages(input) }
  const response = nextMessage(socket, (message) => message.id === "host-1")
  socket.send(JSON.stringify({ type: "host-controller", id: "host-1", action: "snapshot" }))
  assert.equal((await response).value.messages[0].parts[0].text, "History prompt")
  const cached = nextMessage(socket, (message) => message.id === "host-2")
  socket.send(JSON.stringify({ type: "host-controller", id: "host-2", action: "snapshot" }))
  assert.equal((await cached).ok, true)
  assert.equal(reads, 1, "snapshots share SDK reads within the 250ms budget")
  await new Promise((resolve) => setTimeout(resolve, 260))
  const refreshed = nextMessage(socket, (message) => message.id === "host-3")
  socket.send(JSON.stringify({ type: "host-controller", id: "host-3", action: "snapshot" }))
  await refreshed
  assert.equal(reads, 2, "snapshot assertions reach fresh SDK reads after the cache expires")

  for (const canvasID of ["../escape", "a/b", "", "a".repeat(65), "💥"]) await assert.rejects(f.open({ canvasID }), /identifier/)
  const first = await f.open({ canvasID: "plan", title: "Plan <one>" })
  const second = await f.open({ canvasID: "preview", title: "Preview" })
  assert.notEqual(first.metadata.file, second.metadata.file)
  assert.equal((await stat(first.metadata.file)).mode & 0o777, 0o600)
  assert.doesNotMatch(await readFile(first.metadata.file, "utf8"), /opencode.controller|OpenCode controller/)
  await f.edit(first.metadata.file, "<main>Plan content</main>")
  await f.open({ canvasID: "plan", title: "Ignored rename", template: "missing.html" })
  assert.equal(await readFile(first.metadata.file, "utf8"), "<main>Plan content</main>")
  const concurrent = await Promise.all([f.open({ canvasID: "race", title: "First" }), f.open({ canvasID: "race", title: "Second" })])
  assert.deepEqual(concurrent.map((item) => item.metadata.created), [true, false])
  const { init: tabs } = await f.socket()
  assert.equal(tabs.canvases.length, 3)
  assert.equal(tabs.sessions.length, 1, "tab identity does not duplicate session navigation")
  const plan = tabs.canvases.find((canvas: any) => canvas.canvasID === "plan")
  const preview = tabs.canvases.find((canvas: any) => canvas.canvasID === "preview")
  assert.equal(plan.title, "Plan <one>")
  const wrongToken = new URL(preview.frameURL)
  wrongToken.searchParams.set("token", new URL(plan.frameURL).searchParams.get("token")!)
  assert.equal((await fetch(wrongToken)).status, 403, "one tab's capability cannot read another tab")
  assert.equal((await fetch(plan.frameURL)).status, 200)
  const denied = nextMessage(socket, (message) => message.id === "forged")
  socket.send(JSON.stringify({ type: "controller", canvasID: "plan", id: "forged", action: "snapshot" }))
  assert.equal((await denied).ok, false, "custom tabs cannot acquire legacy controller powers")
  socket.send(JSON.stringify({ type: "submit", canvasID: "absent", prompt: "Wrong tab" }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(f.fake.prompts.length, 0, "unknown named-tab submit is rejected")
  const other = await f.open({ canvasID: "plan" }, "tabs-b")
  assert.notEqual(other.metadata.file, first.metadata.file)
  await f.open({ canvasID: "only-b" }, "tabs-b")
  socket.send(JSON.stringify({ type: "submit", canvasID: "only-b", prompt: "Wrong owner", sessionID: "tabs-b" }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(f.fake.prompts.length, 0, "a tab belonging only to another session cannot be submitted through this socket")
  await f.edit(second.metadata.file, "x".repeat(1_000_001))
  assert.ok(f.fake.logs.some((entry) => JSON.stringify(entry).includes("exceeds 1000000 bytes")))
  await rm(second.metadata.file)
  await symlink(first.metadata.file, second.metadata.file)
  await assert.rejects(f.open({ canvasID: "preview" }), /ELOOP/)
  await f.hooks["tool.execute.after"]?.({ tool: "write", sessionID: "tabs-a", callID: "symlink", args: {} }, { title: "edit", output: "", metadata: {} })
  assert.ok(f.fake.logs.some((entry) => JSON.stringify(entry).includes("ELOOP")), "named files retain O_NOFOLLOW")
  await rm(second.metadata.file)
  await f.edit(second.metadata.file, "<main>Preview restored</main>")
  socket.close()
  await f.restart()
  const restored = await f.socket()
  assert.equal(restored.init.canvases.length, 3)
  assert.ok(restored.init.canvases.every((canvas: any) => canvas.restored))
  assert.equal(restored.init.canvases.find((canvas: any) => canvas.canvasID === "plan").title, "Plan <one>")
  const defaultTab = await f.open()
  assert.equal(defaultTab.metadata.file, env.REINDR_UI_FILE, "the legacy/default path is unchanged")
})

test("host sidecar stays live with zero/custom canvases; tabs, drafts, automatic restore and mobile layout", async (t) => {
  const f = await fixture(t)
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium", headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message))
  await page.goto((await f.env()).REINDR_UI_URL)
  await page.locator("#agent-history").getByText("History prompt").waitFor()
  assert.equal(await page.locator("iframe").count(), 0)
  await page.locator("#agent-prompt").fill("Draft stays")
  await page.locator("#agent-select").selectOption("explore")
  await page.locator("#model-select").selectOption("")
  const first = await f.open({ canvasID: "first", title: "First" })
  await f.edit(first.metadata.file, '<main>First content<input id="draft"><button onclick="opencode.submit({prompt: \'Canvas prompt\'})">Submit canvas</button></main>')
  await page.frameLocator('iframe[title="First"]').getByText("First content").waitFor()
  await page.frameLocator('iframe[title="First"]').locator("#draft").fill("Canvas draft")
  const sameIDOtherSession = await f.open({ canvasID: "first", title: "Other session first" }, "tabs-b")
  const second = await f.open({ canvasID: "second", title: "Second" })
  await f.edit(second.metadata.file, '<main>Second content</main>')
  await page.frameLocator('iframe[title="Second"]').getByText("Second content").waitFor()
  await rm(sameIDOtherSession.metadata.file)
  await f.hooks["tool.execute.after"]?.({ tool: "write", sessionID: "tabs-b", callID: "remove-other", args: {} }, { title: "removed", output: "", metadata: {} })
  await new Promise((resolve) => setTimeout(resolve, 100))
  await page.getByRole("tab", { name: "First", exact: true }).click()
  await page.frameLocator('iframe[title="First"]').locator("#draft").waitFor()
  assert.equal(await page.frameLocator('iframe[title="First"]').locator("#draft").inputValue(), "Canvas draft")
  const expanded = await page.locator("#canvas-workspace").boundingBox()
  assert.equal(expanded!.x, 560)
  assert.equal(await page.locator("body > header > #canvas-tabs").count(), 1)
  assert.equal((await page.locator("#main").boundingBox())!.y, 48, "canvas begins immediately beneath the header")
  assert.ok((await page.locator("#main iframe").boundingBox())!.height >= page.viewportSize()!.height - 48)
  const agentToggle = page.getByRole("button", { name: "Agent", exact: true })
  assert.equal(await agentToggle.innerText(), "")
  assert.equal(await agentToggle.locator('svg[aria-hidden="true"]').count(), 1)
  assert.equal(await page.locator("#session-toggle + #agent-toggle").count(), 1)
  await page.locator("#session-toggle").click()
  const navHidden = await page.locator("#canvas-workspace").boundingBox()
  assert.equal(navHidden!.width, expanded!.width + 220)
  await page.locator("#agent-toggle").click()
  assert.equal((await page.locator("#canvas-workspace").boundingBox())!.width, 1400)
  assert.equal(await page.getByRole("tab", { name: "First", exact: true }).getAttribute("aria-selected"), "true")
  await page.locator("#session-toggle").click()
  await page.locator("#agent-toggle").click()
  assert.equal(await page.locator("#agent-prompt").inputValue(), "Draft stays")
  assert.equal(await page.locator("#agent-select").inputValue(), "explore")
  await new Promise((resolve) => setTimeout(resolve, 2100))
  assert.equal(await page.locator("#model-select").inputValue(), "", "explicit default selection survives snapshots")
  assert.equal(await page.frameLocator('iframe[title="First"]').locator("body").evaluate(() => Boolean((window as any).opencode.controller)), false)
  await page.frameLocator('iframe[title="First"]').getByRole("button", { name: "Submit canvas" }).click()
  for (let i = 0; i < 100 && !f.fake.prompts.length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.fake.prompts.length, 1)
  assert.equal(f.fake.prompts[0].path.id, "tabs-a")
  assert.equal(f.fake.prompts[0].body.parts[0].text, "Canvas prompt", "non-default tab's activated bridge reaches its owning session")
  await f.hooks.event?.({ event: { type: "session.status", properties: { sessionID: "tabs-a", status: { type: "idle" } } } as never })
  await page.locator("#agent-prompt-form").getByRole("button", { name: "Send", exact: true }).click()
  await page.waitForFunction(() => !(document.getElementById("agent-prompt") as HTMLTextAreaElement).value)
  for (let i = 0; i < 100 && f.fake.prompts.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.fake.prompts[1].path.id, "tabs-a")
  assert.equal(f.fake.prompts[1].body.agent, "explore")
  assert.equal(f.fake.prompts[1].body.model, undefined)
  await page.locator("#agent-panel details summary").first().click()
  await page.locator("#command-select").selectOption("test-command")
  await page.locator("#command-arguments").fill("--real")
  await page.locator("#command-run").click()
  await page.waitForFunction(() => !(document.getElementById("command-arguments") as HTMLInputElement).value)
  assert.equal(f.fake.commands[0].body.arguments, "--real")
  await page.locator("#agent-abort").click()
  await page.locator("#agent-abort-confirm").click()
  for (let i = 0; i < 100 && !f.fake.aborts.length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(f.fake.aborts, ["tabs-a"])
  await page.setViewportSize({ width: 390, height: 760 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  const mobileHeader = await page.locator("body > header").boundingBox()
  const mobileTabs = await page.locator("#canvas-tabs").boundingBox()
  assert.equal(mobileHeader!.height, 48)
  assert.ok(mobileTabs!.x + mobileTabs!.width <= 390, "tabs scroll within the header on mobile")
  await page.getByRole("tab", { name: "Second", exact: true }).click()
  await page.frameLocator('iframe[title="Second"]').getByText("Second content").waitFor()
  await page.locator("#agent-toggle").click()
  await page.locator("#session-toggle").click()
  assert.equal((await page.locator("#canvas-workspace").boundingBox())!.width, 390)
  await f.edit(second.metadata.file, '<main id="restored">Second content</main><script>document.getElementById("restored").textContent = "Saved script ran"</script>')
  await f.restart()
  await page.goto((await f.env()).REINDR_UI_URL)
  await page.frameLocator('iframe[title="First"]').getByText("First content").waitFor()
  await page.locator("#agent-history").getByText("History prompt").waitFor()
  assert.equal(await page.getByRole("button", { name: "Activate saved content" }).count(), 0)
  await page.getByRole("tab", { name: "Second", exact: true }).click()
  await page.frameLocator('iframe[title="Second"]').getByText("Saved script ran").waitFor()
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts allow-forms")
  await page.reload()
  await page.getByRole("tab", { name: "Second", exact: true }).click()
  await page.frameLocator('iframe[title="Second"]').getByText("Saved script ran").waitFor()
  assert.deepEqual(errors, [])
})

test("large controller catalogs keep connected/current/default models and reject hidden agents", async (t) => {
  const f = await fixture(t)
  const model = (id: string) => ({ id, name: id, limit: { context: 100_000, output: 10_000 } })
  const models = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`early-${i}`, { ...model(`early-${i}`), name: "A long catalog model name ".repeat(12) }]))
  models["gpt-6-astra"] = model("gpt-6-astra")
  models["late-default"] = model("late-default")
  f.fake.client.provider.list = async () => ({ data: {
    all: [
      ...Array.from({ length: 30 }, (_, i) => ({ id: `disconnected-${i}`, name: `Disconnected ${i}`, models: { unavailable: model("unavailable") } })),
      { id: "openai", name: "OpenAI", models },
      { id: "other-connected", name: "Other", models: { "other-default": model("other-default") } },
    ],
    connected: ["openai", "other-connected"],
    default: { openai: "late-default", "other-connected": "other-default" },
  } } as any)
  const originalAgents = f.fake.client.app.agents
  f.fake.client.app.agents = async () => ({ data: [
    ...Array.from({ length: 105 }, (_, i) => ({ name: `internal-${i}`, hidden: true, mode: "primary" })),
    ...["compaction", "summary", "title"].map((name) => ({ name, hidden: true, mode: "primary" })),
    ...(await originalAgents()).data,
  ] } as any)
  const originalMessages = f.fake.client.session.messages
  f.fake.client.session.messages = async (input) => {
    const result = await originalMessages(input)
    result.data[0].info.model = { providerID: "openai", modelID: "gpt-6-astra" }
    return result
  }
  const { socket } = await f.socket()
  let sequence = 0
  const rpc = async (action: string, payload = {}) => {
    const id = `catalog-${++sequence}`
    const response = nextMessage(socket, (message) => message.type === "controller-result" && message.id === id)
    socket.send(JSON.stringify({ type: "host-controller", id, action, payload }))
    return response
  }
  const response = await rpc("snapshot")
  assert.equal(response.ok, true)
  const snapshot = response.value
  assert.deepEqual(snapshot.providers.map((provider: any) => provider.id), ["openai", "other-connected"], "disconnected providers before OpenAI cannot consume the catalog")
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.providers)) <= 250_000)
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 1_000_000)
  const openai = snapshot.providers[0]
  assert.ok(openai.models.length < Object.keys(models).length, "the oversized fixture actually reaches the provider byte budget")
  assert.ok(openai.models.some((model: any) => model.id === "gpt-6-astra"), "late current model survives the byte budget")
  assert.ok(openai.models.some((model: any) => model.id === "late-default"), "late default model survives the byte budget")
  assert.equal(snapshot.providers[1].models[0].id, "other-default", "other providers' defaults are reserved before bulk models")
  assert.deepEqual(snapshot.agents.map((agent: any) => agent.name), ["build", "explore"], "hidden agents are removed before the 100-agent limit")
  for (const agent of ["compaction", "summary", "title"]) {
    const denied = await rpc("prompt", { agent, prompt: "Must not dispatch" })
    assert.equal(denied.ok, false)
    assert.match(denied.error, /Unknown OpenCode agent/)
  }
  const disconnected = await rpc("prompt", { providerID: "disconnected-0", modelID: "unavailable", prompt: "Must not dispatch" })
  assert.equal(disconnected.ok, false)
  assert.match(disconnected.error, /Unknown or disconnected/)
  assert.equal(f.fake.prompts.length, 0)

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium", headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto((await f.env()).REINDR_UI_URL)
  await page.locator('#model-select option[value="openai/gpt-6-astra"]').waitFor({ state: "attached" })
  assert.equal(await page.locator('#model-select option[value="openai/gpt-6-astra"]').isEnabled(), true)
  assert.equal(await page.locator('#agent-select option[value="compaction"], #agent-select option[value="summary"], #agent-select option[value="title"]').count(), 0)
  await page.locator("#model-select").selectOption("openai/gpt-6-astra")
  await page.locator("#agent-select").selectOption("build")
  await page.locator("#agent-prompt").fill("Use the late connected model")
  await page.locator("#agent-prompt-form").getByRole("button", { name: "Send", exact: true }).click()
  for (let i = 0; i < 100 && !f.fake.prompts.length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(f.fake.prompts.length, 1)
  assert.deepEqual(f.fake.prompts[0].body.model, { providerID: "openai", modelID: "gpt-6-astra" })
  assert.equal(f.fake.prompts[0].path.id, "tabs-a")
  assert.equal(f.fake.prompts[0].body.agent, "build")
  // Truncation of the wire snapshot must not become an authorization denial.
  assert.equal(openai.models.some((model: any) => model.id === "early-1199"), false, "the validation control is actually omitted from the display subset")
  assert.equal((await rpc("prompt", { providerID: "openai", modelID: "early-1199", prompt: "Another valid model" })).ok, true)
})

test("omitted idle statuses dispatch prompts; malformed and failed status reads stay unknown", async (t) => {
  const cases = [
    { name: "empty status map", response: { data: {} }, idle: true },
    { name: "only another busy session", response: { data: { other: { type: "busy" } } }, idle: true },
    { name: "null data", response: { data: null }, idle: false },
    { name: "missing data", response: undefined, idle: false },
    { name: "array data", response: { data: [] }, idle: false },
    { name: "malformed entry", response: { data: { other: {} } }, idle: false },
    { name: "invalid status type", response: { data: { "tabs-a": { type: "invalid" } } }, idle: false },
    { name: "SDK error with empty data", response: { error: "Unavailable", data: {} }, idle: false },
    { name: "transport failure", response: undefined, idle: false, throws: true },
  ]
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const f = await fixture(t)
    let statusReads = 0
    f.fake.client.session.status = async () => {
      statusReads++
      if (scenario.throws) throw new Error("Transport failure")
      return scenario.response as any
    }
    const { socket } = await f.socket()
    const snapshotReply = nextMessage(socket, (message) => message.id === "status-snapshot")
    socket.send(JSON.stringify({ type: "host-controller", id: "status-snapshot", action: "snapshot" }))
    const snapshot = await snapshotReply
    assert.equal(snapshot.ok, true)
    assert.deepEqual(snapshot.value.status, { type: scenario.idle ? "idle" : "unknown" })
    assert.deepEqual(snapshot.value.children[0].status, { type: scenario.idle ? "idle" : "unknown" })
    const accepted = nextMessage(socket, (message) => message.id === "status-prompt")
    socket.send(JSON.stringify({ type: "host-controller", id: "status-prompt", action: "prompt", payload: { prompt: "Actually dispatch this prompt" } }))
    assert.equal((await accepted).ok, true)
    if (scenario.idle) {
      for (let i = 0; i < 100 && !f.fake.prompts.length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(f.fake.prompts.length, 1, "accepted prompt reaches promptAsync rather than retrying forever")
      assert.equal(f.fake.prompts[0].path.id, "tabs-a")
      assert.equal(f.fake.prompts[0].body.parts[0].text, "Actually dispatch this prompt")
    } else {
      await new Promise((resolve) => setTimeout(resolve, 600))
      assert.equal(f.fake.prompts.length, 0, "unknown status must not authorize dispatch")
      assert.ok(statusReads >= 3, "the fail-closed assertion covers a queue retry as well as the snapshot and initial read")
    }
  })
})
