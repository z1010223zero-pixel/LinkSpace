// 打包并运行「高性能投屏」无头测试。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src/main/verify-fast.ts')
const outfile = join(root, 'out/verify/verify-fast.js')

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['electron', 'ws', 'bonjour-service', 'selfsigned'],
  logLevel: 'silent'
})

console.log('[verify-fast] 已打包 out/verify/verify-fast.js')
const res = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(res.status ?? 1)
