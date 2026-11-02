// 无头验证脚本：直接驱动主进程的 adb 枚举与 scrcpy 会话适配器，
// 不依赖 Electron GUI，可重复运行并给出断言结果。
//
// 用法：
//   node out/verify/verify.js            # 完整验证（含启动/停止投屏）
//   node out/verify/verify.js --scan     # 只扫描设备
//
// 该脚本会被 esbuild 单独打包，不引入 electron 依赖。
//
// 注意：本脚本直接调 adapter.start，不走 scrcpy:startFor 的配对门禁
// （W2）——它是 Windows 开发机上的无头验证 harness，没有 Host/信任
// store 可接，不是产品路径。产品内唯一启动入口是 ipc.ts 的
// scrcpy:startFor，不要照抄本脚本绕过门禁。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listDevices } from './adb'
import { ScrcpyAdapter } from './scrcpy-adapter'

const execFileAsync = promisify(execFile)

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  const mark = pass ? 'PASS' : 'FAIL'
  if (!pass) failures++
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function countScrcpyProcesses(): Promise<number> {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq scrcpy.exe', '/NH'], {
      windowsHide: true,
      timeout: 8000
    })
    return (stdout.match(/scrcpy\.exe/gi) ?? []).length
  } catch {
    return -1
  }
}

async function main(): Promise<void> {
  const scanOnly = process.argv.includes('--scan')

  console.log('\n=== LinkSpace 会话适配器无头验证 ===\n')

  // 1. 设备枚举
  console.log('1. adb 设备枚举')
  const devices = await listDevices()
  check('枚举命令执行', Array.isArray(devices))
  for (const d of devices) {
    console.log(
      `     - ${d.model ?? d.serial} | state=${d.state} | ${d.wireless ? '无线' : 'USB'} | ${d.serial}`
    )
  }

  const online = devices.filter((d) => d.state === 'device')
  check('存在可用设备', online.length > 0, `${online.length} 台在线`)

  if (scanOnly || online.length === 0) {
    console.log('\n跳过会话测试。\n')
    report()
    return
  }

  // 2. 启动会话
  const target = online[0]
  console.log(`\n2. 启动投屏会话（无窗口模式）：${target.serial}`)
  const before = await countScrcpyProcesses()
  console.log(`     启动前 scrcpy 进程数：${before}`)

  const adapter = new ScrcpyAdapter()
  const started = await adapter.start(target.serial, { noWindow: true, maxSize: 800 })

  if (!started.ok) {
    check('会话启动', false, `${started.error.code}: ${started.error.message}`)
    report()
    return
  }
  check('会话启动', started.value.state === 'running', `id=${started.value.id} pid=${started.value.pid}`)

  const running = await countScrcpyProcesses()
  console.log(`     运行中 scrcpy 进程数：${running}`)
  check('进程已创建', running > before)

  // 3. 并发拒绝：同一设备重复启动
  console.log('\n3. 同设备重复启动应被拒绝');
  const dup = await adapter.start(target.serial, { noWindow: true })
  check('重复启动被拒绝', !dup.ok && dup.error.code === 'SESSION_EXISTS', dup.ok ? '意外成功' : dup.error.code)

  // 4. 停止会话
  console.log('\n4. 停止会话')
  const stopped = await adapter.stop(started.value.id)
  check('停止调用成功', stopped.ok)
  await sleep(1200)

  const after = await countScrcpyProcesses()
  console.log(`     停止后 scrcpy 进程数：${after}`)
  check('进程已清理', after === before, `期望 ${before}，实际 ${after}`)

  const finalState = adapter.get(started.value.id)
  check(
    '会话状态归位',
    finalState?.state === 'stopped' || finalState?.state === 'error',
    `state=${finalState?.state}`
  )

  // 5. 停止不存在的会话
  console.log('\n5. 停止不存在的会话');
  const ghost = await adapter.stop('scr-does-not-exist')
  check('安全返回错误而非崩溃', !ghost.ok, ghost.ok ? '意外成功' : ghost.error.code)

  report()
}

function report(): void {
  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n验证脚本异常：', err)
  process.exit(1)
})
