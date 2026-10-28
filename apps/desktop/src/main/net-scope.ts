// 局域网范围判定。
//
// LinkSpace 的数据面（文件传输）与控制面（WebSocket）共用同一个 TLS 端口，
// 端口一旦监听，任何能路由到本机的主机都能敲门。安全模型是
// 「TLS 双向出示证书 + 信任清单 + 任务 token」，但那是**身份**层面的门禁；
// 它挡不住的一件事是：本机根本不该把端口暴露到局域网以外。
//
// 典型翻车场景：机器上装了 Hyper-V / VMware / VPN / ZeroTier，会多出一张
// 虚拟网卡，其中有些拿到的是可路由地址（VPN 分配的公司内网段、甚至公网段）。
// 绑定 0.0.0.0 时，这些网卡上的端口也一并开着。
//
// 于是在**连接层**再加一道：来源地址不属于局域网范围就直接断开，
// 在 TLS 握手之前就把连接掐掉。这一层与身份门禁互不替代——
// 前者管「谁能敲门」，后者管「敲门的人是谁」。
//
// 判定只依赖 IP 段，不依赖网卡列表：网卡可以热插拔，段是稳定的。

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i

/** 把 ::ffff:192.168.1.2 这类 IPv4 映射地址还原成点分十进制 */
function unwrap(ip: string): string {
  const m = IPV4_MAPPED.exec(ip)
  return m ? m[1] : ip
}

function inRange(octets: number[], base: number[], bits: number): boolean {
  // 逐段比对：前 bits/8 段必须完全相等，剩余部分按零散位比较。
  // 只支持 /8 /12 /16 /10 这类 8 的倍数或以字节为界的前缀，够用且不易写错。
  const fullBytes = Math.floor(bits / 8)
  for (let i = 0; i < fullBytes; i++) {
    if (octets[i] !== base[i]) return false
  }
  const rest = bits % 8
  if (rest === 0) return true
  const mask = (0xff << (8 - rest)) & 0xff
  return (octets[fullBytes] & mask) === (base[fullBytes] & mask)
}

/**
 * 是否属于「不应对外暴露」的地址范围。
 *
 * 包含：回环、RFC1918 私有地址、链路本地（169.254 / fe80）、
 * IPv6 唯一本地地址（fc00::/7）、运营商级 NAT 共享段（100.64/10）。
 * 最后一项目的是覆盖「看起来像公网其实不可路由」的场景，避免误伤。
 *
 * 回环必须放行：所有无头测试都跑在 127.0.0.1 上。
 */
export function isLanAddress(ip: string | undefined | null): boolean {
  if (!ip) return false
  const raw = unwrap(ip.trim())

  if (raw === '::1' || raw === 'localhost') return true

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw)
  if (v4) {
    const o = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if (o.some((n) => n < 0 || n > 255)) return false
    return (
      inRange(o, [127, 0, 0, 0], 8) || // 回环
      inRange(o, [10, 0, 0, 0], 8) || // RFC1918 A 类
      inRange(o, [172, 16, 0, 0], 12) || // RFC1918 B 类
      inRange(o, [192, 168, 0, 0], 16) || // RFC1918 C 类
      inRange(o, [169, 254, 0, 0], 16) || // 链路本地
      inRange(o, [100, 64, 0, 0], 10) // CGNAT 共享地址
    )
  }

  // IPv6：链路本地 fe80::/10（首字节 fe，次字节 80–bf）
  // 与唯一本地 fc00::/7（首字节 fc 或 fd）。文本形式的前两个十六进制
  // 字符就是首字节，直接前缀判断即可，不必解析成字节数组。
  const lower = raw.toLowerCase()
  if (/^fe[89ab]/.test(lower)) return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  return false
}

/**
 * 是否放行了非局域网来源。
 * 正常永远为 false；只有用户显式设 LINKSPACE_ALLOW_WAN=1 才为 true。
 * 这是刻意留的逃生口——比如在公司内网跨网段调试——但必须在日志里留痕。
 */
export function allowWan(): boolean {
  const v = process.env.LINKSPACE_ALLOW_WAN
  return v === '1' || v === 'true'
}

/** 入站连接是否被允许。缺地址时按不信任处理 */
export function inboundAllowed(remoteAddress: string | undefined | null): boolean {
  if (allowWan()) return true
  return isLanAddress(remoteAddress)
}
