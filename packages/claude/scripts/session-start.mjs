const context = [
  "Reindr is available for interactive browser interfaces.",
  "When a task benefits from a dashboard, form, visualization, chooser, or control panel, use the reindr:interface skill and call the reindr_open MCP tool before writing UI HTML.",
  "Always edit the exact uiFile returned by the tool.",
].join(" ")

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: context,
  },
})}\n`)
