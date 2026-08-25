import { open, stat } from "node:fs/promises"
import path from "node:path"

const dataDirectory = process.argv[2] || process.env.REINDR_DATA_DIRECTORY || process.env.CLAUDE_PLUGIN_DATA
if (!dataDirectory) process.exit(0)

const queueFile = path.join(dataDirectory, "interactions.jsonl")
let offset = 0
let incompleteLine = ""

try {
  offset = (await stat(queueFile)).size
} catch (error) {
  if (error?.code !== "ENOENT") console.error(error)
}

async function poll() {
  let handle
  try {
    const info = await stat(queueFile)
    if (info.size < offset) offset = 0
    if (info.size === offset) return

    handle = await open(queueFile, "r")
    const length = Math.min(info.size - offset, 64 * 1024)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    offset += bytesRead

    const records = `${incompleteLine}${buffer.subarray(0, bytesRead).toString("utf8")}`.split("\n")
    incompleteLine = records.pop() || ""
    for (const line of records) {
      if (!line) continue
      try {
        const event = JSON.parse(line)
        const payload = JSON.stringify(event.payload).slice(0, 8_000)
        process.stdout.write(`Reindr interaction from session ${event.sessionId}: ${payload}\n`)
      } catch {
        // Ignore partial or malformed records; the MCP server writes complete JSON lines.
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.error(error)
  } finally {
    await handle?.close()
  }
}

const timer = setInterval(() => void poll(), 250)
timer.unref()
process.stdin.resume()
