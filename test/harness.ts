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
  const logs: any[] = []
  return {
    statuses,
    prompts,
    logs,
    client: {
      app: {
        async log(input: unknown) { logs.push(input); return { data: true } },
      },
      session: {
        async get(input: { path: { id: string } }) {
          statuses[input.path.id] ??= { type: initialStatus }
          return { data: { id: input.path.id, title: `Session ${input.path.id}` } }
        },
        async status() { return { data: statuses } },
        async promptAsync(input: unknown) { prompts.push(input); return { data: undefined } },
      },
    },
  }
}
