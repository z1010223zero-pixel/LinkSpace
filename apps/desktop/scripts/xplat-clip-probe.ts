// 剪贴板同步真机验证：Windows Host → Android 平板。
// 复用既有配对信任，只走「连接 → 发 clipboard.share → 验证对端不反弹」。
// 不复用 xplat-probe.ts：那一个偏重传输，混在一起会让日志难以归因。
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Host } from '../src/main/host'
import type { DiscoveredService } from '../src/main/discovery'

async function main(): Promise<void> {
  // 固定目录：信任要跨轮次保留，否则每轮都重新配对
  const workDir = process.env.LINKSPACE_PROBE_HOME ?? '/tmp/linkspace-clip-probe'
  await mkdir(workDir, { recursive: true })

  const host = new Host({ displayName: 'XPlat-Clip', deviceType: 'win', dataDir: workDir })
  await host.start()
  console.log(`[host] 启动，id=${host.id}，端口=${host.port}`)

  const svc: DiscoveredService = {
    serviceName: 'LinkSpace-TB710FU',
    idPrefix: '2b75a6937085',
    displayName: 'TB710FU',
    deviceType: 'android-tablet',
    caps: ['file', 'clipboard'],
    host: process.env.LINKSPACE_TARGET_HOST ?? '192.168.101.111',
    port: Number(process.env.LINKSPACE_TARGET_PORT ?? 35123),
    lastSeen: Date.now(),
    paired: false
  }

  console.log(`[net] 连接 ${svc.host}:${svc.port} …`)
  const conn = await host.connect(svc)
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (conn.peerId) { clearInterval(t); resolve() }
    }, 100)
    setTimeout(() => { clearInterval(t); resolve() }, 5000)
  })
  console.log(`[net] 对端身份 = ${conn.peerId || '(未知)'}`)

  // 注入内存剪贴板，发一段文本，并监听对端是否把它反弹回来
  let clipboard = ''
  const received: string[] = []
  host.enableClipboardSync({
    readText: () => clipboard,
    writeText: (t) => {
      clipboard = t
      received.push(t)
    }
  })

  const trusted = host.trustedDevices().some((d) => d.deviceId === conn.peerId)
  console.log(`[pair] 已配对: ${trusted}，scope=${host.trustedDevices().find((d) => d.deviceId === conn.peerId)?.scope.join(',') ?? '(无)'}`)
  if (!trusted) {
    console.log('[clip] 未配对，放弃（先跑 run-xplat-verify.sh 建立信任）')
    await host.stop()
    process.exit(2)
  }

  clipboard = '来自 LinkSpace 剪贴板同步验证的文本'
  host.pollClipboard()
  console.log('[clip] 已发送 clipboard.share')

  // 给对端 5 秒：写入本机剪贴板需要时间，反弹（回环）也会在这期间到达
  await new Promise((r) => setTimeout(r, 5000))
  host.pollClipboard()

  const echoed = received.length > 0
  console.log(`[clip] 本端是否收到回推: ${echoed}（次数 ${received.length}）`)
  if (echoed) console.log('[clip] 出现回环！')

  await host.stop()
  process.exit(echoed ? 1 : 0)
}

main().catch((err) => {
  console.error('探测异常：', err)
  process.exit(1)
})
