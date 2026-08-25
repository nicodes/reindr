import { constants, watch, type FSWatcher } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { chmod, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"

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
  | { type: "notice"; level: "info" | "error"; message: string }

type ClientMessage = {
  type: "submit"
  prompt: string
  data?: unknown
}

type Config = {
  preferredPort: number
  autoOpen: boolean
  browserCommand: string | null
  canvasDirectory: string
  allowedAssetOrigins: string[]
  stylesheetPath: string | null
}

const DEFAULT_PORT = 4917
const MAX_CANVAS_HTML_BYTES = 1_000_000
const MAX_STYLESHEET_BYTES = 200_000
const MAX_DATA_BYTES = 64_000
const MAX_PENDING_SUBMISSIONS = 100
const REGISTRY_HEARTBEAT_MS = 3_000
const REGISTRY_STALE_MS = 10_000

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

function projectFile(worktree: string, value: string) {
  const resolved = resolveFile(worktree, value)
  const relative = path.relative(path.resolve(worktree), resolved)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`UI paths must stay inside the project worktree: ${resolved}`)
  }
  return resolved
}

function readConfig(worktree: string, options: PluginOptions | undefined): Config {
  const allowedOption = Array.isArray(options?.allowedAssetHosts) ? options.allowedAssetHosts : []
  const allowedEnvironment = (process.env.REINDR_ALLOWED_ASSET_HOSTS ?? "").split(",")
  const directoryOption = typeof options?.canvasDirectory === "string" ? options.canvasDirectory : ".opencode/ui"
  return {
    preferredPort: portOption(process.env.REINDR_PORT ?? options?.port, DEFAULT_PORT),
    autoOpen: booleanOption(process.env.REINDR_AUTORAISE ?? options?.autoOpen, true),
    browserCommand:
      typeof process.env.REINDR_BROWSER === "string"
        ? process.env.REINDR_BROWSER
        : typeof options?.browser === "string"
          ? options.browser
          : null,
    canvasDirectory: projectFile(worktree, process.env.REINDR_DIRECTORY ?? directoryOption),
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

function sessionPath(sessionID: string) {
  return `/s/${encodeURIComponent(sessionID)}`
}

function canvasFileName(sessionID: string) {
  return `${createHash("sha256").update(sessionID).digest("hex").slice(0, 32)}.html`
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
  var manualHeight = false;
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
  function post(message) {
    try { apply(postToPort, port, [message]); } catch (_) {}
  }
  function fail(message) {
    post({ kind: "error", message: message });
    return false;
  }
  function submit(input) {
    if (!input || typeof input !== "object") return fail("opencode.submit() requires an object.");
    if (!activeEvent || apply(getWindowEvent, window, []) !== activeEvent) {
      return fail("opencode.submit() requires a user click or form submission.");
    }
    if (!activation || !apply(getIsActive, activation, [])) return fail("The browser did not grant user activation.");
    activeEvent = null;
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
  function setHeight(px) {
    manualHeight = true;
    post({ kind: "resize", px: Math.ceil(Number(px) || 0) });
  }
  Object.defineProperty(window, "opencode", {
    configurable: false,
    writable: false,
    value: Object.freeze({ submit: submit, setHeight: setHeight })
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
    post({ kind: "ready" });
  });
  addEventListener("load", autoHeight);
  setTimeout(autoHeight, 300);
})();
</script>`

const DEFAULT_SHARED_CSS = `
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
`

function safeStyle(css: string) {
  return css.replace(/<\/style/gi, "<\\/style")
}

function documentParts(html: string) {
  const head = html.match(/<head(?:\s[^>]*)?>([\s\S]*?)<\/head>/i)?.[1] ?? ""
  const body = html.match(/<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/i)?.[1]
  if (body !== undefined) return { head, body }
  return {
    head,
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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">${BRIDGE_HTML}<style id="reindr-default-styles">${safeStyle(DEFAULT_SHARED_CSS)}</style><style id="reindr-shared-styles">${safeStyle(sharedCSS)}</style>${parts.head}</head><body>${parts.body}</body></html>`
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
    } else if (data.kind === "ready") {
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

  const refreshCanvas = async (sessionID: string, restored: boolean) => {
    if (disposed) return false
    const generation = (refreshGenerations.get(sessionID) ?? 0) + 1
    refreshGenerations.set(sessionID, generation)
    const isCurrent = () => !disposed && knownSessions.has(sessionID) && refreshGenerations.get(sessionID) === generation
    const file = canvasFile(sessionID)
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

  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      for (const sessionID of knownSessions) void refreshCanvas(sessionID, false)
    }, 50)
  }

  const loadSharedStyles = async () => {
    if (!config.stylesheetPath) return
    const file = resolveFile(worktree, config.stylesheetPath)
    try {
      const info = await stat(file)
      if (info.size > MAX_STYLESHEET_BYTES) throw new Error(`stylesheet exceeds ${MAX_STYLESHEET_BYTES} bytes`)
      sharedStyles = await readFile(file, "utf8")
      log("info", "loaded shared UI stylesheet", { file })
    } catch (error) {
      log("warn", "failed to load shared UI stylesheet", { file, error: String(error) })
    }
  }

  await mkdir(config.canvasDirectory, { recursive: true })
  const [realWorktree, realCanvasDirectory] = await Promise.all([realpath(worktree), realpath(config.canvasDirectory)])
  const realRelative = path.relative(realWorktree, realCanvasDirectory)
  if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`UI directory resolves outside the project worktree: ${realCanvasDirectory}`)
  }
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
    if (!socket.data.sessionID || message?.type !== "submit" || typeof message.prompt !== "string") return
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
      fetch(req: Request, server: { upgrade(request: Request, options: { data: SocketData }): boolean }) {
        const url = new URL(req.url)
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
        if (req.method !== "GET") {
          return new Response("forbidden", { status: 403 })
        }
        const sessionMatch = url.pathname.match(/^\/s\/([^/]+)$/)
        if (url.pathname !== "/" && !sessionMatch) return new Response("not found", { status: 404 })
        if (url.searchParams.get("token") !== authToken) return new Response("forbidden", { status: 403 })
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
      "Use normal filesystem tools to create or edit that file. Keep its HTML, CSS, and JavaScript self-contained; the plugin detects changes and live-reloads the sandboxed panel. Do not look for or call custom UI rendering tools.",
      "Generated JavaScript may call opencode.submit({ prompt, data? }) directly from a user click or form submission. The optional data value must be JSON-serializable. Use opencode.setHeight(px) only when automatic sizing is insufficient.",
      config.allowedAssetOrigins.length
        ? `Static assets may load only from: ${config.allowedAssetOrigins.join(", ")}. Fetch, WebSocket, and form submission remain blocked.`
        : "External assets, fetch, WebSocket, and form submission are blocked; inline all CSS and JavaScript.",
    ].join("\n")
  }

  return {
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
