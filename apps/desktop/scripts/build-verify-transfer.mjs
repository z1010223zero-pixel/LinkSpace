// 打包并运行文件传输无头测试。
// 与 build-verify.mjs 相同的思路：esbuild 单独打包，node 运行，不依赖 Electron。

import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'src/main/verify-transfer.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(root, 'out/verify/verify-transfer.js'),
  // electron 必须外置：identity.ts 顶部 import 了它，无头环境下
  // 外置后走的是 node_modules/electron/index.js（返回路径字符串），
  // identity.ts 已对该情况做显式判错并要求 setIdentityDir()
  external: ['electron'],
  logLevel: 'silent'
})

console.log('[verify-transfer] 已打包 out/verify/verify-transfer.js\n')

const child = spawn(
  process.execPath,
  [join(root, 'out/verify/verify-transfer.js'), ...process.argv.slice(2)],
  { stdio: 'inherit' }
)

child.on('exit', (code) => process.exit(code ?? 0))
