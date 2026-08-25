import assert from "node:assert/strict"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import plugin from "../.opencode/plugins/reindr.ts"
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
  assert.match(system.system.join("\n"), new RegExp(firstEnvironment.REINDR_UI_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.ok(firstEnvironment.REINDR_UI_URL)

  await hooks["chat.message"]?.(
    { sessionID: "session-a", agent: "build", messageID: "message-a" },
    { message: {} as never, parts: [] },
  )
  await writeFile(firstEnvironment.REINDR_UI_FILE, `<!doctype html><html><head><style>main { display: grid; }</style></head><body><main><button>Apply</button><p>Ready</p></main></body></html>`)
  await notifyFileEdit(hooks, "session-a")

  const secondEnvironment = await sessionEnvironment(hooks, "session-b")
  assert.notEqual(secondEnvironment.REINDR_UI_FILE, firstEnvironment.REINDR_UI_FILE)
  assert.notEqual(secondEnvironment.REINDR_UI_URL, firstEnvironment.REINDR_UI_URL)
  assert.equal(new URL(secondEnvironment.REINDR_UI_URL).search, new URL(firstEnvironment.REINDR_UI_URL).search)
  await writeFile(secondEnvironment.REINDR_UI_FILE, "<main>Other session</main>")
  await notifyFileEdit(hooks, "session-b")

  const panelURL = new URL(firstEnvironment.REINDR_UI_URL)
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
  assert.equal(init.canvases.length, 2, "the project panel exposes every local session")
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
  const crossSessionSocket = await openSocket(crossSessionURL.href, panelURL.origin)
  const crossSessionInit = await nextMessage(crossSessionSocket, (message) => message.type === "init")
  assert.equal(crossSessionInit.canvases.length, 2, "the shared panel token can switch its active local session")
  crossSessionSocket.close()

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
  await assert.rejects(access(secondEnvironment.REINDR_UI_FILE))
})

test("panel registry links sessions served by different plugin ports", async (t) => {
  const restoreBun = installBunServeAdapter()
  const canvasDirectory = await mkdtemp(path.join(process.cwd(), ".opencode", "test-ui-registry-"))
  const firstPort = await freePort()
  const firstFake = fakeClient("idle")
  const secondFake = fakeClient("idle")
  const pluginInput = (client: unknown) => ({
    client: client as never,
    project: { id: "registry-project" } as never,
    directory: process.cwd(),
    worktree: process.cwd(),
    serverUrl: new URL("http://127.0.0.1:4096"),
    experimental_workspace: { register() {} },
    $: undefined as never,
  })
  const firstHooks = await plugin(pluginInput(firstFake.client), { port: firstPort, autoOpen: false, canvasDirectory })
  const secondPort = await freePort()
  const secondHooks = await plugin(pluginInput(secondFake.client), { port: secondPort, autoOpen: false, canvasDirectory })

  t.after(async () => {
    await secondHooks.dispose?.()
    await firstHooks.dispose?.()
    restoreBun()
    await rm(canvasDirectory, { recursive: true, force: true })
  })

  const firstEnvironment = await sessionEnvironment(firstHooks, "registry-a")
  const secondEnvironment = await sessionEnvironment(secondHooks, "registry-b")
  await writeFile(firstEnvironment.REINDR_UI_FILE, "<main>Registry A</main>")
  await notifyFileEdit(firstHooks, "registry-a")
  await writeFile(secondEnvironment.REINDR_UI_FILE, "<main>Registry B</main>")
  await notifyFileEdit(secondHooks, "registry-b")
  await new Promise((resolve) => setTimeout(resolve, 150))

  const firstPanelURL = new URL(firstEnvironment.REINDR_UI_URL)
  const socketURL = new URL("/ws", firstPanelURL)
  socketURL.protocol = "ws:"
  socketURL.search = firstPanelURL.search
  socketURL.searchParams.set("session", "registry-a")
  const socket = await openSocket(socketURL.href, firstPanelURL.origin)
  const init = await nextMessage(socket, (message) => message.type === "init")
  const origins = new Set(init.sessions.map((session: any) => new URL(session.url).origin))
  assert.deepEqual(origins, new Set([new URL(firstEnvironment.REINDR_UI_URL).origin, new URL(secondEnvironment.REINDR_UI_URL).origin]))
  assert.equal(init.sessions.length, 2)
  socket.close()
})
