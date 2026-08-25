# opencode-generative-ui

A prototype OpenCode plugin that gives an agent the full content region of a companion Chromium panel for generated HTML, CSS, and JavaScript. Retained IDs are composed into one shared document per session, so the agent can build a coherent layout instead of stacking isolated views with unrelated styles. The shell contributes only a compact header.

The runtime implementation is one file:

```text
.opencode/plugins/opencode-generative-ui.ts
```

## Prototype Status

The source plugin works as a project-local OpenCode plugin. The `opencode-generative-ui` npm name and package metadata are prepared for development, but this repository is not yet a published npm plugin.

The prototype targets OpenCode `1.18.22` and Chromium desktop.

## Install Locally

This repository already uses the canonical project plugin location. Quit and restart OpenCode from this project to load it.

To try it in another project, copy the plugin file:

```text
your-project/
  .opencode/
    plugins/
      opencode-generative-ui.ts
```

For a global source installation, copy it to:

```text
~/.config/opencode/plugins/opencode-generative-ui.ts
```

OpenCode loads plugin files only at startup, so restart it after installing or changing the plugin.

## Use

Ask the agent to render something interactive:

> Run the tests and render an interactive pass/fail dashboard.

> Render a form for the refactor options: naming style, target directory, and dry-run toggle.

The first `widget_render` call in each session asks for render permission. The first generated view opens its dedicated session panel automatically. The generated interface is frameless and edge-to-edge beneath the header. A leftmost session-navigation icon opens a left-side drawer below the header; the root URL redirects to the most recently updated session.

## Tools

| Tool | Purpose |
|---|---|
| `widget_render` | Create or replace a session-owned generated view. Reusing an ID updates it. |
| `widget_remove` | Remove a generated view from the current session. |
| `widget_layout` | Set freeform CSS for composing the session's retained IDs. |
| `widget_list` | List generated views from the current session and return its panel URL. |

IDs are scoped to their owning session. Two sessions can safely use the same ID. Within a session, every retained ID becomes a `[data-widget-id="<id>"]` section inside the shared `#oc-root` document. The agent can update `widget_layout` whenever adding or removing sections changes the composition.

The tool names retain `widget_` for API compatibility, but the panel does not add cards, rails, titles, or other widget chrome around the generated content.

## Generated UI Bridge

The shared generated document receives three functions:

- `sendPrompt(text, id?)` sends an interaction. It must be called directly from a user click or form submission. The owning retained ID is inferred from the active control; asynchronous handlers can pass it explicitly.
- `sendData(value, id?)` queues JSON data silently for the owning retained ID. Queued data is included in the next interaction.
- `setHeight(px)` sets the iframe height. Automatic resizing is enabled by default.

A form must prevent normal submission:

```html
<form id="options">
  <label>Name <input name="name"></label>
  <button>Apply</button>
</form>
<script>
  document.getElementById("options").addEventListener("submit", (event) => {
    event.preventDefault()
    sendData({ name: event.currentTarget.elements.name.value })
    sendPrompt("Apply these options")
  })
</script>
```

Interactions do not open a confirmation popup. They wait until the owning session reports an idle status and are then submitted exactly once. A brief shell toast reports queued, sent, or failed status.

## Persistence

Generated view definitions persist outside the repository in the operating system's user-state directory, keyed by project and session:

- Linux: `$XDG_STATE_HOME/opencode-generative-ui`, or `~/.local/state/opencode-generative-ui`
- macOS: `~/Library/Application Support/opencode-generative-ui`
- Windows: `%LOCALAPPDATA%\opencode-generative-ui`

Generated sections and session layout CSS persist. Silent data and interaction queues are discarded on restart. Restored JavaScript does not execute until the user clicks **Activate saved content**. Deleting an OpenCode session deletes its persisted content and layout.

When one retained section updates, the shared document is rebuilt. The shell preserves basic input values, checkbox state, selections, focus, and page scroll across that rebuild.

## Shared Styling

The composed document receives styles in this order:

1. Built-in responsive defaults and shared design tokens such as `--ui-bg`, `--ui-surface`, `--ui-text`, and `--ui-accent`.
2. An optional local shared stylesheet configured by the user.
3. Session-specific CSS set by the agent through `widget_layout`.

Later layers override earlier layers. The built-in `#oc-root` uses a responsive auto-fit grid rather than vertical stacking, while `widget_layout` can replace it with any responsive grid or flex composition.

## Configuration

Secure defaults require no configuration.

| Environment variable | Default | Meaning |
|---|---:|---|
| `OPENCODE_WIDGET_PORT` | `4917` | Preferred panel port. Use `0` for a dynamic port. An occupied preferred port falls back automatically. |
| `OPENCODE_WIDGET_AUTORAISE` | `1` | Set to `0` to disable automatic browser opening. |
| `OPENCODE_WIDGET_BROWSER` | platform default | Browser command. Use `{url}` where the panel URL should be inserted. |
| `OPENCODE_WIDGET_STATE_DIR` | OS state directory | Override persisted widget storage. |
| `OPENCODE_WIDGET_ALLOWED_ASSET_HOSTS` | empty | Comma-separated HTTPS hosts allowed to serve static widget assets. |
| `OPENCODE_WIDGET_STYLESHEET` | empty | Local CSS file appended after built-in shared defaults. Relative paths resolve from the project worktree. |

The eventual npm package also accepts plugin options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-generative-ui",
      {
        "port": 4917,
        "autoOpen": true,
        "browser": "chromium --app={url}",
        "stateDirectory": "/custom/state/path",
        "stylesheetPath": ".opencode/generative-ui.css",
        "allowedAssetHosts": ["cdn.jsdelivr.net"]
      }
    ]
  ]
}
```

Environment variables override plugin options.

## Security Model

- The panel binds only to `127.0.0.1`.
- Panel HTTP and WebSocket access requires a random per-process capability token.
- WebSocket upgrades also require the exact panel `Origin`.
- Session document routes use separate read-only tokens, so iframe code never receives the WebSocket capability.
- The trusted shell uses a nonce-based CSP and cannot be framed.
- Widgets use `sandbox="allow-scripts allow-forms"` without `allow-same-origin`.
- Widget CSP blocks network connections, form actions, nested frames, objects, and base URL changes.
- Configured HTTPS hosts can serve scripts, styles, images, and fonts, but `fetch`, WebSocket, and form submission remain blocked.
- `sendPrompt()` requires transient user activation, preventing automatic submission during page load.
- Interaction payloads, retained events, widget count, and persisted state are bounded.

Allowlisted hosts are trusted code suppliers. A script loaded from an allowed host runs inside the widget sandbox and can influence what the widget displays or sends after a user action.

Generated JavaScript can still consume CPU or create a misleading interface inside its iframe. Because interactions now send without a shell confirmation, generated code can misrepresent what a button will send. Render permission, transient user activation, sandboxing, and CSP reduce its authority but do not make arbitrary code harmless.

## Routes

- `/?token=...` redirects to the most recently updated session, or waits for initial content.
- `/s/<session-id>?token=...` shows one session's edge-to-edge generated content and provides the session drawer.
- `/frame/<session-key>?token=...` serves the composed sandboxed session document with a limited read token.
- `/ws?token=...` carries live updates and interactions.

Capability URLs expire when the OpenCode process exits. Use `widget_list` or a newly opened root URL after restart.

## Develop

Install test dependencies:

```sh
npm install
```

Run static checks and tests:

```sh
npm run typecheck
npm test
```

The core suite runs the real plugin through an HTTP/WebSocket Bun adapter. The browser suite launches `/usr/bin/chromium` and verifies shared-document composition, configurable styles, agent layout CSS, state preservation, the session drawer, CSP enforcement, direct interaction delivery, persistence, and click-to-activate restoration.

## Prototype Limitations

- Chromium is the only browser tested in this version.
- The panel server and live queues belong to one OpenCode process. Parallel processes use separate fallback ports.
- There is no standalone single-widget route yet.
- Basic live form/focus/scroll state is preserved during in-process rebuilds but is not persisted across OpenCode restarts.
- CDN assets require explicit trusted-host configuration.
- The npm package has not been prepared or published yet; source-file installation is the supported prototype path.
