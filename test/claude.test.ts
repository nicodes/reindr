import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer, type AddressInfo } from "node:net"
import test from "node:test"
import { chromium } from "playwright-core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const chromiumExecutablePath = process.env.CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium"

test("Claude MCP uses sequential defaults, rejects occupied explicit ports, and supports zero", { timeout: 20_000 }, async t => {
  const held = []
  for (const port of [7676, 7677, 0]) {
    const server = createServer()
    server.listen(port, "127.0.0.1")
    await once(server, "listening")
    held.push(server)
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  }
  const customPort = (held[2].address() as AddressInfo).port
  for (const scenario of [
    { name: "default occupied twice", configured: undefined, expected: 7678 },
    { name: "explicit default occupied", configured: "7676", error: 7676 },
    { name: "explicit custom occupied", configured: String(customPort), error: customPort },
    { name: "OS assigned", configured: "0" },
  ]) await t.test(scenario.name, async t => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "reindr-claude-port-"))
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
    delete env.REINDR_PORT
    delete env.REINDR_DIRECTORY
    delete env.REINDR_TEMPLATE_DIRECTORY
    if (scenario.configured !== undefined) env.REINDR_PORT = scenario.configured
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("packages/claude/dist/server.mjs")],
      env: { ...env, REINDR_PLUGIN_ROOT: path.resolve("packages/claude"), REINDR_DATA_DIRECTORY: temporaryDirectory, REINDR_AUTORAISE: "0" },
      stderr: "pipe",
    })
    const client = new Client({ name: "reindr-port-test", version: "1.0.0" })
    t.after(async () => {
      await client.close()
      await rm(temporaryDirectory, { recursive: true, force: true })
    })
    const errors: string[] = []
    transport.stderr?.on("data", chunk => errors.push(String(chunk)))
    await client.connect(transport)
    for (const name of ["reindr_open", "reindr_status"]) {
      const result = await client.callTool({ name, arguments: {} }, undefined, { timeout: 2_000 })
      const text = (result.content as { text: string }[])[0].text
      if (scenario.error) {
        assert.equal(result.isError, true)
        assert.match(text, new RegExp(`port ${scenario.error} is already in use.*explicit ports are never retried`))
        assert.doesNotMatch(text, /http:\/\//)
      } else {
        assert.notEqual(result.isError, true)
        const url = new URL(JSON.parse(text).panelUrl)
        if (scenario.expected) assert.equal(Number(url.port), scenario.expected)
        else assert.ok(Number(url.port) > 0)
        assert.equal((await fetch(url)).status, 200)
      }
    }
    if (scenario.error) assert.match(errors.join(""), /Reindr panel server failed to start/)
    else assert.deepEqual(errors, [])
  })
})

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
  assert.equal(new URL(page.url()).searchParams.has("token"), false, "the Claude panel removes its token from the address bar")
  await page.reload()
  await assert.doesNotReject(() => frame.locator("body[data-synthetic-blocked=true]").waitFor())
  assert.equal(new URL(page.url()).searchParams.has("token"), false, "a refreshed Claude panel recovers authentication without exposing its token")

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
