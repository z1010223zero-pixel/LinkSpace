// 打包并运行「键鼠共享」无头测试。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src/main/verify-input.ts')
const outfile = join(root, 'out/verify/verify-input.js')

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['electron', 'ws', 'bonjour-service', 'selfsigned'],
  logLevel: 'silent'
})

console.log('[verify-input] 已打包 out/verify/verify-input.js')
const res = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(res.status ?? 1)
