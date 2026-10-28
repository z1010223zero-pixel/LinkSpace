// 配对流程编排。
//
// 对应 docs/protocol.md 4.1 与方案 6.4：
//   mDNS 发现 → 用户发起 → 配对码人工确认 → 建立信任 → 随时可撤销
//
// 角色是动态的：一台设备既可能是发起方（点了「配对」），
// 也可能是接收方（被别 人点）。两侧状态机在同一份代码里。
//
// 与 protocol.md 的有意偏离（已在 node.ts 注释说明）：
//   pair.challenge 不携带配对码本身，只提示发起方「去要码」。
//   配对码经人眼从接收方屏幕搬到发起方输入框，再经 pair.submit 送回。

import { randomUUID } from 'node:crypto'
import type { Connection, ControlNode, Envelope } from './control/node'
import { generatePairingCode } from './control/node'
import type { TrustEntry, TrustStore } from './transfer/trust'
import { log } from './log'

export interface AnnouncePayload {
  displayName: string
  deviceType: string
  caps: string[]
  fingerprint: string
}

export interface PairRequestPayload {
  displayName: string
  deviceType: string
  fingerprint: string
}

export interface PairChallengePayload {
  expiresAt: number
}

export interface PairSubmitPayload {
  code: string
}

export interface PairApprovePayload {
  deviceId: string
  displayName: string
  deviceType: string
  fingerprint: string
  scope: string[]
}

/** 接收方视角：等待用户确认的配对请求 */
export interface PendingPairing {
  /** 供 UI 引用与 IPC 传递的稳定标识 */
  id: string
  conn: Connection
  peerId: string
  displayName: string
  deviceType: string
  fingerprint: string
  /** 6 位配对码，只应显示在接收方界面上 */
  code: string
  expiresAt: number
  attempts: number
}

export interface PairingCoordinatorOptions {
  deviceId: string
  displayName: string
  deviceType: string
  trust: TrustStore
  node: ControlNode
  /** 配对码有效期，默认 60s */
  codeTtlMs?: number
  /** 最大错误尝试次数，默认 5，超过即断连 */
  maxAttempts?: number
  /** 本机能力位，用于 device.announce 回应 */
  caps(): string[]
  /** 本机自己的证书指纹，用于身份声明与配对确认 */
  selfFingerprint(): string
}

const CODE_TTL_MS = 60_000
const MAX_ATTEMPTS = 5

export class PairingCoordinator {
  private readonly trust: TrustStore
  private readonly node: ControlNode
  private readonly opts: PairingCoordinatorOptions
  /** 接收方：conn → 待确认配对 */
  private readonly pending = new Map<Connection, PendingPairing>()
  /** 发起方：conn → 等待 approve 的 resolver */
  private readonly awaitingApprove = new Map<Connection, (entry: TrustEntry | Error) => void>()
  /** 发起方：conn → 已发起配对、等待用户输入对端显示的配对码 */
  private readonly awaitingCode = new Set<Connection>()
  /** conn → 对端身份（announce 后得知） */
  private readonly peers = new Map<Connection, AnnouncePayload & { deviceId: string }>()
  /**
   * 已向对端回过 announce 的连接。
   * 没有这个守卫，A 回 announce 会触发 B 再回一条，两边无限互弹。
   */
  private readonly announced = new Set<Connection>()
  private codeTtl: number
  private maxAttempts: number

  constructor(opts: PairingCoordinatorOptions) {
    this.opts = opts
    this.trust = opts.trust
    this.node = opts.node
    this.codeTtl = opts.codeTtlMs ?? CODE_TTL_MS
    this.maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS

    // 显式标注 payload 类型：on<T> 是泛型，不标注会退化成 unknown
    this.node
      .on('device.announce', (conn, msg: Envelope<AnnouncePayload>) =>
        this.handleAnnounce(conn, msg)
      )
      .on('pair.request', (conn, msg: Envelope<PairRequestPayload>) =>
        this.handlePairRequest(conn, msg)
      )
      .on('pair.submit', (conn, msg: Envelope<PairSubmitPayload>) => this.handlePairSubmit(conn, msg))
      .on('pair.reject', (conn, msg: Envelope<{ reason?: string }>) =>
        this.handlePairReject(conn, msg)
      )
      .on('pair.approve', (conn, msg: Envelope<PairApprovePayload>) =>
        this.handlePairApprove(conn, msg)
      )
      .on('pair.error', (conn, msg: Envelope<{ code?: string; message?: string }>) =>
        this.handlePairError(conn, msg)
      )
      .on('pair.revoke', (conn, msg: Envelope<{ deviceId?: string }>) =>
        this.handlePairRevoke(conn, msg)
      )
      .onClosed((conn) => this.handleClosed(conn))
  }

  // ---------- 对外 UI 回调 ----------

  /** 收到配对请求，需要用户在界面上看到配对码并确认 */
  onPairRequested(cb: (p: PendingPairing) => void): this {
    ;(this.uiRequested ??= []).push(cb)
    return this
  }

  /** 配对成功（无论本机是发起方还是接收方） */
  onPaired(cb: (entry: TrustEntry) => void): this {
    ;(this.uiPaired ??= []).push(cb)
    return this
  }

  /** 信任被撤销（对端撤销，或本机撤销） */
  onRevoked(cb: (deviceId: string) => void): this {
    ;(this.uiRevoked ??= []).push(cb)
    return this
  }

  private uiRequested: Array<(p: PendingPairing) => void> | null = null
  private uiPaired: Array<(entry: TrustEntry) => void> | null = null
  private uiRevoked: Array<(deviceId: string) => void> | null = null

  // ---------- 接收方 ----------

  /**
   * 用户确认配对。code 必须与界面上显示的一致。
   * 参数用 PendingPairing 而非 Connection：接收方的连接对象在服务端，
   * UI 手上只有 pending，传 Connection 极易拿错（早期就这么错过）。
   */
  approve(p: PendingPairing, code: string): { ok: boolean; error?: string } {
    // pending 可能已过期或被替换，先确认它仍然有效
    if (this.pending.get(p.conn) !== p) {
      return { ok: false, error: '配对请求已失效，请重新发起' }
    }
    if (Date.now() > p.expiresAt) {
      this.pending.delete(p.conn)
      p.conn.send('pair.error', { code: 'AUTH_REQUIRED', message: '配对码已过期' })
      p.conn.close(4003, 'pairing code expired')
      return { ok: false, error: '配对码已过期，请重新发起' }
    }
    if (code !== p.code) {
      p.attempts++
      if (p.attempts >= this.maxAttempts) {
        this.pending.delete(p.conn)
        p.conn.send('pair.error', { code: 'AUTH_REQUIRED', message: '配对码错误次数过多' })
        p.conn.close(4003, 'too many attempts')
        return { ok: false, error: '错误次数过多，连接已断开' }
      }
      return { ok: false, error: `配对码不正确（第 ${p.attempts} 次）` }
    }

    const entry: Omit<TrustEntry, 'trustedAt'> = {
      deviceId: p.peerId,
      displayName: p.displayName,
      deviceType: p.deviceType,
      fingerprint: p.fingerprint,
      scope: ['file']
    }
    this.trust.grant(entry)
    this.pending.delete(p.conn)

    const approveMsg: PairApprovePayload = {
      // deviceId 必须是**本机**的 id：对端要据此知道是谁批准了配对。
      // 曾误写为 p.peerId（对方 id），导致发起方把信任记到自己头上。
      deviceId: this.opts.deviceId,
      displayName: this.opts.displayName,
      deviceType: this.opts.deviceType,
      fingerprint: this.opts.selfFingerprint(),
      scope: entry.scope
    }
    p.conn.send('pair.approve', approveMsg)
    // 接收方自己也要记下对方身份
    this.trust.grant({
      deviceId: p.peerId,
      displayName: p.displayName,
      deviceType: p.deviceType,
      fingerprint: p.fingerprint,
      scope: ['file']
    })
    log.info(`已与 ${p.peerId} 建立信任（用户确认配对码）`)
    this.uiPaired?.forEach((cb) => cb(this.trust.list().find((e) => e.deviceId === p.peerId)!))
    return { ok: true }
  }

  /** 用户拒绝配对 */
  reject(p: PendingPairing, reason = '用户拒绝'): void {
    if (this.pending.get(p.conn) !== p) return
    this.pending.delete(p.conn)
    p.conn.send('pair.reject', { reason })
    p.conn.close(4001, reason)
  }

  /** 本机撤销对某设备的信任，并通知对端 */
  revoke(deviceId: string): boolean {
    const changed = this.trust.revoke(deviceId)
    if (changed) {
      for (const [conn, peer] of this.peers) {
        if (peer.deviceId === deviceId) {
          // deviceId 是撤销方的 id，对端据此知道该删掉谁的信任。
          // 曾误发被撤销方的 id，导致对端把自己的信任条目删掉。
          conn.send('pair.revoke', { deviceId: this.opts.deviceId })
          conn.close(4005, 'trust revoked')
        }
      }
      this.uiRevoked?.forEach((cb) => cb(deviceId))
      log.info(`已撤销对 ${deviceId} 的信任`)
    }
    return changed
  }

  // ---------- 发起方 ----------

  /**
   * 连上对端后主动声明身份。
   * 协议要求先 device.announce 才能配对，否则对方不知道我们是谁。
   */
  introduce(conn: Connection): void {
    conn.send('device.announce', {
      displayName: this.opts.displayName,
      deviceType: this.opts.deviceType,
      caps: this.opts.caps(),
      fingerprint: this.opts.selfFingerprint()
    } satisfies AnnouncePayload)
  }

  /**
   * 发起配对并等待用户在对端确认。
   * 对端确认后 resolve 出信任条目；被拒绝/超时则 reject。
   */
  requestPairing(conn: Connection): Promise<TrustEntry> {
    if (this.awaitingApprove.has(conn)) {
      return Promise.reject(new Error('该连接已有配对请求在进行中'))
    }
    const peer = this.peers.get(conn)
    if (!peer) return Promise.reject(new Error('连接尚未完成身份声明，无法配对'))

    return new Promise<TrustEntry>((resolve, reject) => {
      this.awaitingApprove.set(conn, (result) => {
        if (result instanceof Error) reject(result)
        else resolve(result)
      })
      this.awaitingCode.add(conn)
      conn.send('pair.request', {
        displayName: this.opts.displayName,
        deviceType: this.opts.deviceType,
        fingerprint: this.opts.selfFingerprint()
      } satisfies PairRequestPayload)

      setTimeout(() => {
        if (this.awaitingApprove.delete(conn)) {
          this.awaitingCode.delete(conn)
          conn.send('pair.reject', { reason: 'pairing timeout' })
          conn.close(4002, 'pairing timeout')
          reject(new Error('配对超时，对端未在 60 秒内确认'))
        }
      }, this.codeTtl + 15_000)
    })
  }

  /**
   * 发起方：用户输入了对端显示的配对码。
   * 校验发生在对端，这里只负责转发；发起方本地不持有正确的码。
   */
  submitCode(conn: Connection, code: string): { ok: boolean; error?: string } {
    if (!this.awaitingCode.has(conn)) {
      return { ok: false, error: '没有等待输入配对码的会话' }
    }
    if (!/^\d{6}$/.test(code)) {
      return { ok: false, error: '配对码应为 6 位数字' }
    }
    conn.send('pair.submit', { code } satisfies PairSubmitPayload)
    return { ok: true }
  }

  // ---------- 消息处理 ----------

  private handleAnnounce(conn: Connection, msg: Envelope<AnnouncePayload>): void {
    const p = msg.payload
    if (typeof p?.displayName !== 'string' || !Array.isArray(p?.caps)) return
    const peerId = msg.from
    conn.peerId = peerId
    this.peers.set(conn, {
      deviceId: peerId,
      displayName: p.displayName,
      deviceType: p.deviceType,
      caps: p.caps,
      fingerprint: p.fingerprint
    })
    // 回应自己的身份声明，让对方也知道我们是谁。
    // 每个连接只回一次，否则两边会无限互弹 announce。
    if (!this.announced.has(conn)) {
      this.announced.add(conn)
      conn.send('device.announce', {
        displayName: this.opts.displayName,
        deviceType: this.opts.deviceType,
        caps: this.opts.caps(),
        fingerprint: this.opts.selfFingerprint()
      } satisfies AnnouncePayload)
    }

    // 若已信任且指纹一致，直接视为已配对；不一致说明设备身份被替换，必须重新配对
    const known = this.trust.fingerprintOf(peerId)
    if (known && known === p.fingerprint) {
      log.info(`对端 ${peerId} 已在信任清单中`)
      this.uiPaired?.forEach((cb) => cb(this.trust.list().find((e) => e.deviceId === peerId)!))
    } else if (known && known !== p.fingerprint) {
      log.warn(`对端 ${peerId} 指纹与信任清单不符，可能被替换或存在中间人`)
      conn.send('pair.error', { code: 'NOT_TRUSTED', message: '设备指纹与已存记录不符，请撤销后重新配对' })
    }
  }

  private handlePairRequest(conn: Connection, _msg: Envelope<PairRequestPayload>): void {
    const peer = this.peers.get(conn)
    if (!peer) {
      conn.send('pair.error', { code: 'AUTH_REQUIRED', message: '请先发送 device.announce' })
      return
    }
    if (this.pending.has(conn)) {
      conn.send('pair.error', { code: 'RESOURCE_BUSY', message: '已有配对请求在处理' })
      return
    }

    // 若已信任，直接放行，不再要求配对码
    if (this.trust.isKnown(peer.deviceId)) {
      this.trust.grant({
        deviceId: peer.deviceId,
        displayName: peer.displayName,
        deviceType: peer.deviceType,
        fingerprint: peer.fingerprint,
        scope: this.trust.scopeOf(peer.deviceId)
      })
      conn.send('pair.approve', {
        deviceId: peer.deviceId,
        displayName: this.opts.displayName,
        deviceType: this.opts.deviceType,
        fingerprint: this.opts.selfFingerprint(),
        scope: this.trust.scopeOf(peer.deviceId)
      } satisfies PairApprovePayload)
      this.uiPaired?.forEach((cb) => cb(this.trust.list().find((e) => e.deviceId === peer.deviceId)!))
      return
    }

    const code = generatePairingCode()
    const pending: PendingPairing = {
      id: randomUUID(),
      conn,
      peerId: peer.deviceId,
      displayName: peer.displayName,
      deviceType: peer.deviceType,
      fingerprint: peer.fingerprint,
      code,
      expiresAt: Date.now() + this.codeTtl,
      attempts: 0
    }
    this.pending.set(conn, pending)
    // 只提示「需要配对码」，不把码发过去（见文件头说明）
    conn.send('pair.challenge', { expiresAt: pending.expiresAt } satisfies PairChallengePayload)
    log.info(`收到 ${peer.deviceId} 的配对请求，等待用户输入配对码`)
    this.uiRequested?.forEach((cb) => cb(pending))

    setTimeout(() => {
      if (this.pending.get(conn) === pending) {
        this.pending.delete(conn)
        conn.send('pair.error', { code: 'AUTH_REQUIRED', message: '配对码已过期' })
        conn.close(4003, 'pairing code expired')
      }
    }, this.codeTtl)
  }

  private handlePairSubmit(conn: Connection, msg: Envelope<PairSubmitPayload>): void {
    const pending = this.pending.get(conn)
    if (!pending) {
      conn.send('pair.error', { code: 'AUTH_REQUIRED', message: '没有待确认的配对请求' })
      return
    }
    const result = this.approve(pending, String(msg.payload?.code ?? ''))
    if (!result.ok) {
      // 配对码错误也要告知对端，但不要泄露具体原因给攻击者
      conn.send('pair.error', { code: 'AUTH_REQUIRED', message: result.error ?? '配对失败' })
    }
  }

  private handlePairReject(conn: Connection, msg: Envelope<{ reason?: string }>): void {
    const resolve = this.awaitingApprove.get(conn)
    if (resolve) {
      this.awaitingApprove.delete(conn)
      resolve(new Error(msg.payload?.reason ?? '对端拒绝了配对'))
    }
  }

  private handlePairApprove(conn: Connection, msg: Envelope<PairApprovePayload>): void {
    const p = msg.payload
    const resolve = this.awaitingApprove.get(conn)
    this.awaitingApprove.delete(conn)
    if (!resolve) return

    if (!p?.deviceId || !p.fingerprint) {
      resolve(new Error('对端 approve 消息缺少必要字段'))
      return
    }
    const entry: Omit<TrustEntry, 'trustedAt'> = {
      deviceId: p.deviceId,
      displayName: p.displayName,
      deviceType: p.deviceType,
      fingerprint: p.fingerprint,
      scope: (Array.isArray(p.scope) ? p.scope : ['file']) as TrustEntry['scope']
    }
    this.trust.grant(entry)
    log.info(`配对成功，已信任 ${p.deviceId}`)
    const stored = this.trust.list().find((e) => e.deviceId === p.deviceId)!
    this.uiPaired?.forEach((cb) => cb(stored))
    resolve(stored)
  }

  private handlePairError(conn: Connection, msg: Envelope<{ code?: string; message?: string }>): void {
    const resolve = this.awaitingApprove.get(conn)
    if (resolve) {
      this.awaitingApprove.delete(conn)
      resolve(new Error(msg.payload?.message ?? msg.payload?.code ?? '配对失败'))
    }
  }

  private handlePairRevoke(_conn: Connection, msg: Envelope<{ deviceId?: string }>): void {
    const deviceId = msg.payload?.deviceId ?? msg.from
    this.trust.revoke(deviceId)
    this.uiRevoked?.forEach((cb) => cb(deviceId))
    log.info(`对端撤销了信任：${deviceId}`)
  }

  private handleClosed(conn: Connection): void {
    this.pending.delete(conn)
    this.peers.delete(conn)
    this.announced.delete(conn)
    this.awaitingCode.delete(conn)
    const resolve = this.awaitingApprove.get(conn)
    if (resolve) {
      this.awaitingApprove.delete(conn)
      resolve(new Error('连接已断开'))
    }
  }

  /** 当前等待用户确认的配对请求（供 UI 渲染） */
  pendingRequests(): PendingPairing[] {
    return [...this.pending.values()]
  }
}
