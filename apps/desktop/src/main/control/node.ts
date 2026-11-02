// 控制通道（WebSocket over TLS）。
//
// 对应 docs/protocol.md 第 1、3、4 节：长连接、心跳保活、统一消息信封。
// 与文件传输共用同一个 TLS 端口与同一张证书（ADR-003）。
//
// 与 protocol.md 的一处**有意偏离**：
//   协议草案写 `pair.challenge` 携带 pairingCode 由接收方发给发起方。
//   但配对码的意义在于「人工从一台设备的屏幕抄到另一台」，
//   若它经网络传输，任何能连上的人都能直接拿到，配对形同虚设。
//   因此本实现中 pair.challenge 只携带 expiresAt（提示发起端该去要码），
//   配对码由接收方生成后**仅显示在接收方界面上**，经用户手工输入后
//   由 pair.submit 送回。已回写到 docs/protocol.md。

import { randomFillSync, randomUUID } from 'node:crypto'
import type { Server as HttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { WebSocketServer, WebSocket } from 'ws'
import { inboundAllowed } from '../net-scope'
import { log } from '../log'

/**
 * WebSocket 升级阶段的来源地址门禁。
 *
 * 数据面在 secureConnection 上已经拦过一次，但 upgrade 走的是另一条路：
 * http.Server 的 upgrade 事件不经过 request 处理链，也不保证
 * secureConnection 先到达。这里必须再判一次，否则非局域网来源仍能
 * 通过控制通道建立长连接——门禁只要有一条路没堵住就等于没有。
 */
function guardInbound(socket: Duplex): boolean {
  const remote = (socket as TLSSocket).remoteAddress
  if (!inboundAllowed(remote)) {
    log.warn(`拒绝非局域网来源的控制连接：${remote ?? '(未知)'}（设 LINKSPACE_ALLOW_WAN=1 可放行）`)
    socket.destroy()
    return false
  }
  return true
}

export const PROTOCOL_VERSION = 1
export const HEARTBEAT_INTERVAL_MS = 5000
export const HEARTBEAT_TIMEOUT_MS = 15_000
export const MAX_CLOCK_SKEW_MS = 60_000

/**
 * 控制通道单消息上限（审查 P2-5）：ws 默认 100MiB，一条 clipboard.share
 * 就能把主进程按在 JSON.parse 上数秒。剪贴板内容上限 512KiB
 * （clipboard.ts），1MiB 已覆盖全部合法消息，超出由 ws 以 1009 断开。
 */
export const CONTROL_MAX_PAYLOAD = 1024 * 1024

/**
 * 高成本消息的频率上限（条/秒，1s 滑窗，超限按 4008 断开）。
 * input.event：采集 tick 12ms ≈ 83 条/s，200 留 2.4 倍余量；
 * clipboard.share：人类复制节奏，5 条/s 已远超正常使用。
 */
export const RATE_LIMITS: Readonly<Record<string, number>> = {
  'input.event': 200,
  'clipboard.share': 5
}

/** 每连接消息 id 去重窗口（协议 §3）：最近这么多条 id 内的重复只处理一次 */
export const MAX_SEEN_MESSAGE_IDS = 1024

/**
 * 每连接消息 id 去重（协议 §3）：同一 id 只处理一次。
 * 纯逻辑，可单测。按插入顺序淘汰最旧的 id，窗口固定为最近
 * MAX_SEEN_MESSAGE_IDS 条——连接生命周期内无界增长等于给对端
 * 留一个内存耗尽口子。
 */
export class SeenMessageIds {
  private readonly ids = new Set<string>()
  private readonly order: string[] = []
  /** 调用方看到的重复消息累计数（日志节流用） */
  duplicateCount = 0

  constructor(private readonly maxIds: number = MAX_SEEN_MESSAGE_IDS) {}

  /** 已见过返回 true；首次见返回 false 并记入窗口 */
  isDuplicate(id: string): boolean {
    if (this.ids.has(id)) {
      this.duplicateCount++
      return true
    }
    this.ids.add(id)
    this.order.push(id)
    while (this.order.length > this.maxIds) {
      const oldest = this.order.shift()
      if (oldest !== undefined) this.ids.delete(oldest)
    }
    return false
  }
}

/** 指纹统一成 64 位小写十六进制再比较，兼容冒号分隔与纯 hex 两种写法 */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/:/g, '').toLowerCase()
}

/**
 * 取 TLS 会话对端证书的 SHA-256 指纹（去冒号小写）。
 * 客户端连接上返回服务端证书，服务端连接上返回客户端证书（需服务端
 * 以 requestCert 开启双向索证）。对端未出示证书时返回 null。
 * 这是把「对方自称的身份」锚定到「加密会话实际使用的密钥」的唯一途径，
 * 没有它，announce 里的指纹只是一段可任意伪造的字符串。
 */
function tlsFingerprintOf(ws: WebSocket): string | null {
  try {
    const socket = (ws as unknown as { _socket?: TLSSocket })._socket
    if (!socket || typeof socket.getPeerCertificate !== 'function') return null
    const cert = socket.getPeerCertificate()
    // 未出示证书时 Node 返回空对象而非 null
    if (!cert || Object.keys(cert).length === 0 || !cert.fingerprint256) return null
    return normalizeFingerprint(cert.fingerprint256)
  } catch {
    return null
  }
}

export interface Envelope<T = unknown> {
  v: number
  type: string
  id: string
  from: string
  to: string
  ts: number
  payload: T
}

export interface Connection {
  /** 对端 deviceId，announce 之后才可用 */
  peerId: string
  readonly remoteAddress: string
  /**
   * 对端 TLS 证书指纹（SHA-256，去冒号小写）。连接建立时取自底层
   * TLSSocket，之后不再变化。null 表示对端未出示证书。
   */
  readonly tlsFingerprint: string | null
  /** JSON 控制消息（信封）发送 */
  send<T>(type: string, payload: T): void
  /** 二进制帧发送（屏幕投屏的视频块），与控制消息共用同一条连接 */
  sendBinary(data: Buffer): void
  /** 发送积压字节数（ws.bufferedAmount），码率自适应的拥塞信号 */
  backlog(): number
  /** 最后一次收到消息的时间，用于心跳超时判定 */
  lastSeen: number
  send<T>(type: string, payload: T): void
  close(code?: number, reason?: string): void
}

/**
 * 内部统一用 Envelope<unknown> 存 handler。
 * 外部 on<T> 的强类型只是开发期便利，运行时的信封都是 JSON.parse 出来的
 * unknown，各 handler 内部必须自行校验字段。
 */
type AnyMessageHandler = (conn: Connection, msg: Envelope) => void | Promise<void>

/** 二进制帧处理：WS 二进制帧（屏幕投屏的视频块）不进 JSON 信封，走这里分流 */
export type BinaryHandler = (conn: Connection, data: Buffer) => void

export type MessageHandler<T = unknown> = (
  conn: Connection,
  msg: Envelope<T>
) => void | Promise<void>

export interface ControlNodeOptions {
  deviceId: string
  /** TLS 凭据，与文件传输服务共用 */
  tls: { key: string; cert: string }
}

/**
 * 控制通道节点：既是服务端（接受连入）也是客户端（连出）。
 * 每个连接一个 Connection，消息经信封校验后分发给 handler。
 */
export class ControlNode {
  private wss: WebSocketServer | null = null
  private readonly conns = new Map<WebSocket, Connection>()
  private readonly handlers = new Map<string, AnyMessageHandler[]>()
  private readonly binaryHandlers: BinaryHandler[] = []
  private heartbeatTimer: NodeJS.Timeout | null = null
  private readonly deviceId: string

  constructor(private readonly opts: ControlNodeOptions) {
    this.deviceId = opts.deviceId
  }

  on<T>(type: string, handler: MessageHandler<T>): this {
    const list = this.handlers.get(type) ?? []
    list.push(handler as unknown as AnyMessageHandler)
    this.handlers.set(type, list)
    return this
  }

  /**
   * 注册二进制帧处理（反向 screen.stream 的视频块用）。
   * 文本帧走 on(type) 的 JSON 信封分发，二进制帧不进信封——ws 库按
   * opcode 区分，二者共用同一条连接、互不干扰。
   */
  onBinary(handler: BinaryHandler): this {
    this.binaryHandlers.push(handler)
    return this
  }

  /** 在已有 HTTPS 服务上挂 WebSocket 升级（与文件传输共用端口） */
  attach(httpServer: HttpsServer): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: CONTROL_MAX_PAYLOAD })
    httpServer.on('upgrade', (req, socket, head) => {
      if (!guardInbound(socket)) return
      if (!req.url?.startsWith('/linkspace/v1/control')) {
        socket.destroy()
        return
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
    })
  }

  /** 独立监听（测试用：不依赖已有 HTTPS 服务） */
  async listen(port = 0): Promise<number> {
    const { createServer } = await import('node:https')
    // requestCert 与数据面服务保持一致：向对端索要证书用于指纹锚定
    const server: HttpsServer = createServer({
      ...this.opts.tls,
      requestCert: true,
      rejectUnauthorized: false
    })
    this.wss = new WebSocketServer({ noServer: true, maxPayload: CONTROL_MAX_PAYLOAD })
    server.on('upgrade', (req, socket, head) => {
      if (!guardInbound(socket)) return
      if (!req.url?.startsWith('/linkspace/v1/control')) {
        socket.destroy()
        return
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    this.standaloneServer = server
    const addr = server.address()
    return typeof addr === 'object' && addr ? addr.port : port
  }

  private standaloneServer: HttpsServer | null = null

  /** 连出到对端。rejectUnauthorized 必须为 false：对端是自签证书 */
  connect(host: string, port: number): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${host}:${port}/linkspace/v1/control`, {
        rejectUnauthorized: false,
        maxPayload: CONTROL_MAX_PAYLOAD,
        // 主动出示本机证书：对端服务端开了 requestCert，据此锚定我们的身份
        cert: this.opts.tls.cert,
        key: this.opts.tls.key
      })
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error(`连接 ${host}:${port} 超时`))
      }, 8000)

      ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      ws.on('open', () => {
        clearTimeout(timer)
        const conn = this.wrap(ws)
        // 主动连出的连接也必须登记：否则它不参与心跳、不在 connections() 里、
        // 关闭时也不会触发 onClosed，对端状态永远挂着。
        this.conns.set(ws, conn)
        resolve(conn)
      })
    })
  }

  private accept(ws: WebSocket): void {
    const conn = this.wrap(ws)
    this.conns.set(ws, conn)
  }

  private wrap(ws: WebSocket): Connection {
    // 限频滑窗（审查 P2-5）：per-connection 闭包，连接关闭随 conn 回收
    const rateWindow = new Map<string, number[]>()
    // id 去重（协议 §3）：per-connection 闭包，连接关闭随 conn 回收
    const seenIds = new SeenMessageIds()
    const conn: Connection = {
      peerId: '',
      // 底层 TCP 对端地址（ws 库挂在 _socket 上）。screen.stream 的
      // 连出模式要用它做目标 IP——发现列表的 host 可能过期，活动
      // 连接的真实地址最准
      remoteAddress:
        (ws as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? '',
      tlsFingerprint: tlsFingerprintOf(ws),
      lastSeen: Date.now(),
      send<T>(type: string, payload: T) {
        if (ws.readyState !== WebSocket.OPEN) {
          log.warn(`连接 ${conn.peerId || '(未知)'} 已非 OPEN（${ws.readyState}），丢弃 ${type}`)
          return
        }
        const msg: Envelope<T> = {
          v: PROTOCOL_VERSION,
          type,
          id: randomUUID(),
          from: node.deviceId,
          // 对端身份在 device.announce 之前未知，此时留空。
          // 接收方允许空 to（见 wrap 中的校验）。
          to: conn.peerId,
          ts: Date.now(),
          payload
        }
        ws.send(JSON.stringify(msg), (err) => noteSendError(type, err))
      },
      /**
       * 二进制帧发送（屏幕投屏的视频块）。与 JSON 控制消息共用同一条
       * 连接：TCP 全双工，平板主动连出的链路上桌面照样能发——这绕开了
       * 「桌面→平板方向的新建 TCP 被环境策略拦截」的问题（实测平板
       * ServerSocket 对任何入站端口都不通，唯有平板自己连出的链路可用）
       */
      sendBinary(data: Buffer) {
        if (ws.readyState !== WebSocket.OPEN) return
        ws.send(data, { binary: true }, (err) => noteSendError('binary', err))
      },
      backlog() {
        return ws.readyState === WebSocket.OPEN ? ws.bufferedAmount : 0
      },
      close(code = 1000, reason = '') {
        try {
          ws.close(code, reason)
        } catch {
          /* 已关闭 */
        }
      }
    }
    const node = this
    // 发送失败诊断：ws.send 的错误只在回调里报，静默吞掉会让「对端
    // 收不到回告」变成无头案（真机踩过：投屏 start 丢件两侧全无日志）
    let sendFailures = 0

    const noteSendError = (where: string, err: Error | null | undefined) => {
      if (!err) return
      sendFailures++
      if (sendFailures <= 3 || sendFailures % 100 === 0) {
        log.warn(`连接 ${conn.peerId || '(未知)'} ${where} 发送失败(#${sendFailures}): ${err.message}`)
      }
    }

    ws.on('message', (raw, isBinary) => {
      conn.lastSeen = Date.now()
      // 二进制帧（屏幕投屏的视频块）：不进 JSON 信封解析，直接分流给
      // binaryHandlers。之前这里无条件 JSON.parse，视频块会被静默丢弃。
      if (isBinary) {
        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
        for (const handler of node.binaryHandlers) {
          try {
            handler(conn, data)
          } catch (err) {
            console.error(`[control] binary handler 失败:`, err)
          }
        }
        return
      }
      let msg: Envelope
      try {
        msg = JSON.parse(String(raw)) as Envelope
      } catch {
        return // 无法解析的消息直接丢弃，不回应
      }
      if (!isEnvelope(msg)) return
      // v 必须等于本机协议版本（W3，协议 §3/§8）：版本不兼容没有继续
      // 会话的意义，断开连接并记告警。注意 __closed__ 的 emptyEnvelope
      // 不走这里（直接构造，不经消息解析），不会被误伤。
      if (msg.v !== PROTOCOL_VERSION) {
        log.warn(`对端 ${conn.peerId || '(未知)'} 协议版本不兼容 v=${msg.v}，断开连接`)
        conn.close(4007, 'version mismatch')
        return
      }
      // to 必须是本机，或为空（device.announce 之前双方还不知道彼此 ID）。
      // 不是发给本机的消息静默丢弃，不断连。
      if (msg.to !== '' && msg.to !== node.deviceId) return
      // ts 超偏丢弃并记告警：时钟漂移可能是误配，不断连。
      if (Math.abs(Date.now() - msg.ts) > MAX_CLOCK_SKEW_MS) {
        log.warn(`对端 ${conn.peerId || '(未知)'} 的 ${msg.type} 时间戳超偏 ${Date.now() - msg.ts}ms，丢弃`)
        return
      }
      // from 绑定（协议 §3）：连接身份由 device.announce 登记在
      // conn.peerId 上（pairing.ts），之后固定。from 为空（未声明身份）
      // 或与登记身份不符的消息丢弃并记告警，不断连——连接本身已由 TLS
      // 证书锚定，错标多为对端实现问题；断连会掐掉一条活着的合法会话
      // （与 ts 超偏同款分级处置）。登记前（peerId 为空）只要求 from 非空。
      if (msg.from === '' || (conn.peerId !== '' && msg.from !== conn.peerId)) {
        log.warn(
          `对端 ${conn.peerId || '(未知)'} 的 ${msg.type} from 与连接身份不符（from=${msg.from || '(空)'}），丢弃`
        )
        return
      }

      // 高成本消息限频（审查 P2-5，威胁模型 T4）：input.event 的合法速率
      // 受采集 tick（12ms ≈ 83 条/s）约束，clipboard.share 是人类操作节奏。
      // 这两类消息处理成本最高（整批注入 / 写系统剪贴板），「合法格式 +
      // 非法频率」的洪泛按 4008 断开，不给留通道。
      const limit = RATE_LIMITS[msg.type]
      if (limit !== undefined) {
        const now = Date.now()
        const stamps = (rateWindow.get(msg.type) ?? []).filter((t) => t > now - 1000)
        stamps.push(now)
        rateWindow.set(msg.type, stamps)
        if (stamps.length > limit) {
          log.warn(`对端 ${conn.peerId || '(未知)'} 的 ${msg.type} 超过限频 ${limit} 条/s，断开连接`)
          conn.close(4008, 'rate limit exceeded')
          return
        }
      }

      // id 去重（协议 §3）：同一连接上同一 id 只处理一次；空 id 视为
      // 畸形丢弃。放在限频之后：重放洪泛仍会计入限频、超限按 4008 断开，
      // 不给留一条绕过限频的路。
      if (msg.id === '') {
        log.warn(`对端 ${conn.peerId || '(未知)'} 的 ${msg.type} id 为空，丢弃`)
        return
      }
      if (seenIds.isDuplicate(msg.id)) {
        // 重放多为重发/重连抖动，只记前 3 次、之后每 100 次记一次，
        // 免得一条重放洪泛把日志刷爆（限频在上游已先拦过高成本类型）
        if (seenIds.duplicateCount <= 3 || seenIds.duplicateCount % 100 === 0) {
          log.warn(
            `对端 ${conn.peerId || '(未知)'} 的 ${msg.type} id=${msg.id} 重复（第 ${seenIds.duplicateCount} 次），丢弃`
          )
        }
        return
      }

      void node.dispatch(conn, msg)
    })

    ws.on('error', (err) => {
      // 畸形帧会让 ws 抛 error（如对端在升级后的连接上混发 HTTP）。
      // 不接住的话它以未处理异常打爆整个进程——一颗坏连接等于一次 DoS
      log.warn(`控制连接异常断开: ${err instanceof Error ? err.message : String(err)}`)
      node.conns.delete(ws)
      node.handlers.get('__closed__')?.forEach((cb) => void cb(conn, {
        ...emptyEnvelope(node.deviceId)
      }))
    })

    ws.on('close', () => {
      node.conns.delete(ws)
      node.handlers.get('__closed__')?.forEach((cb) => void cb(conn, {
        ...emptyEnvelope(node.deviceId)
      }))
    })

    return conn
  }

  private async dispatch(conn: Connection, msg: Envelope): Promise<void> {
    const list = this.handlers.get(msg.type)
    if (!list) return // 未知类型按协议第 8 节安全忽略
    for (const handler of list) {
      try {
        await handler(conn, msg)
      } catch (err) {
        // handler 异常不能让连接断开，但必须留痕
        console.error(`[control] handler ${msg.type} 失败:`, err)
      }
    }
  }

  onClosed(cb: (conn: Connection) => void): this {
    const wrapped: MessageHandler = (conn) => void cb(conn)
    const list = this.handlers.get('__closed__') ?? []
    list.push(wrapped)
    this.handlers.set('__closed__', list)
    return this
  }

  /**
   * 启动心跳：周期发送 + 超时判定离线。
   * 间隔与超时可注入（无头测试用短周期验证超时路径），产品路径
   * 不传参数走默认 5s / 15s。
   */
  startHeartbeat(
    onTimeout: (conn: Connection) => void,
    opts: { intervalMs?: number; timeoutMs?: number } = {}
  ): void {
    const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS
    const timeoutMs = opts.timeoutMs ?? HEARTBEAT_TIMEOUT_MS
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()
      for (const [ws, conn] of this.conns) {
        if (ws.readyState !== WebSocket.OPEN) continue
        if (now - conn.lastSeen > timeoutMs) {
          onTimeout(conn)
          conn.close(4000, 'heartbeat timeout')
          continue
        }
        conn.send('device.heartbeat', {})
      }
    }, intervalMs)
  }

  connections(): Connection[] {
    return [...this.conns.values()]
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    for (const [ws] of this.conns) {
      try {
        ws.close(1001, 'shutdown')
      } catch {
        /* 已关闭 */
      }
    }
    this.conns.clear()
    this.wss?.close()
    this.wss = null
    this.standaloneServer?.close()
    this.standaloneServer = null
  }
}

function emptyEnvelope(from: string): Envelope {
  return { v: PROTOCOL_VERSION, type: '__closed__', id: '', from, to: '', ts: 0, payload: {} }
}

export function isEnvelope(v: unknown): v is Envelope {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Partial<Envelope>
  return (
    typeof m.v === 'number' &&
    typeof m.type === 'string' &&
    typeof m.id === 'string' &&
    typeof m.from === 'string' &&
    typeof m.to === 'string' &&
    typeof m.ts === 'number' &&
    typeof m.payload === 'object' &&
    m.payload !== null
  )
}

/** 配对码：6 位十进制，足以对抗 30 秒窗口内的穷举（10^6 / 30s） */
export function generatePairingCode(): string {
  const buf = Buffer.alloc(4)
  randomFillSync(buf)
  const n = buf.readUInt32BE(0) % 1_000_000
  return String(n).padStart(6, '0')
}
