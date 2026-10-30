// 键鼠共享的会话状态机（阶段 3，第 7 组）。
//
// 两个角色，各一个类：
//   - InputSessionCoordinator：**被控端**。别人请求来控制本机时的
//     接待逻辑——授权门禁、用户确认（9.1「每次控制请求都有明确可见
//     的授权提示」）、事件解码注入、随时可被掐断。
//   - InputController：**控制端**。发起控制请求、跟踪会话状态、
//     批量外发事件、随时退出（7.4）。
//
// 刻意做成不依赖 Electron / ws 的纯逻辑：信收发由调用方注入
// （send / localScreen / inject），授权判定由调用方注入
// （isPeerAuthorized）。会话时序、越权拒绝、断连清理这些最容易
// 出错的路径才能在无头测试里确定性覆盖。
//
// **control 授权的语义**：它不是 TrustStore 里的持久化条目，而是
// 「一次已被用户确认的活动会话」。协议 4.1 说控制类能力「需二次
// 授权」——把授权做成会话级内存态，会话结束即失效，才符合 9.1
// 「每次控制请求都要提示」；持久化的 control 授权会让提示失去意义。

import { randomUUID } from 'node:crypto'
import { decodeInputEvents, decodeScreenSize, mapPoint, SESSION_ID_RE, type InputEvent, type ScreenSize } from './protocol'

/** 需要用户确认的控制请求（被控端 UI 展示用） */
export interface InputControlRequest {
  sessionId: string
  peerId: string
  /** 对端自报的显示名，仅用于提示文案，不作信任依据 */
  displayName: string
  /** 控制端屏幕尺寸，accept 时对端据此把本机事件映射过去 */
  screen: ScreenSize
  expiresAt: number
}

/** 进行中的控制会话（被控端视角） */
export interface ActiveInputSession {
  sessionId: string
  peerId: string
  screen: ScreenSize
  startedAt: number
}

export interface CoordinatorCallbacks {
  /**
   * 授权判定：对端必须在信任清单内（已配对）。control 不是前置
   * 授权——恰恰相反，本次会话被确认后才算持有 control。
   */
  isPeerAuthorized: (peerId: string) => boolean
  /** 本机屏幕尺寸，accept 回给对端、事件映射用 */
  localScreen: () => ScreenSize
  /** 事件注入出口。到达时已完成解码与坐标映射 */
  inject: (events: InputEvent[], session: ActiveInputSession) => void
  /** 会话终止时抬起所有按住的键与鼠标键（防卡键） */
  releaseAll: () => void
  /** 给对端发消息。对端不在线时静默丢弃 */
  send: (peerId: string, type: string, payload: Record<string, unknown>) => void
  log?: (msg: string) => void
  /** 状态变化（进入/离开 pending、active），UI 刷新用 */
  onChanged?: () => void
  /** 新控制请求到达且已过门禁，UI 应立即展示确认弹窗（9.1） */
  onRequest?: (req: InputControlRequest) => void
}

export interface CoordinatorOptions {
  callbacks: CoordinatorCallbacks
  /** 挂起的控制请求多久无人处理即自动拒绝。产品值 30s */
  requestTtlMs?: number
  now?: () => number
}

const DEFAULT_REQUEST_TTL_MS = 30_000

export class InputSessionCoordinator {
  private pending: InputControlRequest | null = null
  private active: ActiveInputSession | null = null
  private ttlTimer: NodeJS.Timeout | null = null
  private readonly cbs: CoordinatorCallbacks
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(opts: CoordinatorOptions) {
    this.cbs = opts.callbacks
    this.ttlMs = opts.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS
    this.now = opts.now ?? Date.now
  }

  get activeSession(): ActiveInputSession | null {
    return this.active
  }

  get pendingRequest(): InputControlRequest | null {
    return this.pending
  }

  /** UI 提示用：本机正被谁控制 */
  get controlledBy(): string | null {
    return this.active?.peerId ?? null
  }

  /**
   * 处理对端发来的 session.start（sessionType: 'input'）。
   * Host 的消息桥只做信封透传，校验与状态迁移全在这里。
   */
  onStart(peerId: string, payload: unknown): void {
    const p = payload as { sessionId?: unknown; sessionType?: unknown; params?: { screen?: unknown; displayName?: unknown } }
    if (p?.sessionType !== 'input' || typeof p.sessionId !== 'string' || !SESSION_ID_RE.test(p.sessionId)) {
      this.cbs.send(peerId, 'session.reject', { sessionId: typeof p?.sessionId === 'string' ? p.sessionId : '', reason: 'bad request' })
      return
    }
    const screen = decodeScreenSize(p.params?.screen)
    if (!screen) {
      this.cbs.send(peerId, 'session.reject', { sessionId: p.sessionId, reason: 'bad screen params' })
      return
    }

    // 门禁一：未配对设备的控制请求直接拒绝，**不进 pending、不弹 UI**。
    // 9.1 的授权提示是给用户的，而任意局域网连接都能刷出的提示框
    // 本身就是骚扰面
    if (!this.cbs.isPeerAuthorized(peerId)) {
      this.cbs.log?.(`拒绝未信任设备 ${peerId} 的键鼠控制请求`)
      this.cbs.send(peerId, 'session.reject', { sessionId: p.sessionId, reason: 'not trusted' })
      return
    }

    // 门禁二：同一时刻至多一个挂起/活动会话。键鼠只有一套，多个
    // 控制端同时注入没有意义；重复请求回 RESOURCE_BUSY 语义
    if (this.pending && this.pending.peerId === peerId && this.pending.sessionId === p.sessionId) {
      return // 同一请求的重入：保持等待，不能回 busy 把对端挂起的 promise 打掉
    }
    if (this.active || this.pending) {
      // 幂等：同一会话的 start 重发（对端消息重传）直接重新 accept
      if (this.active && this.active.peerId === peerId && this.active.sessionId === p.sessionId) {
        this.cbs.send(peerId, 'session.accept', { sessionId: p.sessionId, screen: this.cbs.localScreen() })
        return
      }
      this.cbs.send(peerId, 'session.reject', { sessionId: p.sessionId, reason: 'resource busy' })
      return
    }

    this.pending = {
      sessionId: p.sessionId,
      peerId,
      displayName: String(p.params?.displayName ?? ''),
      screen,
      expiresAt: this.now() + this.ttlMs
    }
    this.cbs.log?.(`收到 ${peerId} 的键鼠控制请求，等待本机确认`)
    this.cbs.onRequest?.(this.pending)
    this.cbs.onChanged?.()

    // TTL 自动过期：不能让一个无人理会的请求永远占住「唯一会话槽」
    this.ttlTimer = setTimeout(() => {
      if (this.pending && this.pending.sessionId === p.sessionId) {
        this.cbs.log?.('键鼠控制请求超时未确认，已自动拒绝')
        this.expirePending()
      }
    }, this.ttlMs)
  }

  /** UI：用户同意 */
  approve(sessionId: string): { ok: boolean; error?: string } {
    const req = this.pending
    if (!req || req.sessionId !== sessionId) return { ok: false, error: '请求不存在或已过期' }
    if (this.now() > req.expiresAt) {
      this.expirePending()
      return { ok: false, error: '请求已过期' }
    }
    this.clearTimer()
    this.pending = null
    this.active = { sessionId: req.sessionId, peerId: req.peerId, screen: req.screen, startedAt: this.now() }
    this.cbs.send(req.peerId, 'session.accept', { sessionId: req.sessionId, screen: this.cbs.localScreen() })
    this.cbs.log?.(`已授权 ${req.peerId} 控制本机键鼠（会话级，结束后失效）`)
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
    this.cbs.log?.('用户拒绝了键鼠控制请求')
    this.cbs.onChanged?.()
  }

  /** 处理 input.event。校验不过的整批丢弃，不留痕内容（可能含敏感输入） */
  onEvent(peerId: string, payload: unknown): void {
    const active = this.active
    // 旁观连接（含其他已配对设备）不得注入：会话是点对点的
    if (!active || peerId !== active.peerId) {
      this.cbs.log?.(`忽略 ${peerId} 的 input.event（无活动会话或来源不符）`)
      return
    }
    const p = payload as { sessionId?: unknown }
    if (p?.sessionId !== active.sessionId) return
    const events = decodeInputEvents(p)
    if (!events) {
      this.cbs.log?.('丢弃非法的 input.event 批次')
      return
    }
    const local = this.cbs.localScreen()
    const mapped = events.map((ev) =>
      ev.t === 'move' ? { ...mapPoint(ev.x, ev.y, active.screen, local), t: 'move' as const } : ev
    )
    this.cbs.inject(mapped, active)
  }

  /** 处理 session.stop（对端主动结束） */
  onStop(peerId: string, payload: unknown): void {
    const p = payload as { sessionId?: unknown }
    if (this.active && this.active.peerId === peerId && p?.sessionId === this.active.sessionId) {
      this.endSession('对端结束了控制')
    }
  }

  /** 连接断开：活动会话立即失效（7.5 断线恢复的被控端半边） */
  onPeerDisconnected(peerId: string): void {
    if (this.active && this.active.peerId === peerId) {
      this.endSession('对端连接断开')
    } else if (this.pending && this.pending.peerId === peerId) {
      this.clearTimer()
      this.pending = null
      this.cbs.onChanged?.()
    }
  }

  /** 信任撤销：比断连更优先的终止理由，立即掐断 */
  onTrustRevoked(peerId: string): void {
    if ((this.active && this.active.peerId === peerId) || (this.pending && this.pending.peerId === peerId)) {
      this.clearTimer()
      this.pending = null
      if (this.active) this.endSession('信任已被撤销')
    }
  }

  /** 本机用户主动终止（被控端随时可以拔掉控制权） */
  terminate(): void {
    if (!this.active) return
    const peerId = this.active.peerId
    const sessionId = this.active.sessionId
    this.endSession('本机终止了控制')
    this.cbs.send(peerId, 'session.stop', { sessionId, reason: 'stopped by controlled device' })
  }

  private endSession(reason: string): void {
    const ended = this.active
    this.active = null
    this.cbs.releaseAll()
    this.cbs.log?.(`键鼠控制会话结束：${reason}`)
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

export interface ControllerCallbacks {
  send: (peerId: string, type: string, payload: Record<string, unknown>) => void
  onAccepted?: (peerId: string, sessionId: string, remoteScreen: ScreenSize) => void
  onRejected?: (peerId: string, sessionId: string, reason: string) => void
  /** 会话结束（对端停 / 对端超时）。之后本机输入立即回到本机 */
  onEnded?: (peerId: string, reason: string) => void
  log?: (msg: string) => void
}

export interface ControllerOptions {
  callbacks: ControllerCallbacks
  /** 等待对端 accept/reject 的超时。略长于被控端 TTL，让对端先表态 */
  requestTimeoutMs?: number
}

interface PendingRequest {
  peerId: string
  timer: NodeJS.Timeout
  resolve: (v: { ok: true; sessionId: string } | { ok: false; error: string }) => void
}

const DEFAULT_REQUEST_TIMEOUT_MS = 32_000

export class InputController {
  private active: { peerId: string; sessionId: string } | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly cbs: ControllerCallbacks
  private readonly timeoutMs: number

  constructor(opts: ControllerOptions) {
    this.cbs = opts.callbacks
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  get activeSession(): { peerId: string; sessionId: string } | null {
    return this.active
  }

  /** 正在控制谁（peerId），未控制任何设备时为 null */
  get controlling(): string | null {
    return this.active?.peerId ?? null
  }

  /**
   * 请求控制对端。Promise 在 accept/reject/超时三者之一时落定。
   * 调用方（UI）不需要关心时序，只需要处理两种结果。
   */
  request(peerId: string, screen: ScreenSize, displayName: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    if (this.active || this.pending.size > 0) {
      return Promise.resolve({ ok: false, error: '已有键鼠共享会话进行中' })
    }
    const sessionId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(sessionId)
        resolve({ ok: false, error: '对端未响应控制请求' })
      }, this.timeoutMs)
      this.pending.set(sessionId, { peerId, timer, resolve })
      this.cbs.send(peerId, 'session.start', {
        sessionId,
        sessionType: 'input',
        params: { screen, displayName }
      })
    })
  }

  /** Host 桥：对端 session.accept。来源必须与请求的对端一致 */
  onAccepted(peerId: string, sessionId: string, screen: unknown): void {
    const req = this.pending.get(sessionId)
    if (!req || req.peerId !== peerId) return
    clearTimeout(req.timer)
    this.pending.delete(sessionId)
    const remoteScreen = decodeScreenSize(screen)
    this.active = { peerId: req.peerId, sessionId }
    req.resolve({ ok: true, sessionId })
    this.cbs.onAccepted?.(req.peerId, sessionId, remoteScreen ?? { w: 1920, h: 1080 })
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

  /** Host 桥：对端 session.stop（被控端随时可拔） */
  onStopped(peerId: string, sessionId: string): void {
    if (this.active && this.active.peerId === peerId && this.active.sessionId === sessionId) {
      this.active = null
      this.cbs.log?.('被控端结束了控制会话')
      this.cbs.onEnded?.(peerId, 'stopped by controlled device')
    }
  }

  /** 被控端连接断开：立即回到本机控制（7.5 断线恢复的控制端半边） */
  onPeerDisconnected(peerId: string): void {
    if (this.active && this.active.peerId === peerId) {
      this.active = null
      this.cbs.log?.('被控端连接断开，已回到本机控制')
      this.cbs.onEnded?.(peerId, 'connection lost')
    }
    // 挂起请求随断连落定（审查 P3）：不清会占住唯一会话槽直到请求
    // 超时，期间新请求一律被拒
    for (const [sessionId, req] of this.pending) {
      if (req.peerId !== peerId) continue
      clearTimeout(req.timer)
      this.pending.delete(sessionId)
      req.resolve({ ok: false, error: '对端连接已断开' })
    }
  }

  /** 批量外发事件。只在活动会话中发送；断线/退出后调用是安全的空操作 */
  sendEvents(events: InputEvent[]): void {
    if (!this.active || events.length === 0) return
    this.cbs.send(this.active.peerId, 'input.event', { sessionId: this.active.sessionId, events })
  }

  /** 本地主动退出（7.4 快捷键 / UI 按钮 / 边缘逻辑要求）。幂等 */
  stop(reason = 'stopped by user'): void {
    const active = this.active
    this.active = null
    if (active) {
      this.cbs.send(active.peerId, 'session.stop', { sessionId: active.sessionId, reason })
      this.cbs.onEnded?.(active.peerId, reason)
    }
  }
}
