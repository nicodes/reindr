import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import plugin from "../.opencode/plugins/opencode-generative-ui.ts"
import { fakeClient, fakeContext, freePort, installBunServeAdapter, nextMessage, openSocket, parsePanelURL, waitForHTTP } from "./harness.ts"

test("session routing, direct interaction delivery, persistence, and HTTP security", async (t) => {
  const restoreBun = installBunServeAdapter()
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "opencode-generative-ui-core-"))
  const port = await freePort()
  const fake = fakeClient("busy")
  const hooks = await plugin({
    client: fake.client as never,
    project: { id: "test-project" } as never,
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL("http://127.0.0.1:4096"),
    experimental_workspace: { register() {} },
    $: undefined as never,
  }, { port, autoOpen: false, stateDirectory })

  t.after(async () => {
    await hooks.dispose?.()
    restoreBun()
    await rm(stateDirectory, { recursive: true, force: true })
  })

  const render = hooks.tool!.widget_render.execute
  const first = fakeContext("session-a")
  const firstResult = await render({
    id: "settings",
    title: "Settings",
    html: `<button onclick="sendPrompt('apply')">Apply</button>`,
  }, first.context)
  await render({ id: "status", title: "Status", html: "<p>Ready</p>" }, first.context)
  assert.equal(first.asks.length, 1, "render permission is requested once per session")

  const second = fakeContext("session-b")
  await render({ id: "settings", title: "Other settings", html: "<p>Other session</p>" }, second.context)
  assert.equal(second.asks.length, 1)

  const panelURL = parsePanelURL(firstResult)
  const forbidden = await waitForHTTP(`${panelURL.origin}/`)
  assert.equal(forbidden.status, 403)
  const panel = await waitForHTTP(panelURL.href)
  assert.equal(panel.status, 200)
  assert.equal(panel.headers.get("x-frame-options"), "DENY")
  assert.match(panel.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/)

  const websocketURL = new URL("/ws", panelURL)
  websocketURL.protocol = "ws:"
  websocketURL.search = panelURL.search
  websocketURL.searchParams.set("session", "session-a")
  const socket = await openSocket(websocketURL.href, panelURL.origin)
  const init = await nextMessage(socket, (message) => message.type === "init")
  const widget = init.widgets.find((item: any) => item.id === "settings" && item.sessionID === "session-a")
  assert.ok(widget)
  assert.equal(init.widgets.filter((item: any) => item.id === "settings").length, 2, "same id is isolated by session")
  const frameResponse = await fetch(new URL(widget.frameURL, panelURL))
  assert.equal(frameResponse.status, 200)
  assert.match(frameResponse.headers.get("content-security-policy") ?? "", /connect-src 'none'/)
  assert.match(await frameResponse.text(), /sendPrompt|Content-Security-Policy/)

  socket.send(JSON.stringify({ type: "data", key: widget.key, data: { dryRun: true } }))
  const queuedPromise = nextMessage(socket, (message) => message.type === "submission-status" && message.status === "queued")
  socket.send(JSON.stringify({ type: "submit", key: widget.key, text: "Apply settings" }))
  await queuedPromise
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(fake.prompts.length, 0, "busy sessions do not receive prompts")

  fake.statuses["session-a"] = { type: "idle" }
  const sentPromise = nextMessage(socket, (message) => message.type === "submission-status" && message.status === "sent")
  await hooks.event?.({ event: { type: "session.status", properties: { sessionID: "session-a", status: { type: "idle" } } } as never })
  await sentPromise
  assert.equal(fake.prompts.length, 1)
  assert.equal(fake.prompts[0].path.id, "session-a")
  assert.match(fake.prompts[0].body.parts[0].text, /Apply settings/)
  assert.match(fake.prompts[0].body.parts[0].text, /dryRun/)

  socket.close()
  await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-b" } } } as never })
  const listed = await hooks.tool!.widget_list.execute({}, second.context)
  assert.match(String(listed), /No widgets/)
})
