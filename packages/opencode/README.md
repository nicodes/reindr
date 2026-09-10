# @nicodes/reindr-opencode

The Reindr plugin for OpenCode. Version `0.0.2` provides session navigation, independent host-owned agent controls, and multiple named HTML canvas tabs in the main header. Saved canvases render automatically inside the sandbox.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@nicodes/reindr-opencode"]
}
```

For local source development, install workspace dependencies and run `npm run build:core`; the repository's `.opencode/plugins/reindr.ts` loads adapter source. Do not load the npm adapter alongside it. See the root README's local integration instructions for isolated data/config directories.

`reindr_open({ canvasID: "preview", title: "Preview" })` returns the tab's editable HTML path; optionally add `template: "saved.html"` to initialize a new tab from a saved template. Reusing its stable ID preserves existing HTML and its initial title; omitting the ID uses the legacy/default file. New tabs default to blank HTML, not controller HTML. New sessions have host agent controls even with no canvas files. Generated canvases retain only the limited activated submit/sizing bridge; controller RPC is reserved for recognized legacy controller bytes.
