// 打包并运行「scrcpy 配对门禁」无头测试（W2 安全修复）。
import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const entry = join(root, "src/main/verify-binding.ts")
const outfile = join(root, "out/verify/verify-binding.js")

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  external: ["electron", "ws", "bonjour-service", "selfsigned"],
  logLevel: "silent"
})

console.log("[verify-binding] 已打包 out/verify/verify-binding.js")
const res = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" })
process.exit(res.status ?? 1)
