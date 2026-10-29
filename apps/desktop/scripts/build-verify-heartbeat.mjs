// 打包并运行「在线状态（心跳/断连）」无头测试。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src/main/verify-heartbeat.ts')
const outfile = join(root, 'out/verify/verify-heartbeat.js')

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['electron', 'ws', 'bonjour-service', 'selfsigned'],
  logLevel: 'silent'
})

console.log('[verify-heartbeat] 已打包 out/verify/verify-heartbeat.js')
const res = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(res.status ?? 1)
