---
name: interface
description: Build an interactive visual interface for a task. Use when the user asks for a dashboard, form, visualization, control panel, chooser, preview, or other browser UI.
allowed-tools: mcp__plugin_reindr_reindr__reindr_open, mcp__plugin_reindr_reindr__reindr_wait, mcp__plugin_reindr_reindr__reindr_status, Read, Write, Edit
---

# Reindr Interface

Call `mcp__plugin_reindr_reindr__reindr_open` before authoring the interface. Use the exact `uiFile` returned by the tool; do not guess a path.

Write a complete, self-contained HTML document to that file with inline CSS and JavaScript. Network access is blocked by default. Make the interface responsive and accessible, and show real task state rather than decorative placeholder data.

Use `window.reindr.submit(value)` directly inside a real click or form-submit handler to return an interaction. Values must be JSON-serializable and should include a concise `action` field. Example:

```html
<button type="button" id="approve">Approve</button>
<script>
  document.querySelector('#approve').addEventListener('click', () => {
    window.reindr.submit({ action: 'approve' })
  })
</script>
```

When the next step depends on the user's choice, call `mcp__plugin_reindr_reindr__reindr_wait`. Otherwise continue working; the background monitor will notify Claude when the user submits an interaction.
