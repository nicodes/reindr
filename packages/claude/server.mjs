#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  canvasFileName,
  resolveReindrConfig,
} from "./vendor/reindr-core.mjs"

const MAX_UI_BYTES = 1024 * 1024
const MAX_INTERACTION_BYTES = 16 * 1024
const pluginRoot = process.env.REINDR_PLUGIN_ROOT || path.dirname(fileURLToPath(import.meta.url))
const dataDirectory = process.env.REINDR_DATA_DIRECTORY || path.join(process.cwd(), ".reindr")
const projectDirectory = process.env.REINDR_PROJECT_DIRECTORY || process.cwd()
const sessionId = randomUUID()
const panelToken = randomBytes(32).toString("base64url")
const frameToken = randomBytes(32).toString("base64url")
const config = resolveReindrConfig(projectDirectory, {}, {
  ...process.env,
  REINDR_DIRECTORY: process.env.REINDR_DIRECTORY || path.join(dataDirectory, "sessions"),
  REINDR_TEMPLATE_DIRECTORY: process.env.REINDR_TEMPLATE_DIRECTORY || path.join(dataDirectory, "templates"),
})
const uiFile = path.join(config.canvasDirectory, canvasFileName(sessionId))
const queueFile = path.join(dataDirectory, "interactions.jsonl")
const loadingTemplateFile = path.join(pluginRoot, "assets", "reindr-loading.html")
const stylesheetFile = path.join(pluginRoot, "assets", "reindr-tailwind.css")
const PANEL_TOKEN_STORAGE_KEY = "reindr:panel-token"
const PANEL_TOKEN_CLIENT_SCRIPT = `
  var tokenStorageKey = ${JSON.stringify(PANEL_TOKEN_STORAGE_KEY)};
  var tokenParams = new URLSearchParams(location.search);
  var token = tokenParams.get("token") || "";
  function cleanPanelURL() {
    tokenParams.delete("token");
    var cleanSearch = tokenParams.toString();
    try { history.replaceState(history.state, "", location.pathname + (cleanSearch ? "?" + cleanSearch : "") + location.hash); } catch (_) {}
  }
  if (token) {
    try { sessionStorage.setItem(tokenStorageKey, token); } catch (_) {}
    cleanPanelURL();
  } else {
    try { token = sessionStorage.getItem(tokenStorageKey) || ""; } catch (_) {}
    if (token) {
      tokenParams.set("token", token);
      try { location.replace(location.pathname + "?" + tokenParams.toString() + location.hash); } catch (_) {}
    }
  }`

let panelUrl = ""
let openedBrowser = false
let connected = false
let sessionTitle = path.basename(projectDirectory) || "Claude Code session"
let waitingInteraction = null
const pendingInteractions = []

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function jsonRpcText(text) {
  return { content: [{ type: "text", text }] }
}

function toolError(message) {
  return { isError: true, content: [{ type: "text", text: message }] }
}

function safeJson(value) {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? "null" : serialized
  } catch {
    throw new Error("Interaction payload must be JSON-serializable")
  }
}

async function ensureUiFile() {
  await mkdir(config.canvasDirectory, { recursive: true, mode: 0o700 })
  try {
    await stat(uiFile)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    const template = await readFile(loadingTemplateFile, "utf8")
    await writeFile(uiFile, template.replaceAll("{{sessionTitle}}", escapeHtml(sessionTitle)), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    }).catch(error => {
      if (error?.code !== "EEXIST") throw error
    })
  }
}

async function readUi() {
  const info = await stat(uiFile)
  if (info.size > MAX_UI_BYTES) throw new Error(`UI file exceeds ${MAX_UI_BYTES} bytes`)
  return readFile(uiFile, "utf8")
}

async function uiVersion() {
  const content = await readUi()
  return createHash("sha256").update(content).digest("base64url").slice(0, 16)
}

function frameBootstrap() {
  return `<script>(()=>{const stop=Event.prototype.stopImmediatePropagation;const send=Function.call.bind(MessagePort.prototype.postMessage);const defer=setTimeout;let port=null;let active=false;const api=Object.freeze({submit(value){if(!active)throw new Error("reindr.submit() must run during a trusted click or form submission");if(!port)throw new Error("Reindr bridge is not connected");active=false;send(port,{type:"submit",value})}});Object.defineProperty(window,"reindr",{value:api,writable:false,configurable:false});for(const type of ["click","submit"]){addEventListener(type,event=>{if(!event.isTrusted)return;active=true;defer(()=>{active=false},0)},true)}addEventListener("message",event=>{if(event.data!=="reindr:init"||!event.ports[0])return;stop.call(event);port=event.ports[0];port.start()},true)})();</script>`
}

async function renderFrame() {
  const [source, stylesheet] = await Promise.all([readUi(), readFile(stylesheetFile, "utf8")])
  const injection = `<style>${stylesheet}</style>${frameBootstrap()}`
  if (!/<html[\s>]/i.test(source)) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${injection}</head><body>${source}</body></html>`
  }
  if (/<head[\s>]/i.test(source)) return source.replace(/<head([^>]*)>/i, `<head$1>${injection}`)
  return source.replace(/<html([^>]*)>/i, `<html$1><head>${injection}</head>`)
}

function shellDocument() {
  const nonce = randomBytes(18).toString("base64url")
  const framePath = `/frame?token=${encodeURIComponent(frameToken)}`
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reindr - ${escapeHtml(sessionTitle)}</title>
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0}body{overflow:hidden;background:#080808}iframe{display:block}</style></head>
<body><iframe id="ui" title="${escapeHtml(sessionTitle)} interface" sandbox="allow-scripts allow-forms" src="${framePath}"></iframe>
<script nonce="${nonce}">(()=>{${PANEL_TOKEN_CLIENT_SCRIPT}const frame=document.querySelector("#ui");let version="";function connect(){const channel=new MessageChannel();channel.port1.onmessage=event=>{if(event.data?.type!=="submit")return;fetch("/interaction?token=${panelToken}",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(event.data.value)}).catch(()=>{})};frame.contentWindow.postMessage("reindr:init","*",[channel.port2])}frame.addEventListener("load",connect);connect();setInterval(async()=>{try{const response=await fetch("/state?token=${panelToken}",{cache:"no-store"});if(!response.ok)return;const next=(await response.json()).version;if(version&&next!==version)frame.src="${framePath}&v="+encodeURIComponent(next);version=next}catch{}},500)})();</script></body></html>`
  return { html, nonce }
}

function recoveryDocument() {
  const nonce = randomBytes(18).toString("base64url")
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reindr</title></head><body><p>Not found</p><script nonce="${nonce}">(()=>{${PANEL_TOKEN_CLIENT_SCRIPT}})();</script></body></html>`
  return { html, nonce }
}

function secureHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...extra,
  }
}

function sendResponse(response, status, body, headers = {}) {
  response.writeHead(status, secureHeaders(headers))
  response.end(body)
}

async function persistInteraction(payload) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  const line = `${JSON.stringify({ sessionId, payload, createdAt: new Date().toISOString() })}\n`
  await appendFile(queueFile, line, { encoding: "utf8", mode: 0o600 })
  await chmod(queueFile, 0o600).catch(() => {})
}

async function deliverInteraction(payload) {
  if (waitingInteraction) {
    const waiter = waitingInteraction
    waitingInteraction = null
    clearTimeout(waiter.timer)
    waiter.resolve(payload)
    return
  }

  const pending = { payload, timer: null }
  pending.timer = setTimeout(async () => {
    const index = pendingInteractions.indexOf(pending)
    if (index >= 0) pendingInteractions.splice(index, 1)
    if (process.env.REINDR_CLAUDE_CHANNEL === "1" && connected) {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `The user submitted this Reindr interaction: ${safeJson(payload)}`,
          meta: { session_id: sessionId },
        },
      }).catch(error => console.error("Reindr channel notification failed:", error))
      return
    }
    await persistInteraction(payload).catch(error => console.error("Reindr monitor delivery failed:", error))
  }, 750)
  pending.timer.unref()
  pendingInteractions.push(pending)
  while (pendingInteractions.length > 20) {
    const dropped = pendingInteractions.shift()
    clearTimeout(dropped.timer)
  }
}

const httpServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1")
    if (request.method === "GET" && url.pathname === "/" && url.searchParams.get("token") === panelToken) {
      const { html, nonce } = shellDocument()
      sendResponse(response, 200, html, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      })
      return
    }
    if (request.method === "GET" && url.pathname === "/" && !url.searchParams.has("token")) {
      const { html, nonce } = recoveryDocument()
      sendResponse(response, 404, html, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      })
      return
    }
    if (request.method === "GET" && url.pathname === "/frame" && url.searchParams.get("token") === frameToken) {
      sendResponse(response, 200, await renderFrame(), {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
      })
      return
    }
    if (request.method === "GET" && url.pathname === "/state" && url.searchParams.get("token") === panelToken) {
      sendResponse(response, 200, JSON.stringify({ version: await uiVersion() }), { "content-type": "application/json" })
      return
    }
    if (request.method === "POST" && url.pathname === "/interaction" && url.searchParams.get("token") === panelToken) {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > MAX_INTERACTION_BYTES) throw Object.assign(new Error("Interaction is too large"), { statusCode: 413 })
        chunks.push(chunk)
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")
      await deliverInteraction(payload)
      sendResponse(response, 202, JSON.stringify({ accepted: true }), { "content-type": "application/json" })
      return
    }
    sendResponse(response, 404, "Not found", { "content-type": "text/plain; charset=utf-8" })
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
    sendResponse(response, status, status === 500 ? "Internal server error" : error.message, { "content-type": "text/plain; charset=utf-8" })
    if (status === 500) console.error(error)
  }
})

httpServer.maxHeadersCount = 50
httpServer.requestTimeout = 10_000
httpServer.headersTimeout = 10_000
const panelReady = new Promise((resolve, reject) => {
  let port = config.preferredPort
  httpServer.once("listening", () => {
    const address = httpServer.address()
    panelUrl = `http://127.0.0.1:${address.port}/?token=${panelToken}`
    resolve(panelUrl)
  })
  httpServer.on("error", error => {
    if (error.code === "EADDRINUSE") {
      if (!config.portExplicit && port < 65_535) {
        httpServer.listen(++port, "127.0.0.1")
        return
      }
      error = new Error(`Reindr port ${port} is already in use (EADDRINUSE); ${config.portExplicit ? "explicit ports are never retried" : "no free port remains through 65535"}.`)
    }
    reject(error)
  })
  httpServer.listen(port, "127.0.0.1")
})
// Observe startup failures even before the first tool call awaits the panel.
panelReady.catch(error => console.error("Reindr panel server failed to start:", error))

function openBrowser(url) {
  if (openedBrowser || !config.autoOpen) return
  openedBrowser = true
  let child
  if (config.browser) {
    const command = config.browser.includes("{url}")
      ? config.browser.replaceAll("{url}", url)
      : `${config.browser} '${url}'`
    child = spawn(command, { shell: true, detached: true, stdio: "ignore" })
  } else if (process.platform === "darwin") {
    child = spawn("open", [url], { detached: true, stdio: "ignore" })
  } else if (process.platform === "win32") {
    child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true })
  } else {
    child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" })
  }
  child.on("error", error => console.error("Unable to open Reindr panel:", error.message))
  child.unref()
}

async function waitForPanelUrl() {
  return panelReady
}

const mcp = new Server(
  { name: "reindr", version: "0.0.2" },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: "Reindr creates a local editable HTML interface. Call reindr_open first, edit the exact returned uiFile, and use reindr_wait when your next step depends on a browser interaction.",
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reindr_open",
      description: "Create or reveal this Claude session's editable Reindr UI and open its secure local browser panel.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 160, description: "Short title for the interface" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "reindr_wait",
      description: "Wait for the next trusted click or form interaction submitted by the open Reindr interface.",
      inputSchema: {
        type: "object",
        properties: {
          timeoutSeconds: { type: "number", minimum: 1, maximum: 120, default: 120 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "reindr_status",
      description: "Return the current Reindr UI path and panel URL without opening a browser.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const args = isRecord(request.params.arguments) ? request.params.arguments : {}
    if (request.params.name === "reindr_open") {
      if (typeof args.title === "string" && args.title.trim()) sessionTitle = args.title.trim().slice(0, 160)
      await ensureUiFile()
      const url = await waitForPanelUrl()
      openBrowser(url)
      return jsonRpcText(JSON.stringify({
        sessionId,
        uiFile,
        panelUrl: url,
        instructions: "Edit uiFile with a complete self-contained HTML document. Call window.reindr.submit(value) directly from a trusted click or form-submit handler to send an interaction.",
      }, null, 2))
    }
    if (request.params.name === "reindr_status") {
      await ensureUiFile()
      return jsonRpcText(JSON.stringify({ sessionId, uiFile, panelUrl: await waitForPanelUrl() }, null, 2))
    }
    if (request.params.name === "reindr_wait") {
      if (waitingInteraction) return toolError("Another reindr_wait call is already active")
      const queued = pendingInteractions.shift()
      if (queued) {
        clearTimeout(queued.timer)
        return jsonRpcText(safeJson(queued.payload))
      }
      const seconds = Math.min(120, Math.max(1, Number(args.timeoutSeconds) || 120))
      const payload = await new Promise(resolve => {
        const timer = setTimeout(() => {
          waitingInteraction = null
          resolve(undefined)
        }, seconds * 1_000)
        waitingInteraction = { resolve, timer }
      })
      return jsonRpcText(payload === undefined ? "No interaction was received before the timeout." : safeJson(payload))
    }
    return toolError(`Unknown tool: ${request.params.name}`)
  } catch (error) {
    console.error(error)
    return toolError(error instanceof Error ? error.message : String(error))
  }
})

await mcp.connect(new StdioServerTransport())
connected = true

function shutdown() {
  httpServer.close()
  process.exit(0)
}

process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
