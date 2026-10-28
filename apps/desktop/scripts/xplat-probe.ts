// 跨平台直连验证：Windows Host → Android（已知 IP 与端口）
// mDNS 互通有问题（见 README），这里绕过发现层，直连验证协议本身
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Host } from '../src/main/host'
import type { DiscoveredService } from '../src/main/discovery'
import type { TrustEntry } from '../src/main/transfer/trust'

async function main(): Promise<void> {
  // 固定目录而非每轮 mkdtemp：身份证书与信任清单要跨轮次保留。
  // 每轮新身份会让对端信任清单堆满同名条目（曾堆到 9 条，
  // 把界面里的传输卡片挤出屏幕，uiautomator 再也找不到接收按钮）。
  const workDir = process.env.LINKSPACE_PROBE_HOME ?? '/tmp/linkspace-probe-home'
  await mkdir(workDir, { recursive: true })

  const host = new Host({
    displayName: 'XPlat-Test',
    deviceType: 'win',
    dataDir: workDir
  })
  await host.start()
  console.log(`[host] 启动，id=${host.id}，端口=${host.port}`)

  // 本机是发起方，配对码显示在 Android 屏幕上。
  // 联调时从 logcat 读取：adb logcat -s LinkSpace/Service
  const codeFile = process.env.LINKSPACE_PAIR_CODE_FILE

  // 直连 Android：绕过 mDNS 发现
  // 目标设备与端口可经环境变量覆盖：应用重启后端口会变，
  // 硬编码的话每次重启探测都会连到已关闭的端口上。
  const svc: DiscoveredService = {
    serviceName: 'LinkSpace-TB710FU',
    idPrefix: '2b75a6937085',
    displayName: 'TB710FU',
    deviceType: 'android-tablet',
    caps: ['file'],
    host: process.env.LINKSPACE_TARGET_HOST ?? '192.168.101.111',
    port: Number(process.env.LINKSPACE_TARGET_PORT ?? 35123),
    lastSeen: Date.now(),
    paired: false
  }
  console.log(`[net] 连接 ${svc.host}:${svc.port} …`)
  const conn = await host.connect(svc)
  console.log(`[net] 已连接`)

  // 等身份声明完成
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (conn.peerId) { clearInterval(t); resolve() }
    }, 100)
    setTimeout(() => { clearInterval(t); resolve() }, 5000)
  })
  console.log(`[net] 对端身份 = ${conn.peerId || '(未知)'}`)

  // 已信任则跳过配对：对端收到已信任设备的 pair.request 会直接忽略，
  // 不跳过的话会死等一个永远不会出现的配对码。
  // 用连接后动态拿到的对端 ID，不硬编码：对端重装应用后证书会变，
  // 硬编码的 ID 会让「已配对」检查永远为真或永远为假。
  const PAD_DEVICE_ID = conn.peerId
  const alreadyPaired = host.trustedDevices().some((d) => d.deviceId === PAD_DEVICE_ID)
  let pairingPromise: Promise<TrustEntry> | null = null
  if (alreadyPaired) {
    console.log('[pair] 双方已配对，跳过配对流程')
  } else {
    pairingPromise = host.requestPairing(conn)
    console.log('[pair] 已发起配对，等待 Android 显示配对码…')
  }

  // Android 端会显示配对码；这里从日志拿。等 20 秒让人工读取。
  let entry: TrustEntry | null = null
  if (pairingPromise) {
    const deadline = Date.now() + 40000
    let pairingCode = ''
    while (!pairingCode && Date.now() < deadline) {
      if (codeFile) {
        const { readFileSync, existsSync } = await import('node:fs')
        if (existsSync(codeFile)) {
          pairingCode = readFileSync(codeFile, 'utf8').trim()
        }
      }
      if (!pairingCode) await new Promise((r) => setTimeout(r, 500))
    }
    if (!pairingCode) {
      console.log('[pair] 未在 40 秒内收到配对码（需要 Android 界面操作或日志读取）')
      await host.stop()
      process.exit(2)
    }

    console.log(`[pair] 提交配对码 ${pairingCode}`)
    const submit = host.submitCode(conn, pairingCode)
    console.log(`[pair] submit 结果: ${JSON.stringify(submit)}`)

    entry = await pairingPromise
    console.log(`[pair] 配对成功！trust=${entry.deviceId} scope=${entry.scope.join(',')}`)
  } else {
    entry = host.trustedDevices().find((d) => d.deviceId === PAD_DEVICE_ID) ?? null
    console.log(`[pair] 使用既有信任: ${entry?.deviceId}`)
  }

  try {

    // 传输一个文件
    const srcPath = join(workDir, 'cross-platform.txt')
    const payload = Buffer.from('LinkSpace 跨平台传输验证 '.repeat(200))
    await writeFile(srcPath, payload)
    const digest = createHash('sha256').update(payload).digest('hex')

    if (!entry) {
      console.log('[xfer] 失败: 没有可用的信任条目')
      await host.stop()
      process.exit(3)
    }
    console.log(`[xfer] 发起传输 ${payload.length} 字节`)
    const task = await host.offerFiles(entry.deviceId, [
      { name: 'cross-platform.txt', path: srcPath, size: payload.length }
    ])
    console.log(`[xfer] 任务 ${task.id} 状态 ${task.state}`)

    const done = await new Promise<string>((resolve) => {
      const timer = setInterval(() => {
        const t = host.transferTasks().find((x) => x.id === task.id)
        if (t && (t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled')) {
          clearInterval(timer)
          resolve(t.state + (t.error ? ` (${t.error})` : ''))
        }
      }, 300)
      setTimeout(() => { clearInterval(timer); resolve('timeout') }, 60000)
    })
    console.log(`[xfer] 最终状态: ${done}`)
    console.log(`[xfer] 期望 SHA-256: ${digest.slice(0, 16)}…`)
  } catch (err) {
    console.log(`[xfer] 失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  await host.stop()
  process.exit(0)
}

void main()
