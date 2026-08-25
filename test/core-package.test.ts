import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {
  canvasFileName,
  normalizeAssetOrigins,
  resolveReindrConfig,
  sessionPath,
} from "../packages/core/src/index.ts"

test("core resolves secure host-neutral defaults and overrides", () => {
  const worktree = path.resolve("/tmp/reindr-worktree")
  const config = resolveReindrConfig(worktree, {
    port: 0,
    autoOpen: false,
    canvasDirectory: "state/sessions",
    allowedAssetHosts: ["cdn.jsdelivr.net", "http://insecure.example", "https://example.com/path"],
  }, {
    XDG_DATA_HOME: "/tmp/reindr-data",
    REINDR_ALLOWED_ASSET_HOSTS: "assets.example.com,https://cdn.jsdelivr.net",
  })

  assert.equal(config.preferredPort, 0)
  assert.equal(config.autoOpen, false)
  assert.equal(config.canvasDirectory, path.join(worktree, "state", "sessions"))
  assert.equal(config.templateDirectory, path.join(worktree, "state", "templates"))
  assert.deepEqual(config.allowedAssetOrigins, ["https://cdn.jsdelivr.net", "https://assets.example.com"])
})

test("core creates stable encoded session paths without path separators", () => {
  assert.equal(canvasFileName("session/a b"), "session%2Fa%20b.html")
  assert.equal(sessionPath("session/a b"), "/s/session%2Fa%20b")
  assert.throws(() => canvasFileName(""), /cannot be empty/i)
  assert.deepEqual(normalizeAssetOrigins(["user:pass@example.com", "https://safe.example"]), ["https://safe.example"])
})
