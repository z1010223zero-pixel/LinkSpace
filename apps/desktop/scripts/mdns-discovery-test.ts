// mDNS 互通验证（需要 Android 设备在线）。
//
// 与其他 verify 不同：这个必须有真机在局域网内，否则必然 FAIL。
// 所以它不进「全套无头回归」，单独跑：
//
//   npm run verify:mdns
//
// 修复历史（2026-10-29，三层问题叠加，现象极具迷惑性）：
//   1. Android 的组播锁在 advertise 之后才获取 → 通告静默发不出去
//   2. multicast-dns 的 interface 选中了 CGNAT 网卡 → 查询发不到局域网
//   3. Android 的 TXT 缺 ver 字段 → 桌面端 parseTxt 直接拒收
// 三层各自的表现都是「底层 mDNS 通，上层发现不了」，必须逐层隔离排查。
import { Discovery } from '../src/main/discovery'

const TIMEOUT_MS = Number(process.env.LINKSPACE_MDNS_TIMEOUT ?? 15000)

const d = new Discovery({
  displayName: 'Win-Test',
  deviceType: 'win',
  deviceId: 'aabbccddeeff00112233445566778899',
  port: 12345,
  caps: ['file', 'clipboard'],
  staleMs: 60_000
})

const found: Array<{ name: string; host: string; port: number; caps: string }> = []
d.on('up', (svc) => {
  found.push({ name: svc.displayName, host: svc.host, port: svc.port, caps: svc.caps.join(',') })
  console.log(`  [发现] ${svc.displayName} (${svc.deviceType}) @ ${svc.host}:${svc.port} caps=${svc.caps.join(',')}`)
})

console.log(`\n=== LinkSpace mDNS 互通验证（需 Android 在线，${TIMEOUT_MS / 1000}s）===\n`)
d.start()

setTimeout(() => {
  d.stop()
  if (found.length === 0) {
    console.log('\n  [FAIL] 未发现任何设备')
    console.log('  排查顺序：')
    console.log('    1. Android 应用是否在运行（adb logcat -s LinkSpace/Service）')
    console.log('    2. 平板与电脑是否在同一网段')
    console.log('    3. 若日志提示「多个局域网地址」，用 LINKSPACE_BIND_IP 指定网卡')
    process.exit(1)
  }
  // 至少发现一个带 IP 地址的设备才算通：拿到主机名而拿不到 IP，
  // 说明 SRV 应答了但 A 记录查询没成功，连接时仍然会失败
  const withIp = found.filter((f) => /^\d+\.\d+\.\d+\.\d+$/.test(f.host))
  if (withIp.length === 0) {
    console.log('\n  [FAIL] 发现了设备但拿不到 IP 地址')
    process.exit(1)
  }
  console.log(`\n=== 结果：全部通过（${withIp.length} 台带 IP 的设备）===\n`)
  process.exit(0)
}, TIMEOUT_MS)
