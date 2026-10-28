// 开发模式启动包装。
//
// 为什么需要它：
// 宿主环境（WorkBuddy 本身是 Electron 应用）会向子进程传递
// ELECTRON_RUN_AS_NODE=1，这会让 electron.exe 退化成纯 Node 运行，
// 表现为 require('electron') 返回 npm 包的路径字符串，app 等 API
// 全部为 undefined，启动即抛 TypeError。
//
// 因此启动前必须从环境中删除该变量。注意：把它设为空字符串无效，
// Electron 判断的是变量是否存在，而非其值。

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

delete process.env.ELECTRON_RUN_AS_NODE

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const child = spawn(npx, ['electron-vite', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32'
})

child.on('error', (err) => {
  console.error('[dev] 启动失败:', err.message)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[dev] electron-vite 被信号终止: ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 0)
})
