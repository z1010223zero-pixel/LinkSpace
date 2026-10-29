// 验证 5353 端口是否可绑定。
// bonjour-service 的 browser 需要 bind UDP 5353 才能收发 mDNS。
// 如果 Windows 自身的 mDNS 响应器（或残留进程）占着它，browser 会静默失效——
// 表现为「组播能收到包（别人的 socket），但自己收不到、查询也发不出」。
const dgram = require('node:dgram')

const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
s.on('error', (e) => {
  console.log('★ bind 失败:', e.code, e.message)
  console.log('  → 5353 被占用，bonjour-service 的 browser 无法工作')
  process.exit(1)
})
s.bind(5353, () => {
  console.log('✓ bind 5353 成功（reuseAddr）')
  try {
    s.addMembership('224.0.0.251')
    console.log('✓ 加入组播组成功')
  } catch (e) {
    console.log('★ 加入组播组失败:', e.message)
  }
  s.close()
  console.log('--- 端口可用性检查结束 ---')
  process.exit(0)
})
