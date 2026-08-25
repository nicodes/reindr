import assert from "node:assert/strict"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import plugin from "../.opencode/plugins/opencode-generative-ui.ts"
import { fakeClient, freePort, installBunServeAdapter, nextMessage, openSocket, waitForHTTP } from "./harness.ts"

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

test("file-backed session routing, interaction delivery, and HTTP security", async (t) => {
  const restoreBun = installBunServeAdapter()
  const canvasDirectory = await mkdtemp(path.join(process.cwd(), ".opencode", "test-ui-core-"))
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
  }, { port, autoOpen: false, canvasDirectory })

  t.after(async () => {
    await hooks.dispose?.()
    restoreBun()
    await rm(canvasDirectory, { recursive: true, force: true })
  })

  assert.equal(hooks.tool, undefined, "the plugin exposes no custom UI authoring tools")

  const system = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]?.({ sessionID: "session-a", model: {} as never }, system)
  const firstEnvironment = await sessionEnvironment(hooks, "session-a")
  assert.match(system.system.join("\n"), new RegExp(firstEnvironment.OPENCODE_UI_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.ok(firstEnvironment.OPENCODE_UI_URL)

  await hooks["chat.message"]?.(
    { sessionID: "session-a", agent: "build", messageID: "message-a" },
    { message: {} as never, parts: [] },
  )
  await writeFile(firstEnvironment.OPENCODE_UI_FILE, `<!doctype html><html><head><style>main { display: grid; }</style></head><body><main><button>Apply</button><p>Ready</p></main></body></html>`)
  await notifyFileEdit(hooks, "session-a")

  const secondEnvironment = await sessionEnvironment(hooks, "session-b")
  assert.notEqual(secondEnvironment.OPENCODE_UI_FILE, firstEnvironment.OPENCODE_UI_FILE)
  assert.notEqual(secondEnvironment.OPENCODE_UI_URL, firstEnvironment.OPENCODE_UI_URL)
  await writeFile(secondEnvironment.OPENCODE_UI_FILE, "<main>Other session</main>")
  await notifyFileEdit(hooks, "session-b")

  const panelURL = new URL(firstEnvironment.OPENCODE_UI_URL)
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
  assert.equal(init.canvases.length, 1, "a session capability cannot enumerate another session")
  const canvas = init.canvases.find((item: any) => item.sessionID === "session-a")
  assert.ok(canvas)
  const frameResponse = await fetch(new URL(canvas.frameURL, panelURL))
  assert.equal(frameResponse.status, 200)
  assert.match(frameResponse.headers.get("content-security-policy") ?? "", /connect-src 'none'/)
  const frameDocument = await frameResponse.text()
  assert.match(frameDocument, /opencode/)
  assert.match(frameDocument, /MessageChannel|Content-Security-Policy/)
  assert.match(frameDocument, /<button>Apply<\/button>/)
  assert.match(frameDocument, /--ui-accent/)
  assert.doesNotMatch(frameDocument, /data-widget-id|sendPrompt|sendData/)

  const crossSessionURL = new URL("/ws", panelURL)
  crossSessionURL.protocol = "ws:"
  crossSessionURL.search = panelURL.search
  crossSessionURL.searchParams.set("session", "session-b")
  const crossSessionResponse = await fetch(crossSessionURL.href.replace(/^ws:/, "http:"), {
    headers: { origin: panelURL.origin },
  })
  assert.equal(crossSessionResponse.status, 403, "a session token cannot bind to another session")

  const queuedPromise = nextMessage(socket, (message) => message.type === "submission-status" && message.status === "queued")
  socket.send(JSON.stringify({ type: "submit", prompt: "Apply settings", data: { dryRun: true } }))
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
  await assert.rejects(access(secondEnvironment.OPENCODE_UI_FILE))
})
