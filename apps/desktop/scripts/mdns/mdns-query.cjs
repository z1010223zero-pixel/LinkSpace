// 手动构造 mDNS PTR 查询并等待应答。
// 目的：区分「Windows 的查询发不出去」与「Android 不答应」。
// 前面已知：Android 会在启动时突发通告（组播层能收到），
// 但 bonjour-service 的 browser 主动查询时拿不到服务。
const dgram = require('node:dgram')

function encodeName(name) {
  const parts = name.split('.')
  const bufs = []
  for (const p of parts) {
    bufs.push(Buffer.from([p.length]), Buffer.from(p, 'latin1'))
  }
  bufs.push(Buffer.from([0]))
  return Buffer.concat(bufs)
}

const query = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  encodeName('_linkspace._tcp.local'),
  Buffer.from([0x00, 0x0c, 0x00, 0x01]) // type=PTR, class=IN
])

const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
let answered = 0

s.on('message', (msg, rinfo) => {
  const txt = msg.toString('latin1')
  const flags = msg.readUInt16BE(2)
  const isResponse = (flags & 0x8000) !== 0
  const ancount = msg.readUInt16BE(6)
  if (/linkspace/i.test(txt)) {
    answered++
    console.log(`★ 收到来自 ${rinfo.address}:${rinfo.port} 响应=${isResponse ? '是' : '否'} 应答数=${ancount} 长度=${msg.length}`)
  }
})

s.bind(5353, () => {
  try { s.addMembership('224.0.0.251') } catch (e) { console.log('组播失败', e.message) }
  console.log('发送 PTR 查询 _linkspace._tcp.local …')
  for (let i = 0; i < 3; i++) {
    s.send(query, 5353, '224.0.0.251', (e) => { if (e) console.log('发送失败:', e.message) })
  }
  console.log('等待 10 秒应答…')
})
setTimeout(() => {
  console.log(`--- 结束：${answered} 个应答 ---`)
  if (answered === 0) console.log('★ 查询发出去但没人应答 → Android 的 NsdManager 没在应答查询')
  process.exit(0)
}, 10000)
