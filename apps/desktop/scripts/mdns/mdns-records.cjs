// 精确解析 mDNS 包里的 PTR/SRV 记录名。
// 目的：确认 Android NsdManager 通告的服务类型名是否带 `.local.` 后缀。
// 背景：bonjour-service 的 browser 用严格相等比较 answer.name === '_linkspace._tcp.local.'，
// 少一个后缀就会被整体丢弃——这是「组播收到包但解析不出服务」的典型原因。
const dgram = require('node:dgram')
const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })

/** 读 DNS 长度前缀格式的名字 */
function readName(buf, offset) {
  const labels = []
  let i = offset
  let jumped = false
  let end = offset
  while (i < buf.length) {
    const len = buf[i]
    if (len === 0) { if (!jumped) end = i + 1; break }
    // 压缩指针（0xC0 开头）
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = i + 2
      jumped = true
      i = ((len & 0x3f) << 8) | buf[i + 1]
      continue
    }
    labels.push(buf.slice(i + 1, i + 1 + len).toString('latin1'))
    i += 1 + len
  }
  return { name: labels.join('.'), end }
}

s.on('message', (msg, rinfo) => {
  const txt = msg.toString('latin1')
  if (!/linkspace/i.test(txt)) return

  const header = msg.slice(0, 12)
  const qd = header.readUInt16BE(4)
  const an = header.readUInt16BE(6)
  let off = 12
  const out = []

  for (let i = 0; i < qd; i++) {
    const r = readName(msg, off)
    off = r.end + 4 // 跳过 type/class
    out.push(`Q  ${r.name}`)
  }
  for (let i = 0; i < an && off < msg.length; i++) {
    const r = readName(msg, off)
    off = r.end
    const type = msg.readUInt16BE(off); off += 2
    off += 2 // class
    off += 4 // ttl
    const rdlen = msg.readUInt16BE(off); off += 2
    const rdStart = off
    const typeName = { 1: 'A', 12: 'PTR', 16: 'TXT', 33: 'SRV', 28: 'AAAA' }[type] ?? String(type)
    let extra = ''
    if (type === 12) { // PTR
      const t = readName(msg, rdStart)
      extra = `→ ${t.name}`
    } else if (type === 33) { // SRV
      const t = readName(msg, rdStart + 6)
      extra = `→ ${t.name}:${msg.readUInt16BE(rdStart + 4)}`
    }
    out.push(`AN ${typeName.padEnd(4)} ${r.name} ${extra}`)
    off = rdStart + rdlen
  }
  console.log(`\n===== ${rinfo.address} (${msg.length}B) =====`)
  out.forEach((l) => console.log('  ' + l))
})

s.bind(5353, () => {
  try { s.addMembership('224.0.0.251') } catch (e) { console.log('组播失败:', e.message) }
  console.log('解析中，20 秒…')
})
setTimeout(() => { console.log('\n--- 结束 ---'); process.exit(0) }, 20000)
