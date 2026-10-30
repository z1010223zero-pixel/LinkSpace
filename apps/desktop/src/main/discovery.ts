// 局域网设备发现（mDNS / DNS-SD）。
//
// 对应 docs/protocol.md 第 1、2 节：服务类型 `_linkspace._tcp`，
// TXT 记录只含**公开非身份信息**（协议版本、设备 ID 前缀、端口、类型、能力位）。
//
// 设计要点：
//   - 发现层只回答「网络上有什么服务」，不回答「能不能信它」。
//     是否可信由 TrustStore 决定，本模块不读信任清单。
//   - mDNS 的 goodbye 包不可靠（设备可能直接断网），所以离线判定不依赖它，
//     改用「超过 STALE_MS 未再通告即视为消失」的软过期。
//     精确的在线/离线由控制通道心跳负责（protocol.md 4.2）。
//   - 服务名中的显示名必须过滤，否则用户把机器名改成含点或反斜杠的字符串
//     就能污染 mDNS 应答。
//
// 为什么直接解析原始应答包而不用 bonjour-service 的 Browser 事件
// （真机实证 2026-10-29，两个独立缺陷叠加）：
//   1. Browser 只在 start() 时发**一次** PTR 查询（dist/lib/browser.js L77），
//      此后纯被动收听；而 Android NSD 注册后只应答查询、不做周期性通告。
//      桌面端先于平板启动就永远空列表。→ 下方周期性补查解决。
//   2. Browser 对内容相同的重复应答**去重后不再发出任何事件**
//      （L66-71：已有实例仅在 SRV/TXT 变化时才 emit），导致 lastSeen
//      永不刷新，12s 软过期误删在线设备；且 Browser 内部仍保留该服务，
//      此后永远不会再发 up——设备在界面上出现约 12s 后永久消失。
//      → 直接从原始应答驱动 seen 表，每次应答都刷新 lastSeen。
//
// 为什么 socket 要自建并显式指定组播出接口（真机实证 2026-10-30）：
//   multicast-dns 默认 setMulticastInterface('0.0.0.0')，Windows 把
//   INADDR_ANY 解析为「隐式默认接口」——这个选择**不跟随路由 metric**
//   （实测把 Tailscale 接口 metric 调到 5000、WLAN 只有 30，组播仍从
//   Tailscale 虚拟网卡发出），表现为：通告与应答全部困在虚拟网卡里，
//   物理局域网上的对端永远发现不了本机；而同机的探针（loopback）却
//   能收到应答，极具迷惑性。历史脉络：第一版曾给 multicast-dns 传
//   `interface` 选项修出方向，但那会连带 bind 到具体地址，入方向完全
//   失聪，被 14dfb12 推翻；本版两全——bind 保持 0.0.0.0（入方向全接口），
//   出方向在 listening 后用 socket.setMulticastInterface() 显式钉到
//   物理网卡（见 pickOutInterface 与 onNetworkInterface）。

import dgram from 'node:dgram'
import os from 'node:os'
import { Bonjour, type Service } from 'bonjour-service'

export const SERVICE_TYPE = 'linkspace'

/** 本服务的完整 DNS 名，查询与应答匹配都用它 */
const SERVICE_FQDN = `_${SERVICE_TYPE}._tcp.local`

/** 周期重通告间隔：对端 NSD 的主动查询会随时间衰减，靠本端重发维持可见性 */
const REANNOUNCE_MS = 45_000

/** mDNS 标准组播组 */
const MCAST_GROUP = '224.0.0.251'

/** Windows 上组播出不去局域网的虚拟网卡（接口名匹配，大小写不敏感） */
const VIRTUAL_IFACE_RE = /vmware|virtualbox|hyper-v|vethernet|tailscale|zerotier|wsl|bluetooth/i

/** CGNAT 段 100.64.0.0/10：Tailscale 等虚拟组网默认落址于此 */
function isCgnat(addr: string): boolean {
  const m = /^100\.(\d+)\./.exec(addr)
  if (!m) return false
  const second = Number(m[1])
  return second >= 64 && second <= 127
}

/**
 * 选组播出接口（IPv4 地址）。判据按优先级：
 *   1. 排除 loopback（internal）与 169.254 链路本地——组播出去没人收
 *   2. 排除 CGNAT 段——Tailscale/ZeroTier 的落址区，包发进去会被虚拟网络吞掉
 *   3. 接口名命中虚拟网卡黑名单的降级（VMware VMnet 等也是死路）
 * 全部被过滤时返回 null（调用方保持系统默认，聊胜于无）。
 */
export function pickOutInterface(): string | null {
  const candidates: Array<{ addr: string; score: number }> = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      if (addr.address.startsWith('169.254.')) continue
      if (isCgnat(addr.address)) continue
      candidates.push({ addr: addr.address, score: VIRTUAL_IFACE_RE.test(name) ? 1 : 0 })
    }
  }
  candidates.sort((a, b) => a.score - b.score)
  return candidates[0]?.addr ?? null
}

export type DeviceType = 'win' | 'android-phone' | 'android-tablet'

export interface TxtRecord {
  /** 协议版本，无法解析时忽略该设备 */
  ver: string
  /** 设备 ID 前缀（不广播完整 ID 以降低追踪性） */
  id: string
  /** 控制/文件服务端口 */
  port: string
  type: DeviceType
  /** 能力位集合 */
  caps: string
  /** 是否已与本设备配对过（供 UI 排序） */
  paired: string
}

/** 发现层看到的候选服务。不含信任状态，也不含完整设备 ID */
export interface DiscoveredService {
  /** mDNS 服务名，形如 `LinkSpace-<displayName>`，仅用于去重与展示 */
  serviceName: string
  /** TXT 中的设备 ID 前缀 */
  idPrefix: string
  displayName: string
  deviceType: DeviceType
  caps: string[]
  host: string
  port: number
  /** 最后一次收到通告的时间 */
  lastSeen: number
  /** 通告里声明是否已与本机配对（仅提示，真实信任以 TrustStore 为准） */
  paired: boolean
}

export interface DiscoveryOptions {
  displayName: string
  deviceType: DeviceType
  deviceId: string
  port: number
  caps: string[]
  /** 是否已与某设备配对过，广播给对端做 UI 排序。可随信任清单变化 */
  isPaired?: () => boolean
  /** 软过期阈值，默认 12s（协议建议心跳 5s，3 次即 15s 判离线） */
  staleMs?: number
}

/** 服务名里只允许这些字符，其余替换为下划线，避免 DNS 注入与解析失败 */
export function sanitizeServiceName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9 \-_一-龥]/g, '_').trim()
  return cleaned.length ? cleaned.slice(0, 60) : 'LinkSpace-Device'
}

function parseTxt(rec: Record<string, string>, fallbackPort: number): TxtRecord | null {
  const ver = String(rec.ver ?? '')
  if (ver !== '1') return null
  const port = Number(rec.port ?? fallbackPort)
  if (!Number.isFinite(port) || port <= 0) return null
  const type = String(rec.type ?? '') as DeviceType
  if (type !== 'win' && type !== 'android-phone' && type !== 'android-tablet') return null
  return {
    ver,
    id: String(rec.id ?? ''),
    port: String(port),
    type,
    caps: String(rec.caps ?? ''),
    paired: rec.paired === '1' ? '1' : '0'
  }
}

// ---- 原始 mDNS 包结构（multicast-dns / dns-packet 的输出形态）----
//
// bonjour-service 的类型把底层 server 标为 private，但周期性补查与
// 逐包解析必须直接触达它；这里按 dns-packet 的实际输出定义最小结构，
// 用显式断言越过 private（与库行为耦合点已集中在此一处）。

interface RawRecord {
  type: string
  name: string
  ttl: number
  /** PTR: 实例 fqdn 字符串；SRV: { port, target }；A: IPv4 字符串；TXT: Buffer[] */
  data: unknown
}

interface RawPacket {
  type: string
  answers: RawRecord[]
  additionals: RawRecord[]
}

interface RawMdnsServer {
  query(name: string, type: string): void
  on(event: 'response', cb: (packet: RawPacket, rinfo: { address: string; port: number }) => void): void
  removeListener(event: 'response', cb: (packet: RawPacket, rinfo: { address: string; port: number }) => void): void
  /** multicast-dns 在 membership 变化后发出（listening 首次必发），用于随后覆盖出接口 */
  on(event: 'networkInterface', cb: () => void): void
  removeListener(event: 'networkInterface', cb: () => void): void
}

/** DNS TXT 记录：每条 character-string 形如 `key=value`（DNS-SD 规范） */
function decodeTxtRecords(chunks: unknown[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk)) continue
    const kv = chunk.toString('utf8')
    if (!kv) continue
    const eq = kv.indexOf('=')
    // `=` 开头的键是 DNS-SD 的「隐藏」键；无 `=` 的键取空值
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1)
    else if (eq < 0) out[kv] = ''
  }
  return out
}

/** DNS 名不区分大小写，比较前统一小写 */
function dnsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * mDNS 发现。
 *
 * 用法：
 *   const d = new Discovery({ displayName, deviceType, deviceId, port, caps })
 *   d.on('up', (svc) => { ... })
 *   d.on('down', (svc) => { ... })
 *   d.start()
 */
export class Discovery {
  private bonjour: Bonjour | null = null
  private ad: Service | null = null
  /** 自建 socket：持有引用才能在 listening 后显式指定组播出接口（见文件头注释） */
  private mcastSocket: dgram.Socket | null = null
  private readonly seen = new Map<string, DiscoveredService>()
  private readonly staleMs: number
  private sweepTimer: NodeJS.Timeout | null = null
  private reAnnounceTimer: NodeJS.Timeout | null = null
  private queryTimer: NodeJS.Timeout | null = null
  private started = false

  constructor(private readonly opts: DiscoveryOptions) {
    this.staleMs = opts.staleMs ?? 12_000
    this.ownIdPrefix = opts.deviceId.slice(0, 12)
  }

  private readonly ownIdPrefix: string

  private emit<K extends 'up' | 'down' | 'changed'>(event: K, svc: DiscoveredService): void {
    this.listeners[event]?.forEach((cb) => cb(svc))
  }

  private listeners: {
    up?: Array<(svc: DiscoveredService) => void>
    down?: Array<(svc: DiscoveredService) => void>
    changed?: Array<(svc: DiscoveredService) => void>
  } = {}

  on(event: 'up' | 'down' | 'changed', cb: (svc: DiscoveredService) => void): this {
    ;(this.listeners[event] ??= []).push(cb)
    return this
  }

  /** 当前已发现且未过期的服务列表 */
  list(): DiscoveredService[] {
    const now = Date.now()
    return [...this.seen.values()]
      .filter((s) => now - s.lastSeen < this.staleMs)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  start(): void {
    if (this.started) return
    this.started = true

    // 不绑定具体组播网卡（bind 保持 0.0.0.0 全接口）：实测（真机走查
    // 2026-10-29）Windows 上把组播 socket 绑到具体地址会导致**完全收不到
    // 组播入包**。出方向的修正走 socket.setMulticastInterface（不影响
    // bind），见 onNetworkInterface。
    this.mcastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    // bonjour-service 的 ServiceConfig 类型未收录 socket 透传，但运行时
    // mdns-server.js 把 opts 原样交给 multicast-dns（其 L25 支持注入
    // socket），断言越过类型缺口即可
    this.bonjour = new Bonjour({
      socket: this.mcastSocket
    } as unknown as ConstructorParameters<typeof Bonjour>[0])
    this.publishSelf()

    // 应答驱动发现：不用 Browser 事件，理由见文件头注释。
    const raw = this.rawServer()
    this.onResponse = (packet, rinfo) => this.handleResponse(packet, rinfo)
    raw.on('response', this.onResponse)

    // multicast-dns 在 listening 后的首次 update 会把出接口重置回
    // '0.0.0.0'（Windows 上隐式落到 Tailscale 等虚拟网卡），此后每次
    // membership 变化都会再发一次 networkInterface 事件——在事件回调里
    // 统一覆盖出接口并补漏 membership，保证始终晚于库的默认行为执行。
    raw.on('networkInterface', this.onNetworkInterface)

    // 周期性补发查询，这是发现功能的生命线：Android NSD 注册后只应答
    // 查询、不做周期性通告，桌面端先启动就会错过所有通告。RFC 6762 §5.2
    // 允许周期性重查；5s 间隔与 staleMs=12s 的软过期窗口匹配——错过
    // 2 次查询才会被判离线，短暂丢包不至于闪断。
    raw.query(SERVICE_FQDN, 'PTR')
    this.queryTimer = setInterval(() => {
      try {
        this.rawServer().query(SERVICE_FQDN, 'PTR')
      } catch {
        /* 已停止时忽略 */
      }
    }, 5000)

    // 软过期扫描：直接断网的设备不会发 goodbye，只能靠超时判定
    this.sweepTimer = setInterval(() => this.sweep(), Math.max(1000, this.staleMs / 2))

    // 周期重通告：bonjour 只在发布时做启动 burst（RFC 6762），此后 75min
    // TTL 内不再主动发。对端（Android NSD 的 mdnsd）的主动查询窗口会随
    // browse 时长衰减（实测 40s → 90s+ → 更长），一旦错过启动 burst，
    // 对端发现列表就永久空窗——真机 B-1 验证踩过。周期性重发（停旧发新，
    // 与 refreshAdvertisement 同路径）让任何时刻启动的对端都能在
    // 一个周期内看到本机。
    this.reAnnounceTimer = setInterval(() => {
      if (!this.started) return
      try {
        this.refreshAdvertisement()
      } catch {
        /* 重发冲突等瞬时问题，下一个周期再试 */
      }
    }, REANNOUNCE_MS)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    if (this.reAnnounceTimer) clearInterval(this.reAnnounceTimer)
    this.reAnnounceTimer = null
    if (this.queryTimer) clearInterval(this.queryTimer)
    this.queryTimer = null
    if (this.onResponse) {
      try {
        this.rawServer().removeListener('response', this.onResponse)
      } catch {
        /* 已销毁时忽略 */
      }
      this.onResponse = null
    }
    try {
      this.rawServer().removeListener('networkInterface', this.onNetworkInterface)
    } catch {
      /* 已销毁时忽略 */
    }
    try {
      this.ad?.stop()
    } catch {
      /* 已停止时忽略 */
    }
    this.bonjour?.destroy()
    this.bonjour = null
    this.mcastSocket = null
    this.seen.clear()
  }

  private onResponse: ((packet: RawPacket, rinfo: { address: string; port: number }) => void) | null = null

  /**
   * 出接口显式化 + membership 补漏（真机实证 2026-10-30，见文件头注释）：
   *   - 出接口：multicast-dns 每次都设回 '0.0.0.0'，Windows 隐式解析会落
   *     到 Tailscale 等虚拟网卡且不跟随路由 metric——必须显式钉回物理网卡。
   *   - membership：库内 allInterfaces 对 127.0.0.1/169.254 的加入会 throw
   *     被吞掉，真实接口若同样失败同样静默——这里对每个非 internal IPv4
   *     接口重补一次（重复加入抛错同样吞掉，幂等）。
   */
  private readonly onNetworkInterface = (): void => {
    const sock = this.mcastSocket
    if (!sock) return
    const out = pickOutInterface()
    if (out) {
      try {
        sock.setMulticastInterface(out)
      } catch {
        /* 网卡瞬态（切换/禁用）时忽略，下次事件再试 */
      }
    }
    for (const [, addrs] of Object.entries(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family !== 'IPv4' || addr.internal) continue
        try {
          sock.addMembership(MCAST_GROUP, addr.address)
        } catch {
          /* 已加入或接口不支持组播 */
        }
      }
    }
  }

  private rawServer(): RawMdnsServer {
    // server 在 bonjour-service 类型里是 private，见 RawMdnsServer 上方说明
    return (this.bonjour as unknown as { server: { mdns: RawMdnsServer } }).server.mdns
  }

  /**
   * 用当前信任状态刷新广播的 paired 位（配对成功后调用）。
   * bonjour-service 的 Service 不支持原地改 TXT，只能停掉重发。
   * 重发有毫秒级空窗，但对端本来就要等下一次通告，可接受。
   */
  refreshAdvertisement(): void {
    if (!this.bonjour || !this.started) return
    try {
      this.ad?.stop()
    } catch {
      /* 未发布时忽略 */
    }
    this.publishSelf()
  }

  /**
   * 本机改名后更新通告（5.4）。服务名内嵌显示名（LinkSpace-<displayName>），
   * NSD/bonjour 都不支持原地改名，走与 refreshAdvertisement 相同的
   * 「停掉重发」路径；重发前先更新 opts，publishSelf 会取到新名字。
   */
  setDisplayName(name: string): void {
    this.opts.displayName = name
    this.refreshAdvertisement()
  }

  private publishSelf(): void {
    this.ad = this.bonjour!.publish({
      // 服务名约定为 `LinkSpace-<displayName>`：Android 端解析时按该前缀
      // 取显示名（Discovery.kt removePrefix），广播侧漏前缀会让对端把
      // 原始服务名当显示名展示（实例：平板上显示 "LinkSpace Desktop"）
      name: sanitizeServiceName(`LinkSpace-${this.opts.displayName}`),
      type: SERVICE_TYPE,
      port: this.opts.port,
      txt: {
        ver: '1',
        id: this.opts.deviceId.slice(0, 12),
        port: String(this.opts.port),
        type: this.opts.deviceType,
        caps: this.opts.caps.join(','),
        paired: this.opts.isPaired?.() ? '1' : '0'
      }
    })
  }

  /** 一条应答包 = 若干实例的通告（PTR）+ 细节（SRV/TXT/A）+ 注销（ttl=0 的 PTR） */
  private handleResponse(packet: RawPacket, rinfo: { address: string }): void {
    const records = [...(packet.answers ?? []), ...(packet.additionals ?? [])]
    // goodbye：ttl=0 的 PTR 表示服务注销（mDNS 规范）
    for (const rr of records) {
      if (rr.type === 'PTR' && rr.ttl === 0 && dnsEqual(rr.name, SERVICE_FQDN)) {
        this.removeByInstance(String(rr.data).split('.')[0])
      }
    }
    for (const rr of records) {
      if (rr.type === 'PTR' && rr.ttl > 0 && dnsEqual(rr.name, SERVICE_FQDN)) {
        this.announceInstance(String(rr.data), records, rinfo.address)
      }
    }
  }

  /**
   * 从一次 PTR 通告重建服务条目。Android NSD 会把 SRV/TXT/A 作为
   * additional 记录附在同一包里；缺失 SRV 时无法使用（没有端口）。
   */
  private announceInstance(fqdn: string, records: RawRecord[], sourceIp: string): void {
    const instance = fqdn.split('.')[0]
    if (!instance) return
    const srv = records.find((rr) => rr.type === 'SRV' && dnsEqual(rr.name, fqdn))
    if (!srv) return
    const srvData = srv.data as { port?: unknown; target?: unknown }
    if (!srvData || typeof srvData.port !== 'number') return
    const target = typeof srvData.target === 'string' ? srvData.target : ''
    const txtRec = records.find((rr) => rr.type === 'TXT' && dnsEqual(rr.name, fqdn))
    const parsed = parseTxt(
      Array.isArray(txtRec?.data) ? decodeTxtRecords(txtRec.data) : {},
      srvData.port
    )
    if (!parsed) return

    // 自己的通告要跳过：同一台机器上 mDNS 会收到自己的广播。
    // 判据用「ID 前缀 + 端口」同时匹配——端口由系统分配，本机唯一。
    if (parsed.id === this.ownIdPrefix && Number(parsed.port) === this.opts.port) return

    // 地址优先取对端自报的 A 记录；拿不到就退回包来源 IP——包能到，
    // 这个 IP 就一定可达（比 SRV target 的 .local 主机名可靠）。
    const aRec = records.find((rr) => rr.type === 'A' && target && dnsEqual(rr.name, target))
    const address = typeof aRec?.data === 'string' ? aRec.data : sourceIp
    if (!address) return

    const key = `${instance}@${parsed.id}`
    const svc: DiscoveredService = {
      serviceName: instance,
      idPrefix: parsed.id,
      // 服务名是 `LinkSpace-<displayName>`，取回显示名部分
      displayName: instance.replace(/^LinkSpace-/, ''),
      deviceType: parsed.type,
      caps: parsed.caps ? parsed.caps.split(',').filter(Boolean) : [],
      host: address,
      port: Number(parsed.port),
      lastSeen: Date.now(),
      paired: parsed.paired === '1'
    }

    const existing = this.seen.get(key)
    this.seen.set(key, svc)
    if (existing) this.emit('changed', svc)
    else this.emit('up', svc)
  }

  private removeByInstance(instance: string): void {
    for (const [key, svc] of this.seen) {
      if (svc.serviceName === instance) {
        this.seen.delete(key)
        this.emit('down', svc)
      }
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const [key, svc] of this.seen) {
      if (now - svc.lastSeen >= this.staleMs) {
        this.seen.delete(key)
        this.emit('down', svc)
      }
    }
  }
}
