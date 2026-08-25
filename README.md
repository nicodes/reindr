# opencode-generative-ui

A prototype OpenCode plugin that gives each agent session an editable HTML file and displays it in a companion Chromium panel. The file is the interface: the agent uses normal filesystem tools to write HTML, CSS, and JavaScript, while the plugin handles discovery, live reload, sandboxing, session routing, and browser-to-agent interactions.

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

Ask the agent to build an interface:

> Run the tests and make an interactive pass/fail dashboard.

> Make a form for the refactor options: naming style, target directory, and dry-run toggle.

The plugin adds the current session's exact UI file path and panel URL to the agent's system instructions. It also exports them to shell commands as:

```text
OPENCODE_UI_FILE
OPENCODE_UI_URL
```

The default file location is:

```text
.opencode/ui/<session-hash>.html
```

Each OpenCode session gets a different file. The agent creates or edits that one file with the standard filesystem tools; there are no custom UI authoring tools or component schemas. A write triggers a live panel update, and the first non-empty UI opens its session panel automatically by default.

The file may be a complete document or an HTML fragment. Keep CSS and JavaScript inline unless static asset hosts have been explicitly allowed.

## Browser Bridge

Generated JavaScript receives a frozen `window.opencode` capability object:

- `opencode.submit({ prompt, data? })` sends an interaction to the owning OpenCode session. It must run directly during a user click or form submission. `data` is optional and must be JSON-serializable.
- `opencode.setHeight(px)` overrides automatic iframe sizing when needed.

Example:

```html
<!doctype html>
<html>
  <head>
    <style>
      body { font: 16px system-ui; padding: 24px; }
    </style>
  </head>
  <body>
    <form id="options">
      <label>Name <input name="name"></label>
      <button>Apply</button>
    </form>
    <script>
      document.getElementById("options").addEventListener("submit", (event) => {
        event.preventDefault()
        opencode.submit({
          prompt: "Apply these options",
          data: { name: event.currentTarget.elements.name.value },
        })
      })
    </script>
  </body>
</html>
```

Interactions wait until the owning session reports an idle status and are submitted exactly once. A brief shell toast reports queued, sent, or failed status.

## Files And Reloading

The HTML files are normal project-local files. `.opencode/ui/` is ignored by this repository so generated interfaces do not appear in commits by default.

The plugin watches the directory for external changes and also checks the current session's file after ordinary tool calls. Whole-file updates preserve basic input values, checkbox state, selections, focus, and page scroll when corresponding controls still exist.

Existing files are rediscovered when their session becomes active after an OpenCode restart. Restored JavaScript does not execute until the user clicks **Activate saved content**. Deleting an OpenCode session deletes its associated HTML file.

Each UI file is limited to 1 MB of UTF-8 HTML. The optional shared stylesheet is limited to 200 KB.

## Shared Styling

The generated document receives a small neutral base stylesheet before the file's own styles. It supplies dark defaults and reusable tokens such as `--ui-bg`, `--ui-surface`, `--ui-text`, and `--ui-accent`, but does not impose a component or layout system.

An optional local shared stylesheet can be configured by the user. Styles are applied in this order:

1. Built-in neutral defaults and design tokens.
2. The configured shared stylesheet.
3. Styles from the session HTML file.

## Configuration

Secure defaults require no configuration.

| Environment variable | Default | Meaning |
|---|---:|---|
| `OPENCODE_UI_PORT` | `4917` | Preferred panel port. Use `0` for a dynamic port. An occupied preferred port falls back automatically. |
| `OPENCODE_UI_AUTORAISE` | `1` | Set to `0` to disable automatic browser opening. |
| `OPENCODE_UI_BROWSER` | platform default | Browser command. Use `{url}` where the panel URL should be inserted. |
| `OPENCODE_UI_DIRECTORY` | `.opencode/ui` | Directory containing per-session HTML files. It must remain inside the project worktree. |
| `OPENCODE_UI_ALLOWED_ASSET_HOSTS` | empty | Comma-separated HTTPS hosts allowed to serve static assets. |
| `OPENCODE_UI_STYLESHEET` | empty | Local CSS file inserted before each session file's styles. Relative paths resolve from the project worktree. |

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
        "canvasDirectory": ".opencode/ui",
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
- Each agent-visible panel URL has a random capability token bound to exactly one session.
- WebSocket upgrades also require the exact panel `Origin`.
- Session document routes use separate read-only tokens, so generated code never receives the WebSocket capability.
- The trusted shell uses a nonce-based CSP and cannot be framed.
- Generated content uses `sandbox="allow-scripts allow-forms"` without `allow-same-origin`.
- The generated-content CSP blocks network connections, form actions, nested frames, objects, and base URL changes.
- Configured HTTPS hosts can serve scripts, styles, images, and fonts, but `fetch`, WebSocket, and form submission remain blocked.
- The trusted bridge communicates over a private `MessageChannel`; arbitrary generated scripts cannot forge privileged shell messages with `parent.postMessage`.
- `opencode.submit()` is accepted only synchronously inside a trusted click or form-submission event.
- Interaction payloads, pending interactions, and file sizes are bounded.

Allowlisted hosts are trusted code suppliers. A script loaded from an allowed host runs inside the generated-content sandbox and can influence what the interface displays or submits after a user action.

Generated JavaScript can still consume CPU or create a misleading interface inside its iframe. User activation, sandboxing, CSP, and the private bridge reduce its authority but do not make arbitrary code harmless.

The CSP blocks `fetch`, WebSocket, form submission, and similar connection APIs. Browser sandboxing does not reliably prevent generated code from navigating its own iframe to an external URL; such navigation can make an outbound request, destroys access to the private bridge, and replaces the generated interface. Do not render untrusted secrets into the canvas.

## Routes

- `/?token=...` redirects to the most recently updated session UI, or waits for initial content.
- `/s/<session-id>?token=...` displays the UI authorized by that session-scoped token.
- `/frame/<session-key>?token=...` serves the sandboxed session HTML with a limited read token.
- `/ws?token=...` carries live updates and interactions.

Capability URLs expire when the OpenCode process exits. The current URL is reinjected into agent instructions and `OPENCODE_UI_URL` after restart.

## Develop

Install test dependencies with Bun:

```sh
bun install
```

Run static checks and tests:

```sh
bun run typecheck
bun run test
```

The core suite runs the real plugin through an HTTP/WebSocket Bun adapter. The browser suite launches `/usr/bin/chromium` and verifies file-backed live reload, session isolation, configurable styles, state preservation, session navigation, CSP enforcement, private bridge delivery, and click-to-activate restoration.

## Prototype Limitations

- Chromium is the only browser tested in this version.
- The panel server and interaction queues belong to one OpenCode process. Parallel processes use separate fallback ports.
- Full-file updates preserve basic form/focus/scroll state, not JavaScript heap state or event state.
- Full-document normalization preserves head and body contents but not attributes on the original `html` or `body` elements.
- CDN assets require explicit trusted-host configuration.
- The npm package has not been prepared or published yet; source-file installation is the supported prototype path.
