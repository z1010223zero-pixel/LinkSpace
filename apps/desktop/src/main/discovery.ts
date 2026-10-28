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

import { Bonjour, Browser, type Service } from 'bonjour-service'

export const SERVICE_TYPE = 'linkspace'

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

    this.bonjour = new Bonjour()
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
