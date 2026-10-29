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

import { networkInterfaces } from 'node:os'
import { Bonjour, Browser, type Service } from 'bonjour-service'
import { log } from './log'

export const SERVICE_TYPE = 'linkspace'

/**
 * 选出用于 mDNS 组播的局域网网卡地址。
 *
 * 与 `resolveBindAddress()` 的判据**刻意不同**：那里把 CGNAT 段（100.64/10）
 * 算作「不可公开路由」所以放行，而组播网卡必须选真正能跑 mDNS 的那张。
 * 100.64/10 是运营商级 NAT 段，虚拟网卡（Tailscale、ZeroTier 等）常用它，
 * 选中的结果就是「能收到突发通告但查不过去」——正是本次要修的现象。
 *
 * 选择顺序：环境变量 > 192.168.x > 10.x > 172.16–31.x。
 * 多个同类地址时取第一个并告警：这一步选错发现功能会整体失效，
 * 宁可说出来也不要静默。
 */
function pickLanInterface(): string | undefined {
  const override = process.env.LINKSPACE_BIND_IP
  if (override) return override

  const scored: Array<{ addr: string; score: number }> = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue
      const o = ni.address.split('.').map(Number)
      if (o.length !== 4 || o.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) continue
      if (o[0] === 127) continue // 回环
      if (o[0] === 169 && o[1] === 254) continue // 链路本地
      if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) continue // CGNAT，不能跑 mDNS
      let score: number
      if (o[0] === 192 && o[1] === 168) score = 3
      else if (o[0] === 10) score = 2
      else if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) score = 1
      else continue // 其余一律不当局域网
      scored.push({ addr: ni.address, score })
    }
  }

  if (scored.length === 0) {
    log.warn('未找到可用的局域网 IPv4 网卡，mDNS 将使用默认接口（可能发现不到设备）')
    return undefined
  }
  // 分数高的优先；同分保持系统枚举顺序（稳定，不随运行变化）
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  const sameGrade = scored.filter((s) => s.score === best.score).map((s) => s.addr)
  if (sameGrade.length > 1) {
    log.warn(`检测到多个同级局域网地址（${sameGrade.join(', ')}），mDNS 使用 ${best.addr}；可用 LINKSPACE_BIND_IP 覆盖`)
  }
  return best.addr
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

function parseTxt(txt: unknown, fallbackPort: number): TxtRecord | null {
  const rec = (txt ?? {}) as Record<string, string>
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
  private browser: Browser | null = null
  private readonly seen = new Map<string, DiscoveredService>()
  private readonly staleMs: number
  private sweepTimer: NodeJS.Timeout | null = null
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

    // 必须显式指定组播网卡。
    // multicast-dns 的 allInterfaces() 不排除回环地址（判据只有 isIPv4），
    // 会把 127.0.0.1 也 addMembership；而 defaultInterface() 在 Windows 上
    // 返回 0.0.0.0，setMulticastInterface('0.0.0.0') 让系统自选接口。
    // 多网卡机器上选中的往往不是局域网那张，结果是：能收到别人突发式
    // 的通告（组播包广播到所有接口），但主动查询发不到对端所在的网段，
    // browser 永远发现不了服务。
    // 传入 interface 后，库只对该地址 addMembership 并用它发组播。
    // interface 在运行时有支持（mdns-server 把 opts 原样透传给 multicast-dns），
    // 但 bonjour-service 的 TS 类型没声明它，这里显式断言并说明原因
    this.bonjour = new Bonjour({ interface: pickLanInterface() } as Record<string, unknown>)
    this.publishSelf()

    // find 返回 Browser，直接用它的 up/down 事件。
    // down 只在收到 goodbye 包时触发，设备直接断网时不会有，
    // 所以仍保留 sweep() 软过期兜底（两者互补，不冲突）。
    this.browser = this.bonjour.find({ type: SERVICE_TYPE })
    this.browser.on('up', (service: Service) => this.handleService(service))
    this.browser.on('txt-update', (service: Service) => this.handleService(service))
    this.browser.on('down', (service: Service) => this.handleDown(service))

    // 软过期扫描：直接断网的设备不会发 goodbye，只能靠超时判定
    this.sweepTimer = setInterval(() => this.sweep(), Math.max(1000, this.staleMs / 2))
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    try {
      this.browser?.stop()
    } catch {
      /* 已停止时忽略 */
    }
    try {
      this.ad?.stop()
    } catch {
      /* 已停止时忽略 */
    }
    this.bonjour?.destroy()
    this.bonjour = null
    this.seen.clear()
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
      name: sanitizeServiceName(this.opts.displayName),
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

  private handleService(service: Service): void {
    // 自己的通告要跳过：同一台机器上 mDNS 会收到自己的广播。
    // 判据用「ID 前缀 + 端口」同时匹配——端口由系统分配，本机唯一。
    const parsed = parseTxt(service.txt, service.port)
    if (!parsed) return
    if (parsed.id === this.ownIdPrefix && Number(parsed.port) === this.opts.port) return

    const address = service.addresses?.find((a) => a.includes('.')) ?? service.host
    if (!address) return

    const key = `${service.name}@${parsed.id}`
    const svc: DiscoveredService = {
      serviceName: service.name,
      idPrefix: parsed.id,
      // 服务名是 `LinkSpace-<displayName>`，取回显示名部分
      displayName: service.name.replace(/^LinkSpace-/, ''),
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

  private handleDown(service: Service): void {
    const parsed = parseTxt(service.txt, service.port)
    if (!parsed) return
    if (parsed.id === this.ownIdPrefix && Number(parsed.port) === this.opts.port) return
    const key = `${service.name}@${parsed.id}`
    const svc = this.seen.get(key)
    if (svc) {
      this.seen.delete(key)
      this.emit('down', svc)
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
