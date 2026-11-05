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
import { generatePairingCode, normalizeFingerprint } from './control/node'
import { ALL_SCOPES, type TrustEntry, type TrustScope, type TrustStore } from './transfer/trust'
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
  /**
   * 配对成功时授予的授权范围。
   * 默认 file + clipboard：两者都在对外通告的能力位里，且都不涉及
   * 控制本机。control 永远不在此列——它需要用户单独授权。
   */
  grantScope?: TrustScope[]
}

/** 默认授予范围。control 不在其中，键鼠/投屏需用户二次授权 */
const DEFAULT_GRANT_SCOPE: TrustScope[] = ['file', 'clipboard']

/**
 * 对端 approve 载荷的 scope 收敛（审查 P3）：白名单过滤之外再强制剔除
 * control。grantScope() 在接收侧已剔除，发起侧收对端载荷必须对称剔除，
 * 否则恶意 approve 可把 control 位写进本机 TrustStore。
 */
export function filterApprovedScope(raw: unknown): TrustScope[] {
  return (Array.isArray(raw) ? raw : []).filter(
    (s): s is TrustScope => (ALL_SCOPES as string[]).includes(s) && s !== 'control'
  )
}

const CODE_TTL_MS = 60_000
const MAX_ATTEMPTS = 5
/** 同时挂起的配对请求上限。超出即拒绝，防止未认证连接刷 UI */
const MAX_PENDING = 8

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

  /**
   * 配对成功时授予的范围。
   * control 被强制剔除：键鼠与投屏能让对端操作本机，不能靠一次配对
   * 就交出去，必须由用户另行授权。
   */
  private grantScope(): TrustScope[] {
    const s = this.opts.grantScope ?? DEFAULT_GRANT_SCOPE
    return s.filter((x) => x !== 'control')
  }

  /**
   * 本机改名后同步（5.4）：后续的 announce / pair.request 会带上新名字。
   * opts 字段非只读，原地更新即可，协调器没有其他地方缓存名字副本。
   */
  setDisplayName(name: string): void {
    this.opts.displayName = name
  }

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

    // 入库的指纹以 TLS 会话的实际证书为准（发起方连入时已出示），
    // announce 里的自报指纹只配当拿不到证书时的退路
    const presentedFp = p.conn.tlsFingerprint ?? normalizeFingerprint(p.fingerprint)
    const entry: Omit<TrustEntry, 'trustedAt'> = {
      deviceId: p.peerId,
      displayName: p.displayName,
      deviceType: p.deviceType,
      fingerprint: presentedFp,
      scope: this.grantScope()
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
   * connect() 发出 device.announce 后立即返回，调用方很可能在对端
   * hello 返回前就发起配对（UI 点击快于网络 RTT）。此时等待身份到达
   * 而不是立即报错——报错后 UI 按钮消失，用户无从恢复（真机踩过）。
   */
  private readonly identityWaiters = new Map<Connection, Array<() => void>>()

  private waitIdentity(conn: Connection, timeoutMs = 8000): Promise<boolean> {
    if (this.peers.has(conn)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (arrived: boolean): void => {
        clearTimeout(timer)
        const ws = this.identityWaiters.get(conn)?.filter((w) => w !== wake)
        if (ws?.length) this.identityWaiters.set(conn, ws)
        else this.identityWaiters.delete(conn)
        resolve(arrived)
      }
      const wake = (): void => done(true)
      const timer = setTimeout(() => done(false), timeoutMs)
      const ws = this.identityWaiters.get(conn) ?? []
      ws.push(wake)
      this.identityWaiters.set(conn, ws)
    })
  }

  /** 对端身份已在 handleAnnounce 注册完毕，唤醒等它的 requestPairing */
  private flushIdentityWaiters(conn: Connection): void {
    this.identityWaiters.get(conn)?.forEach((wake) => wake())
    this.identityWaiters.delete(conn)
  }

  async requestPairing(conn: Connection): Promise<TrustEntry> {
    if (this.awaitingApprove.has(conn)) {
      return Promise.reject(new Error('该连接已有配对请求在进行中'))
    }
    if (!(await this.waitIdentity(conn))) {
      return Promise.reject(new Error('连接尚未完成身份声明（对端未响应），请稍后重试'))
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
    const claimedFp = typeof p.fingerprint === 'string' ? normalizeFingerprint(p.fingerprint) : ''
    const actualFp = conn.tlsFingerprint

    // 自称的指纹与 TLS 会话实际使用的证书不符：连接那头根本不持有它
    // 声称的身份，多说什么都是假的，直接断开。
    if (actualFp && claimedFp && actualFp !== claimedFp) {
      log.warn(`对端 ${peerId} 声称的指纹与 TLS 证书不符，断开连接`)
      conn.send('pair.error', { code: 'NOT_TRUSTED', message: '指纹与证书不符' })
      conn.close(4006, 'fingerprint mismatch')
      return
    }

    // 已信任的设备重新连入：与信任清单比对。已信任身份意味着剪贴板
    // 广播、挂起任务补发等授权都会对着这条连接敞开，因此**必须出示
    // TLS 证书**且指纹与库存一致——无证书一律断开（审查 2.1 P0）。
    // 此前 `presented = actualFp ?? claimedFp` 的自报回退让攻击者只要
    // 自报受害者的指纹即可冒充已配对设备。自报回退仅对未知设备保留：
    // 未知连接拿不到任何授权（各处 hasScope 闸），风险止于显示层。
    const known = this.trust.fingerprintOf(peerId)
    if (known) {
      if (!actualFp) {
        log.warn(`对端 ${peerId} 未出示 TLS 证书却声称已信任身份，断开连接（疑似冒充）`)
        conn.send('pair.error', { code: 'NOT_TRUSTED', message: '已信任设备必须出示证书，请撤销后重新配对' })
        conn.close(4006, 'certificate required')
        return
      }
      if (actualFp !== normalizeFingerprint(known)) {
        log.warn(`对端 ${peerId} 指纹与信任清单不符，可能被替换或存在中间人，断开连接`)
        conn.send('pair.error', { code: 'NOT_TRUSTED', message: '设备指纹与已存记录不符，请撤销后重新配对' })
        conn.close(4006, 'fingerprint mismatch')
        return
      }
      log.info(`对端 ${peerId} 已在信任清单中（证书指纹核验通过）`)
      this.peers.set(conn, {
        deviceId: peerId,
        displayName: p.displayName,
        deviceType: p.deviceType,
        caps: p.caps,
        fingerprint: actualFp
      })
      conn.peerId = peerId
      this.uiPaired?.forEach((cb) => cb(this.trust.list().find((e) => e.deviceId === peerId)!))
    } else {
      this.peers.set(conn, {
        deviceId: peerId,
        displayName: p.displayName,
        deviceType: p.deviceType,
        caps: p.caps,
        fingerprint: claimedFp
      })
      conn.peerId = peerId
    }
    // 身份注册完成，唤醒可能在等它的 requestPairing
    this.flushIdentityWaiters(conn)

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
    // 配对请求不需要任何前置授权就能发起，必须设总量上限，
    // 否则任意未认证连接都能无限刷出配对码污染接收方 UI
    if (this.pending.size >= MAX_PENDING) {
      log.warn(`挂起配对请求已达上限 ${MAX_PENDING}，拒绝新请求`)
      conn.send('pair.error', { code: 'RESOURCE_BUSY', message: '配对请求过多，请稍后再试' })
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
        deviceId: this.opts.deviceId,
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
    // 入库指纹以 TLS 会话实际证书为准——approve 载荷里的指纹是对方
    // 自报的，若与证书不符，证书说了算（证书拿不到才用自报值）
    const presentedFp = conn.tlsFingerprint ?? normalizeFingerprint(p.fingerprint)
    // scope 由对端构造：白名单过滤并强制剔除 control（审查 P3）
    const scope = filterApprovedScope(p.scope)
    const entry: Omit<TrustEntry, 'trustedAt'> = {
      deviceId: p.deviceId,
      displayName: p.displayName,
      deviceType: p.deviceType,
      fingerprint: presentedFp,
      scope
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

  private handlePairRevoke(conn: Connection, msg: Envelope<{ deviceId?: string }>): void {
    const deviceId = msg.payload?.deviceId ?? msg.from
    // 撤销消息的语义是「我撤销你对我的信任」，因此只接受撤销方
    // 撤销它自己的身份，且连接必须完成过身份声明。否则任何能连上
    // 控制通道的设备都能伪造一条消息，定向删除本机对第三方的信任。
    if (deviceId !== msg.from || deviceId !== conn.peerId) {
      log.warn(`拒绝来源与内容不符的撤销请求（声称撤销 ${deviceId}）`)
      return
    }
    // 已信任设备的撤销，还必须由持有对应证书的连接发出：
    // 指纹锚定不上就当没收到，防止冒用 deviceId 的连接清掉信任
    const stored = this.trust.fingerprintOf(deviceId)
    if (stored) {
      const presented = conn.tlsFingerprint
      if (!presented || presented !== normalizeFingerprint(stored)) {
        log.warn(`撤销请求的 TLS 指纹与信任条目不符，已忽略`)
        return
      }
    }
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
