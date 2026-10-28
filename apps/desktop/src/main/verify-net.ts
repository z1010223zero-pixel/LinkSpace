// 局域网范围判定的无头测试。
//
// 这一层是「端口别开到局域网以外」的唯一保障，判定表错一格就是
// 要么把端口暴露出去、要么把所有人都挡在门外。全是纯函数，没有 IO，
// 所以值得把边界逐个钉死。

import { isLanAddress, allowWan, inboundAllowed } from './net-scope'

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  console.log('\n=== LinkSpace 局域网范围判定测试 ===\n')

  // ---------- 1. 必须放行 ----------
  console.log('1. 局域网地址放行')
  for (const ip of ['127.0.0.1', '10.0.0.1', '10.255.255.254', '192.168.1.20', '172.16.0.1', '172.31.255.254']) {
    check(`${ip} 属于局域网`, isLanAddress(ip))
  }

  // ---------- 2. 必须拒绝 ----------
  console.log('\n2. 非局域网地址拒绝')
  for (const ip of ['8.8.8.8', '1.1.1.1', '114.114.114.114', '172.32.0.1', '172.15.255.255', '11.0.0.1', '192.167.1.1']) {
    check(`${ip} 不属于局域网`, !isLanAddress(ip))
  }

  // ---------- 3. 172.16/12 的边界 ----------
  console.log('\n3. 172.16.0.0/12 边界')
  check('172.16.0.0 在范围内', isLanAddress('172.16.0.0'))
  check('172.31.255.255 在范围内', isLanAddress('172.31.255.255'))
  check('172.15.255.255 在范围外', !isLanAddress('172.15.255.255'))
  check('172.32.0.0 在范围外', !isLanAddress('172.32.0.0'))

  // ---------- 4. IPv6 与映射地址 ----------
  console.log('\n4. IPv6')
  check('::1 放行', isLanAddress('::1'))
  check('fe80::1 放行', isLanAddress('fe80::1'))
  check('fd00::1 放行', isLanAddress('fd00::1'))
  check('::ffff:192.168.1.9 按 IPv4 判定并放行', isLanAddress('::ffff:192.168.1.9'))
  check('::ffff:8.8.8.8 按 IPv4 判定并拒绝', !isLanAddress('::ffff:8.8.8.8'))
  check('公网 IPv6 拒绝', !isLanAddress('2408:400a:10::1'))

  // ---------- 5. 畸形输入 ----------
  console.log('\n5. 畸形输入按不信任处理')
  for (const bad of [undefined, null, '', 'not-an-ip', '999.1.1.1']) {
    check(`${JSON.stringify(bad)} 不被当作局域网`, !isLanAddress(bad as string | undefined))
  }
  check('入站地址缺失时被拒绝', !inboundAllowed(undefined))

  // ---------- 6. 逃生开关 ----------
  console.log('\n6. LINKSPACE_ALLOW_WAN 逃生开关')
  const original = process.env.LINKSPACE_ALLOW_WAN
  try {
    delete process.env.LINKSPACE_ALLOW_WAN
    check('默认不放行非局域网', !allowWan() && !inboundAllowed('8.8.8.8'))

    process.env.LINKSPACE_ALLOW_WAN = '1'
    check('置 1 后放行', allowWan() && inboundAllowed('8.8.8.8'))

    process.env.LINKSPACE_ALLOW_WAN = 'true'
    check("置 'true' 后放行", allowWan())

    process.env.LINKSPACE_ALLOW_WAN = '0'
    check("置 '0' 仍不放行", !allowWan())
  } finally {
    if (original === undefined) delete process.env.LINKSPACE_ALLOW_WAN
    else process.env.LINKSPACE_ALLOW_WAN = original
  }

  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试脚本异常：', err)
  process.exit(1)
})
