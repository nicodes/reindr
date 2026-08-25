import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
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

test("file-backed session routing, interaction delivery, and HTTP security", async (t) => {
  const restoreBun = installBunServeAdapter()
  const canvasDirectory = await mkdtemp(path.join(process.cwd(), ".opencode", "test-ui-core-"))
  const templateDirectory = path.join(canvasDirectory, "templates")
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
  }, { port, autoOpen: false, canvasDirectory, templateDirectory })

  t.after(async () => {
    await hooks.dispose?.()
    restoreBun()
    await rm(canvasDirectory, { recursive: true, force: true })
  })

  assert.deepEqual(Object.keys(hooks.tool ?? {}), ["reindr_open"], "the plugin exposes only its lifecycle tool")

  const system = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]?.({ sessionID: "session-a", model: {} as never }, system)
  const firstEnvironment = await sessionEnvironment(hooks, "session-a")
  assert.match(system.system.join("\n"), new RegExp(firstEnvironment.REINDR_UI_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.ok(firstEnvironment.REINDR_UI_URL)

  await hooks["chat.message"]?.(
    { sessionID: "session-a", agent: "build", messageID: "message-a" },
    { message: {} as never, parts: [] },
  )
  const opened = await openReindr(hooks, "session-a")
  assert.equal(typeof opened, "object")
  const shippedController = await readFile(path.join(process.cwd(), "templates", "opencode-controller.html"), "utf8")
  assert.match(await readFile(firstEnvironment.REINDR_UI_FILE, "utf8"), /OpenCode controller[\s\S]*opencode\.controller/)
  await writeFile(firstEnvironment.REINDR_UI_FILE, shippedController.trimEnd())
  await notifyFileEdit(hooks, "session-a")
  assert.equal(await readFile(firstEnvironment.REINDR_UI_FILE, "utf8"), shippedController, "the shipped controller without its final newline is migrated")
  const authoredHTML = `<!doctype html><html><head><style>main { display: grid; }</style></head><body><main><button>Apply</button><p>Ready</p></main></body></html>`
  await writeFile(firstEnvironment.REINDR_UI_FILE, authoredHTML)
  const reopened = await openReindr(hooks, "session-a")
  assert.equal(typeof reopened, "object")
  assert.equal(await readFile(firstEnvironment.REINDR_UI_FILE, "utf8"), authoredHTML, "reindr_open never overwrites an existing UI")

  const secondEnvironment = await sessionEnvironment(hooks, "session-b")
  assert.notEqual(secondEnvironment.REINDR_UI_FILE, firstEnvironment.REINDR_UI_FILE)
  assert.notEqual(secondEnvironment.REINDR_UI_URL, firstEnvironment.REINDR_UI_URL)
  assert.equal(new URL(secondEnvironment.REINDR_UI_URL).search, new URL(firstEnvironment.REINDR_UI_URL).search)
  await writeFile(secondEnvironment.REINDR_UI_FILE, "<main>Other session</main>")
  await notifyFileEdit(hooks, "session-b")

  const panelURL = new URL(firstEnvironment.REINDR_UI_URL)
  const landing = await waitForHTTP(`${panelURL.origin}/`)
  assert.equal(landing.status, 200)
  assert.equal(landing.headers.get("x-frame-options"), "DENY")
  assert.match(landing.headers.get("content-security-policy") ?? "", /default-src 'none'/)
  assert.match(landing.headers.get("content-security-policy") ?? "", /img-src 'self'/)
  const landingDocument = await landing.text()
  assert.match(landingDocument, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/)
  assert.match(landingDocument, /Reindr[\s\S]*Start a session to get started\./)
  assert.doesNotMatch(landingDocument, /Session session-a|Session session-b|token=/, "the unauthenticated landing page exposes no bearer links or session metadata")
  const favicon = await fetch(new URL("/favicon.svg", panelURL))
  assert.equal(favicon.status, 200)
  assert.equal(favicon.headers.get("content-type"), "image/svg+xml; charset=utf-8")
  assert.match(await favicon.text(), /<svg[\s\S]*#101513[\s\S]*#9ee6c2[\s\S]*<\/svg>/)
  const authorizedLandingURL = new URL("/", panelURL)
  authorizedLandingURL.search = panelURL.search
  authorizedLandingURL.searchParams.set("view", "sessions")
  const authorizedLanding = await fetch(authorizedLandingURL)
  const authorizedLandingDocument = await authorizedLanding.text()
  assert.match(authorizedLandingDocument, /Session session-a/, "the authenticated landing page links session A")
  assert.match(authorizedLandingDocument, /Session session-b/, "the authenticated landing page links session B")
  const templatePreviewURL = new URL("/template/opencode-controller.html", panelURL)
  templatePreviewURL.search = panelURL.search
  const templatePreview = await fetch(templatePreviewURL)
  assert.equal(templatePreview.status, 200)
  assert.match(templatePreview.headers.get("content-security-policy") ?? "", /frame-src 'self'/)
  const templatePreviewDocument = await templatePreview.text()
  assert.match(templatePreviewDocument, /href="\/favicon\.svg"/)
  assert.match(templatePreviewDocument, /Read-only preview[\s\S]*Template preview: opencode-controller\.html/)
  const forbiddenTemplateFrame = await fetch(new URL("/template-frame/opencode-controller.html", panelURL))
  assert.equal(forbiddenTemplateFrame.status, 403)
  const frameURLMatch = templatePreviewDocument.match(/frame\.src = ("[^"]+")/)
  assert.ok(frameURLMatch)
  const templateFrameURL = new URL(JSON.parse(frameURLMatch[1]), panelURL)
  assert.notEqual(templateFrameURL.searchParams.get("token"), panelURL.searchParams.get("token"), "template code receives only a narrow frame capability")
  const mainTokenFrameURL = new URL("/template-frame/opencode-controller.html", panelURL)
  mainTokenFrameURL.search = panelURL.search
  assert.equal((await fetch(mainTokenFrameURL)).status, 403, "the panel bearer cannot be reused as a template-frame capability")
  const templateFrame = await fetch(templateFrameURL)
  assert.equal(templateFrame.status, 200)
  assert.match(templateFrame.headers.get("content-security-policy") ?? "", /sandbox allow-scripts; frame-ancestors 'self'/)
  assert.match(await templateFrame.text(), /OpenCode controller[\s\S]*opencode\.controller/)
  const staleSession = await fetch(new URL("/s/missing-session", panelURL))
  assert.equal(staleSession.status, 200)
  assert.doesNotMatch(await staleSession.text(), /Session session-a/, "a stale unauthenticated URL does not enumerate sessions")
  const authorizedStaleURL = new URL("/s/missing-session", panelURL)
  authorizedStaleURL.search = panelURL.search
  assert.match(await (await fetch(authorizedStaleURL)).text(), /Running Reindr sessions[\s\S]*Session session-a/)
  const unknownRoute = await fetch(`${panelURL.origin}/not-a-session`)
  assert.equal(unknownRoute.status, 200)
  assert.match(await unknownRoute.text(), /Start a session to get started\./)
  const forgedHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const forgedRequest = request({ hostname: panelURL.hostname, port: panelURL.port, path: "/", headers: { host: "attacker.invalid" } }, (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    forgedRequest.on("error", reject)
    forgedRequest.end()
  })
  assert.equal(forgedHostStatus, 403, "requests with a forged Host header are rejected")
  const panel = await waitForHTTP(panelURL.href)
  assert.equal(panel.status, 200)
  assert.equal(panel.headers.get("x-frame-options"), "DENY")
  assert.match(panel.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/)
  assert.match(await panel.text(), /href="\/favicon\.svg"/)

  const websocketURL = new URL("/ws", panelURL)
  websocketURL.protocol = "ws:"
  websocketURL.search = panelURL.search
  websocketURL.searchParams.set("session", "session-a")
  const socket = await openSocket(websocketURL.href, panelURL.origin)
  const init = await nextMessage(socket, (message) => message.type === "init")
  assert.equal(init.canvases.length, 2, "the panel exposes every session active in this process")
  const canvas = init.canvases.find((item: any) => item.sessionID === "session-a")
  assert.ok(canvas)
  const forbiddenFrameURL = new URL(canvas.frameURL)
  forbiddenFrameURL.search = ""
  assert.equal((await fetch(forbiddenFrameURL)).status, 403, "frame routes still require a capability token")
  const frameResponse = await fetch(new URL(canvas.frameURL, panelURL))
  assert.equal(frameResponse.status, 200)
  assert.match(frameResponse.headers.get("content-security-policy") ?? "", /connect-src 'none'/)
  assert.match(frameResponse.headers.get("content-security-policy") ?? "", /sandbox allow-scripts allow-forms; frame-ancestors 'self'/)
  const frameDocument = await frameResponse.text()
  assert.match(frameDocument, /opencode/)
  assert.match(frameDocument, /tailwindcss v4/)
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

  const unknownSessionURL = new URL("/ws", panelURL)
  unknownSessionURL.protocol = "ws:"
  unknownSessionURL.search = panelURL.search
  unknownSessionURL.searchParams.set("session", "unknown-session")
  await assert.rejects(openSocket(unknownSessionURL.href, panelURL.origin), /403/)

  socket.send(JSON.stringify({ type: "controller", id: "untrusted-snapshot", action: "snapshot", payload: {} }))
  const deniedController = await nextMessage(socket, (message) => message.type === "controller-result" && message.id === "untrusted-snapshot")
  assert.equal(deniedController.ok, false)
  assert.match(deniedController.error, /unmodified built-in controller/)

  let releaseStatus!: () => void
  const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve })
  fake.client.session.status = async () => {
    const snapshot = structuredClone(fake.statuses)
    await statusGate
    return { data: snapshot }
  }
  const queuedPromise = nextMessage(socket, (message) => message.type === "submission-status" && message.status === "queued")
  socket.send(JSON.stringify({ type: "submit", prompt: "Apply settings", data: { dryRun: true } }))
  await queuedPromise
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(fake.prompts.length, 0, "busy sessions do not receive prompts")

  fake.statuses["session-a"] = { type: "idle" }
  const sentPromise = nextMessage(socket, (message) => message.type === "submission-status" && message.status === "sent")
  await hooks.event?.({ event: { type: "session.status", properties: { sessionID: "session-a", status: { type: "idle" } } } as never })
  releaseStatus()
  await sentPromise
  assert.equal(fake.prompts.length, 1)
  assert.equal(fake.prompts[0].path.id, "session-a")
  assert.match(fake.prompts[0].body.parts[0].text, /Apply settings/)
  assert.match(fake.prompts[0].body.parts[0].text, /dryRun/)

  let releasePrompt!: () => void
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve })
  fake.client.session.promptAsync = async (input: unknown) => {
    fake.prompts.push(input)
    await promptGate
    return { data: undefined }
  }
  const firstRaceQueued = nextMessage(socket, (message) => message.type === "submission-status" && message.status === "queued")
  socket.send(JSON.stringify({ type: "submit", prompt: "First serialized prompt" }))
  await firstRaceQueued
  const secondRaceQueued = nextMessage(socket, (message) => message.type === "submission-status" && message.status === "queued")
  socket.send(JSON.stringify({ type: "submit", prompt: "Second serialized prompt" }))
  await secondRaceQueued
  await hooks.event?.({ event: { type: "session.status", properties: { sessionID: "session-a", status: { type: "idle" } } } as never })
  for (let attempt = 0; attempt < 100 && fake.prompts.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(fake.prompts.length, 2, "only the first queued prompt dispatches")
  await hooks.event?.({ event: { type: "session.status", properties: { sessionID: "session-a", status: { type: "idle" } } } as never })
  releasePrompt()
  for (let attempt = 0; attempt < 100 && fake.prompts.length < 3; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(fake.prompts.length, 3, "an idle event received during dispatch wakes the remaining queue")
  assert.match(fake.prompts[2].body.parts[0].text, /Second serialized prompt/)

  socket.close()
  await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-b" } } } as never })
  await assert.rejects(access(secondEnvironment.REINDR_UI_FILE))
})

test("the same session reuses its global UI file across worktrees", async (t) => {
  const restoreBun = installBunServeAdapter()
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "reindr-data-"))
  const firstWorktree = await mkdtemp(path.join(tmpdir(), "reindr-worktree-a-"))
  const secondWorktree = await mkdtemp(path.join(tmpdir(), "reindr-worktree-b-"))
  const previousDataHome = process.env.XDG_DATA_HOME
  const previousDirectory = process.env.REINDR_DIRECTORY
  const previousTemplateDirectory = process.env.REINDR_TEMPLATE_DIRECTORY
  process.env.XDG_DATA_HOME = dataDirectory
  delete process.env.REINDR_DIRECTORY
  delete process.env.REINDR_TEMPLATE_DIRECTORY
  let activeHooks: Awaited<ReturnType<typeof plugin>> | null = null

  t.after(async () => {
    await activeHooks?.dispose?.()
    restoreBun()
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    if (previousDirectory === undefined) delete process.env.REINDR_DIRECTORY
    else process.env.REINDR_DIRECTORY = previousDirectory
    if (previousTemplateDirectory === undefined) delete process.env.REINDR_TEMPLATE_DIRECTORY
    else process.env.REINDR_TEMPLATE_DIRECTORY = previousTemplateDirectory
    await rm(dataDirectory, { recursive: true, force: true })
    await rm(firstWorktree, { recursive: true, force: true })
    await rm(secondWorktree, { recursive: true, force: true })
  })

  const fake = fakeClient("idle")
  const pluginInput = (worktree: string) => ({
    client: fake.client as never,
    project: { id: "shared-project" } as never,
    directory: worktree,
    worktree,
    serverUrl: new URL("http://127.0.0.1:4096"),
    experimental_workspace: { register() {} },
    $: undefined as never,
  })

  activeHooks = await plugin(pluginInput(firstWorktree), { port: await freePort(), autoOpen: false })
  const firstEnvironment = await sessionEnvironment(activeHooks, "ses_shared")
  const expectedFile = path.join(dataDirectory, "reindr", "sessions", "ses_shared.html")
  const loadingTemplateFile = path.join(dataDirectory, "reindr", "templates", "reindr-loading.html")
  const controllerTemplateFile = path.join(dataDirectory, "reindr", "templates", "opencode-controller.html")
  assert.equal(firstEnvironment.REINDR_UI_FILE, expectedFile)
  assert.equal(await readFile(loadingTemplateFile, "utf8"), await readFile(path.join(process.cwd(), "templates", "reindr-loading.html"), "utf8"))
  assert.equal(await readFile(controllerTemplateFile, "utf8"), await readFile(path.join(process.cwd(), "templates", "opencode-controller.html"), "utf8"))
  assert.match(await readFile(loadingTemplateFile, "utf8"), /Preparing your interface[\s\S]*\{\{sessionTitle\}\}/)
  assert.match(await readFile(controllerTemplateFile, "utf8"), /OpenCode controller[\s\S]*opencode\.controller/)
  assert.doesNotMatch(await readFile(loadingTemplateFile, "utf8"), /<style>/)
  assert.doesNotMatch(await readFile(controllerTemplateFile, "utf8"), /<style>/)
  const runtimeConfig = {} as { permission?: { external_directory?: Record<string, string> } }
  await activeHooks.config?.(runtimeConfig as never)
  assert.equal(runtimeConfig.permission?.external_directory?.[path.join(path.dirname(expectedFile), "*.html")], "allow")
  const deniedConfig = { permission: { external_directory: "deny" } }
  await activeHooks.config?.(deniedConfig as never)
  assert.equal(deniedConfig.permission.external_directory, "deny", "an explicit external-directory denial is preserved")
  await writeFile(expectedFile, "<main>Persisted session UI</main>")
  await notifyFileEdit(activeHooks, "ses_shared")
  const customTemplate = "<main>Custom loading view for {{sessionTitle}}</main>"
  const customController = "<main>Custom controller template</main>"
  await writeFile(loadingTemplateFile, customTemplate)
  await writeFile(controllerTemplateFile, customController)
  await activeHooks.dispose?.()
  activeHooks = null

  activeHooks = await plugin(pluginInput(secondWorktree), { port: await freePort(), autoOpen: false })
  assert.equal(await readFile(loadingTemplateFile, "utf8"), customTemplate, "plugin restart preserves the saved template")
  assert.equal(await readFile(controllerTemplateFile, "utf8"), customController, "controller migration preserves customized templates")
  const system = { system: [] as string[] }
  await activeHooks["experimental.chat.system.transform"]?.({ sessionID: "ses_shared", model: {} as never }, system)
  const secondEnvironment = await sessionEnvironment(activeHooks, "ses_shared")
  assert.equal(secondEnvironment.REINDR_UI_FILE, expectedFile)
  assert.match(system.system.join("\n"), new RegExp(expectedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))

  const panelURL = new URL(secondEnvironment.REINDR_UI_URL)
  const socketURL = new URL("/ws", panelURL)
  socketURL.protocol = "ws:"
  socketURL.search = panelURL.search
  socketURL.searchParams.set("session", "ses_shared")
  const socket = await openSocket(socketURL.href, panelURL.origin)
  const init = await nextMessage(socket, (message) => message.type === "init")
  const canvas = init.canvases.find((item: any) => item.sessionID === "ses_shared")
  assert.ok(canvas, "the resumed session discovers its existing UI")
  const frame = await fetch(canvas.frameURL)
  assert.match(await frame.text(), /Persisted session UI/)
  socket.close()

  const templateEnvironment = await sessionEnvironment(activeHooks, "ses_template")
  await openReindr(activeHooks, "ses_template", "reindr-loading.html")
  assert.equal(await readFile(templateEnvironment.REINDR_UI_FILE, "utf8"), "<main>Custom loading view for Session ses_template</main>")
})

test("panel registry links sessions served by different plugin ports", async (t) => {
  const restoreBun = installBunServeAdapter()
  const canvasDirectory = await mkdtemp(path.join(process.cwd(), ".opencode", "test-ui-registry-"))
  const templateDirectory = path.join(canvasDirectory, "templates")
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
  const firstHooks = await plugin(pluginInput(firstFake.client), { port: firstPort, autoOpen: false, canvasDirectory, templateDirectory })
  const secondPort = await freePort()
  const secondHooks = await plugin(pluginInput(secondFake.client), { port: secondPort, autoOpen: false, canvasDirectory, templateDirectory })

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
