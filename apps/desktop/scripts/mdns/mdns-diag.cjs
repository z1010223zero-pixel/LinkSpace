// mDNS 连通性诊断：不带过滤器，抓所有 224.0.0.251 流量。
// 用来区分「对端没发」与「本机收不到」——这两种情况的修法完全不同。
const dgram = require('node:dgram')
const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
let count = 0
const senders = new Map()
s.on('message', (msg, rinfo) => {
  count++
  senders.set(rinfo.address, (senders.get(rinfo.address) ?? 0) + 1)
  const txt = msg.toString('latin1')
  // 只打印与 linkspace 相关的包，其余只计数
  if (/linkspace/i.test(txt)) {
    const names = [...txt.matchAll(/([A-Za-z0-9_\-\.]+linkspace[A-Za-z0-9_\-\.]*)/gi)].map(m => m[1])
    console.log(`★ LinkSpace 包 来自 ${rinfo.address}:${rinfo.port} 长度=${msg.length} 名称=${[...new Set(names)].join(',')}`)
  }
})
s.bind(5353, () => {
  try { s.addMembership('224.0.0.251') } catch (e) { console.log('加入组播出错:', e.message) }
  console.log('已监听 224.0.0.251:5353（全流量），等待 15 秒…')
})
setTimeout(() => {
  console.log(`--- 结束：共 ${count} 个 mDNS 包 ---`)
  if (count === 0) {
    console.log('★ 一个包都没收到。本机可能没有加入组播组，或网卡禁用了组播。')
  } else {
    console.log('来源分布：', [...senders.entries()].map(([k, v]) => `${k}×${v}`).join(', '))
    console.log('★ 有流量但没有 LinkSpace 包 → 对端没有在发，或发的类型名不匹配')
  }
  process.exit(0)
}, 15000)
