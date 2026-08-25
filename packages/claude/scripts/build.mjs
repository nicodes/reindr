import { copyFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = path.resolve(pluginRoot, "..", "..")
const vendorDirectory = path.join(pluginRoot, "vendor")
const assetsDirectory = path.join(pluginRoot, "assets")

await Promise.all([
  mkdir(vendorDirectory, { recursive: true }),
  mkdir(assetsDirectory, { recursive: true }),
])

await Promise.all([
  copyFile(path.join(repositoryRoot, "packages/core/dist/index.js"), path.join(vendorDirectory, "reindr-core.mjs")),
  copyFile(path.join(repositoryRoot, "packages/opencode/assets/reindr-loading.html"), path.join(assetsDirectory, "reindr-loading.html")),
  copyFile(path.join(repositoryRoot, "packages/opencode/assets/reindr-tailwind.css"), path.join(assetsDirectory, "reindr-tailwind.css")),
  copyFile(path.join(repositoryRoot, "LICENSE"), path.join(pluginRoot, "LICENSE")),
])

const bundle = await build({
  entryPoints: [path.join(pluginRoot, "server.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  minify: true,
  legalComments: "none",
  write: false,
})

await mkdir(path.join(pluginRoot, "dist"), { recursive: true })
await writeFile(
  path.join(pluginRoot, "dist", "server.mjs"),
  bundle.outputFiles[0].text.replace(/^[\t ]+$/gm, ""),
)
