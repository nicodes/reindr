# Reindr for Claude Code

The Claude Code adapter is distributed from the `nicodes/reindr` marketplace rather than npm. It includes a skill, a local MCP server, a session hook, a background interaction monitor, and an opt-in Claude channel.

```text
/plugin marketplace add nicodes/reindr
/plugin install reindr@nicodes
```

Restart Claude Code after installation. Ask Claude to build an interface, or invoke `/reindr:interface`. Reindr returns the exact HTML path Claude should edit and opens a sandboxed loopback panel that live-reloads when the file changes.

Browser interactions are delivered through the plugin monitor by default. Claude can instead wait for the next interaction with `reindr_wait`. The MCP server also implements Claude's research-preview channel contract; start Claude Code with `--dangerously-load-development-channels plugin:reindr@nicodes` and set `REINDR_CLAUDE_CHANNEL=1` to test direct channel injection.

The plugin requires Node.js 20 or later. Its MCP runtime is bundled into the plugin artifact, so marketplace installation does not run a dependency installer or reference files outside the cached plugin directory.
