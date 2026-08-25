import { constants, watch, type FSWatcher } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { chmod, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { tool, type Plugin, type PluginOptions } from "@opencode-ai/plugin"

type Canvas = {
  sessionID: string
  sessionTitle: string
  agent?: string
  html: string
  file: string
  createdAt: number
  updatedAt: number
  restored: boolean
}

type SessionSummary = {
  key: string
  id: string
  title: string
  url: string
  updatedAt: number
}

type TemplateSummary = {
  name: string
  url: string
}

type PanelRegistry = {
  version: 1
  instanceID: string
  pid: number
  updatedAt: number
  sessions: SessionSummary[]
}

type Submission = {
  id: string
  sessionID: string
  agent?: string
  model?: { providerID: string; modelID: string }
  prompt: string
}

type SocketData = {
  sessionID: string | null
}

type PanelSocket = {
  data: SocketData
  send(data: string): unknown
  close(code?: number, reason?: string): unknown
}

type PanelServer = {
  port: number
  stop(closeActiveConnections?: boolean): unknown
}

type ClientCanvas = Omit<Canvas, "html" | "file"> & {
  frameURL: string
}

type ServerMessage =
  | { type: "init"; canvases: ClientCanvas[]; sessions: SessionSummary[] }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "session-canvas"; sessionID: string; canvas: ClientCanvas | null }
  | { type: "session-remove"; sessionID: string }
  | { type: "submission-status"; id: string; status: "queued" | "sent" | "failed"; message: string }
  | { type: "controller-result"; id: string; ok: true; value: unknown }
  | { type: "controller-result"; id: string; ok: false; error: string }
  | { type: "notice"; level: "info" | "error"; message: string }

type ClientMessage =
  | { type: "submit"; prompt: string; data?: unknown }
  | { type: "controller"; id: string; action: "snapshot" | "prompt" | "command" | "abort"; payload?: unknown }

type Config = {
  preferredPort: number
  autoOpen: boolean
  browserCommand: string | null
  canvasDirectory: string
  templateDirectory: string
  allowedAssetOrigins: string[]
  stylesheetPath: string | null
}

type PermissionAction = "ask" | "allow" | "deny"
type RuntimePermission = {
  external_directory?: PermissionAction | Record<string, PermissionAction>
  [key: string]: unknown
}

const DEFAULT_PORT = 4917
const MAX_CANVAS_HTML_BYTES = 1_000_000
const MAX_TEMPLATE_BYTES = 200_000
const MAX_STYLESHEET_BYTES = 200_000
const MAX_DATA_BYTES = 64_000
const MAX_PENDING_SUBMISSIONS = 100
const REGISTRY_HEARTBEAT_MS = 3_000
const REGISTRY_STALE_MS = 10_000
const BUILT_IN_TAILWIND_STYLESHEET = new URL("../reindr-tailwind.css", import.meta.url)

function booleanOption(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value !== "0" && value.toLowerCase() !== "false"
  return fallback
}

function portOption(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) return fallback
  return parsed
}

function normalizeAssetOrigins(values: unknown[]): string[] {
  const origins = new Set<string>()
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue
    try {
      const url = new URL(value.includes("://") ? value : `https://${value}`)
      if (url.protocol !== "https:") continue
      if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) continue
      origins.add(url.origin)
    } catch {}
  }
  return [...origins]
}

function resolveFile(worktree: string, value: string) {
  const expanded = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value
  return path.isAbsolute(expanded) ? expanded : path.resolve(worktree, expanded)
}

function dataHome() {
  const configured = process.env.XDG_DATA_HOME
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(homedir(), ".local", "share")
}

function readConfig(worktree: string, options: PluginOptions | undefined): Config {
  const allowedOption = Array.isArray(options?.allowedAssetHosts) ? options.allowedAssetHosts : []
  const allowedEnvironment = (process.env.REINDR_ALLOWED_ASSET_HOSTS ?? "").split(",")
  const directoryOption = typeof options?.canvasDirectory === "string"
    ? options.canvasDirectory
    : path.join(dataHome(), "reindr", "sessions")
  const canvasDirectory = resolveFile(worktree, process.env.REINDR_DIRECTORY ?? directoryOption)
  const templateOption = typeof process.env.REINDR_TEMPLATE_DIRECTORY === "string"
    ? process.env.REINDR_TEMPLATE_DIRECTORY
    : typeof options?.templateDirectory === "string"
      ? options.templateDirectory
      : path.join(path.dirname(canvasDirectory), "templates")
  return {
    preferredPort: portOption(process.env.REINDR_PORT ?? options?.port, DEFAULT_PORT),
    autoOpen: booleanOption(process.env.REINDR_AUTORAISE ?? options?.autoOpen, true),
    browserCommand:
      typeof process.env.REINDR_BROWSER === "string"
        ? process.env.REINDR_BROWSER
        : typeof options?.browser === "string"
          ? options.browser
          : null,
    canvasDirectory,
    templateDirectory: resolveFile(worktree, templateOption),
    allowedAssetOrigins: normalizeAssetOrigins([...allowedOption, ...allowedEnvironment]),
    stylesheetPath:
      typeof process.env.REINDR_STYLESHEET === "string"
        ? process.env.REINDR_STYLESHEET
        : typeof options?.stylesheetPath === "string"
          ? options.stylesheetPath
          : null,
  }
}

function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url")
}

function jsonBytes(value: unknown) {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("not JSON serializable")
  return Buffer.byteLength(encoded, "utf8")
}

function sdkData<T>(response: unknown): T {
  if (response && typeof response === "object" && "error" in response && response.error) {
    throw new Error(String(response.error))
  }
  if (response && typeof response === "object" && "data" in response) {
    return (response as { data: T }).data
  }
  return response as T
}

function recordValue(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" ? value as Record<string, any> : null
}

function limitedText(value: unknown, limit = 20_000) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value)
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text
}

function jsonText(value: unknown, limit = 12_000) {
  try {
    return limitedText(JSON.stringify(value, null, 2), limit)
  } catch {
    return "[unserializable]"
  }
}

function controllerPart(value: unknown) {
  const part = recordValue(value) ?? {}
  const base = { id: limitedText(part.id, 200), type: limitedText(part.type, 100) }
  if (part.type === "text" || part.type === "reasoning") {
    return { ...base, text: limitedText(part.text, 30_000), time: part.time }
  }
  if (part.type === "tool") {
    const state = recordValue(part.state) ?? {}
    return {
      ...base,
      callID: limitedText(part.callID, 200),
      tool: limitedText(part.tool, 200),
      state: {
        status: limitedText(state.status, 40),
        title: limitedText(state.title, 500),
        input: jsonText(state.input),
        output: limitedText(state.output, 24_000),
        error: limitedText(state.error, 12_000),
        time: state.time,
      },
    }
  }
  if (part.type === "subtask") {
    return { ...base, prompt: limitedText(part.prompt), description: limitedText(part.description, 1_000), agent: limitedText(part.agent, 200) }
  }
  if (part.type === "agent") return { ...base, name: limitedText(part.name, 200) }
  if (part.type === "file") return { ...base, filename: limitedText(part.filename, 500), mime: limitedText(part.mime, 200) }
  if (part.type === "patch") return { ...base, files: Array.isArray(part.files) ? part.files.map((file) => limitedText(file, 1_000)).slice(0, 200) : [] }
  if (part.type === "step-finish") return { ...base, reason: limitedText(part.reason, 500), cost: part.cost, tokens: part.tokens }
  if (part.type === "retry") return { ...base, attempt: part.attempt, error: limitedText(part.error?.data?.message ?? part.error?.name, 2_000) }
  if (part.type === "compaction") return { ...base, auto: Boolean(part.auto) }
  return base
}

function controllerMessage(value: unknown) {
  const entry = recordValue(value) ?? {}
  const info = recordValue(entry.info) ?? {}
  const model = recordValue(info.model)
  const error = recordValue(info.error)
  const errorData = recordValue(error?.data)
  return {
    id: limitedText(info.id, 200),
    role: info.role === "user" ? "user" : "assistant",
    time: info.time,
    agent: limitedText(info.agent ?? info.mode, 200),
    model: model
      ? { providerID: limitedText(model.providerID, 200), modelID: limitedText(model.modelID, 300) }
      : { providerID: limitedText(info.providerID, 200), modelID: limitedText(info.modelID, 300) },
    cost: Number(info.cost) || 0,
    tokens: info.tokens,
    finish: limitedText(info.finish, 200),
    error: limitedText(errorData?.message ?? error?.name, 2_000),
    parts: Array.isArray(entry.parts) ? entry.parts.map(controllerPart) : [],
  }
}

function sessionPath(sessionID: string) {
  return `/s/${encodeURIComponent(sessionID)}`
}

function canvasFileName(sessionID: string) {
  if (!sessionID) throw new Error("Session ID cannot be empty")
  const encoded = encodeURIComponent(sessionID).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${encoded}.html`
}

function escapeHTML(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

const DEFAULT_LOADING_TEMPLATE = `<!doctype html>
<!-- reindr-template:reindr-loading version=2 -->
<html lang="en" class="min-h-full bg-[#080808] text-zinc-100">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Preparing {{sessionTitle}}</title>
</head>
<body class="m-0 grid min-h-dvh place-items-center bg-[radial-gradient(circle_at_50%_35%,#242424_0,#0d0d0d_34%,#080808_68%)] px-5 font-sans">
  <!-- reindr-starter -->
  <main class="w-full max-w-[540px] rounded-[18px] border border-[#2b2b2b] bg-[#111111e8] p-[42px] shadow-[0_30px_90px_#0009]" aria-live="polite">
    <p class="mb-[30px] text-[11px] font-bold tracking-[.18em] text-[#8d8d93] uppercase">reindr</p>
    <div class="mb-5 flex gap-[7px]" aria-hidden="true">
      <span class="size-[7px] animate-bounce rounded-full bg-zinc-100 motion-reduce:animate-none"></span>
      <span class="size-[7px] animate-bounce rounded-full bg-zinc-100 [animation-delay:160ms] motion-reduce:animate-none"></span>
      <span class="size-[7px] animate-bounce rounded-full bg-zinc-100 [animation-delay:320ms] motion-reduce:animate-none"></span>
    </div>
    <h1 class="text-[clamp(25px,6vw,40px)] leading-[1.08] font-semibold tracking-[-.035em]">Preparing your interface</h1>
    <p class="mt-[15px] text-sm leading-[1.6] text-[#96969d]">{{sessionTitle}} is taking shape. This view will update as the agent builds it.</p>
  </main>
</body>
</html>`

const DEFAULT_CONTROLLER_TEMPLATE = `<!doctype html>
<!-- reindr-template:opencode-controller version=4 -->
<html lang="en" class="h-full overflow-hidden bg-[#090a0c] text-[#f1f3f7]">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Controller</title>
</head>
<body class="m-0 h-full overflow-hidden bg-[#090a0c] text-[#f1f3f7] [font-family:Inter,ui-sans-serif,system-ui,sans-serif]">
  <header class="sticky top-0 z-5 flex min-h-14 items-center gap-3 border-b border-[#20232a] bg-[#090a0ce8] px-3.5 py-[9px] backdrop-blur-[18px]">
    <span class="text-[11px] font-bold tracking-[.16em] uppercase">OpenCode controller</span>
    <strong id="session-title" class="min-w-0 overflow-hidden text-sm font-semibold text-ellipsis whitespace-nowrap">Loading session</strong>
    <span id="status" class="ml-auto rounded-full border border-[#282c35] bg-[#11141a] px-2 py-1 text-[11px] text-[#8c929f]">connecting</span>
    <button id="refresh" class="cursor-pointer rounded-lg border border-[#282c35] bg-[#171a20] px-[11px] py-2 hover:border-[#444b58] disabled:cursor-wait disabled:opacity-50" type="button">Refresh</button>
    <button id="abort" class="cursor-pointer rounded-lg border border-[#282c35] bg-[#171a20] px-[11px] py-2 hover:border-[#444b58] disabled:cursor-wait disabled:opacity-50" type="button">Abort</button>
  </header>
  <div class="grid h-[calc(100dvh-56px)] min-h-0 grid-cols-[280px_minmax(0,1fr)] overflow-hidden max-[760px]:grid-cols-1 max-[760px]:grid-rows-[auto_minmax(0,1fr)]">
    <aside class="min-h-0 overflow-y-auto border-r border-[#20232a] bg-[#0f1115] p-3.5 max-[760px]:max-h-[38dvh] max-[760px]:border-r-0 max-[760px]:border-b">
      <section class="border-b border-[#20232a] pb-4">
        <h2 class="mb-2.5 text-[10px] font-bold tracking-[.14em] text-[#8c929f] uppercase">Next turn</h2>
        <label class="mt-[9px] grid gap-[5px] text-[11px] text-[#8c929f]">Agent / mode<select id="agent" class="w-full rounded-lg border border-[#282c35] bg-[#171a20] px-2.5 py-[9px] text-[#f1f3f7]"></select></label>
        <label class="mt-[9px] grid gap-[5px] text-[11px] text-[#8c929f]">Model<select id="model" class="w-full rounded-lg border border-[#282c35] bg-[#171a20] px-2.5 py-[9px] text-[#f1f3f7]"></select></label>
        <label class="mt-[9px] flex items-center gap-2 text-[11px] text-[#8c929f]"><input id="thinking" class="size-auto" type="checkbox"> Show reasoning</label>
      </section>
      <section class="border-b border-[#20232a] py-3 pb-4">
        <h2 class="mb-2.5 text-[10px] font-bold tracking-[.14em] text-[#8c929f] uppercase">Commands</h2>
        <label class="mt-[9px] grid gap-[5px] text-[11px] text-[#8c929f]">Command<select id="command" class="w-full rounded-lg border border-[#282c35] bg-[#171a20] px-2.5 py-[9px] text-[#f1f3f7]"></select></label>
        <div class="mt-[7px] grid grid-cols-[1fr_auto] gap-[7px]"><input id="arguments" class="w-full rounded-lg border border-[#282c35] bg-[#171a20] px-2.5 py-[9px] text-[#f1f3f7]" placeholder="Arguments"><button id="run-command" class="cursor-pointer rounded-lg border border-[#282c35] bg-[#171a20] px-[11px] py-2 hover:border-[#444b58]" type="button">Run</button></div>
      </section>
      <section class="border-b border-[#20232a] py-3 pb-4">
        <h2 class="mb-2.5 text-[10px] font-bold tracking-[.14em] text-[#8c929f] uppercase">Subagents</h2>
        <div id="children" class="grid gap-1.5"><span class="text-[11px] text-[#8c929f]">No child sessions</span></div>
      </section>
    </aside>
    <main class="min-h-0 min-w-0 overflow-y-auto px-[18px] pt-[18px] pb-[190px] max-[760px]:px-2.5">
      <div id="error" class="mb-3 rounded-lg border border-[#6b302d] bg-[#351b1a] px-3 py-2.5 text-xs text-[#ffd6d2]" role="alert" hidden></div>
      <div id="history" class="mx-auto grid max-w-[980px] gap-3" aria-live="polite"></div>
    </main>
  </div>
  <div class="fixed right-0 bottom-0 left-[280px] z-4 bg-[linear-gradient(transparent,#090a0c_20%)] px-[18px] pt-3 pb-4 max-[760px]:left-0">
    <form id="prompt-form" class="mx-auto mt-7 grid max-w-[980px] grid-cols-[1fr_auto] gap-2 rounded-xl border border-[#303641] bg-[#11141a] p-2 shadow-[0_18px_55px_#000b]"><textarea id="prompt" class="min-h-12 max-h-40 w-full resize-y border-0 bg-transparent px-2.5 py-[9px] text-[#f1f3f7] outline-none" required placeholder="Send the next instruction..."></textarea><button class="self-end cursor-pointer rounded-lg border border-[#9ee6c2] bg-[#9ee6c2] px-[11px] py-2 font-bold text-[#07110c]" type="submit">Send</button></form>
  </div>
  <dialog id="abort-confirm" class="w-[min(420px,calc(100vw-32px))] rounded-xl border border-[#303641] bg-[#11141a] p-0 text-[#f1f3f7] shadow-[0_24px_80px_#000e] backdrop:bg-black/70 backdrop:backdrop-blur-[3px]">
    <form class="p-[18px]" method="dialog">
      <h2 class="text-[15px] font-bold">Abort active turn?</h2>
      <p class="mt-2 mb-[18px] text-xs text-[#8c929f]">This stops the current OpenCode response for this session.</p>
      <div class="flex justify-end gap-2"><button class="cursor-pointer rounded-lg border border-[#282c35] bg-[#171a20] px-[11px] py-2 hover:border-[#444b58]" value="cancel">Keep running</button><button id="confirm-abort" class="cursor-pointer rounded-lg border border-[#8d403b] bg-[#6b302d] px-[11px] py-2 text-white" type="button">Abort turn</button></div>
    </form>
  </dialog>
  <script>
  (function () {
    var api = window.opencode && window.opencode.controller;
    if (window.opencode) {
      if (window.opencode.fillViewport) window.opencode.fillViewport();
      window.opencode.setHeight(120);
    }
    var state = null;
    var busy = false;
    var sessionTitle = document.getElementById("session-title");
    var status = document.getElementById("status");
    var history = document.getElementById("history");
    var children = document.getElementById("children");
    var agent = document.getElementById("agent");
    var model = document.getElementById("model");
    var thinking = document.getElementById("thinking");
    var command = document.getElementById("command");
    var argumentsInput = document.getElementById("arguments");
    var promptInput = document.getElementById("prompt");
    var errorBox = document.getElementById("error");
    var abortDialog = document.getElementById("abort-confirm");
    function text(value) { return value == null ? "" : String(value); }
    function showError(error) { errorBox.textContent = text(error && error.message || error); errorBox.hidden = false; }
    function clearError() { errorBox.textContent = ""; errorBox.hidden = true; }
    function el(tag, className, value) { var node = document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = text(value); return node; }
    function time(value) { var stamp = value && (value.created || value.start); return stamp ? new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""; }
    function selectedModel() { var pieces = model.value.split("/"); return pieces.length > 1 ? { providerID: pieces.shift(), modelID: pieces.join("/") } : {}; }
    function selection() { var picked = selectedModel(); return { agent: agent.value, providerID: picked.providerID || "", modelID: picked.modelID || "" }; }
    function fillSelect(select, items, current, label) {
      var before = select.value || current;
      select.replaceChildren();
      var fallback = document.createElement("option"); fallback.value = ""; fallback.textContent = label; select.appendChild(fallback);
      items.forEach(function (item) { var option = document.createElement("option"); option.value = item.value; option.textContent = item.label; option.disabled = item.disabled; select.appendChild(option); });
      select.value = items.some(function (item) { return item.value === before; }) ? before : current || "";
    }
    function renderControls() {
      var agents = (state.agents || []).map(function (item) { return { value: item.name, label: item.name + " [" + item.mode + "]" }; });
      fillSelect(agent, agents, state.selection && state.selection.agent, "Default agent");
      var models = [];
      (state.providers || []).forEach(function (provider) { (provider.models || []).forEach(function (item) { models.push({ value: provider.id + "/" + item.id, label: provider.name + " / " + item.name + (item.reasoning ? " [reasoning]" : ""), disabled: !provider.connected }); }); });
      var currentModel = state.selection && state.selection.model ? state.selection.model.providerID + "/" + state.selection.model.modelID : "";
      fillSelect(model, models, currentModel === "/" ? "" : currentModel, "Default model");
      fillSelect(command, (state.commands || []).map(function (item) { return { value: item.name, label: "/" + item.name + (item.subtask ? " [subtask]" : "") }; }), command.value, "Select command");
    }
    function renderChildren() {
      children.replaceChildren();
      if (!(state.children || []).length) { children.appendChild(el("span", "text-[11px] text-[#8c929f]", "No child sessions")); return; }
      state.children.forEach(function (item) { var card = el("div", "rounded-lg border border-[#242832] bg-[#12151a] p-[9px]"); card.appendChild(el("strong", "block overflow-hidden text-xs text-ellipsis whitespace-nowrap", item.title)); card.appendChild(el("span", "mt-[3px] block overflow-hidden text-[10px] text-ellipsis whitespace-nowrap text-[#8c929f]", (item.status && item.status.type || "idle") + " | " + item.id)); children.appendChild(card); });
    }
    function renderPart(part) {
      var detailsClasses = "rounded-lg border border-[#252a33] bg-[#12151a]";
      var summaryClasses = "cursor-pointer px-2.5 py-[9px] text-[11px] font-semibold text-[#c8cdd7]";
      var preClasses = "m-0 max-h-[360px] overflow-auto border-t border-[#252a33] p-2.5 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap text-[#b9c0cc] [overflow-wrap:anywhere]";
      if (part.type === "text") return el("p", "m-0 font-mono text-[13px] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]", part.text);
      if (part.type === "reasoning") { var reasoning = el("details", detailsClasses); reasoning.dataset.kind = "reasoning"; reasoning.open = thinking.checked; reasoning.appendChild(el("summary", summaryClasses + " text-[#b8a6dd]", "Reasoning / thinking")); reasoning.appendChild(el("pre", preClasses, part.text)); return reasoning; }
      if (part.type === "tool") { var toolStatus = text(part.state && part.state.status); var tool = el("details", detailsClasses); tool.dataset.kind = "tool"; tool.dataset.status = toolStatus; var title = part.tool + " | " + toolStatus; var toolColor = toolStatus === "error" ? " text-[#ff786f]" : toolStatus === "running" || toolStatus === "pending" ? " text-[#f4bf75]" : ""; tool.appendChild(el("summary", summaryClasses + toolColor, title)); if (part.state && part.state.input) tool.appendChild(el("pre", preClasses, "Input\\n" + part.state.input)); if (part.state && part.state.output) tool.appendChild(el("pre", preClasses, "Output\\n" + part.state.output)); if (part.state && part.state.error) tool.appendChild(el("pre", preClasses, "Error\\n" + part.state.error)); return tool; }
      if (part.type === "subtask") { var subtask = el("div", "rounded-lg border border-[#294039] bg-[#111a18] p-2.5"); subtask.appendChild(el("strong", "block text-[11px] text-[#9ee6c2]", "Subagent: " + part.agent + " | " + part.description)); subtask.appendChild(el("p", "mt-[5px] mb-0 text-[11px] whitespace-pre-wrap text-[#b8c8c2]", part.prompt)); return subtask; }
      if (part.type === "patch") return el("pre", preClasses, "Changed files\\n" + (part.files || []).join("\\n"));
      if (part.type === "step-finish") return el("pre", preClasses, "Step finished: " + part.reason + " | cost " + text(part.cost));
      if (part.type === "retry") return el("pre", preClasses, "Retry " + text(part.attempt) + ": " + part.error);
      return null;
    }
    function renderHistory() {
      history.replaceChildren();
      if (!(state.messages || []).length) { history.appendChild(el("div", "px-5 py-[60px] text-center text-[#8c929f]", "No history yet. Send a prompt to begin.")); return; }
      state.messages.forEach(function (message) {
        var card = el("article", "overflow-hidden rounded-xl border bg-[#0f1115] " + (message.role === "user" ? "border-[#2b443a]" : "border-[#232730]"));
        var head = el("div", "flex items-center gap-2.5 border-b border-[#22262e] bg-[#12151a] px-3 py-[9px] text-[10px] text-[#8c929f]");
        head.appendChild(el("strong", "text-[11px] text-[#f1f3f7] uppercase", message.role));
        head.appendChild(el("span", "", (message.agent || "default") + " | " + (message.model && message.model.modelID || "default model")));
        if (message.tokens && message.role === "assistant") head.appendChild(el("span", "", "tokens " + text(message.tokens.output || 0) + " / reasoning " + text(message.tokens.reasoning || 0)));
        head.appendChild(el("time", "ml-auto", time(message.time)));
        card.appendChild(head);
        var parts = el("div", "grid gap-2.5 p-3");
        (message.parts || []).forEach(function (part) { var node = renderPart(part); if (node) parts.appendChild(node); });
        if (message.error) parts.appendChild(el("pre", "m-0 max-h-[360px] overflow-auto border-t border-[#252a33] p-2.5 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap text-[#b9c0cc] [overflow-wrap:anywhere]", "Error\\n" + message.error));
        card.appendChild(parts); history.appendChild(card);
      });
    }
    function render() {
      sessionTitle.textContent = state.session && state.session.title || "OpenCode session";
      var statusType = state.status && state.status.type || "unknown"; status.textContent = statusType; status.className = "ml-auto rounded-full border border-[#282c35] bg-[#11141a] px-2 py-1 text-[11px] " + (statusType === "busy" || statusType === "retry" ? "text-[#f4bf75]" : "text-[#8c929f]");
      renderControls(); renderChildren(); renderHistory();
    }
    async function refresh() {
      if (!api || busy) return;
      busy = true;
      try { state = await api.snapshot(); clearError(); render(); }
      catch (error) { showError(error); }
      finally { busy = false; }
    }
    document.getElementById("refresh").addEventListener("click", refresh);
    thinking.addEventListener("change", renderHistory);
    promptInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit(); }
    });
    document.getElementById("prompt-form").addEventListener("submit", async function (event) {
      event.preventDefault(); clearError(); var value = promptInput.value.trim(); if (!value) return;
      try { var request = api.prompt(Object.assign({ prompt: value }, selection())); await request; promptInput.value = ""; await refresh(); } catch (error) { showError(error); }
    });
    document.getElementById("run-command").addEventListener("click", async function () {
      if (!command.value) return; clearError();
      try { var request = api.command(Object.assign({ command: command.value, arguments: argumentsInput.value }, selection())); await request; argumentsInput.value = ""; await refresh(); } catch (error) { showError(error); }
    });
    document.getElementById("abort").addEventListener("click", function () { abortDialog.showModal(); });
    document.getElementById("confirm-abort").addEventListener("click", async function () {
      clearError();
      try { var request = api.abort(); abortDialog.close(); await request; await refresh(); } catch (error) { showError(error); }
    });
    if (!api) showError("This OpenCode runtime does not expose the Reindr controller bridge.");
    else { refresh(); setInterval(refresh, 2000); }
  })();
  </script>
</body>
</html>`

const LEGACY_CONTROLLER_HASHES = new Set([
  "0f32ae6f600ca3471d7526a218af37e9a726d4df25365c67f9e1057386431342",
  "9e0ff44ae7aa7628212371f70810eefe98b1c6f0460698ff637f0da4988e04ec",
  "9cee7d4574c4be5abb4e4278b1351dc72e440842495495e38aa00b9b1b111316",
  "853211f29c8dabdb208164deb6f913dea2cb977c85eb060855f1e7f4707c1b2e",
  "96a56bff912bb4047ec14a56359759a06696b98bccdabddde377b3f1e311b521",
  "a8498c15f547227b35f3e9f111761bb438910651f20aafd131a52232a255a5ef",
])

const LEGACY_LOADING_HASHES = new Set([
  "b84ac8855452ea7d64dbac04ba698379e8052e269c49492ce162c6f29ce49516",
])

function renderLoadingTemplate(template: string, sessionTitle: string) {
  return template.replaceAll("{{sessionTitle}}", escapeHTML(sessionTitle))
}

function canvasCsp(allowedAssetOrigins: string[]) {
  const assets = allowedAssetOrigins.join(" ")
  const withAssets = assets ? ` ${assets}` : ""
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${withAssets}`,
    `style-src 'unsafe-inline'${withAssets}`,
    `img-src data: blob:${withAssets}`,
    `font-src data:${withAssets}`,
    "connect-src 'none'",
    "media-src data: blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ")
}

const BRIDGE_HTML = `<script>
(function () {
  var channel = new MessageChannel();
  var port = channel.port1;
  var sentAt = 0;
  var controllerSequence = 0;
  var controllerRequests = {};
  var manualHeight = false;
  var viewportMode = false;
  var activeEvent = null;
  var encoder = new TextEncoder();
  var apply = Reflect.apply;
  var addListener = EventTarget.prototype.addEventListener;
  var postToPort = MessagePort.prototype.postMessage;
  var startPort = MessagePort.prototype.start;
  var parentPost = parent.postMessage.bind(parent);
  var stringify = JSON.stringify;
  var parse = JSON.parse;
  var hasOwn = Object.prototype.hasOwnProperty;
  var activation = navigator.userActivation;
  var getIsActive = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(activation), "isActive").get;
  var getIsTrusted = Object.getOwnPropertyDescriptor(new Event("reindr-bridge"), "isTrusted").get;
  var getMessageData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data").get;
  var getWindowEvent = Object.getOwnPropertyDescriptor(window, "event").get;
  var defer = setTimeout.bind(window);
  var NativePromise = Promise;
  function post(message) {
    try { apply(postToPort, port, [message]); } catch (_) {}
  }
  function fail(message) {
    post({ kind: "error", message: message });
    return false;
  }
  function consumeActivation(name) {
    if (!activeEvent || apply(getWindowEvent, window, []) !== activeEvent) {
      fail(name + " requires a user click or form submission.");
      return false;
    }
    if (!activation || !apply(getIsActive, activation, [])) {
      fail("The browser did not grant user activation.");
      return false;
    }
    activeEvent = null;
    return true;
  }
  function submit(input) {
    if (!input || typeof input !== "object") return fail("opencode.submit() requires an object.");
    if (!consumeActivation("opencode.submit()")) return false;
    var prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) return fail("opencode.submit() requires a prompt.");
    if (encoder.encode(prompt).length > 64000) return fail("The UI prompt is too large.");
    var message = { kind: "submit", prompt: prompt };
    if (apply(hasOwn, input, ["data"])) {
      try {
        var encoded = stringify(input.data);
        if (encoded === undefined || encoder.encode(encoded).length > 64000) throw new Error("invalid data");
        message.data = parse(encoded);
      } catch (_) {
        return fail("UI data must be JSON-serializable and smaller than 64 KB.");
      }
    }
    var now = Date.now();
    if (now - sentAt < 500) return false;
    sentAt = now;
    post(message);
    return true;
  }
  function controllerCall(action, payload, requiresActivation) {
    if (requiresActivation && !consumeActivation("This controller action")) {
      return NativePromise.reject(new Error("User activation is required."));
    }
    var cleanPayload;
    try {
      var encoded = stringify(payload == null ? {} : payload);
      if (encoded === undefined || encoder.encode(encoded).length > 64000) throw new Error("invalid payload");
      cleanPayload = parse(encoded);
    } catch (_) {
      fail("Controller data must be JSON-serializable and smaller than 64 KB.");
      return NativePromise.reject(new Error("Invalid controller data."));
    }
    if (requiresActivation) {
      var now = Date.now();
      if (now - sentAt < 250) return NativePromise.reject(new Error("Controller action was sent too quickly."));
      sentAt = now;
    }
    var id = String(++controllerSequence);
    return new NativePromise(function (resolve, reject) {
      var timer = defer(function () {
        delete controllerRequests[id];
        reject(new Error("Controller request timed out."));
      }, 15000);
      controllerRequests[id] = { resolve: resolve, reject: reject, timer: timer };
      post({ kind: "controller", id: id, action: action, payload: cleanPayload });
    });
  }
  var controller = Object.freeze({
    snapshot: function () { return controllerCall("snapshot", {}, false); },
    prompt: function (input) { return controllerCall("prompt", input, true); },
    command: function (input) { return controllerCall("command", input, true); },
    abort: function () { return controllerCall("abort", {}, true); }
  });
  function setHeight(px) {
    manualHeight = true;
    post({ kind: "resize", px: Math.ceil(Number(px) || 0) });
  }
  function fillViewport() {
    manualHeight = true;
    viewportMode = true;
    post({ kind: "viewport" });
  }
  Object.defineProperty(window, "opencode", {
    configurable: false,
    writable: false,
    value: Object.freeze({ submit: submit, setHeight: setHeight, fillViewport: fillViewport, controller: controller })
  });
  function autoHeight() {
    if (manualHeight) return;
    var root = document.documentElement;
    var body = document.body;
    var height = Math.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0);
    post({ kind: "resize", px: Math.min(Math.max(height, 120), 5000) });
  }
  function controlKey(control, index) {
    if (control.id) return "id:" + control.id;
    if (control.getAttribute("name")) return "name:" + control.getAttribute("name") + ":" + index;
    return "index:" + index;
  }
  function captureState() {
    var controls = Array.prototype.slice.call(document.querySelectorAll("input, textarea, select"));
    var values = {};
    controls.forEach(function (control, index) {
      var value = { value: control.value };
      if ("checked" in control) value.checked = control.checked;
      if (control instanceof HTMLSelectElement) value.selectedIndex = control.selectedIndex;
      values[controlKey(control, index)] = value;
    });
    var activeIndex = controls.indexOf(document.activeElement);
    return {
      controls: values,
      active: activeIndex >= 0 ? controlKey(controls[activeIndex], activeIndex) : null,
      scrollX: scrollX,
      scrollY: scrollY
    };
  }
  function restoreState(state) {
    if (!state || !state.controls) return;
    var controls = Array.prototype.slice.call(document.querySelectorAll("input, textarea, select"));
    controls.forEach(function (control, index) {
      var key = controlKey(control, index);
      var value = state.controls[key];
      if (!value) return;
      if ("value" in value) control.value = value.value;
      if ("checked" in value && "checked" in control) control.checked = value.checked;
      if ("selectedIndex" in value && control instanceof HTMLSelectElement) control.selectedIndex = value.selectedIndex;
      if (state.active === key) setTimeout(function () { control.focus(); }, 0);
    });
    requestAnimationFrame(function () { scrollTo(Number(state.scrollX) || 0, Number(state.scrollY) || 0); });
  }
  function receive(message) {
    var data = apply(getMessageData, message, []);
    if (!data || data.__ocwParent !== 1) return;
    if (data.kind === "capture-state") post({ kind: "state", requestID: data.requestID, state: captureState() });
    if (data.kind === "restore-state") restoreState(data.state);
    if (data.kind === "controller-result") {
      var request = controllerRequests[data.id];
      if (!request) return;
      clearTimeout(request.timer);
      delete controllerRequests[data.id];
      if (data.ok) request.resolve(data.value);
      else request.reject(new Error(String(data.error || "Controller request failed.")));
    }
  }
  function authorize(event) {
    if (!apply(getIsTrusted, event, [])) return;
    activeEvent = event;
    defer(function () { activeEvent = null; }, 0);
  }
  apply(addListener, window, ["click", authorize, true]);
  apply(addListener, window, ["submit", authorize, true]);
  apply(addListener, port, ["message", receive]);
  apply(startPort, port, []);
  parentPost({ __ocwConnect: 1 }, "*", [channel.port2]);
  addEventListener("DOMContentLoaded", function () {
    if ("ResizeObserver" in window) new ResizeObserver(autoHeight).observe(document.documentElement);
    autoHeight();
    post({ kind: "ready", viewport: viewportMode });
  });
  addEventListener("load", autoHeight);
  setTimeout(autoHeight, 300);
})();
</script>`

const DEFAULT_SHARED_CSS = `
@layer base {
  :root {
    color-scheme: dark;
    --ui-bg: #13110e;
    --ui-surface: #1d1914;
    --ui-surface-raised: #252019;
    --ui-border: #393126;
    --ui-text: #f0e9dc;
    --ui-muted: #a69b8d;
    --ui-accent: #f4b942;
    --ui-danger: #e17161;
    --ui-radius: 10px;
    --ui-space: clamp(14px, 2vw, 24px);
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body { margin: 0; background: var(--ui-bg); color: var(--ui-text); }
}
`

function safeStyle(css: string) {
  return css.replace(/<\/style/gi, "<\\/style")
}

function documentClass(html: string, tag: "html" | "body") {
  const attributes = html.match(new RegExp(`<${tag}\\b([^>]*)>`, "i"))?.[1] ?? ""
  return attributes.match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] ?? ""
}

function documentParts(html: string) {
  const head = html.match(/<head(?:\s[^>]*)?>([\s\S]*?)<\/head>/i)?.[1] ?? ""
  const body = html.match(/<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i)?.[1]
  const htmlClass = documentClass(html, "html")
  const bodyClass = documentClass(html, "body")
  if (body !== undefined) return { head, body, htmlClass, bodyClass }
  return {
    head,
    htmlClass,
    bodyClass,
    body: html
      .replace(/<!doctype[^>]*>/gi, "")
      .replace(/<\/?html(?:\s[^>]*)?>/gi, "")
      .replace(/<head(?:\s[^>]*)?>[\s\S]*?<\/head>/gi, "")
      .replace(/<\/?body(?:\s[^>]*)?>/gi, ""),
  }
}

function canvasDocument(html: string, sharedCSS: string, allowedAssetOrigins: string[]) {
  const parts = documentParts(html)
  const csp = canvasCsp(allowedAssetOrigins).replaceAll("&", "&amp;").replaceAll('"', "&quot;")
  return `<!doctype html><html class="${escapeHTML(parts.htmlClass)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">${BRIDGE_HTML}<style id="reindr-default-styles">${safeStyle(DEFAULT_SHARED_CSS)}</style><style id="reindr-shared-styles">${safeStyle(sharedCSS)}</style>${parts.head}</head><body class="${escapeHTML(parts.bodyClass)}">${parts.body}</body></html>`
}

function landingHtml(sessions: SessionSummary[], templates: TemplateSummary[], selectedView: "sessions" | "templates") {
  const sessionLinks = sessions.map((session) => `
      <a class="session" href="${escapeHTML(session.url)}">
        <strong>${escapeHTML(session.title)}</strong>
        <span>${escapeHTML(session.id)}</span>
      </a>`).join("")
  const templateItems = templates.map((template) => `
      <a class="template" href="${escapeHTML(template.url)}">
        <strong>${escapeHTML(template.name)}</strong>
        <span>Preview template</span>
      </a>`).join("")
  const items = selectedView === "templates"
    ? templateItems || '<p class="empty-list">No templates are saved.</p>'
    : sessionLinks || '<p class="empty-list">No Reindr sessions are running.</p>'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Reindr</title>
  <style>
    :root { color-scheme: dark; background: #080808; color: #f4f4f5; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100dvh; margin: 0; display: grid; grid-template-columns: 280px 1fr; background: #080808; }
    aside { min-width: 0; padding: 24px 16px; background: #0c0c0c; border-right: 1px solid #222; }
    .wordmark { margin: 0 10px 18px; color: #a1a1a8; font-size: 11px; font-weight: 720; letter-spacing: .18em; text-transform: uppercase; }
    .tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin-bottom: 14px; padding: 3px; background: #111; border: 1px solid #202020; border-radius: 9px; }
    .tab { padding: 7px 8px; color: #77777e; border-radius: 6px; font-size: 11px; font-weight: 650; text-align: center; text-decoration: none; }
    .tab:hover, .tab:focus-visible { color: #ddd; outline: none; }
    .tab.active { color: #fff; background: #232323; box-shadow: 0 1px 2px #0008; }
    nav { display: grid; gap: 4px; }
    .session, .template { min-width: 0; padding: 11px 12px; color: #d7d7da; border: 1px solid transparent; border-radius: 9px; text-decoration: none; }
    .session:hover, .session:focus-visible, .template:hover, .template:focus-visible { color: #fff; background: #151515; border-color: #2a2a2a; outline: none; }
    .session strong, .session span, .template strong, .template span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session strong, .template strong { font-size: 13px; font-weight: 580; }
    .session span, .template span { margin-top: 3px; color: #77777e; font-size: 11px; }
    .empty-list { margin: 10px; color: #68686f; font-size: 12px; line-height: 1.5; }
    main { min-width: 0; display: grid; place-items: center; padding: 32px; text-align: center; background: radial-gradient(circle at 50% 40%, #1b1b1b 0, #0b0b0b 38%, #080808 70%); }
    h1 { margin: 0; font-size: clamp(42px, 10vw, 82px); font-weight: 620; letter-spacing: -.06em; line-height: 1; }
    p { margin: 20px 0 0; color: #8f8f96; font-size: 15px; letter-spacing: .01em; }
    @media (max-width: 700px) {
      body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
      aside { padding: 16px; border-right: 0; border-bottom: 1px solid #222; }
      .wordmark { margin-bottom: 12px; }
      nav { display: flex; overflow-x: auto; }
      .session, .template { width: min(240px, 76vw); flex: 0 0 auto; }
    }
  </style>
</head>
<body>
  <aside>
    <p class="wordmark">Reindr</p>
    <div class="tabs" role="tablist" aria-label="Reindr navigation">
      <a class="tab${selectedView === "sessions" ? " active" : ""}" role="tab" aria-selected="${selectedView === "sessions"}" href="/?view=sessions">Sessions</a>
      <a class="tab${selectedView === "templates" ? " active" : ""}" role="tab" aria-selected="${selectedView === "templates"}" href="/?view=templates">Templates</a>
    </div>
    <nav aria-label="${selectedView === "templates" ? "Saved Reindr templates" : "Running Reindr sessions"}">${items}
    </nav>
  </aside>
  <main>
    <div>
      <h1>Reindr</h1>
      <p>Start a session to get started.</p>
    </div>
  </main>
</body>
</html>`
}

function templatePreviewHtml(name: string, frameURL: string, nonce: string, templatesURL: string) {
  const previewSnapshot = JSON.stringify({
    session: { id: "template-preview", title: `Preview: ${name}` },
    status: { type: "idle" },
    selection: { agent: "", model: { providerID: "", modelID: "" } },
    agents: [],
    providers: [],
    commands: [],
    messages: [],
    children: [],
  })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHTML(name)} | Reindr template preview</title>
<style>
  :root { color-scheme: dark; background: #050505; color: #f4f4f5; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { min-height: 100dvh; margin: 0; background: #050505; }
  header { display: flex; min-height: 48px; align-items: center; gap: 12px; padding: 7px 14px; background: #080808; border-bottom: 1px solid #1d1d1d; }
  a { padding: 7px 10px; color: #b5b5ba; border: 1px solid #282828; border-radius: 7px; font-size: 12px; text-decoration: none; }
  a:hover, a:focus-visible { color: #fff; background: #151515; outline: none; }
  h1 { min-width: 0; margin: 0; overflow: hidden; color: #d9d9dc; font-size: 12px; font-weight: 560; text-overflow: ellipsis; white-space: nowrap; }
  span { margin-left: auto; color: #707077; font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
  iframe { display: block; width: 100%; height: calc(100dvh - 48px); min-height: 320px; border: 0; background: transparent; }
</style>
</head>
<body>
<header><a href="${escapeHTML(templatesURL)}">Back to templates</a><h1>${escapeHTML(name)}</h1><span>Read-only preview</span></header>
<iframe id="preview" title="Template preview: ${escapeHTML(name)}" sandbox="allow-scripts"></iframe>
<script nonce="${nonce}">
  const frame = document.getElementById("preview");
  const snapshot = ${previewSnapshot};
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || !event.data || event.data.__ocwConnect !== 1 || !event.ports[0]) return;
    const port = event.ports[0];
    port.onmessage = (portEvent) => {
      const message = portEvent.data;
      if (!message || typeof message !== "object") return;
      if (message.kind === "viewport") {
        frame.style.height = "calc(100dvh - 48px)";
      } else if (message.kind === "resize" && Number.isFinite(message.px)) {
        frame.style.height = Math.max(320, Math.min(4000, Math.round(message.px))) + "px";
      } else if (message.kind === "controller" && message.action === "snapshot") {
        port.postMessage({ __ocwParent: 1, kind: "controller-result", id: message.id, ok: true, value: { ...snapshot, timestamp: Date.now() } });
      } else if (message.kind === "controller") {
        port.postMessage({ __ocwParent: 1, kind: "controller-result", id: message.id, ok: false, error: "Template previews are read-only." });
      }
    };
    port.start();
    port.postMessage({ kind: "reindr-connected" });
  });
  frame.src = ${JSON.stringify(frameURL)};
</script>
</body>
</html>`
}

function shellHtml(nonce: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>reindr</title>
<style>
  :root { --bg: #050505; --panel: #090909; --raised: #111; --hover: #171717; --edge: #242424; --ink: #f4f4f5; --muted: #7c7c82; --accent: #fafafa; --bad: #ff6259; color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body { margin: 0; overflow-x: hidden; background: var(--bg); color: var(--ink); font: 13px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body.drawer-open { overflow: hidden; }
  button, a { font: inherit; }
  header { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 10px; height: 48px; padding: 7px 14px; background: #050505e8; border-bottom: 1px solid #181818; box-shadow: 0 1px 0 #000; backdrop-filter: blur(18px) saturate(120%); }
  header h1 { margin: 0; color: #d9d9dc; font-size: 12px; font-weight: 520; letter-spacing: .025em; }
  main { width: 100%; min-height: calc(100dvh - 48px); margin: 0; padding: 0; }
  .empty { display: grid; min-height: calc(100dvh - 48px); place-items: center; padding: 24px; color: var(--muted); text-align: center; }
  .agent-view { width: 100%; overflow: hidden; background: transparent; }
  iframe { display: block; width: 100%; height: 240px; min-height: calc(100dvh - 48px); border: 0; background: transparent; }
  .dormant { display: grid; place-items: center; min-height: calc(100dvh - 48px); padding: 24px; text-align: center; background: var(--bg); }
  .dormant p { max-width: 520px; margin: 0 0 14px; color: var(--muted); }
  button { padding: 8px 13px; color: var(--ink); background: var(--raised); border: 1px solid var(--edge); border-radius: 8px; cursor: pointer; }
  button:hover { background: var(--hover); border-color: #343434; }
  button:focus-visible { border-color: #555; outline: 2px solid #ffffff24; outline-offset: 2px; }
  #session-toggle { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; padding: 0; color: #85858b; background: transparent; border-color: transparent; }
  #session-toggle svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.55; }
  #session-toggle:hover, #session-toggle:focus-visible, #session-toggle[aria-expanded="true"] { color: var(--ink); background: var(--raised); border-color: var(--edge); }
  #drawer-backdrop { position: fixed; inset: 48px 0 0; z-index: 19; background: #000b; opacity: 0; pointer-events: none; transition: opacity .18s ease; backdrop-filter: blur(2px); }
  #drawer-backdrop.open { opacity: 1; pointer-events: auto; }
  #session-drawer { position: fixed; inset: 48px auto 0 0; z-index: 20; width: min(340px, 88vw); height: calc(100dvh - 48px); color: var(--ink); background: #090909f7; border-right: 1px solid #1f1f1f; box-shadow: 24px 0 70px #000c; transform: translateX(-100%); visibility: hidden; transition: transform .2s cubic-bezier(.22, 1, .36, 1), visibility 0s linear .2s; backdrop-filter: blur(20px); }
  #session-drawer.open { transform: translateX(0); visibility: visible; transition-delay: 0s; }
  #session-list { height: 100%; overflow: auto; padding: 12px; }
  .drawer-empty { padding: 28px 12px; color: var(--muted); text-align: center; }
  .drawer-session { display: block; padding: 12px 13px; color: #d7d7da; border: 1px solid transparent; border-radius: 9px; text-decoration: none; transition: background .14s ease, border-color .14s ease, color .14s ease; }
  .drawer-session + .drawer-session { margin-top: 3px; }
  .drawer-session:hover, .drawer-session:focus-visible { color: #fff; background: var(--raised); border-color: #252525; outline: none; }
  .drawer-session.active { color: #fff; background: #151515; border-color: #303030; box-shadow: inset 2px 0 0 #e5e5e5; }
  .drawer-session strong { display: block; overflow: hidden; font-size: 13px; font-weight: 560; text-overflow: ellipsis; white-space: nowrap; }
  .drawer-session span { display: block; margin-top: 3px; color: #8b8b91; font-size: 11px; }
  #toast { position: fixed; right: 16px; bottom: 16px; z-index: 10; max-width: min(480px, calc(100vw - 32px)); padding: 10px 13px; color: var(--ink); background: #111e; border: 1px solid #292929; border-radius: 9px; box-shadow: 0 16px 50px #000c; opacity: 0; pointer-events: none; transform: translateY(8px); transition: .18s ease; backdrop-filter: blur(16px); }
  #toast.show { opacity: 1; transform: translateY(0); }
  #toast.error { border-color: var(--bad); }
  @media (max-width: 520px) { header h1 { font-size: 12px; } }
  @media (prefers-reduced-motion: reduce) { #drawer-backdrop, #session-drawer, #toast { transition: none; } }
</style>
</head>
<body>
<header>
  <button id="session-toggle" type="button" aria-label="Open sessions" title="Sessions" aria-controls="session-drawer" aria-expanded="false">
    <svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2.25" y="2.25" width="13.5" height="13.5" rx="2"></rect><path d="M6.25 2.5v13M9.25 6h3.5M9.25 9h3.5M9.25 12h2.25"></path></svg>
  </button>
  <h1>reindr</h1>
</header>
<main id="main"></main>
<div id="drawer-backdrop"></div>
<aside id="session-drawer" aria-hidden="true" aria-label="Sessions">
  <nav id="session-list" aria-label="OpenCode sessions"></nav>
</aside>
<div id="toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}">
(function () {
  var token = new URLSearchParams(location.search).get("token") || "";
  var match = location.pathname.match(/^\\/s\\/([^/]+)$/);
  var currentSession = match ? decodeURIComponent(match[1]) : null;
  var canvases = {};
  var sessions = [];
  var currentView = { container: null, iframe: null, frameURL: null, port: null, restoreState: null, pageScroll: null };
  var stateRequests = {};
  var stateRequestID = 0;
  var ws;
  var reconnectTimer;
  var toastTimer;
  var main = document.getElementById("main");
  var sessionToggle = document.getElementById("session-toggle");
  var sessionDrawer = document.getElementById("session-drawer");
  var drawerBackdrop = document.getElementById("drawer-backdrop");
  var sessionList = document.getElementById("session-list");
  var toast = document.getElementById("toast");

  function safeSend(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      notify("Panel is offline; the interaction was not sent.", true);
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  }

  function notify(message, error) {
    toast.textContent = message;
    toast.className = "show" + (error ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.className = ""; }, 4200);
  }

  function sessionTitle(id) {
    for (var i = 0; i < sessions.length; i++) if (sessions[i].id === id) return sessions[i].title;
    return id;
  }

  function orderedSessions() {
    return sessions.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  function isCurrentSession(session) {
    try {
      var target = new URL(session.url, location.href);
      return target.origin === location.origin && target.pathname === location.pathname;
    } catch (_) {
      return false;
    }
  }

  function renderDrawer() {
    sessionList.replaceChildren();
    var current = orderedSessions();
    if (!current.length) {
      var empty = document.createElement("div");
      empty.className = "drawer-empty";
      empty.textContent = "No sessions have generated content yet.";
      sessionList.appendChild(empty);
      return;
    }
    current.forEach(function (session) {
      var active = isCurrentSession(session);
      var link = document.createElement("a");
      link.className = "drawer-session" + (active ? " active" : "");
      link.href = session.url;
      if (active) link.setAttribute("aria-current", "page");
      var title = document.createElement("strong");
      title.textContent = session.title;
      var meta = document.createElement("span");
      meta.textContent = session.id;
      link.append(title, meta);
      sessionList.appendChild(link);
    });
  }

  function setDrawer(open) {
    sessionDrawer.classList.toggle("open", open);
    drawerBackdrop.classList.toggle("open", open);
    sessionDrawer.setAttribute("aria-hidden", String(!open));
    sessionToggle.setAttribute("aria-expanded", String(open));
    sessionToggle.setAttribute("aria-label", open ? "Close sessions" : "Open sessions");
    document.body.classList.toggle("drawer-open", open);
    var firstSession = sessionList.querySelector("a");
    if (open && firstSession) firstSession.focus();
    else if (!open) sessionToggle.focus();
  }

  function renderIndex() {
    main.replaceChildren();
    var current = orderedSessions();
    renderDrawer();
    if (current.length) {
      location.replace(current[0].url);
      return;
    }
    var empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Waiting for a session UI file.";
    main.appendChild(empty);
  }

  function handleFrameMessage(data) {
    if (!data || !currentView.iframe) return;
    if (data.kind === "resize") {
      currentView.iframe.style.height = Math.min(Math.max(Number(data.px) || 240, 120), 5000) + "px";
    } else if (data.kind === "viewport") {
      currentView.iframe.style.height = "120px";
    } else if (data.kind === "ready") {
      if (data.viewport) currentView.iframe.style.height = "120px";
      if (currentView.restoreState && currentView.port) {
        currentView.port.postMessage({ __ocwParent: 1, kind: "restore-state", state: currentView.restoreState });
        currentView.restoreState = null;
      }
      if (currentView.pageScroll) {
        var savedScroll = currentView.pageScroll;
        currentView.pageScroll = null;
        var restorePageScroll = function () { scrollTo(Number(savedScroll.x) || 0, Number(savedScroll.y) || 0); };
        requestAnimationFrame(function () { restorePageScroll(); requestAnimationFrame(restorePageScroll); });
        setTimeout(restorePageScroll, 100);
      }
    } else if (data.kind === "state") {
      if (stateRequests[data.requestID]) stateRequests[data.requestID](data.state);
    } else if (data.kind === "error") {
      notify(String(data.message || "UI interaction was blocked."), true);
    } else if (data.kind === "controller") {
      var requestID = String(data.id || "");
      var action = String(data.action || "");
      if (!requestID || requestID.length > 100 || ["snapshot", "prompt", "command", "abort"].indexOf(action) < 0) return;
      safeSend({ type: "controller", id: requestID, action: action, payload: data.payload });
    } else if (data.kind === "submit") {
      var prompt = String(data.prompt || "");
      if (!prompt || new TextEncoder().encode(prompt).length > 64000) {
        notify("UI prompt must be between 1 byte and 64 KB.", true);
        return;
      }
      try {
        var message = { type: "submit", prompt: prompt };
        if (Object.prototype.hasOwnProperty.call(data, "data")) {
          var encoded = JSON.stringify(data.data);
          if (encoded === undefined || new TextEncoder().encode(encoded).length > 64000) throw new Error("invalid data");
          message.data = data.data;
        }
        safeSend(message);
      } catch (_) {
        notify("UI data must be JSON-serializable and smaller than 64 KB.", true);
      }
    }
  }

  function mountFrame(canvas, state, pageScroll) {
    if (currentView.port) currentView.port.close();
    main.replaceChildren();
    var view = document.createElement("section");
    view.className = "agent-view";
    view.setAttribute("aria-label", sessionTitle(canvas.sessionID));
    var iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts allow-forms");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("title", sessionTitle(canvas.sessionID));
    currentView = { container: view, iframe: iframe, frameURL: canvas.frameURL, port: null, restoreState: state, pageScroll: pageScroll || null };
    iframe.src = canvas.frameURL;
    view.appendChild(iframe);
    main.appendChild(view);
  }

  function captureViewState(callback) {
    if (!currentView.port) { callback(null); return; }
    var id = String(++stateRequestID);
    var settled = false;
    stateRequests[id] = function (state) {
      if (settled) return;
      settled = true;
      delete stateRequests[id];
      callback(state);
    };
    currentView.port.postMessage({ __ocwParent: 1, kind: "capture-state", requestID: id });
    setTimeout(function () { if (stateRequests[id]) stateRequests[id](null); }, 250);
  }

  function renderSession(preserveState) {
    renderDrawer();
    var canvas = canvases[currentSession];
    if (!canvas) {
      if (currentView.port) currentView.port.close();
      main.replaceChildren();
      currentView = { container: null, iframe: null, frameURL: null, port: null, restoreState: null, pageScroll: null };
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Waiting for this session's UI file.";
      main.appendChild(empty);
      return;
    }
    if (currentView.iframe && currentView.frameURL === canvas.frameURL) return;
    if (canvas.restored && !currentView.iframe) {
      main.replaceChildren();
      var dormant = document.createElement("div");
      dormant.className = "dormant";
      var content = document.createElement("div");
      var text = document.createElement("p");
      text.textContent = "This UI file was restored from disk. Its saved JavaScript will run only after you activate it.";
      var button = document.createElement("button");
      button.textContent = "Activate saved content";
      button.addEventListener("click", function () { mountFrame(canvas, null, null); });
      content.append(text, button);
      dormant.appendChild(content);
      main.appendChild(dormant);
      return;
    }
    if (preserveState && currentView.iframe) {
      var pageScroll = { x: scrollX, y: scrollY };
      captureViewState(function (state) { mountFrame(canvas, state, pageScroll); });
    } else mountFrame(canvas, null, null);
  }

  function render() {
    if (currentSession) renderSession(false);
    else renderIndex();
  }

  sessionToggle.addEventListener("click", function () { setDrawer(sessionToggle.getAttribute("aria-expanded") !== "true"); });
  drawerBackdrop.addEventListener("click", function () { setDrawer(false); });
  addEventListener("keydown", function (event) { if (event.key === "Escape" && sessionDrawer.classList.contains("open")) setDrawer(false); });
  addEventListener("message", function (event) {
    if (!event.data || event.data.__ocwConnect !== 1 || !event.ports[0]) return;
    if (!currentView.iframe || currentView.iframe.contentWindow !== event.source || currentView.port) return;
    currentView.port = event.ports[0];
    currentView.port.onmessage = function (message) { handleFrameMessage(message.data); };
    currentView.port.start();
  });

  function connect() {
    clearTimeout(reconnectTimer);
    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    var url = protocol + "//" + location.host + "/ws?token=" + encodeURIComponent(token);
    if (currentSession) url += "&session=" + encodeURIComponent(currentSession);
    ws = new WebSocket(url);
    ws.onclose = function () { reconnectTimer = setTimeout(connect, 1500); };
    ws.onmessage = function (event) {
      var message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === "init") {
        canvases = {};
        message.canvases.forEach(function (canvas) { canvases[canvas.sessionID] = canvas; });
        sessions = message.sessions;
        render();
      } else if (message.type === "sessions") {
        sessions = message.sessions;
        if (currentSession) renderDrawer();
        else renderIndex();
      } else if (message.type === "session-canvas") {
        if (message.canvas) canvases[message.sessionID] = message.canvas;
        else delete canvases[message.sessionID];
        if (message.sessionID === currentSession) renderSession(true);
        else renderDrawer();
      } else if (message.type === "session-remove") {
        delete canvases[message.sessionID];
        if (message.sessionID === currentSession) renderSession(false);
        else renderDrawer();
      } else if (message.type === "submission-status") {
        notify(message.message, message.status === "failed");
      } else if (message.type === "controller-result") {
        if (currentView.port) currentView.port.postMessage({ __ocwParent: 1, kind: "controller-result", id: message.id, ok: message.ok, value: message.value, error: message.error });
      } else if (message.type === "notice") {
        notify(message.message, message.level === "error");
      }
    };
  }

  connect();
})();
</script>
</body>
</html>`
}

const ReindrPlugin: Plugin = async ({ client, worktree }, options) => {
  const config = readConfig(worktree, options)
  const authToken = randomToken()
  const shellNonce = randomToken(18)
  const instanceID = `${process.pid}-${randomToken(9)}`
  const loadingTemplateFile = path.join(config.templateDirectory, "reindr-loading.html")
  const controllerTemplateFile = path.join(config.templateDirectory, "opencode-controller.html")
  const registryDirectory = path.join(config.canvasDirectory, ".panels")
  const registryFile = path.join(registryDirectory, `${instanceID}.json`)
  const browserLockFile = path.join(registryDirectory, ".browser-lock")
  const canvases = new Map<string, Canvas>()
  const knownSessions = new Set<string>()
  const sessionAgents = new Map<string, string>()
  const sessionFrameTokens = new Map<string, string>()
  const sessionTitles = new Map<string, string>()
  const peerPanels = new Map<string, PanelRegistry>()
  const sockets = new Set<PanelSocket>()
  const submissionQueues = new Map<string, Submission[]>()
  const sessionStatus = new Map<string, "idle" | "busy" | "unknown">()
  const flushingSessions = new Set<string>()
  const refreshGenerations = new Map<string, number>()
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()

  let panelServer: PanelServer | null = null
  let panelOrigin: string | null = null
  let serveError: string | null = null
  let openedBrowser = false
  let ownsBrowserLock = false
  let disposed = false
  let sharedStyles = ""
  let canvasWatcher: FSWatcher | null = null
  let registryWatcher: FSWatcher | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let registryRefreshTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let registryWrite = Promise.resolve()
  let sessionsSignature = ""
  let controllerCatalogCache: { expiresAt: number; agents: any[]; providers: any[]; commands: any[] } | null = null

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: "reindr", level, message, extra } }).catch(() => {})

  const canvasFile = (sessionID: string) => path.join(config.canvasDirectory, canvasFileName(sessionID))

  const sessionFrameKey = (sessionID: string) =>
    createHash("sha256").update("session-frame\0").update(sessionID).digest("base64url").slice(0, 24)

  const sessionFrameToken = (sessionID: string) => {
    const existing = sessionFrameTokens.get(sessionID)
    if (existing) return existing
    const token = randomToken()
    sessionFrameTokens.set(sessionID, token)
    return token
  }

  const canvasForClient = (canvas: Canvas): ClientCanvas => ({
    sessionID: canvas.sessionID,
    sessionTitle: canvas.sessionTitle,
    agent: canvas.agent,
    createdAt: canvas.createdAt,
    updatedAt: canvas.updatedAt,
    restored: canvas.restored,
    frameURL: `${panelOrigin}/frame/${sessionFrameKey(canvas.sessionID)}?token=${encodeURIComponent(sessionFrameToken(canvas.sessionID))}&v=${createHash("sha256").update(canvas.html).digest("base64url").slice(0, 16)}`,
  })

  const send = (socket: PanelSocket, message: ServerMessage) => {
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      sockets.delete(socket)
      return false
    }
  }

  const broadcastToSession = (sessionID: string, message: ServerMessage) => {
    for (const socket of sockets) send(socket, message)
  }

  const broadcastCanvas = (sessionID: string) => {
    const canvas = canvases.get(sessionID)
    broadcastToSession(sessionID, { type: "session-canvas", sessionID, canvas: canvas ? canvasForClient(canvas) : null })
  }

  const broadcastSubmissionStatus = (submission: Submission, status: "queued" | "sent" | "failed", message: string) => {
    for (const socket of sockets) {
      if (socket.data.sessionID === submission.sessionID) send(socket, { type: "submission-status", id: submission.id, status, message })
    }
  }

  const resolveSessionTitle = async (sessionID: string) => {
    const existing = sessionTitles.get(sessionID)
    if (existing) return existing
    try {
      const session = sdkData<{ title?: string }>(await client.session.get({ path: { id: sessionID } }))
      const title = session?.title?.trim() || sessionID
      sessionTitles.set(sessionID, title)
      return title
    } catch {
      sessionTitles.set(sessionID, sessionID)
      return sessionID
    }
  }

  const sessionURL = (sessionID: string) => {
    if (!panelOrigin) return null
    return `${panelOrigin}${sessionPath(sessionID)}?token=${encodeURIComponent(authToken)}`
  }

  const openBrowser = async (url: string) => {
    if (openedBrowser || !config.autoOpen || !await claimBrowserOwnership()) return
    openedBrowser = true
    try {
      let command: string
      let args: string[]
      if (config.browserCommand) {
        const quotedURL = process.platform === "win32" ? `"${url.replaceAll('"', '\\"')}"` : `'${url.replaceAll("'", "'\\''")}'`
        command = config.browserCommand.includes("{url}")
          ? config.browserCommand.replaceAll("{url}", quotedURL)
          : `${config.browserCommand} ${quotedURL}`
        const child = spawn(command, { detached: true, shell: true, stdio: "ignore" })
        child.on("error", (error) => {
          openedBrowser = false
          void releaseBrowserOwnership()
          log("warn", "custom browser command failed", { error: String(error), url })
        })
        child.unref()
        return
      }
      if (process.platform === "darwin") {
        command = "open"
        args = [url]
      } else if (process.platform === "win32") {
        command = "cmd"
        args = ["/c", "start", "", url]
      } else {
        command = "xdg-open"
        args = [url]
      }
      const child = spawn(command, args, { detached: true, stdio: "ignore" })
      child.on("error", (error) => {
        openedBrowser = false
        void releaseBrowserOwnership()
        log("warn", "browser command failed", { error: String(error), url })
      })
      child.unref()
    } catch (error) {
      openedBrowser = false
      void releaseBrowserOwnership()
      log("warn", "could not open the UI panel browser", { error: String(error), url })
    }
  }

  const migrateKnownBuiltInTemplate = async (file: string) => {
    let handle
    try {
      handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_CANVAS_HTML_BYTES) return false
      const existing = await handle.readFile("utf8")
      const digest = createHash("sha256").update(existing).digest("hex")
      const replacementText = LEGACY_CONTROLLER_HASHES.has(digest)
        ? DEFAULT_CONTROLLER_TEMPLATE
        : LEGACY_LOADING_HASHES.has(digest)
          ? DEFAULT_LOADING_TEMPLATE
          : null
      if (!replacementText) return false
      const replacement = Buffer.from(replacementText, "utf8")
      let offset = 0
      while (offset < replacement.length) {
        const { bytesWritten } = await handle.write(replacement, offset, replacement.length - offset, offset)
        if (!bytesWritten) throw new Error("could not write migrated controller")
        offset += bytesWritten
      }
      await handle.truncate(replacement.length)
      await handle.sync()
      log("info", "migrated known built-in template", { file })
      return true
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null
      if (code !== "ENOENT") log("warn", "could not migrate known built-in template", { file, error: String(error) })
      return false
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  const refreshCanvas = async (sessionID: string, restored: boolean) => {
    if (disposed) return false
    const generation = (refreshGenerations.get(sessionID) ?? 0) + 1
    refreshGenerations.set(sessionID, generation)
    const isCurrent = () => !disposed && knownSessions.has(sessionID) && refreshGenerations.get(sessionID) === generation
    const file = canvasFile(sessionID)
    await migrateKnownBuiltInTemplate(file)
    try {
      if (await realpath(config.canvasDirectory) !== realCanvasDirectory) throw new Error("UI directory changed after plugin startup")
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let html: string
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw new Error("UI path must be a regular file")
        if (info.size > MAX_CANVAS_HTML_BYTES) throw new Error(`UI file exceeds ${MAX_CANVAS_HTML_BYTES} bytes`)
        html = await handle.readFile("utf8")
      } finally {
        await handle.close()
      }
      if (Buffer.byteLength(html, "utf8") > MAX_CANVAS_HTML_BYTES) throw new Error(`UI file exceeds ${MAX_CANVAS_HTML_BYTES} bytes`)
      if (!html.trim()) throw Object.assign(new Error("empty UI file"), { code: "ENOENT" })
      if (!isCurrent()) return false
      const existing = canvases.get(sessionID)
      if (existing?.html === html) {
        existing.agent = sessionAgents.get(sessionID) ?? existing.agent
        existing.sessionTitle = sessionTitles.get(sessionID) ?? existing.sessionTitle
        return false
      }
      const now = Date.now()
      const sessionTitle = await resolveSessionTitle(sessionID)
      if (!isCurrent()) return false
      const canvas: Canvas = {
        sessionID,
        sessionTitle,
        agent: sessionAgents.get(sessionID) ?? existing?.agent,
        html,
        file,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        restored,
      }
      canvases.set(sessionID, canvas)
      broadcastCanvas(sessionID)
      broadcastSessions()
      await writeRegistry()
      if (!restored) {
        await loadRegistry()
        const url = sessionURL(sessionID)
        if (url) await openBrowser(url)
      }
      return true
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null
      if (!isCurrent()) return false
      if (code === "ENOENT") {
        if (canvases.delete(sessionID)) {
          broadcastCanvas(sessionID)
          broadcastSessions()
          await writeRegistry()
        }
      } else {
        log("warn", "failed to load session UI file", { sessionID, file, error: String(error) })
        for (const socket of sockets) {
          if (socket.data.sessionID === sessionID) send(socket, { type: "notice", level: "error", message: String(error) })
        }
      }
      return false
    }
  }

  const registerSession = async (sessionID: string, restored: boolean) => {
    const firstRegistration = !knownSessions.has(sessionID)
    knownSessions.add(sessionID)
    if (firstRegistration) await refreshCanvas(sessionID, restored)
  }

  const ensureTemplate = async (file: string, content: string) => {
    let created = false
    try {
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      try {
        await handle.writeFile(content, "utf8")
      } finally {
        await handle.close()
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null
      if (created) await rm(file, { force: true }).catch(() => {})
      if (code !== "EEXIST") throw error
    }
  }

  const savedTemplateFile = (name: string) => {
    if (!name || path.basename(name) !== name || !name.toLowerCase().endsWith(".html")) throw new Error("Template must be an HTML filename from the Reindr templates directory.")
    return path.join(config.templateDirectory, name)
  }

  const readSavedTemplate = async (name: string) => {
    const file = savedTemplateFile(name)
    try {
      if (await realpath(config.templateDirectory) !== realTemplateDirectory) throw new Error("Template directory changed after plugin startup")
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = await handle.stat()
        if (!info.isFile()) throw new Error("Template must be a regular file")
        if (info.size > MAX_TEMPLATE_BYTES) throw new Error(`template exceeds ${MAX_TEMPLATE_BYTES} bytes`)
        const template = await handle.readFile("utf8")
        if (!template.trim()) throw new Error("Template cannot be empty")
        return template
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (name === "reindr-loading.html") {
        log("warn", "failed to load saved loading template; using the built-in default", { file, error: String(error) })
        return DEFAULT_LOADING_TEMPLATE
      }
      throw error
    }
  }

  const listTemplates = async () => {
    try {
      if (await realpath(config.templateDirectory) !== realTemplateDirectory) throw new Error("Template directory changed after plugin startup")
      return (await readdir(config.templateDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".html"))
        .map((entry) => entry.name)
        .toSorted((a, b) => a.localeCompare(b))
    } catch (error) {
      log("warn", "failed to list saved templates", { directory: config.templateDirectory, error: String(error) })
      return []
    }
  }

  const openSessionUI = async (sessionID: string, agent?: string, templateName = "opencode-controller.html") => {
    if (agent) sessionAgents.set(sessionID, agent)
    await registerSession(sessionID, false)
    const file = canvasFile(sessionID)
    let created = false
    try {
      if (await realpath(config.canvasDirectory) !== realCanvasDirectory) throw new Error("UI directory changed after plugin startup")
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      try {
        const [template, title] = await Promise.all([readSavedTemplate(templateName), resolveSessionTitle(sessionID)])
        await handle.writeFile(renderLoadingTemplate(template, title), "utf8")
      } catch (error) {
        await rm(file, { force: true }).catch(() => {})
        throw error
      } finally {
        await handle.close()
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null
      if (code !== "EEXIST") throw error
    }
    await refreshCanvas(sessionID, false)
    const url = sessionURL(sessionID)
    if (url) await openBrowser(url)
    return { created, file, url, template: templateName }
  }

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      for (const sessionID of knownSessions) void refreshCanvas(sessionID, false)
    }, 50)
  }

  const loadSharedStyles = async () => {
    const styles: string[] = []
    try {
      const info = await stat(BUILT_IN_TAILWIND_STYLESHEET)
      if (info.size > MAX_STYLESHEET_BYTES) throw new Error(`built-in Tailwind stylesheet exceeds ${MAX_STYLESHEET_BYTES} bytes`)
      styles.push(await readFile(BUILT_IN_TAILWIND_STYLESHEET, "utf8"))
    } catch (error) {
      log("warn", "failed to load built-in Tailwind stylesheet", { error: String(error) })
    }
    if (config.stylesheetPath) {
      const file = resolveFile(worktree, config.stylesheetPath)
      try {
        const info = await stat(file)
        if (info.size > MAX_STYLESHEET_BYTES) throw new Error(`stylesheet exceeds ${MAX_STYLESHEET_BYTES} bytes`)
        styles.push(await readFile(file, "utf8"))
        log("info", "loaded shared UI stylesheet", { file })
      } catch (error) {
        log("warn", "failed to load shared UI stylesheet", { file, error: String(error) })
      }
    }
    sharedStyles = styles.join("\n")
  }

  await Promise.all([
    mkdir(config.canvasDirectory, { recursive: true }),
    mkdir(config.templateDirectory, { recursive: true, mode: 0o700 }),
  ])
  await Promise.all([
    ensureTemplate(loadingTemplateFile, DEFAULT_LOADING_TEMPLATE),
    ensureTemplate(controllerTemplateFile, DEFAULT_CONTROLLER_TEMPLATE),
  ])
  await Promise.all([
    migrateKnownBuiltInTemplate(loadingTemplateFile),
    migrateKnownBuiltInTemplate(controllerTemplateFile),
  ])
  const [realCanvasDirectory, realTemplateDirectory] = await Promise.all([
    realpath(config.canvasDirectory),
    realpath(config.templateDirectory),
  ])
  await mkdir(registryDirectory, { recursive: true, mode: 0o700 })
  const realRegistryDirectory = await realpath(registryDirectory)
  const registryRelative = path.relative(realCanvasDirectory, realRegistryDirectory)
  if (registryRelative === ".." || registryRelative.startsWith(`..${path.sep}`) || path.isAbsolute(registryRelative)) {
    throw new Error(`Panel registry resolves outside the UI directory: ${realRegistryDirectory}`)
  }

  const assertRegistryDirectory = async () => {
    if (await realpath(registryDirectory) !== realRegistryDirectory) throw new Error("Panel registry directory changed after plugin startup")
  }

  const localSessionSummaries = (): SessionSummary[] =>
    [...canvases.values()].map((canvas) => ({
      key: `${instanceID}:${canvas.sessionID}`,
      id: canvas.sessionID,
      title: sessionTitles.get(canvas.sessionID) ?? canvas.sessionTitle,
      url: sessionURL(canvas.sessionID) ?? "",
      updatedAt: canvas.updatedAt,
    })).filter((session) => session.url)

  const sessionsForClient = () => {
    const sessions = localSessionSummaries()
    for (const panel of peerPanels.values()) sessions.push(...panel.sessions)
    return sessions.toSorted((a, b) => b.updatedAt - a.updatedAt)
  }

  const broadcastSessions = () => {
    const sessions = sessionsForClient()
    const signature = JSON.stringify(sessions)
    if (signature === sessionsSignature) return
    sessionsSignature = signature
    for (const socket of sockets) send(socket, { type: "sessions", sessions })
  }

  const writeRegistry = () => {
    registryWrite = registryWrite.catch(() => {}).then(async () => {
      if (disposed || !panelOrigin) return
      await assertRegistryDirectory()
      const record: PanelRegistry = {
        version: 1,
        instanceID,
        pid: process.pid,
        updatedAt: Date.now(),
        sessions: localSessionSummaries(),
      }
      const temporary = `${registryFile}.${randomToken(6)}.tmp`
      await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 })
      await rename(temporary, registryFile)
      await chmod(registryFile, 0o600).catch(() => {})
    }).catch((error) => { log("warn", "failed to update panel registry", { error: String(error) }) })
    return registryWrite
  }

  const loadRegistry = async () => {
    const next = new Map<string, PanelRegistry>()
    try {
      await assertRegistryDirectory()
      const entries = await readdir(registryDirectory, { withFileTypes: true })
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".json")) return
        const file = path.join(registryDirectory, entry.name)
        try {
          const info = await stat(file)
          if (info.size > 1_000_000) throw new Error("registry record is too large")
          const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PanelRegistry>
          if (
            parsed.version !== 1 ||
            typeof parsed.instanceID !== "string" ||
            !Number.isInteger(parsed.pid) ||
            typeof parsed.updatedAt !== "number" ||
            !Array.isArray(parsed.sessions)
          ) throw new Error("invalid registry record")
          if (Date.now() - parsed.updatedAt > REGISTRY_STALE_MS) {
            if (parsed.instanceID !== instanceID) await rm(file, { force: true }).catch(() => {})
            return
          }
          if (parsed.instanceID === instanceID) return
          const sessions: SessionSummary[] = []
          for (const item of parsed.sessions) {
            if (!item || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.url !== "string" || typeof item.updatedAt !== "number") continue
            try {
              const url = new URL(item.url)
              if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== sessionPath(item.id)) continue
              sessions.push({
                key: `${parsed.instanceID}:${item.id}`,
                id: item.id,
                title: item.title.slice(0, 200),
                url: url.href,
                updatedAt: item.updatedAt,
              })
            } catch {}
          }
          next.set(parsed.instanceID, { ...parsed, version: 1, sessions } as PanelRegistry)
        } catch (error) {
          log("debug", "ignored invalid panel registry record", { file, error: String(error) })
        }
      }))
    } catch (error) {
      log("warn", "failed to read panel registry", { error: String(error) })
    }
    peerPanels.clear()
    for (const [id, panel] of next) peerPanels.set(id, panel)
    broadcastSessions()
  }

  const registryOwnerIsLive = async (owner: string) => {
    if (owner === instanceID || peerPanels.has(owner)) return true
    if (!/^[a-zA-Z0-9_-]+$/.test(owner)) return false
    try {
      await assertRegistryDirectory()
      const file = path.join(registryDirectory, `${owner}.json`)
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > 1_000_000) return false
        const record = JSON.parse(await handle.readFile("utf8")) as Partial<PanelRegistry>
        return record.instanceID === owner && typeof record.updatedAt === "number" && Date.now() - record.updatedAt <= REGISTRY_STALE_MS
      } finally {
        await handle.close()
      }
    } catch {
      return false
    }
  }

  const claimBrowserOwnership = async () => {
    if (ownsBrowserLock) return true
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assertRegistryDirectory()
      try {
        const handle = await open(browserLockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
        try {
          await handle.writeFile(JSON.stringify({ instanceID, claimedAt: Date.now() }))
        } finally {
          await handle.close()
        }
        ownsBrowserLock = true
        return true
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null
        if (code !== "EEXIST") throw error
      }
      let owner = ""
      try {
        const handle = await open(browserLockFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.size > 10_000) throw new Error("invalid browser lock")
          const parsed = JSON.parse(await handle.readFile("utf8")) as { instanceID?: unknown }
          if (typeof parsed.instanceID === "string") owner = parsed.instanceID
        } finally {
          await handle.close()
        }
      } catch {}
      if (owner && await registryOwnerIsLive(owner)) return owner === instanceID
      await assertRegistryDirectory()
      await rm(browserLockFile, { force: true }).catch(() => {})
    }
    return false
  }

  const releaseBrowserOwnership = async () => {
    if (!ownsBrowserLock) return
    ownsBrowserLock = false
    try {
      await assertRegistryDirectory()
      const parsed = JSON.parse(await readFile(browserLockFile, "utf8")) as { instanceID?: unknown }
      if (parsed.instanceID === instanceID) await rm(browserLockFile, { force: true })
    } catch {}
  }

  const scheduleRegistryRefresh = () => {
    if (registryRefreshTimer) clearTimeout(registryRefreshTimer)
    registryRefreshTimer = setTimeout(() => {
      registryRefreshTimer = null
      void loadRegistry()
    }, 50)
  }

  await loadSharedStyles()
  try {
    canvasWatcher = watch(config.canvasDirectory, scheduleRefresh)
    canvasWatcher.on("error", (error) => log("warn", "UI file watcher failed", { error: String(error) }))
  } catch (error) {
    log("warn", "could not watch UI directory", { directory: config.canvasDirectory, error: String(error) })
  }
  try {
    registryWatcher = watch(registryDirectory, scheduleRegistryRefresh)
    registryWatcher.on("error", (error) => log("warn", "panel registry watcher failed", { error: String(error) }))
  } catch (error) {
    log("warn", "could not watch panel registry", { directory: registryDirectory, error: String(error) })
  }

  const promptText = (text: string, data: unknown, hasData: boolean) => {
    const sections = [text.trim()]
    if (hasData) sections.push(`UI data:\n${JSON.stringify(data, null, 2)}`)
    return sections.join("\n\n")
  }

  const refreshSessionStatus = async (sessionID: string) => {
    try {
      const response = await client.session.status()
      const statuses = sdkData<Record<string, { type?: string }>>(response)
      const status = statuses?.[sessionID]?.type
      const normalized = status === "idle" ? "idle" : status ? "busy" : "unknown"
      sessionStatus.set(sessionID, normalized)
      return normalized
    } catch (error) {
      log("warn", "could not read session status", { sessionID, error: String(error) })
      return sessionStatus.get(sessionID) ?? "unknown"
    }
  }

  const controllerCatalog = async () => {
    if (controllerCatalogCache && controllerCatalogCache.expiresAt > Date.now()) return controllerCatalogCache
    const safe = async <T>(request: Promise<unknown>, fallback: T): Promise<T> => {
      try { return sdkData<T>(await request) } catch { return fallback }
    }
    const [agentData, providerData, commandData] = await Promise.all([
      safe<any[]>(client.app.agents(), []),
      safe<any>(client.provider.list(), { all: [], connected: [], default: {} }),
      safe<any[]>(client.command.list(), []),
    ])
    const connected = new Set(Array.isArray(providerData?.connected) ? providerData.connected : [])
    const providers = (Array.isArray(providerData?.all) ? providerData.all : []).map((provider: any) => ({
      id: limitedText(provider?.id, 200),
      name: limitedText(provider?.name, 300),
      connected: connected.has(provider?.id),
      defaultModel: limitedText(providerData?.default?.[provider?.id], 300),
      models: Object.values(recordValue(provider?.models) ?? {}).map((model: any) => ({
        id: limitedText(model?.id, 300),
        name: limitedText(model?.name, 300),
        reasoning: Boolean(model?.reasoning),
        attachment: Boolean(model?.attachment),
        toolCall: Boolean(model?.tool_call),
        status: limitedText(model?.status ?? "active", 40),
        limit: model?.limit,
      })).filter((model: any) => model.id),
    })).filter((provider: any) => provider.id)
    const agents = agentData.map((agent: any) => ({
      name: limitedText(agent?.name, 200),
      description: limitedText(agent?.description, 1_000),
      mode: limitedText(agent?.mode, 40),
      color: limitedText(agent?.color, 40),
      model: agent?.model ? {
        providerID: limitedText(agent.model.providerID, 200),
        modelID: limitedText(agent.model.modelID, 300),
      } : null,
    })).filter((agent: any) => agent.name)
    const commands = commandData.map((command: any) => ({
      name: limitedText(command?.name, 200),
      description: limitedText(command?.description, 1_000),
      agent: limitedText(command?.agent, 200),
      model: limitedText(command?.model, 500),
      subtask: Boolean(command?.subtask),
    })).filter((command: any) => command.name)
    controllerCatalogCache = { expiresAt: Date.now() + 30_000, agents, providers, commands }
    return controllerCatalogCache
  }

  const controllerSnapshot = async (sessionID: string) => {
    const safe = async <T>(request: Promise<unknown>, fallback: T): Promise<T> => {
      try { return sdkData<T>(await request) } catch { return fallback }
    }
    const [session, messages, children, statuses, catalog] = await Promise.all([
      safe<any>(client.session.get({ path: { id: sessionID } }), { id: sessionID, title: sessionID }),
      safe<any[]>(client.session.messages({ path: { id: sessionID }, query: { limit: 100 } }), []),
      safe<any[]>(client.session.children({ path: { id: sessionID } }), []),
      safe<Record<string, any>>(client.session.status(), {}),
      controllerCatalog(),
    ])
    const normalizedMessages = messages.map(controllerMessage)
    const lastUser = [...normalizedMessages].reverse().find((message) => message.role === "user")
    return {
      generatedAt: Date.now(),
      session: {
        id: limitedText(session?.id ?? sessionID, 200),
        title: limitedText(session?.title ?? sessionID, 500),
        directory: limitedText(session?.directory, 2_000),
        parentID: limitedText(session?.parentID, 200),
        time: session?.time,
      },
      status: statuses?.[sessionID] ?? sessionStatus.get(sessionID) ?? { type: "unknown" },
      selection: {
        agent: sessionAgents.get(sessionID) ?? lastUser?.agent ?? "",
        model: lastUser?.model ?? { providerID: "", modelID: "" },
      },
      agents: catalog.agents,
      providers: catalog.providers,
      commands: catalog.commands,
      children: children.map((child: any) => ({
        id: limitedText(child?.id, 200),
        title: limitedText(child?.title ?? child?.id, 500),
        parentID: limitedText(child?.parentID, 200),
        time: child?.time,
        status: statuses?.[child?.id] ?? { type: "idle" },
      })),
      messages: normalizedMessages,
    }
  }

  const controllerPayload = (value: unknown) => recordValue(value) ?? {}

  const controllerModel = (payload: Record<string, any>) => {
    const providerID = limitedText(payload.providerID, 200).trim()
    const modelID = limitedText(payload.modelID, 300).trim()
    return providerID && modelID ? { providerID, modelID } : undefined
  }

  const handleController = async (sessionID: string, action: "snapshot" | "prompt" | "command" | "abort", payloadValue: unknown) => {
    const payload = controllerPayload(payloadValue)
    if (action === "snapshot") return controllerSnapshot(sessionID)
    if (action === "prompt") {
      const prompt = limitedText(payload.prompt, MAX_DATA_BYTES).trim()
      if (!prompt || Buffer.byteLength(prompt, "utf8") > MAX_DATA_BYTES) throw new Error("Prompt must be between 1 byte and 64 KB.")
      const queuedCount = [...submissionQueues.values()].reduce((total, queue) => total + queue.length, 0)
      if (queuedCount >= MAX_PENDING_SUBMISSIONS) throw new Error("Too many interactions are waiting for an agent session.")
      const agent = limitedText(payload.agent, 200).trim() || undefined
      const submission: Submission = { id: randomToken(18), sessionID, agent, model: controllerModel(payload), prompt }
      const queue = submissionQueues.get(sessionID) ?? []
      queue.push(submission)
      submissionQueues.set(sessionID, queue)
      if (agent) sessionAgents.set(sessionID, agent)
      void flushSession(sessionID)
      return { accepted: true, id: submission.id }
    }
    if (action === "command") {
      const command = limitedText(payload.command, 200).trim()
      const argumentsText = limitedText(payload.arguments, MAX_DATA_BYTES)
      const catalog = await controllerCatalog()
      if (!command || !catalog.commands.some((item) => item.name === command)) throw new Error("Unknown OpenCode command.")
      const agent = limitedText(payload.agent, 200).trim() || undefined
      const model = controllerModel(payload)
      if (agent) sessionAgents.set(sessionID, agent)
      void client.session.command({
        path: { id: sessionID },
        body: {
          command,
          arguments: argumentsText,
          ...(agent ? { agent } : {}),
          ...(model ? { model: `${model.providerID}/${model.modelID}` } : {}),
        },
      }).catch((error) => log("error", "controller command failed", { sessionID, command, error: String(error) }))
      return { accepted: true }
    }
    if (action === "abort") {
      const aborted = sdkData<boolean>(await client.session.abort({ path: { id: sessionID } }))
      sessionStatus.set(sessionID, "unknown")
      return { aborted }
    }
    throw new Error("Unsupported controller action.")
  }

  const flushSession = async (sessionID: string) => {
    if (disposed || flushingSessions.has(sessionID)) return
    const queue = submissionQueues.get(sessionID)
    if (!queue?.length) return
    const cachedStatus = sessionStatus.get(sessionID)
    const status = !cachedStatus || cachedStatus === "unknown" ? await refreshSessionStatus(sessionID) : cachedStatus
    if (status !== "idle") return
    const submission = queue.shift()
    if (!submission) return
    if (!queue.length) submissionQueues.delete(sessionID)
    flushingSessions.add(sessionID)
    sessionStatus.set(sessionID, "busy")
    try {
      const response = await client.session.promptAsync({
        path: { id: submission.sessionID },
        body: {
          ...(submission.agent ? { agent: submission.agent } : {}),
          ...(submission.model ? { model: submission.model } : {}),
          parts: [{ type: "text", text: submission.prompt }],
        },
      })
      sdkData(response)
      broadcastSubmissionStatus(submission, "sent", "UI interaction was sent to the agent.")
    } catch (error) {
      sessionStatus.set(sessionID, "unknown")
      broadcastSubmissionStatus(submission, "failed", `UI interaction failed: ${String(error)}`)
      log("error", "failed to submit a UI interaction", { sessionID, error: String(error) })
    } finally {
      flushingSessions.delete(sessionID)
      if (submissionQueues.get(sessionID)?.length && sessionStatus.get(sessionID) === "unknown") {
        const timer = setTimeout(() => {
          retryTimers.delete(timer)
          void flushSession(sessionID)
        }, 500)
        retryTimers.add(timer)
      }
    }
  }

  const removeSession = async (sessionID: string) => {
    refreshGenerations.set(sessionID, (refreshGenerations.get(sessionID) ?? 0) + 1)
    knownSessions.delete(sessionID)
    canvases.delete(sessionID)
    submissionQueues.delete(sessionID)
    sessionStatus.delete(sessionID)
    sessionAgents.delete(sessionID)
    sessionTitles.delete(sessionID)
    sessionFrameTokens.delete(sessionID)
    try {
      if (await realpath(config.canvasDirectory) !== realCanvasDirectory) throw new Error("UI directory changed after plugin startup")
      await rm(canvasFile(sessionID), { force: true })
    } catch (error) {
      log("warn", "failed to remove session UI file", { sessionID, file: canvasFile(sessionID), error: String(error) })
    }
    broadcastToSession(sessionID, { type: "session-remove", sessionID })
    broadcastSessions()
    await writeRegistry()
  }

  const handleMessage = async (socket: PanelSocket, raw: unknown) => {
    let message: ClientMessage
    try {
      const text = typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8")
      if (Buffer.byteLength(text, "utf8") > MAX_DATA_BYTES * 2) return
      message = JSON.parse(text) as ClientMessage
    } catch {
      return
    }
    if (!socket.data.sessionID) return
    if (message?.type === "controller") {
      if (!message.id || message.id.length > 100) return
      try {
        send(socket, { type: "controller-result", id: message.id, ok: true, value: await handleController(socket.data.sessionID, message.action, message.payload) })
      } catch (error) {
        send(socket, { type: "controller-result", id: message.id, ok: false, error: String(error) })
      }
      return
    }
    if (message?.type !== "submit" || typeof message.prompt !== "string") return
    const canvas = canvases.get(socket.data.sessionID)
    if (!canvas || !message.prompt.trim() || Buffer.byteLength(message.prompt, "utf8") > MAX_DATA_BYTES) return
    const hasData = Object.prototype.hasOwnProperty.call(message, "data")
    if (hasData) {
      try {
        if (jsonBytes(message.data) > MAX_DATA_BYTES) throw new Error("payload too large")
      } catch {
        send(socket, { type: "notice", level: "error", message: "UI data was rejected because it is not valid JSON or exceeds 64 KB." })
        return
      }
    }
    const queuedCount = [...submissionQueues.values()].reduce((total, queue) => total + queue.length, 0)
    if (queuedCount >= MAX_PENDING_SUBMISSIONS) {
      send(socket, { type: "notice", level: "error", message: "Too many interactions are waiting for an agent session." })
      return
    }
    const submission: Submission = {
      id: randomToken(18),
      sessionID: canvas.sessionID,
      agent: canvas.agent,
      prompt: promptText(message.prompt, message.data, hasData),
    }
    const queue = submissionQueues.get(submission.sessionID) ?? []
    queue.push(submission)
    submissionQueues.set(submission.sessionID, queue)
    broadcastSubmissionStatus(submission, "queued", "UI interaction is waiting for the session.")
    void flushSession(submission.sessionID)
  }

  const startServer = () => {
    const bun = (globalThis as typeof globalThis & { Bun?: { serve(options: Record<string, unknown>): PanelServer } }).Bun
    if (!bun?.serve) {
      serveError = "The UI panel requires an OpenCode runtime with Bun.serve support."
      return
    }

    const create = (port: number) => bun.serve!({
      port,
      hostname: "127.0.0.1",
      async fetch(req: Request, server: { upgrade(request: Request, options: { data: SocketData }): boolean }) {
        const url = new URL(req.url)
        const landing = async () => new Response(landingHtml(
          sessionsForClient(),
          (await listTemplates()).map((name) => ({
            name,
            url: `/template/${encodeURIComponent(name)}?token=${encodeURIComponent(authToken)}`,
          })),
          url.searchParams.get("view") === "templates" ? "templates" : "sessions",
        ), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          },
        })
        if (url.pathname === "/ws") {
          const requestedSession = url.searchParams.get("session")
          if (req.headers.get("origin") !== panelOrigin || url.searchParams.get("token") !== authToken) {
            return new Response("forbidden", { status: 403 })
          }
          return server.upgrade(req, { data: { sessionID: requestedSession } })
            ? undefined
            : new Response("upgrade failed", { status: 400 })
        }
        const frameMatch = url.pathname.match(/^\/frame\/([^/]+)$/)
        if (req.method === "GET" && frameMatch) {
          let frameKey: string
          try { frameKey = decodeURIComponent(frameMatch[1]) } catch { return new Response("bad session frame", { status: 400 }) }
          const sessionID = [...canvases.keys()].find((id) => sessionFrameKey(id) === frameKey)
          if (!sessionID || url.searchParams.get("token") !== sessionFrameToken(sessionID)) {
            return new Response("forbidden", { status: 403 })
          }
          const canvas = canvases.get(sessionID)
          if (!canvas) return new Response("not found", { status: 404 })
          return new Response(canvasDocument(canvas.html, sharedStyles, config.allowedAssetOrigins), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "x-content-type-options": "nosniff",
              "content-security-policy": canvasCsp(config.allowedAssetOrigins),
            },
          })
        }
        const templateFrameMatch = url.pathname.match(/^\/template-frame\/([^/]+)$/)
        if (req.method === "GET" && templateFrameMatch) {
          if (url.searchParams.get("token") !== authToken) return new Response("forbidden", { status: 403 })
          let name: string
          try { name = decodeURIComponent(templateFrameMatch[1]) } catch { return new Response("bad template", { status: 400 }) }
          let html: string
          try { html = await readSavedTemplate(name) } catch { return new Response("not found", { status: 404 }) }
          return new Response(canvasDocument(html, sharedStyles, config.allowedAssetOrigins), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "x-content-type-options": "nosniff",
              "content-security-policy": canvasCsp(config.allowedAssetOrigins),
            },
          })
        }
        if (req.method !== "GET") {
          return new Response("forbidden", { status: 403 })
        }
        const sessionMatch = url.pathname.match(/^\/s\/([^/]+)$/)
        const templateMatch = url.pathname.match(/^\/template\/([^/]+)$/)
        if (url.pathname !== "/" && !sessionMatch && !templateMatch) return landing()
        if (url.searchParams.get("token") !== authToken) return landing()
        if (templateMatch) {
          let name: string
          try { name = decodeURIComponent(templateMatch[1]) } catch { return landing() }
          try { await readSavedTemplate(name) } catch { return landing() }
          const nonce = randomToken(18)
          const frameURL = `/template-frame/${encodeURIComponent(name)}?token=${encodeURIComponent(authToken)}`
          const html = templatePreviewHtml(name, frameURL, nonce, "/?view=templates")
          return new Response(html, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "x-content-type-options": "nosniff",
              "x-frame-options": "DENY",
              "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
            },
          })
        }
        if (sessionMatch) {
          let sessionID: string
          try { sessionID = decodeURIComponent(sessionMatch[1]) } catch { return landing() }
          if (!canvases.has(sessionID)) return landing()
        }
        const html = shellHtml(shellNonce)
        const connectSource = panelOrigin ? `${panelOrigin.replace("http:", "ws:")} ${panelOrigin}` : "'self'"
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "content-security-policy": `default-src 'none'; script-src 'nonce-${shellNonce}'; style-src 'unsafe-inline'; connect-src 'self' ${connectSource}; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
          },
        })
      },
      websocket: {
        maxPayloadLength: MAX_DATA_BYTES * 2,
        idleTimeout: 120,
        open(socket: PanelSocket) {
          sockets.add(socket)
          send(socket, { type: "init", canvases: [...canvases.values()].map(canvasForClient), sessions: sessionsForClient() })
        },
        close(socket: PanelSocket) {
          sockets.delete(socket)
        },
        message(socket: PanelSocket, raw: unknown) {
          void handleMessage(socket, raw)
        },
      },
    })

    try {
      panelServer = create(config.preferredPort)
    } catch (error) {
      if (config.preferredPort === 0) throw error
      log("warn", `port ${config.preferredPort} is unavailable; selecting a fallback port`, { error: String(error) })
      panelServer = create(0)
    }
    panelOrigin = `http://127.0.0.1:${panelServer.port}`
    log("info", `UI panel listening on ${panelOrigin}`)
  }

  try {
    startServer()
  } catch (error) {
    serveError = `UI panel server failed to start: ${String(error)}`
    log("error", serveError)
  }
  await writeRegistry()
  await loadRegistry()
  heartbeatTimer = setInterval(() => {
    void writeRegistry()
    void loadRegistry()
  }, REGISTRY_HEARTBEAT_MS)
  heartbeatTimer.unref?.()

  const instructionsFor = (sessionID: string) => {
    const file = canvasFile(sessionID)
    const url = sessionURL(sessionID)
    return [
      "This session has a browser UI canvas backed by one editable HTML file.",
      `UI file: ${file}`,
      url ? `Panel: ${url}` : `Panel unavailable: ${serveError ?? "server did not start"}`,
      "When the user requests an interface, call reindr_open as your first action so the default OpenCode controller appears immediately, then edit the returned file with normal filesystem tools when a custom interface is needed. The reindr_open tool never overwrites existing content and is only a lifecycle tool; do not look for other UI rendering tools.",
      "Keep the file's HTML, CSS, and JavaScript self-contained. The plugin detects changes and live-reloads the sandboxed panel.",
      "Generated JavaScript may call opencode.submit({ prompt, data? }) directly from a user click or form submission. The optional data value must be JSON-serializable. Use opencode.setHeight(px) only when automatic sizing is insufficient.",
      config.allowedAssetOrigins.length
        ? `Static assets may load only from: ${config.allowedAssetOrigins.join(", ")}. Fetch, WebSocket, and form submission remain blocked.`
        : "External assets, fetch, WebSocket, and form submission are blocked; inline all CSS and JavaScript.",
    ].join("\n")
  }

  return {
    tool: {
      reindr_open: tool({
        description: "Open the Reindr panel immediately when the user requests an interface. New session UIs default to opencode-controller.html and can optionally use another saved HTML template. Existing session UI content is always preserved.",
        args: {
          template: tool.schema.string().optional().describe("Saved template filename, for example reindr-loading.html. Defaults to opencode-controller.html."),
        },
        async execute(args, context) {
          context.metadata({ title: "Opening Reindr" })
          const result = await openSessionUI(context.sessionID, context.agent, args.template)
          return {
            title: result.created ? "Opened Reindr" : "Reopened Reindr",
            output: [
              result.created ? "Created a temporary Reindr starter." : "Preserved the existing Reindr UI.",
              `Template: ${result.template}`,
              `UI file: ${result.file}`,
              result.url ? `Panel: ${result.url}` : `Panel unavailable: ${serveError ?? "server did not start"}`,
              "Edit the UI file now with normal filesystem tools to implement the user's request.",
            ].join("\n"),
            metadata: { file: result.file, url: result.url, created: result.created, template: result.template },
          }
        },
      }),
    },

    config: async (input) => {
      const mutable = input as unknown as { permission?: PermissionAction | RuntimePermission }
      if (typeof mutable.permission === "string") return
      const permission = mutable.permission ?? {}
      mutable.permission = permission
      const external = permission.external_directory
      if (external === "allow" || external === "deny") return
      const pattern = path.join(realCanvasDirectory, "*.html")
      const rules = external && typeof external === "object" ? external : { "*": external ?? "ask" }
      if (rules[pattern] === "deny") return
      delete rules[pattern]
      rules[pattern] = "allow"
      permission.external_directory = rules
    },

    dispose: async () => {
      disposed = true
      canvasWatcher?.close()
      registryWatcher?.close()
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = null
      if (registryRefreshTimer) clearTimeout(registryRefreshTimer)
      registryRefreshTimer = null
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = null
      for (const timer of retryTimers) clearTimeout(timer)
      retryTimers.clear()
      for (const socket of sockets) {
        try { socket.close(1001, "plugin disposed") } catch {}
      }
      sockets.clear()
      await registryWrite
      await releaseBrowserOwnership()
      await rm(registryFile, { force: true }).catch(() => {})
      if (panelServer) await Promise.resolve(panelServer.stop(true)).catch(() => {})
      panelServer = null
    },

    event: async ({ event }) => {
      const properties = (event as { properties?: Record<string, unknown> }).properties ?? {}
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = properties.info as { id?: string; title?: string } | undefined
        if (info?.id && info.title) {
          sessionTitles.set(info.id, info.title)
          const canvas = canvases.get(info.id)
          if (canvas) canvas.sessionTitle = info.title
          broadcastSessions()
          await writeRegistry()
        }
      }
      if (event.type === "session.status") {
        const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : null
        const status = properties.status as { type?: string } | undefined
        if (sessionID && status?.type) {
          sessionStatus.set(sessionID, status.type === "idle" ? "idle" : "busy")
          if (status.type === "idle") void flushSession(sessionID)
        }
      }
      if (event.type === "session.deleted") {
        const info = properties.info as { id?: string } | undefined
        if (info?.id) await removeSession(info.id)
      }
    },

    "chat.message": async (input) => {
      if (input.agent) sessionAgents.set(input.sessionID, input.agent)
      const canvas = canvases.get(input.sessionID)
      if (canvas && input.agent) canvas.agent = input.agent
      await registerSession(input.sessionID, true)
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      await registerSession(input.sessionID, true)
      output.system.push(instructionsFor(input.sessionID))
    },

    "shell.env": async (input, output) => {
      if (!input.sessionID) return
      await registerSession(input.sessionID, true)
      output.env.REINDR_UI_FILE = canvasFile(input.sessionID)
      const url = sessionURL(input.sessionID)
      if (url) output.env.REINDR_UI_URL = url
    },

    "tool.execute.after": async (input) => {
      await registerSession(input.sessionID, false)
      await refreshCanvas(input.sessionID, false)
    },
  }
}

export default ReindrPlugin
