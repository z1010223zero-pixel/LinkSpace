// 打包并运行 mDNS 发现验证（用真实的 Discovery 类）。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'scripts/mdns-discovery-test.ts')
const outfile = join(root, 'out/verify/mdns-discovery-test.js')

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  // bonjour-service 等运行时依赖不打进去，从 node_modules 读
  external: ['electron', 'ws', 'bonjour-service', 'selfsigned'],
  logLevel: 'silent'
})

console.log('[mdns-test] 已打包')
const res = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
process.exit(res.status ?? 1)
