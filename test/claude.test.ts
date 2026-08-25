import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { spawn } from "node:child_process"
import test from "node:test"
import { chromium } from "playwright-core"

const chromiumExecutablePath = process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium"

test("Claude MCP opens a sandboxed panel and receives only trusted interactions", async t => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "reindr-claude-test-"))
  const server = spawn(process.execPath, [path.resolve("packages/claude/dist/server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      REINDR_PLUGIN_ROOT: path.resolve("packages/claude"),
      REINDR_DATA_DIRECTORY: temporaryDirectory,
      REINDR_PROJECT_DIRECTORY: process.cwd(),
      REINDR_AUTORAISE: "0",
      REINDR_PORT: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const errors: string[] = []
  server.stderr.setEncoding("utf8")
  server.stderr.on("data", chunk => errors.push(chunk))

  let requestId = 0
  const responses = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  const lines = readline.createInterface({ input: server.stdout })
  lines.on("line", line => {
    const message = JSON.parse(line)
    if (typeof message.id !== "number") return
    const pending = responses.get(message.id)
    if (!pending) return
    responses.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
  })

  function request(method: string, params: unknown) {
    const id = ++requestId
    const response = new Promise<any>((resolve, reject) => responses.set(id, { resolve, reject }))
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    return response
  }

  function notify(method: string, params: unknown = {}) {
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  t.after(async () => {
    lines.close()
    server.kill("SIGTERM")
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "reindr-test", version: "0.0.1" },
  })
  notify("notifications/initialized")

  const tools = await request("tools/list", {})
  assert.deepEqual(tools.tools.map((tool: { name: string }) => tool.name), ["reindr_open", "reindr_wait", "reindr_status"])

  const opened = await request("tools/call", { name: "reindr_open", arguments: { title: "Claude integration test" } })
  const details = JSON.parse(opened.content[0].text)
  assert.match(details.uiFile, /\.html$/)
  assert.match(details.panelUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/)

  const unauthenticated = await fetch(new URL("/", details.panelUrl))
  assert.equal(unauthenticated.status, 404)
  const shell = await fetch(details.panelUrl)
  assert.equal(shell.status, 200)
  assert.match(shell.headers.get("content-security-policy") || "", /frame-ancestors 'none'/)
  assert.match(await shell.text(), /sandbox="allow-scripts allow-forms"/)

  await writeFile(details.uiFile, `<!doctype html><html><body>
    <button id="send" type="button">Send choice</button>
    <script>
      try { window.reindr.submit({ action: "synthetic" }) } catch { document.body.dataset.syntheticBlocked = "true" }
      document.querySelector("#send").addEventListener("click", () => {
        try { window.reindr.submit({ action: "choose", value: 7 }) } catch (error) { document.body.dataset.clickError = error.message }
      })
    </script>
  </body></html>`)

  const browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const pageErrors: string[] = []
  page.on("pageerror", error => pageErrors.push(error.message))
  await page.goto(details.panelUrl)
  const frame = page.frameLocator("iframe")
  await assert.doesNotReject(() => frame.locator("body[data-synthetic-blocked=true]").waitFor())

  const interaction = request("tools/call", { name: "reindr_wait", arguments: { timeoutSeconds: 10 } })
  const submitted = page.waitForRequest(request => new URL(request.url()).pathname === "/interaction", { timeout: 2_000 })
  await frame.locator("#send").click()
  await submitted.catch(async error => {
    const clickError = await frame.locator("body").getAttribute("data-click-error")
    throw new Error(`Interaction request was not sent: ${clickError || pageErrors.join("; ") || error.message}`)
  })
  const received = await interaction
  assert.deepEqual(JSON.parse(received.content[0].text), { action: "choose", value: 7 })
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(errors, [])
})
