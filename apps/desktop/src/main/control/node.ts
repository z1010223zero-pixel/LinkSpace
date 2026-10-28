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

import { createHash, randomFillSync, randomUUID } from 'node:crypto'
import type { Server as HttpsServer } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { WebSocketServer, WebSocket } from 'ws'

export const PROTOCOL_VERSION = 1
export const HEARTBEAT_INTERVAL_MS = 5000
export const HEARTBEAT_TIMEOUT_MS = 15_000
export const MAX_CLOCK_SKEW_MS = 60_000

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

  /** 在已有 HTTPS 服务上挂 WebSocket 升级（与文件传输共用端口） */
  attach(httpServer: HttpsServer): void {
    this.wss = new WebSocketServer({ noServer: true })
    httpServer.on('upgrade', (req, socket, head) => {
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
    this.wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
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
    const conn: Connection = {
      peerId: '',
      remoteAddress: '',
      tlsFingerprint: tlsFingerprintOf(ws),
      lastSeen: Date.now(),
      send<T>(type: string, payload: T) {
        if (ws.readyState !== WebSocket.OPEN) return
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
        ws.send(JSON.stringify(msg))
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

    ws.on('message', (raw) => {
      conn.lastSeen = Date.now()
      let msg: Envelope
      try {
        msg = JSON.parse(String(raw)) as Envelope
      } catch {
        return // 无法解析的消息直接丢弃，不回应
      }
      if (!isEnvelope(msg)) return
      // to 必须是本机，或为空（device.announce 之前双方还不知道彼此 ID）
      if (msg.to !== '' && msg.to !== node.deviceId) return
      if (Math.abs(Date.now() - msg.ts) > MAX_CLOCK_SKEW_MS) return

      void node.dispatch(conn, msg)
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

  /** 启动心跳：周期发送 + 超时判定离线 */
  startHeartbeat(onTimeout: (conn: Connection) => void): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()
      for (const [ws, conn] of this.conns) {
        if (ws.readyState !== WebSocket.OPEN) continue
        if (now - conn.lastSeen > HEARTBEAT_TIMEOUT_MS) {
          onTimeout(conn)
          conn.close(4000, 'heartbeat timeout')
          continue
        }
        conn.send('device.heartbeat', {})
      }
    }, HEARTBEAT_INTERVAL_MS)
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

/** 内容摘要：剪贴板防循环用，取 SHA-256 前 16 字节 */
export function contentDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
}
