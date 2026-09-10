# @nicodes/reindr-opencode

The Reindr plugin for OpenCode. Version `0.0.3` provides session navigation, independent host-owned agent controls, and multiple named HTML canvas tabs in the main header. Saved canvases render automatically inside the sandbox.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@nicodes/reindr-opencode"]
}
```

For local source development, install workspace dependencies and run `npm run build:core`; the repository's `.opencode/plugins/reindr.ts` loads adapter source. Do not load the npm adapter alongside it. See the root README's local integration instructions for isolated data/config directories.

The local panel defaults to port `7676`, incrementing by one only on `EADDRINUSE`, up to `65535` without wrapping. A valid explicit `REINDR_PORT` or plugin `port` option never increments or falls back, even if it is `7676`; an occupied port reports an error. Explicit `0` asks the OS to assign a port. The environment takes precedence over the plugin option; invalid or empty selected values use the default policy. Other startup errors fail without retry.

`reindr_open({ canvasID: "preview", title: "Preview" })` returns the tab's editable HTML path; optionally add `template: "saved.html"` to initialize a new tab from a saved template. Reusing its stable ID preserves existing HTML and its initial title; omitting the ID uses the legacy/default file. New tabs default to blank HTML, not controller HTML. New sessions have host agent controls even with no canvas files. Generated canvases retain only the limited activated submit/sizing bridge; controller RPC is reserved for recognized legacy controller bytes.
