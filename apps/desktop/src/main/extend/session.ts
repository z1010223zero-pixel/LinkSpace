// 平板当扩展屏的会话状态机（线 3，协议 4.3，sessionType: 'display-extend'）。
//
// 两个角色，各一个类（与 input/session.ts 的键鼠会话同构，刻意不复用
// 同一个类——两种会话的生命周期、授权物与终止副作用完全不同，
// 共用一个状态机会把「input 会话结束不终止扩展屏」这一解耦点埋掉）：
//   - DisplayExtendSessionCoordinator：**被控端（桌面）**。平板请求
//     把本机扩展出一块虚拟显示器时的接待逻辑——授权门禁、用户确认
//     （9.1「每次控制请求都有明确可见的授权提示」，扩展屏改动本机
//     显示拓扑，同样要确认）、虚拟显示器创建/销毁、随时可被掐断。
//   - DisplayExtendController：**控制端（平板）**。发起扩展请求、
//     跟踪会话状态、随时退出。
//
// 刻意做成不依赖 Electron / ws 的纯逻辑：信收发由调用方注入
// （send / createVirtualDisplay / destroyVirtualDisplay），授权判定
// 由调用方注入（isPeerAuthorized）。会话时序、越权拒绝、断连清理
// 这些最容易出错的路径才能在无头测试里确定性覆盖。
//
// **与 input 会话解耦**：扩展屏会话与键鼠会话各占一个独立槽位，
// 互不感知——无活动 input 会话也能开扩展屏；input 会话结束不终止
// 扩展屏推流；扩展屏结束也不动 input 会话。两类会话的 sessionId
// 各自独立，session.stop 按 sessionId 各自匹配。
//
// **虚拟显示器是会话级资源**：approve 成功时创建（createVirtualDisplay），
// 会话结束（stop / 断连 / 撤销 / 本机终止 / 进程退出）的任何路径都
// 销毁（destroyVirtualDisplay）。创建失败时会话不建立，回
// session.reject，绝不先 accept 再补建。

import { randomUUID } from 'node:crypto'
import { SESSION_ID_RE, decodeScreenSize } from '../input/protocol'

/** 扩展屏请求里希望的虚拟显示器尺寸（可空：由桌面按 INF 预置模式选） */
export interface ExtendPreferredSize {
  width: number
  height: number
}

/** 需要用户确认的扩展请求（被控端 UI 展示用） */
export interface ExtendControlRequest {
  sessionId: string
  peerId: string
  /** 对端自报的显示名，仅用于提示文案，不作信任依据 */
  displayName: string
  /** 平板希望的虚拟显示器尺寸；null = 由桌面按 INF 预置模式选 */
  preferred: ExtendPreferredSize | null
  /** 平板希望的推流宽度档位（1280/1920/2560/3840），默认 1920 */
  scaleWidth: number
  expiresAt: number
}

/** 进行中的扩展会话（被控端视角） */
export interface ActiveExtendSession {
  sessionId: string
  peerId: string
  /** 虚拟显示器在虚拟屏坐标系里的矩形（触控映射与推流区域基准） */
  virtualScreen: { x: number; y: number; w: number; h: number }
  startedAt: number
}

export interface ExtendCoordinatorCallbacks {
  /**
   * 授权判定：对端必须在信任清单内（已配对）。扩展屏不是前置授权——
   * 恰恰相反，本次会话被确认后才算持有扩展权。
   */
  isPeerAuthorized: (peerId: string) => boolean
  /**
   * 创建虚拟显示器。成功返回其在虚拟屏坐标系里的矩形；失败返回原因
   * （如驱动未安装、测试签名未开），会话层据此回 session.reject。
   * 实现侧是 VirtualDisplayManager（3.2）：SWD 创建 + 模式选定。
   */
  createVirtualDisplay: (
    preferred: ExtendPreferredSize | null
  ) => { ok: true; screen: { x: number; y: number; w: number; h: number } } | { ok: false; reason: string }
  /** 销毁当前虚拟显示器（SWD 销毁）。无虚拟显示器时是安全空操作 */
  destroyVirtualDisplay: () => void
  /** 给对端发消息。对端不在线时静默丢弃 */
  send: (peerId: string, type: string, payload: Record<string, unknown>) => void
  log?: (msg: string) => void
  /** 状态变化（进入/离开 pending、active），UI 刷新用 */
  onChanged?: () => void
  /** 新扩展请求到达且已过门禁，UI 应立即展示确认弹窗（9.1） */
  onRequest?: (req: ExtendControlRequest) => void
}

export interface ExtendCoordinatorOptions {
  callbacks: ExtendCoordinatorCallbacks
  /** 挂起的扩展请求多久无人处理即自动拒绝。产品值 30s，与 input 一致 */
  requestTtlMs?: number
  now?: () => number
}

const DEFAULT_REQUEST_TTL_MS = 30_000

/** 校验扩展请求参数：width/height 省略时为 null；scaleWidth 非法时回默认 */
export function decodeExtendParams(raw: unknown): {
  preferred: ExtendPreferredSize | null
  scaleWidth: number
} | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  let preferred: ExtendPreferredSize | null = null
  if (p.width !== undefined || p.height !== undefined) {
    const size = decodeScreenSize({ w: p.width, h: p.height })
    if (!size) return null
    preferred = { width: size.w, height: size.h }
  }
  const scaleWidth =
    typeof p.scaleWidth === 'number' && Number.isFinite(p.scaleWidth)
      ? Math.round(p.scaleWidth)
      : 1920
  return { preferred, scaleWidth }
}

export class DisplayExtendSessionCoordinator {
  private pending: ExtendControlRequest | null = null
  private active: ActiveExtendSession | null = null
  private ttlTimer: NodeJS.Timeout | null = null
  private readonly cbs: ExtendCoordinatorCallbacks
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(opts: ExtendCoordinatorOptions) {
    this.cbs = opts.callbacks
    this.ttlMs = opts.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS
    this.now = opts.now ?? Date.now
  }

  get activeSession(): ActiveExtendSession | null {
    return this.active
  }

  get pendingRequest(): ExtendControlRequest | null {
    return this.pending
  }

  /** UI 提示用：本机正把扩展屏给谁 */
  get extendedFor(): string | null {
    return this.active?.peerId ?? null
  }

  /**
   * 处理对端发来的 session.start（sessionType: 'display-extend'）。
   * Host 的消息桥只做信封透传，校验与状态迁移全在这里。
   */
  onStart(peerId: string, payload: unknown): void {
    const p = payload as {
      sessionId?: unknown
      sessionType?: unknown
      params?: unknown
    }
    if (p?.sessionType !== 'display-extend' || typeof p.sessionId !== 'string' || !SESSION_ID_RE.test(p.sessionId)) {
      this.cbs.send(peerId, 'session.reject', {
        sessionId: typeof p?.sessionId === 'string' ? p.sessionId : '',
        reason: 'bad request'
      })
      return
    }
    const decoded = decodeExtendParams(p.params)
    if (!decoded) {
      this.cbs.send(peerId, 'session.reject', { sessionId: p.sessionId, reason: 'bad params' })
      return
    }

    // 门禁一：未配对设备的扩展请求直接拒绝，**不进 pending、不弹 UI**。
    // 9.1 的授权提示是给用户的，而任意局域网连接都能刷出的提示框
    // 本身就是骚扰面（与 input 会话同口径）。
    if (!this.cbs.isPeerAuthorized(peerId)) {
      this.cbs.log?.(`拒绝未信任设备 ${peerId} 的扩展屏请求`)
      this.cbs.send(peerId, 'session.reject', { sessionId: p.sessionId, reason: 'not trusted' })
      return
    }

    // 门禁二：同一时刻至多一个挂起/活动扩展会话。虚拟显示器只有一块，
    // 多个平板同时扩展没有意义；重复请求回 RESOURCE_BUSY 语义。
    if (this.pending && this.pending.peerId === peerId && this.pending.sessionId === p.sessionId) {
      return // 同一请求的重入：保持等待，不能回 busy 把对端挂起的 promise 打掉
    }
    if (this.active || this.pending) {
      // 幂等：同一会话的 start 重发（对端消息重传）直接重新 accept
      if (this.active && this.active.peerId === peerId && this.active.sessionId === p.sessionId) {
        this.cbs.send(peerId, 'session.accept', {
          sessionId: p.sessionId,
          virtualScreen: this.active.virtualScreen
        })
        return
      }
      this.cbs.send(peerId, 'session.reject', { sessionId: p.sessionId, reason: 'resource busy' })
      return
    }

    this.pending = {
      sessionId: p.sessionId,
      peerId,
      displayName: String((p.params as { displayName?: unknown } | null)?.displayName ?? ''),
      preferred: decoded.preferred,
      scaleWidth: decoded.scaleWidth,
      expiresAt: this.now() + this.ttlMs
    }
    this.cbs.log?.(`收到 ${peerId} 的扩展屏请求，等待本机确认`)
    this.cbs.onRequest?.(this.pending)
    this.cbs.onChanged?.()

    // TTL 自动过期：不能让一个无人理会的请求永远占住「唯一会话槽」
    this.ttlTimer = setTimeout(() => {
      if (this.pending && this.pending.sessionId === p.sessionId) {
        this.cbs.log?.('扩展屏请求超时未确认，已自动拒绝')
        this.expirePending()
      }
    }, this.ttlMs)
  }

  /**
   * UI：用户同意。同意即创建虚拟显示器——创建失败时会话不建立，
   * 回 session.reject（reason 为创建失败原因），不先 accept 再补建。
   */
  approve(sessionId: string): { ok: boolean; error?: string } {
    const req = this.pending
    if (!req || req.sessionId !== sessionId) return { ok: false, error: '请求不存在或已过期' }
    if (this.now() > req.expiresAt) {
      this.expirePending()
      return { ok: false, error: '请求已过期' }
    }
    const created = this.cbs.createVirtualDisplay(req.preferred)
    if (!created.ok) {
      this.clearTimer()
      this.pending = null
      this.cbs.send(req.peerId, 'session.reject', { sessionId: req.sessionId, reason: created.reason })
      this.cbs.log?.(`扩展屏创建失败，已拒绝 ${req.peerId}：${created.reason}`)
      this.cbs.onChanged?.()
      return { ok: false, error: created.reason }
    }
    this.clearTimer()
    this.pending = null
    this.active = {
      sessionId: req.sessionId,
      peerId: req.peerId,
      virtualScreen: created.screen,
      startedAt: this.now()
    }
    this.cbs.send(req.peerId, 'session.accept', { sessionId: req.sessionId, virtualScreen: created.screen })
    this.cbs.log?.(`已授权 ${req.peerId} 使用扩展屏（会话级，结束后虚拟显示器销毁）`)
    this.cbs.onChanged?.()
    return { ok: true }
  }

  /** UI：用户拒绝 */
  deny(sessionId: string, reason = 'denied by user'): void {
    const req = this.pending
    if (!req || req.sessionId !== sessionId) return
    this.clearTimer()
    this.pending = null
    this.cbs.send(req.peerId, 'session.reject', { sessionId: req.sessionId, reason })
    this.cbs.log?.('用户拒绝了扩展屏请求')
    this.cbs.onChanged?.()
  }

  /** 处理 session.stop（对端主动结束） */
  onStop(peerId: string, payload: unknown): void {
    const p = payload as { sessionId?: unknown }
    if (this.active && this.active.peerId === peerId && p?.sessionId === this.active.sessionId) {
      this.endSession('对端结束了扩展屏')
    }
  }

  /** 连接断开：活动会话立即失效，虚拟显示器随之销毁 */
  onPeerDisconnected(peerId: string): void {
    if (this.active && this.active.peerId === peerId) {
      this.endSession('对端连接断开')
    } else if (this.pending && this.pending.peerId === peerId) {
      this.clearTimer()
      this.pending = null
      this.cbs.onChanged?.()
    }
  }

  /** 信任撤销：比断连更优先的终止理由，立即掐断并销毁虚拟显示器 */
  onTrustRevoked(peerId: string): void {
    if ((this.active && this.active.peerId === peerId) || (this.pending && this.pending.peerId === peerId)) {
      this.clearTimer()
      this.pending = null
      if (this.active) this.endSession('信任已被撤销')
    }
  }

  /** 本机用户主动终止（被控端随时可以收回扩展屏） */
  terminate(): void {
    if (!this.active) return
    const peerId = this.active.peerId
    const sessionId = this.active.sessionId
    this.endSession('本机终止了扩展屏')
    this.cbs.send(peerId, 'session.stop', { sessionId, reason: 'stopped by controlled device' })
  }

  private endSession(reason: string): void {
    const ended = this.active
    this.active = null
    // 虚拟显示器是会话级资源：任何终止路径都销毁，不留残留设备
    this.cbs.destroyVirtualDisplay()
    this.cbs.log?.(`扩展屏会话结束：${reason}`)
    if (ended) this.cbs.send(ended.peerId, 'session.stop', { sessionId: ended.sessionId, reason })
    this.cbs.onChanged?.()
  }

  private expirePending(): void {
    const req = this.pending
    this.clearTimer()
    this.pending = null
    if (req) this.cbs.send(req.peerId, 'session.reject', { sessionId: req.sessionId, reason: 'expired' })
    this.cbs.onChanged?.()
  }

  private clearTimer(): void {
    if (this.ttlTimer) clearTimeout(this.ttlTimer)
    this.ttlTimer = null
  }
}

// ---------- 控制端 ----------

export interface ExtendControllerCallbacks {
  send: (peerId: string, type: string, payload: Record<string, unknown>) => void
  onAccepted?: (peerId: string, sessionId: string, virtualScreen: { x: number; y: number; w: number; h: number }) => void
  onRejected?: (peerId: string, sessionId: string, reason: string) => void
  /** 会话结束（对端停 / 对端超时）。之后扩展屏画面立即收起 */
  onEnded?: (peerId: string, reason: string) => void
  log?: (msg: string) => void
}

export interface ExtendControllerOptions {
  callbacks: ExtendControllerCallbacks
  /** 等待对端 accept/reject 的超时。略长于被控端 TTL，让对端先表态 */
  requestTimeoutMs?: number
}

interface ExtendPendingRequest {
  peerId: string
  timer: NodeJS.Timeout
  resolve: (v: { ok: true; sessionId: string } | { ok: false; error: string }) => void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 32_000

/** accept 里虚拟显示器矩形的校验：x/y 可为负（虚拟屏相对坐标），w/h 须 ≥1 */
export function decodeVirtualScreen(raw: unknown): { x: number; y: number; w: number; h: number } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Record<string, unknown>
  const nums = ['x', 'y', 'w', 'h'].map((k) => s[k])
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const [x, y, w, h] = nums as number[]
  if (w < 1 || h < 1 || w > 32768 || h > 32768) return null
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

export class DisplayExtendController {
  private active: { peerId: string; sessionId: string; virtualScreen: { x: number; y: number; w: number; h: number } } | null = null
  private readonly pending = new Map<string, ExtendPendingRequest>()
  private readonly cbs: ExtendControllerCallbacks
  private readonly timeoutMs: number

  constructor(opts: ExtendControllerOptions) {
    this.cbs = opts.callbacks
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  get activeSession(): { peerId: string; sessionId: string; virtualScreen: { x: number; y: number; w: number; h: number } } | null {
    return this.active
  }

  /** 正在扩展到谁（peerId），未扩展时为 null */
  get extendingTo(): string | null {
    return this.active?.peerId ?? null
  }

  /** 是否有扩展请求已发出、等对端确认 */
  get hasPendingRequest(): boolean {
    return this.pending.size > 0
  }

  /**
   * 请求把对端用作扩展屏。Promise 在 accept/reject/超时三者之一时落定。
   * preferred 为 null 时由对端按 INF 预置模式选虚拟显示器尺寸。
   */
  request(
    peerId: string,
    preferred: ExtendPreferredSize | null,
    scaleWidth: number,
    displayName: string
  ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    if (this.active || this.pending.size > 0) {
      return Promise.resolve({ ok: false, error: '已有扩展屏会话进行中' })
    }
    const sessionId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(sessionId)
        resolve({ ok: false, error: '对端未响应扩展屏请求' })
      }, this.timeoutMs)
      this.pending.set(sessionId, { peerId, timer, resolve })
      const params: Record<string, unknown> = { displayName, scaleWidth }
      if (preferred) {
        params.width = preferred.width
        params.height = preferred.height
      }
      this.cbs.send(peerId, 'session.start', {
        sessionId,
        sessionType: 'display-extend',
        params
      })
    })
  }

  /** Host 桥：对端 session.accept。来源必须与请求的对端一致 */
  onAccepted(peerId: string, sessionId: string, virtualScreen: unknown): void {
    const req = this.pending.get(sessionId)
    if (!req || req.peerId !== peerId) return
    const screen = decodeVirtualScreen(virtualScreen)
    if (!screen) {
      clearTimeout(req.timer)
      this.pending.delete(sessionId)
      req.resolve({ ok: false, error: '对端 accept 缺少虚拟显示器尺寸' })
      this.cbs.log?.('扩展屏 accept 缺少合法 virtualScreen，已拒绝本次请求')
      return
    }
    clearTimeout(req.timer)
    this.pending.delete(sessionId)
    this.active = { peerId: req.peerId, sessionId, virtualScreen: screen }
    req.resolve({ ok: true, sessionId })
    this.cbs.onAccepted?.(req.peerId, sessionId, screen)
  }

  /** Host 桥：对端 session.reject。来源必须与请求的对端一致 */
  onRejected(peerId: string, sessionId: string, reason: string): void {
    const req = this.pending.get(sessionId)
    if (!req || req.peerId !== peerId) return
    clearTimeout(req.timer)
    this.pending.delete(sessionId)
    req.resolve({ ok: false, error: reason === 'not trusted' ? '对端拒绝了请求（未信任设备）' : `对端拒绝：${reason || '未知原因'}` })
    this.cbs.onRejected?.(req.peerId, sessionId, reason)
  }

  /** Host 桥：对端 session.stop（被控端随时可收回扩展屏） */
  onStopped(peerId: string, sessionId: string): void {
    if (this.active && this.active.peerId === peerId && this.active.sessionId === sessionId) {
      this.active = null
      this.cbs.log?.('被控端结束了扩展屏会话')
      this.cbs.onEnded?.(peerId, 'stopped by controlled device')
    }
  }

  /** 被控端连接断开：扩展画面立即收起 */
  onPeerDisconnected(peerId: string): void {
    if (this.active && this.active.peerId === peerId) {
      this.active = null
      this.cbs.log?.('被控端连接断开，扩展屏已收起')
      this.cbs.onEnded?.(peerId, 'connection lost')
    }
    for (const [sessionId, req] of this.pending) {
      if (req.peerId !== peerId) continue
      clearTimeout(req.timer)
      this.pending.delete(sessionId)
      req.resolve({ ok: false, error: '对端连接已断开' })
    }
  }

  /** 本地主动退出（UI 按钮）。幂等 */
  stop(reason = 'stopped by user'): void {
    const active = this.active
    this.active = null
    if (active) {
      this.cbs.send(active.peerId, 'session.stop', { sessionId: active.sessionId, reason })
      this.cbs.onEnded?.(active.peerId, reason)
    }
  }
}
