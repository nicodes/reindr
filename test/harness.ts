import { once } from "node:events"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import type { AddressInfo } from "node:net"
import { WebSocket, WebSocketServer } from "ws"

type BunSocket = WebSocket & { data: { sessionID: string | null } }

type BunServeOptions = {
  port: number
  hostname: string
  fetch(request: Request, server: { upgrade(request: Request, options: { data: BunSocket["data"] }): boolean }): Response | undefined | Promise<Response | undefined>
  websocket: {
    maxPayloadLength?: number
    open(socket: BunSocket): void
    close(socket: BunSocket): void
    message(socket: BunSocket, data: Buffer): void
  }
}

function requestURL(request: IncomingMessage, hostname: string, port: number) {
  return `http://${request.headers.host ?? `${hostname}:${port}`}${request.url ?? "/"}`
}

async function writeResponse(response: Response, target: ServerResponse) {
  target.statusCode = response.status
  response.headers.forEach((value, name) => target.setHeader(name, value))
  target.end(Buffer.from(await response.arrayBuffer()))
}

export function installBunServeAdapter() {
  const original = (globalThis as { Bun?: unknown }).Bun
  ;(globalThis as { Bun?: unknown }).Bun = {
    serve(options: BunServeOptions) {
      const http = createServer(async (request, response) => {
        const webRequest = new Request(requestURL(request, options.hostname, options.port), {
          method: request.method,
          headers: request.headers as HeadersInit,
        })
        const result = await options.fetch(webRequest, { upgrade: () => false })
        await writeResponse(result ?? new Response("upgrade failed", { status: 400 }), response)
      })
      const websocket = new WebSocketServer({ noServer: true, maxPayload: options.websocket.maxPayloadLength })
      websocket.on("connection", (socket: BunSocket) => {
        options.websocket.open(socket)
        socket.on("message", (data) => options.websocket.message(socket, Buffer.from(data as Buffer)))
        socket.on("close", () => options.websocket.close(socket))
      })
      http.on("upgrade", async (request, socket, head) => {
        let upgraded = false
        const webRequest = new Request(requestURL(request, options.hostname, options.port), {
          method: request.method,
          headers: request.headers as HeadersInit,
        })
        const result = await options.fetch(webRequest, {
          upgrade(_request, upgradeOptions) {
            upgraded = true
            websocket.handleUpgrade(request, socket, head, (client) => {
              ;(client as BunSocket).data = upgradeOptions.data
              websocket.emit("connection", client, request)
            })
            return true
          },
        })
        if (!upgraded) {
          const status = result?.status ?? 400
          socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`)
          socket.destroy()
        }
      })
      http.listen(options.port, options.hostname)
      return {
        port: options.port,
        async stop() {
          for (const client of websocket.clients) client.close(1001, "test server stopped")
          websocket.close()
          http.close()
          if (http.listening) await once(http, "close")
        },
      }
    },
  }
  return () => {
    ;(globalThis as { Bun?: unknown }).Bun = original
  }
}

export async function freePort() {
  const server = createNetServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as AddressInfo).port
  server.close()
  await once(server, "close")
  return port
}

export async function waitForHTTP(url: string, timeout = 5_000) {
  const deadline = Date.now() + timeout
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.status < 500) return response
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`)
}

export function openSocket(url: string, origin: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { origin })
    socket.once("message", (message) => {
      ;(socket as WebSocket & { initialMessages?: Buffer[] }).initialMessages = [Buffer.from(message as Buffer)]
      resolve(socket)
    })
    socket.once("error", reject)
  })
}

export function nextMessage(socket: WebSocket, predicate: (message: any) => boolean = () => true, timeout = 5_000) {
  const queued = (socket as WebSocket & { initialMessages?: Buffer[] }).initialMessages ?? []
  const index = queued.findIndex((raw) => predicate(JSON.parse(raw.toString("utf8"))))
  if (index >= 0) {
    const [raw] = queued.splice(index, 1)
    return Promise.resolve(JSON.parse(raw.toString("utf8")))
  }
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage)
      reject(new Error("Timed out waiting for WebSocket message"))
    }, timeout)
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString("utf8"))
      if (!predicate(message)) return
      clearTimeout(timer)
      socket.off("message", onMessage)
      resolve(message)
    }
    socket.on("message", onMessage)
  })
}

export function fakeClient(initialStatus: "idle" | "busy" = "idle") {
  const statuses: Record<string, { type: "idle" | "busy" }> = {}
  const prompts: any[] = []
  const commands: any[] = []
  const aborts: string[] = []
  const logs: any[] = []
  return {
    statuses,
    prompts,
    commands,
    aborts,
    logs,
    client: {
      app: {
        async log(input: unknown) { logs.push(input); return { data: true } },
        async agents() {
          return { data: [
            { name: "build", description: "Build agent", mode: "primary", builtIn: true, permission: {}, tools: {}, options: {} },
            { name: "explore", description: "Explore subagent", mode: "subagent", builtIn: true, permission: {}, tools: {}, options: {} },
          ] }
        },
      },
      provider: {
        async list() {
          return { data: {
            all: [{
              id: "test-provider",
              name: "Test Provider",
              env: [],
              models: {
                "test-model": {
                  id: "test-model",
                  name: "Test Model",
                  release_date: "2026-01-01",
                  attachment: true,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  limit: { context: 100_000, output: 10_000 },
                  options: {},
                },
              },
            }],
            default: { "test-provider": "test-model" },
            connected: ["test-provider"],
          } }
        },
      },
      command: {
        async list() {
          return { data: [{ name: "test-command", description: "Run the test command", template: "Test $ARGUMENTS" }] }
        },
      },
      session: {
        async get(input: { path: { id: string } }) {
          statuses[input.path.id] ??= { type: initialStatus }
          return { data: { id: input.path.id, projectID: "test-project", directory: process.cwd(), title: `Session ${input.path.id}`, time: { created: 1, updated: 2 } } }
        },
        async status() { return { data: statuses } },
        async messages(input: { path: { id: string } }) {
          return { data: [
            {
              info: { id: `user-${input.path.id}`, sessionID: input.path.id, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test-provider", modelID: "test-model" } },
              parts: [{ id: "text-1", sessionID: input.path.id, messageID: `user-${input.path.id}`, type: "text", text: "History prompt" }],
            },
            {
              info: { id: `assistant-${input.path.id}`, sessionID: input.path.id, role: "assistant", time: { created: 2, completed: 3 }, parentID: `user-${input.path.id}`, providerID: "test-provider", modelID: "test-model", mode: "build", path: { cwd: process.cwd(), root: process.cwd() }, cost: 0.01, tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 0, write: 0 } }, finish: "stop" },
              parts: [
                { id: "reasoning-1", sessionID: input.path.id, messageID: `assistant-${input.path.id}`, type: "reasoning", text: "Reasoning trace", time: { start: 2, end: 3 } },
                { id: "tool-1", sessionID: input.path.id, messageID: `assistant-${input.path.id}`, type: "tool", callID: "call-1", tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "Tests passed", title: "Run tests", metadata: {}, time: { start: 2, end: 3 } } },
                { id: "subtask-1", sessionID: input.path.id, messageID: `assistant-${input.path.id}`, type: "subtask", prompt: "Inspect the code", description: "Explore code", agent: "explore" },
              ],
            },
          ] }
        },
        async children(input: { path: { id: string } }) {
          return { data: [{ id: `${input.path.id}-child`, projectID: "test-project", directory: process.cwd(), parentID: input.path.id, title: "Explore child", version: "1", time: { created: 2, updated: 3 } }] }
        },
        async promptAsync(input: unknown) { prompts.push(input); return { data: undefined } },
        async command(input: unknown) { commands.push(input); return { data: { info: {}, parts: [] } } },
        async abort(input: { path: { id: string } }) { aborts.push(input.path.id); return { data: true } },
      },
    },
  }
}
