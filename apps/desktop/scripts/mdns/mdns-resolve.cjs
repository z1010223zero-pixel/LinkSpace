// 桌面端 mDNS 发现验证：用真实的 Discovery 类，看能否发现 Android 通告。
// 与 mdns-diag.cjs 的区别：那个只验证「组播能收到包」，
// 这个验证「bonjour-service 的解析链路是通的」——两件事可能各自坏掉。
const { Bonjour } = require('bonjour-service')

const bonjour = new Bonjour()
const browser = bonjour.find({ type: '_linkspace._tcp' })

const found = []
browser.on('up', (service) => {
  const addr = service.addresses?.find((a) => a.includes('.')) ?? service.host
  found.push(service.name)
  console.log(`★ 发现服务: ${service.name}`)
  console.log(`  地址=${addr} 端口=${service.port} 主机=${service.host}`)
  console.log(`  TXT=${JSON.stringify(service.txt)}`)
})
browser.on('down', (s) => console.log(`- 服务消失: ${s.name}`))

browser.start()
console.log('浏览器已启动，等待 12 秒…')
setTimeout(() => {
  console.log(`--- 结束：发现 ${found.length} 个服务 ---`)
  if (found.length === 0) console.log('★ bonjour-service 没解析出服务，但组播层收到了包 → 问题在解析链路')
  browser.stop()
  bonjour.destroy()
  process.exit(0)
}, 12000)
