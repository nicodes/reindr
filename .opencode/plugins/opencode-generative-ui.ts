import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin, PluginOptions, ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

type Widget = {
  key: string
  frameToken: string
  id: string
  sessionID: string
  sessionTitle: string
  agent: string
  title: string
  html: string
  createdAt: number
  updatedAt: number
  restored: boolean
}

type SessionSummary = {
  id: string
  title: string
}

type DataEvent = {
  data: unknown
  at: number
}

type Submission = {
  id: string
  widgetID: string
  sessionID: string
  agent: string
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

type ClientWidget = Omit<Widget, "html" | "frameToken"> & {
  frameURL: string
}

type ServerMessage =
  | { type: "init"; widgets: ClientWidget[]; sessions: SessionSummary[] }
  | { type: "widget"; widget: ClientWidget }
  | { type: "remove"; key: string }
  | { type: "session"; session: SessionSummary }
  | { type: "session-remove"; sessionID: string }
  | { type: "submission-status"; id: string; status: "queued" | "sent" | "failed"; message: string }
  | { type: "notice"; level: "info" | "error"; message: string }

type ClientMessage =
  | { type: "data"; key: string; data: unknown }
  | { type: "submit"; key: string; text: string }

type PersistedState = {
  version: 1
  widgets: Array<Omit<Widget, "restored" | "frameToken">>
}

type Config = {
  preferredPort: number
  autoOpen: boolean
  browserCommand: string | null
  stateDirectory: string
  allowedAssetOrigins: string[]
}

const DEFAULT_PORT = 4917
const MAX_WIDGET_HTML_BYTES = 400_000
const MAX_TOTAL_WIDGET_HTML_BYTES = 10_000_000
const MAX_WIDGETS_PER_SESSION = 50
const MAX_WIDGETS_TOTAL = 200
const MAX_DATA_BYTES = 64_000
const MAX_DATA_EVENTS_PER_WIDGET = 100
const MAX_PENDING_SUBMISSIONS = 100
const MAX_PERSISTED_STATE_BYTES = 20_000_000

const ID_SCHEMA = tool.schema
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "alphanumeric, dashes, underscores")

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

function defaultStateDirectory() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "opencode-generative-ui")
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "opencode-generative-ui")
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"), "opencode-generative-ui")
}

function readConfig(options: PluginOptions | undefined): Config {
  const allowedOption = Array.isArray(options?.allowedAssetHosts) ? options.allowedAssetHosts : []
  const allowedEnvironment = (process.env.OPENCODE_WIDGET_ALLOWED_ASSET_HOSTS ?? "").split(",")
  return {
    preferredPort: portOption(process.env.OPENCODE_WIDGET_PORT ?? options?.port, DEFAULT_PORT),
    autoOpen: booleanOption(process.env.OPENCODE_WIDGET_AUTORAISE ?? options?.autoOpen, true),
    browserCommand:
      typeof process.env.OPENCODE_WIDGET_BROWSER === "string"
        ? process.env.OPENCODE_WIDGET_BROWSER
        : typeof options?.browser === "string"
          ? options.browser
          : null,
    stateDirectory:
      typeof process.env.OPENCODE_WIDGET_STATE_DIR === "string"
        ? process.env.OPENCODE_WIDGET_STATE_DIR
        : typeof options?.stateDirectory === "string"
          ? options.stateDirectory
          : defaultStateDirectory(),
    allowedAssetOrigins: normalizeAssetOrigins([...allowedOption, ...allowedEnvironment]),
  }
}

function widgetKey(sessionID: string, id: string) {
  return createHash("sha256").update(sessionID).update("\0").update(id).digest("base64url").slice(0, 24)
}

function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url")
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
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

function sessionPath(sessionID: string) {
  return `/s/${encodeURIComponent(sessionID)}`
}

function widgetCsp(allowedAssetOrigins: string[]) {
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
  var sentAt = 0;
  function post(message) {
    parent.postMessage(Object.assign({ __ocw: 1 }, message), "*");
  }
  window.sendPrompt = function (text) {
    if (!navigator.userActivation || !navigator.userActivation.isActive) {
      post({ kind: "error", message: "sendPrompt() requires a user click or form submission." });
      return false;
    }
    var now = Date.now();
    if (now - sentAt < 500) return false;
    sentAt = now;
    post({ kind: "prompt", text: String(text) });
    return true;
  };
  window.sendData = function (data) {
    post({ kind: "data", data: data });
  };
  var manualHeight = false;
  window.setHeight = function (px) {
    manualHeight = true;
    post({ kind: "resize", px: Math.ceil(Number(px) || 0) });
  };
  function autoHeight() {
    if (manualHeight) return;
    var root = document.documentElement;
    var body = document.body;
    var height = Math.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0);
    post({ kind: "resize", px: Math.min(Math.max(height, 120), 1600) });
  }
  addEventListener("DOMContentLoaded", function () {
    if ("ResizeObserver" in window) new ResizeObserver(autoHeight).observe(document.documentElement);
    autoHeight();
  });
  addEventListener("load", autoHeight);
  setTimeout(autoHeight, 300);
})();
</script>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: transparent; color: #ede6d8; font: 14px/1.55 ui-sans-serif, system-ui, sans-serif; }
</style>`

function widgetDocument(html: string, allowedAssetOrigins: string[]) {
  const csp = widgetCsp(allowedAssetOrigins).replaceAll("&", "&amp;").replaceAll('"', "&quot;")
  const prelude = `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">${BRIDGE_HTML}`
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${prelude}`)
  }
  if (/<html(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(?:\s[^>]*)?>/i, (root) => `${root}<head>${prelude}</head>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8">${prelude}</head><body>${html}</body></html>`
}

function shellHtml(nonce: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>opencode generative UI</title>
<style>
  :root {
    --bg: #13110e; --panel: #1d1914; --raised: #252019; --edge: #393126;
    --ink: #f0e9dc; --muted: #a69b8d; --accent: #f4b942; --ok: #7cc47f; --bad: #e17161;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body { margin: 0; overflow-x: hidden; background: var(--bg); color: var(--ink); font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  body.drawer-open { overflow: hidden; }
  button, a { font: inherit; }
  header { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 12px; height: 48px; padding: 8px 14px 8px 16px; background: color-mix(in srgb, var(--bg) 94%, transparent); border-bottom: 1px solid var(--edge); backdrop-filter: blur(12px); }
  header h1 { margin: 0; font-size: 13px; letter-spacing: .05em; }
  #status { display: flex; align-items: center; gap: 6px; margin-left: auto; color: var(--muted); font-size: 11px; }
  #dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
  #dot.on { background: var(--ok); }
  main { width: 100%; min-height: calc(100dvh - 48px); margin: 0; padding: 0; }
  .empty { display: grid; min-height: calc(100dvh - 48px); place-items: center; padding: 24px; color: var(--muted); text-align: center; }
  .agent-view { width: 100%; overflow: hidden; background: transparent; }
  iframe { display: block; width: 100%; height: 240px; border: 0; background: transparent; }
  .agent-view:only-child iframe { min-height: calc(100dvh - 48px); }
  .dormant { display: grid; place-items: center; min-height: calc(100dvh - 48px); padding: 24px; text-align: center; background: var(--panel); }
  .dormant p { max-width: 520px; margin: 0 0 14px; color: var(--muted); }
  button { padding: 8px 13px; color: var(--ink); background: var(--raised); border: 1px solid var(--edge); border-radius: 6px; cursor: pointer; }
  button:hover, button:focus-visible { border-color: var(--accent); outline: none; }
  #session-toggle { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; padding: 0; color: var(--muted); background: transparent; }
  #session-toggle svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
  #session-toggle:hover, #session-toggle:focus-visible, #session-toggle[aria-expanded="true"] { color: var(--ink); }
  #drawer-backdrop { position: fixed; inset: 48px 0 0; z-index: 19; background: #08070699; opacity: 0; pointer-events: none; transition: opacity .18s ease; }
  #drawer-backdrop.open { opacity: 1; pointer-events: auto; }
  #session-drawer { position: fixed; inset: 48px auto 0 0; z-index: 20; display: grid; grid-template-rows: auto 1fr; width: min(380px, 90vw); height: calc(100dvh - 48px); color: var(--ink); background: var(--panel); border-right: 1px solid var(--edge); box-shadow: 20px 0 60px #0008; transform: translateX(-100%); visibility: hidden; transition: transform .2s ease, visibility 0s linear .2s; }
  #session-drawer.open { transform: translateX(0); visibility: visible; transition-delay: 0s; }
  .drawer-head { display: flex; align-items: center; min-height: 56px; padding: 10px 12px 10px 18px; border-bottom: 1px solid var(--edge); }
  .drawer-head strong { font-size: 13px; letter-spacing: .04em; }
  #drawer-close { margin-left: auto; padding: 6px 10px; color: var(--muted); background: transparent; }
  #session-list { overflow: auto; padding: 10px; }
  .drawer-empty { padding: 24px 10px; color: var(--muted); text-align: center; }
  .drawer-session { display: block; padding: 12px 13px; color: var(--ink); border: 1px solid transparent; border-radius: 7px; text-decoration: none; }
  .drawer-session + .drawer-session { margin-top: 4px; }
  .drawer-session:hover, .drawer-session:focus-visible { background: var(--raised); border-color: var(--edge); outline: none; }
  .drawer-session.active { background: var(--raised); border-color: var(--accent); }
  .drawer-session strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .drawer-session span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; }
  #toast { position: fixed; right: 16px; bottom: 16px; z-index: 10; max-width: min(480px, calc(100vw - 32px)); padding: 10px 13px; color: var(--ink); background: var(--raised); border: 1px solid var(--edge); border-radius: 7px; opacity: 0; pointer-events: none; transform: translateY(8px); transition: .18s ease; }
  #toast.show { opacity: 1; transform: translateY(0); }
  #toast.error { border-color: var(--bad); }
  @media (max-width: 520px) { #status-text { display: none; } header h1 { font-size: 12px; } }
  @media (prefers-reduced-motion: reduce) { #drawer-backdrop, #session-drawer, #toast { transition: none; } }
</style>
</head>
<body>
<header>
  <button id="session-toggle" type="button" aria-label="Open sessions" title="Sessions" aria-controls="session-drawer" aria-expanded="false">
    <svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2.25" y="2.25" width="13.5" height="13.5" rx="2"></rect><path d="M6.25 2.5v13M9.25 6h3.5M9.25 9h3.5M9.25 12h2.25"></path></svg>
  </button>
  <h1>opencode generative UI</h1>
  <span id="status"><span id="dot"></span><span id="status-text">connecting</span></span>
</header>
<main id="main"></main>
<div id="drawer-backdrop"></div>
<aside id="session-drawer" aria-hidden="true" aria-label="Sessions">
  <div class="drawer-head"><strong>Sessions</strong><button id="drawer-close" type="button" aria-label="Close sessions">Close</button></div>
  <nav id="session-list" aria-label="OpenCode sessions"></nav>
</aside>
<div id="toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}">
(function () {
  var token = new URLSearchParams(location.search).get("token") || "";
  var match = location.pathname.match(/^\\/s\\/([^/]+)$/);
  var currentSession = match ? decodeURIComponent(match[1]) : null;
  var widgets = {};
  var sessions = [];
  var cards = {};
  var ws;
  var reconnectTimer;
  var toastTimer;
  var main = document.getElementById("main");
  var dot = document.getElementById("dot");
  var statusText = document.getElementById("status-text");
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

  function groupedSessions() {
    var grouped = {};
    Object.keys(widgets).forEach(function (key) {
      var widget = widgets[key];
      if (!grouped[widget.sessionID]) grouped[widget.sessionID] = [];
      grouped[widget.sessionID].push(widget);
    });
    return Object.keys(grouped).sort(function (a, b) {
      return Math.max.apply(null, grouped[b].map(function (w) { return w.updatedAt; })) - Math.max.apply(null, grouped[a].map(function (w) { return w.updatedAt; }));
    }).map(function (id) { return { id: id, widgets: grouped[id] }; });
  }

  function renderDrawer() {
    sessionList.replaceChildren();
    var groups = groupedSessions();
    if (!groups.length) {
      var empty = document.createElement("div");
      empty.className = "drawer-empty";
      empty.textContent = "No sessions have generated content yet.";
      sessionList.appendChild(empty);
      return;
    }
    groups.forEach(function (group) {
      var link = document.createElement("a");
      link.className = "drawer-session" + (group.id === currentSession ? " active" : "");
      link.href = "/s/" + encodeURIComponent(group.id) + "?token=" + encodeURIComponent(token);
      if (group.id === currentSession) link.setAttribute("aria-current", "page");
      var title = document.createElement("strong");
      title.textContent = sessionTitle(group.id);
      var meta = document.createElement("span");
      meta.textContent = group.id === currentSession ? "Current session" : "Open session";
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
    if (open) document.getElementById("drawer-close").focus();
    else sessionToggle.focus();
  }

  function renderIndex() {
    main.replaceChildren();
    var groups = groupedSessions();
    renderDrawer();
    if (groups.length) {
      location.replace("/s/" + encodeURIComponent(groups[0].id) + "?token=" + encodeURIComponent(token));
      return;
    }
    var empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Waiting for agent-generated content.";
    main.appendChild(empty);
  }

  function activate(widget, view) {
    var old = view.querySelector(".dormant, iframe");
    if (old) old.remove();
    var entry = cards[widget.key];
    var iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts allow-forms");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("title", widget.title);
    iframe.src = widget.frameURL;
    view.appendChild(iframe);
    entry.iframe = iframe;
  }

  function upsertView(widget) {
    if (widget.sessionID !== currentSession) return;
    var entry = cards[widget.key];
    if (!entry) {
      var view = document.createElement("section");
      view.className = "agent-view";
      view.setAttribute("aria-label", widget.title);
      main.appendChild(view);
      entry = cards[widget.key] = { view: view, iframe: null };
    }
    entry.view.setAttribute("aria-label", widget.title);
    if (widget.restored) {
      var old = entry.view.querySelector(".dormant, iframe");
      if (old) old.remove();
      var dormant = document.createElement("div");
      dormant.className = "dormant";
      var content = document.createElement("div");
      var text = document.createElement("p");
      text.textContent = "This content was restored from disk. Its saved JavaScript will run only after you activate it.";
      var button = document.createElement("button");
      button.textContent = "Activate saved content";
      button.addEventListener("click", function () { activate(widget, entry.view); });
      content.append(text, button);
      dormant.appendChild(content);
      entry.view.appendChild(dormant);
      entry.iframe = null;
    } else {
      activate(widget, entry.view);
    }
  }

  function renderSession() {
    main.replaceChildren();
    cards = {};
    renderDrawer();
    var relevant = Object.keys(widgets).map(function (key) { return widgets[key]; }).filter(function (widget) { return widget.sessionID === currentSession; });
    relevant.sort(function (a, b) { return a.createdAt - b.createdAt; });
    if (!relevant.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Waiting for agent-generated content in this session.";
      main.appendChild(empty);
      return;
    }
    relevant.forEach(upsertView);
  }

  function render() {
    if (currentSession) renderSession();
    else renderIndex();
  }

  sessionToggle.addEventListener("click", function () {
    setDrawer(sessionToggle.getAttribute("aria-expanded") !== "true");
  });
  document.getElementById("drawer-close").addEventListener("click", function () { setDrawer(false); });
  drawerBackdrop.addEventListener("click", function () { setDrawer(false); });
  addEventListener("keydown", function (event) {
    if (event.key === "Escape" && sessionDrawer.classList.contains("open")) setDrawer(false);
  });

  addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.__ocw !== 1) return;
    var key = null;
    Object.keys(cards).some(function (candidate) {
      if (cards[candidate].iframe && cards[candidate].iframe.contentWindow === event.source) { key = candidate; return true; }
      return false;
    });
    if (!key) return;
    if (data.kind === "resize") {
      cards[key].iframe.style.height = Math.min(Math.max(Number(data.px) || 240, 120), 1600) + "px";
    } else if (data.kind === "error") {
      notify(String(data.message || "Widget interaction was blocked."), true);
    } else if (data.kind === "prompt") {
      var text = String(data.text || "");
      if (text.length > 64000) notify("Widget prompt is too large.", true);
      else safeSend({ type: "submit", key: key, text: text });
    } else if (data.kind === "data") {
      try {
        var encoded = JSON.stringify(data.data);
        if (encoded.length > 64000) throw new Error("too large");
        safeSend({ type: "data", key: key, data: data.data });
      } catch (_) {
        notify("Widget data must be JSON-serializable and smaller than 64 KB.", true);
      }
    }
  });

  function connect() {
    clearTimeout(reconnectTimer);
    var protocol = location.protocol === "https:" ? "wss:" : "ws:";
    var url = protocol + "//" + location.host + "/ws?token=" + encodeURIComponent(token);
    if (currentSession) url += "&session=" + encodeURIComponent(currentSession);
    ws = new WebSocket(url);
    ws.onopen = function () { dot.className = "on"; statusText.textContent = "live"; };
    ws.onclose = function () {
      dot.className = "";
      statusText.textContent = "reconnecting";
      reconnectTimer = setTimeout(connect, 1500);
    };
    ws.onmessage = function (event) {
      var message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === "init") {
        widgets = {};
        message.widgets.forEach(function (widget) { widgets[widget.key] = widget; });
        sessions = message.sessions;
        render();
      } else if (message.type === "widget") {
        widgets[message.widget.key] = message.widget;
        if (message.widget.sessionID === currentSession) renderSession();
        else renderDrawer();
      } else if (message.type === "remove") {
        delete widgets[message.key];
        render();
      } else if (message.type === "session") {
        var replaced = false;
        sessions = sessions.map(function (session) {
          if (session.id !== message.session.id) return session;
          replaced = true;
          return message.session;
        });
        if (!replaced) sessions.push(message.session);
        renderDrawer();
      } else if (message.type === "session-remove") {
        Object.keys(widgets).forEach(function (key) { if (widgets[key].sessionID === message.sessionID) delete widgets[key]; });
        if (message.sessionID === currentSession) location.replace("/?token=" + encodeURIComponent(token));
        else renderDrawer();
      } else if (message.type === "submission-status") {
        notify(message.message, message.status === "failed");
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

const OpencodeGenerativeUIPlugin: Plugin = async ({ client, project, worktree }, options) => {
  const config = readConfig(options)
  const authToken = randomToken()
  const shellNonce = randomToken(18)
  const widgets = new Map<string, Widget>()
  const sessionTitles = new Map<string, string>()
  const sockets = new Set<PanelSocket>()
  const pendingData = new Map<string, DataEvent[]>()
  const submissionQueues = new Map<string, Submission[]>()
  const sessionStatus = new Map<string, "idle" | "busy" | "unknown">()
  const flushingSessions = new Set<string>()
  const authorizedSessions = new Set<string>()
  const projectKey = createHash("sha256").update(project.id).update("\0").update(worktree).digest("hex").slice(0, 32)
  const stateFile = path.join(config.stateDirectory, `${projectKey}.json`)

  let panelServer: PanelServer | null = null
  let panelOrigin: string | null = null
  let serveError: string | null = null
  let openedBrowser = false
  let disposed = false

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: "opencode-generative-ui", level, message, extra } }).catch(() => {})

  const sessionsForClient = (): SessionSummary[] => {
    const ids = new Set([...widgets.values()].map((widget) => widget.sessionID))
    return [...ids].map((id) => ({ id, title: sessionTitles.get(id) ?? id }))
  }

  const widgetForClient = (widget: Widget): ClientWidget => ({
    key: widget.key,
    id: widget.id,
    sessionID: widget.sessionID,
    sessionTitle: widget.sessionTitle,
    agent: widget.agent,
    title: widget.title,
    createdAt: widget.createdAt,
    updatedAt: widget.updatedAt,
    restored: widget.restored,
    frameURL: `${panelOrigin}/frame/${encodeURIComponent(widget.key)}?token=${encodeURIComponent(widget.frameToken)}&v=${widget.updatedAt}`,
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

  const broadcast = (message: ServerMessage) => {
    for (const socket of sockets) send(socket, message)
  }

  const broadcastSubmissionStatus = (submission: Submission, status: "queued" | "sent" | "failed", message: string) => {
    broadcast({ type: "submission-status", id: submission.id, status, message })
  }

  const persist = async () => {
    const state: PersistedState = {
      version: 1,
      widgets: [...widgets.values()].map(({ restored: _restored, frameToken: _frameToken, ...widget }) => widget),
    }
    await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 })
    const temporary = `${stateFile}.${process.pid}.${randomToken(6)}.tmp`
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 })
    await rename(temporary, stateFile)
    await chmod(stateFile, 0o600).catch(() => {})
  }

  const loadPersistedState = async () => {
    try {
      const info = await stat(stateFile)
      if (info.size > MAX_PERSISTED_STATE_BYTES) throw new Error("persisted state exceeds the size limit")
      const parsed = JSON.parse(await readFile(stateFile, "utf8")) as Partial<PersistedState>
      if (parsed.version !== 1 || !Array.isArray(parsed.widgets)) throw new Error("unsupported persisted state")
      for (const item of parsed.widgets) {
        if (
          !item ||
          typeof item.id !== "string" ||
          typeof item.sessionID !== "string" ||
          typeof item.agent !== "string" ||
          typeof item.title !== "string" ||
          typeof item.html !== "string" ||
          jsonBytes(item.html) > MAX_WIDGET_HTML_BYTES
        ) continue
        const key = widgetKey(item.sessionID, item.id)
        const widget: Widget = {
          ...item,
          key,
          frameToken: randomToken(),
          sessionTitle: typeof item.sessionTitle === "string" ? item.sessionTitle : item.sessionID,
          createdAt: Number(item.createdAt) || Date.now(),
          updatedAt: Number(item.updatedAt) || Date.now(),
          restored: true,
        }
        widgets.set(key, widget)
        sessionTitles.set(widget.sessionID, widget.sessionTitle)
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null
      if (code !== "ENOENT") log("warn", "failed to load persisted widget state", { error: String(error) })
    }
  }

  await loadPersistedState()

  const sessionURL = (sessionID: string) => {
    if (!panelOrigin) return null
    return `${panelOrigin}${sessionPath(sessionID)}?token=${encodeURIComponent(authToken)}`
  }

  const rootURL = () => panelOrigin ? `${panelOrigin}/?token=${encodeURIComponent(authToken)}` : null

  const openBrowser = (url: string) => {
    if (openedBrowser || !config.autoOpen) return
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
        child.on("error", (error) => log("warn", "custom browser command failed", { error: String(error), url }))
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
      child.on("error", (error) => log("warn", "browser command failed", { error: String(error), url }))
      child.unref()
    } catch (error) {
      log("warn", "could not open the widget panel browser", { error: String(error), url })
    }
  }

  const promptText = (widget: Widget, text: string, data: DataEvent[]) => {
    const sections = [`[widget:${widget.id}]`, text.trim()]
    if (data.length) sections.push(`Widget data:\n${JSON.stringify(data, null, 2)}`)
    return sections.filter(Boolean).join("\n\n")
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

  const flushSession = async (sessionID: string) => {
    if (disposed || flushingSessions.has(sessionID)) return
    const queue = submissionQueues.get(sessionID)
    if (!queue?.length) return
    const status = sessionStatus.get(sessionID) ?? await refreshSessionStatus(sessionID)
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
          agent: submission.agent,
          parts: [{ type: "text", text: submission.prompt }],
        },
      })
      sdkData(response)
      broadcastSubmissionStatus(submission, "sent", `Interaction from #${submission.widgetID} was sent to the agent.`)
    } catch (error) {
      sessionStatus.set(sessionID, "unknown")
      broadcastSubmissionStatus(submission, "failed", `Interaction from #${submission.widgetID} failed: ${String(error)}`)
      log("error", "failed to submit a widget interaction", { sessionID, error: String(error) })
    } finally {
      flushingSessions.delete(sessionID)
    }
  }

  const removeSession = async (sessionID: string) => {
    for (const [key, widget] of widgets) {
      if (widget.sessionID !== sessionID) continue
      widgets.delete(key)
      pendingData.delete(key)
    }
    submissionQueues.delete(sessionID)
    sessionStatus.delete(sessionID)
    authorizedSessions.delete(sessionID)
    sessionTitles.delete(sessionID)
    await persist()
    broadcast({ type: "session-remove", sessionID })
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
    if (!message || typeof message !== "object" || typeof message.type !== "string") return
    if (message.type === "data") {
      if (typeof message.key !== "string" || !widgets.has(message.key)) return
      try {
        if (jsonBytes(message.data) > MAX_DATA_BYTES) throw new Error("payload too large")
      } catch {
        send(socket, { type: "notice", level: "error", message: "Widget data was rejected because it is not valid JSON or exceeds 64 KB." })
        return
      }
      const events = pendingData.get(message.key) ?? []
      events.push({ data: message.data, at: Date.now() })
      if (events.length > MAX_DATA_EVENTS_PER_WIDGET) events.shift()
      pendingData.set(message.key, events)
      return
    }

    if (message.type === "submit") {
      if (typeof message.key !== "string" || typeof message.text !== "string" || Buffer.byteLength(message.text, "utf8") > MAX_DATA_BYTES) return
      const widget = widgets.get(message.key)
      if (!widget || (socket.data.sessionID && socket.data.sessionID !== widget.sessionID)) return
      const queuedCount = [...submissionQueues.values()].reduce((total, queue) => total + queue.length, 0)
      if (queuedCount >= MAX_PENDING_SUBMISSIONS) {
        send(socket, { type: "notice", level: "error", message: "Too many interactions are waiting for an agent session." })
        return
      }
      const data = pendingData.get(widget.key) ?? []
      pendingData.delete(widget.key)
      const submission: Submission = {
        id: randomToken(18),
        widgetID: widget.id,
        sessionID: widget.sessionID,
        agent: widget.agent,
        prompt: promptText(widget, message.text, data),
      }
      const queue = submissionQueues.get(submission.sessionID) ?? []
      queue.push(submission)
      submissionQueues.set(submission.sessionID, queue)
      broadcastSubmissionStatus(submission, "queued", `Interaction from #${submission.widgetID} is waiting for the session.`)
      void flushSession(submission.sessionID)
      return
    }
  }

  const startServer = () => {
    const bun = (globalThis as typeof globalThis & {
      Bun?: {
        serve(options: Record<string, unknown>): PanelServer
      }
    }).Bun
    if (!bun?.serve) {
      serveError = "The widget panel requires an OpenCode runtime with Bun.serve support."
      return
    }

    const create = (port: number) => bun.serve!({
      port,
      hostname: "127.0.0.1",
      fetch(req: Request, server: { upgrade(request: Request, options: { data: SocketData }): boolean }) {
        const url = new URL(req.url)
        if (url.pathname === "/ws") {
          if (url.searchParams.get("token") !== authToken || req.headers.get("origin") !== panelOrigin) {
            return new Response("forbidden", { status: 403 })
          }
          const requestedSession = url.searchParams.get("session")
          return server.upgrade(req, { data: { sessionID: requestedSession } })
            ? undefined
            : new Response("upgrade failed", { status: 400 })
        }
        const frameMatch = url.pathname.match(/^\/frame\/([^/]+)$/)
        if (req.method === "GET" && frameMatch) {
          let key: string
          try { key = decodeURIComponent(frameMatch[1]) } catch { return new Response("bad widget key", { status: 400 }) }
          const widget = widgets.get(key)
          if (!widget || url.searchParams.get("token") !== widget.frameToken) {
            return new Response("forbidden", { status: 403 })
          }
          return new Response(widgetDocument(widget.html, config.allowedAssetOrigins), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "x-content-type-options": "nosniff",
              "content-security-policy": widgetCsp(config.allowedAssetOrigins),
            },
          })
        }
        if (req.method !== "GET" || url.searchParams.get("token") !== authToken) {
          return new Response("forbidden", { status: 403 })
        }
        const sessionMatch = url.pathname.match(/^\/s\/([^/]+)$/)
        if (url.pathname !== "/" && !sessionMatch) return new Response("not found", { status: 404 })
        if (sessionMatch) {
          try { decodeURIComponent(sessionMatch[1]) } catch { return new Response("bad session", { status: 400 }) }
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
          send(socket, {
            type: "init",
            widgets: [...widgets.values()].map(widgetForClient),
            sessions: sessionsForClient(),
          })
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
    log("info", `widget panel listening on ${panelOrigin}`)
  }

  try {
    startServer()
  } catch (error) {
    serveError = `Widget panel server failed to start: ${String(error)}`
    log("error", serveError)
  }

  const authorizeRender = async (ctx: ToolContext, id: string) => {
    if (authorizedSessions.has(ctx.sessionID)) return
    await ctx.ask({
      permission: "widget_render",
      patterns: [ctx.sessionID],
      always: [ctx.sessionID],
      metadata: { sessionID: ctx.sessionID, widgetID: id },
    })
    authorizedSessions.add(ctx.sessionID)
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

  return {
    dispose: async () => {
      disposed = true
      await persist().catch((error) => log("warn", "failed to persist widgets during disposal", { error: String(error) }))
      for (const socket of sockets) {
        try { socket.close(1001, "plugin disposed") } catch {}
      }
      sockets.clear()
      if (panelServer) await Promise.resolve(panelServer.stop(true)).catch(() => {})
      panelServer = null
    },

    event: async ({ event }) => {
      const properties = (event as { properties?: Record<string, unknown> }).properties ?? {}
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = properties.info as { id?: string; title?: string } | undefined
        if (info?.id && info.title) {
          sessionTitles.set(info.id, info.title)
          broadcast({ type: "session", session: { id: info.id, title: info.title } })
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

    tool: {
      widget_render: tool({
        description: [
          "Render or replace a self-contained HTML/CSS/JavaScript view in the user's companion browser panel.",
          "The generated view is frameless, full width, and fills the region below the panel header when it is the only view. Design it as a complete interface and control its layout, spacing, and background.",
          "Use the same id to update a view in place. IDs are scoped to the current session.",
          "The iframe is sandboxed and external networking is blocked except for configured static asset hosts.",
          "Available bridge functions:",
          "- sendPrompt(text): send an interaction that resumes this session as soon as it is idle. Call it directly from a click or submit handler.",
          "- sendData(value): queue JSON data silently. It is attached to the next sendPrompt interaction.",
          "- setHeight(px): set the iframe height; automatic resizing is enabled by default.",
          "Forms must prevent their default submission and use sendPrompt(). Inline all other CSS and JavaScript.",
          config.allowedAssetOrigins.length
            ? `Allowed static asset origins: ${config.allowedAssetOrigins.join(", ")}.`
            : "No external asset origins are currently allowed.",
        ].join("\n"),
        args: {
          id: ID_SCHEMA.describe("Stable session-local view id, such as 'test-results'."),
          title: tool.schema.string().min(1).max(120).describe("Accessible iframe title used by browser assistive technology and tool listings; the panel does not render title chrome."),
          html: tool.schema.string().max(MAX_WIDGET_HTML_BYTES).describe("Self-contained HTML fragment or document with inline CSS and JavaScript."),
        },
        async execute(args, ctx) {
          if (serveError || !panelOrigin) {
            return { title: "Widget panel unavailable", output: serveError ?? "Widget panel server is unavailable." }
          }
          if (Buffer.byteLength(args.html, "utf8") > MAX_WIDGET_HTML_BYTES) {
            return { title: "Widget is too large", output: `Widget HTML must be at most ${MAX_WIDGET_HTML_BYTES} UTF-8 bytes.` }
          }
          const key = widgetKey(ctx.sessionID, args.id)
          const now = Date.now()
          const existing = widgets.get(key)
          if (!existing && widgets.size >= MAX_WIDGETS_TOTAL) {
            return { title: "Widget limit reached", output: `The project panel can retain at most ${MAX_WIDGETS_TOTAL} widgets.` }
          }
          const sessionWidgetCount = [...widgets.values()].filter((widget) => widget.sessionID === ctx.sessionID).length
          if (!existing && sessionWidgetCount >= MAX_WIDGETS_PER_SESSION) {
            return { title: "Widget limit reached", output: `A session can retain at most ${MAX_WIDGETS_PER_SESSION} widgets.` }
          }
          const retainedHTMLBytes = [...widgets.values()].reduce(
            (total, widget) => total + (widget.key === key ? 0 : Buffer.byteLength(widget.html, "utf8")),
            Buffer.byteLength(args.html, "utf8"),
          )
          if (retainedHTMLBytes > MAX_TOTAL_WIDGET_HTML_BYTES) {
            return { title: "Panel storage limit reached", output: `Retained widget HTML must total at most ${MAX_TOTAL_WIDGET_HTML_BYTES} UTF-8 bytes.` }
          }
          await authorizeRender(ctx, args.id)
          const title = await resolveSessionTitle(ctx.sessionID)
          const widget: Widget = {
            key,
            frameToken: randomToken(),
            id: args.id,
            sessionID: ctx.sessionID,
            sessionTitle: title,
            agent: ctx.agent,
            title: args.title,
            html: args.html,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            restored: false,
          }
          widgets.set(key, widget)
          sessionTitles.set(ctx.sessionID, title)
          await persist()
          broadcast({ type: "widget", widget: widgetForClient(widget) })
          const url = sessionURL(ctx.sessionID)!
          openBrowser(url)
          ctx.metadata({ title: `widget: ${widget.title}`, metadata: { widgetID: widget.id, url } })
          return {
            title: `${existing ? "Updated" : "Rendered"} widget '${widget.id}'`,
            output: `Widget '${widget.id}' ${existing ? "updated" : "created"} for this session. Panel: ${url}`,
            metadata: { widgetID: widget.id, sessionID: widget.sessionID, url },
          }
        },
      }),

      widget_remove: tool({
        description: "Remove one generated view owned by the current session.",
        args: { id: ID_SCHEMA.describe("Session-local view id to remove.") },
        async execute(args, ctx) {
          const key = widgetKey(ctx.sessionID, args.id)
          if (!widgets.delete(key)) return `No widget with id '${args.id}' exists in this session.`
          pendingData.delete(key)
          await persist()
          broadcast({ type: "remove", key })
          return `Removed widget '${args.id}' from this session.`
        },
      }),

      widget_list: tool({
        description: "List generated views owned by the current session and return its companion panel URL.",
        args: {},
        async execute(_args, ctx) {
          const current = [...widgets.values()].filter((widget) => widget.sessionID === ctx.sessionID)
          const url = sessionURL(ctx.sessionID)
          if (!current.length) return `No widgets are rendered for this session.${url ? ` Panel: ${url}` : ""}`
          const lines = current.map((widget) => `- ${widget.id}: "${widget.title}" (updated ${new Date(widget.updatedAt).toISOString()}${widget.restored ? ", restored" : ""})`)
          return `Panel: ${url}\n${lines.join("\n")}`
        },
      }),
    },
  }
}

export default OpencodeGenerativeUIPlugin
