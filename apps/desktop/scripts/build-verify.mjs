// 把无头验证脚本单独打包成可执行的 CJS，然后用 node 运行。
// 之所以不直接跑 TS：验证脚本不依赖 Electron，用 esbuild 单独打包
// 可以避免引入 electron 依赖，能在任何 Node 环境重复执行。

import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'src/main/verify-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(root, 'out/verify/verify.js'),
  external: ['electron'],
  logLevel: 'silent'
})

console.log('[verify] 已打包 out/verify/verify.js\n')

const child = spawn(process.execPath, [join(root, 'out/verify/verify.js'), ...process.argv.slice(2)], {
  stdio: 'inherit'
})

child.on('exit', (code) => process.exit(code ?? 0))
