// 直接测试 multicast-dns 带 interface 选项能否发现服务。
// 绕过 bonjour-service，验证「interface 选项本身是否有效」。
// 前面已知：Android 会应答手动查询（mdns-query.cjs 拿到了应答）。

const IFACE = process.argv[2] || '192.168.101.9'
const mdns = require('multicast-dns')({ interface: IFACE })

mdns.on('response', (res) => {
  for (const a of res.answers ?? []) {
    if (a.name.includes('linkspace')) {
      console.log(`★ 应答: ${a.type} ${a.name} → ${a.data?.target ?? a.data?.port ?? a.data}`)
    }
  }
})
mdns.on('warning', (e) => console.log('警告:', e.message))
mdns.on('error', (e) => console.log('错误:', e.message))

mdns.query(
  { questions: [{ name: '_linkspace._tcp.local', type: 'PTR' }] },
  () => console.log('查询已发送')
)
console.log(`已用 interface=${IFACE} 发送查询，等待 10 秒…`)
setTimeout(() => { console.log('--- 结束 ---'); process.exit(0) }, 10000)
