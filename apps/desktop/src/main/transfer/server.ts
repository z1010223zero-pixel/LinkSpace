// 文件传输服务端与客户端。
//
// 协议见 docs/protocol.md 第 4.5 / 5 节。控制消息（offer/accept/reject/
// complete）由上层经 WebSocket 或直接调用交换，本模块只负责**数据面**：
// 同一 TLS 端口上的 HTTPS 分块上传/下载（ADR-003：控制与文件共用端口）。
//
//   POST /linkspace/v1/transfer/:id/chunk?offset=N
//   GET  /linkspace/v1/transfer/:id/chunk?offset=N&length=M
//
// 身份校验：每个请求带 X-Device-Id 与 X-Transfer-Token。token 在
// transfer.accept 时由接收方生成并交还发送方，未持 token 的请求一律 403。
// 这是「未授权设备不能传输」的第一道闸门。

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Agent, createServer, request, type Server } from 'node:https'
import { networkInterfaces } from 'node:os'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { getDeviceCert } from './identity'
import { readChunk, writtenBytes } from './chunker'
import { inboundAllowed, isLanAddress } from '../net-scope'
import { log, shortSerial } from '../log'

export interface TransferRouteContext {
  /** 该 transferId 是否已被本机接受，以及其落盘路径 */
  resolveIncoming(transferId: string): { path: string; expectedSize: number } | null
  /**
   * 追加一块数据到已接受的任务。实现在管理器内串行化并在锁内重查
   * 任务存在性，取消与写入因此不会竞态。返回 null = 任务已不存在；
   * conflict = 偏移不衔接（值为对端已确认偏移）。
   */
  appendIncoming(
    transferKey: string,
    offset: number,
    body: Buffer
  ): Promise<{ conflict?: number; committedOffset: number } | null>
  /** 对端请求拉取（下载方向）：本机是否同意提供该文件 */
  resolveOutgoing(transferId: string): { path: string } | null
  /**
   * 数据面鉴权：设备在信任清单中且持有 file 授权，且 token 与该任务匹配。
   * 三项缺一不可——device 门禁挡未配对设备，token 门禁把每台已配对设备
   * 限制在它自己的传输任务里（否则任何已配对设备都能读写其他任务的分块）。
   */
  verifyTransfer(transferKey: string, deviceId: string, token: string): boolean
}

export interface StartedServer {
  server: Server
  port: number
}

export interface TransferServerOptions {
  /**
   * 监听地址。缺省时自动选择：环境变量 LINKSPACE_BIND_IP > 唯一非内部
   * IPv4 > 0.0.0.0。多网卡机器无法断定哪个是「局域网网卡」，保持全监听
   * 并在日志里提示，安全上由 TLS + 信任清单兜底。
   */
  bind?: string | { addr: string; note: string }
}

/**
 * 解析默认监听地址。
 *
 * 优先级：环境变量 LINKSPACE_BIND_IP > 唯一的局域网 IPv4 > 全部私有地址
 * 里挑一个 > 回环。
 *
 * 关键变化：过去「多网卡」直接回落 0.0.0.0，等于把所有网卡（含 VPN、
 * 虚拟网卡、可能可路由的地址）全部暴露。现在只要还能挑出一个私有地址，
 * 就绑到具体地址；实在挑不出来才退回回环——那时本来也不在局域网上，
 * 不该把端口开出去。
 *
 * 注意绑死单一地址在多网卡机器上仍有代价：mDNS 通告的地址可能不是监听的
 * 那张网卡，对端会连不上。所以同时保留 0.0.0.0 的可选路径——由
 * resolveBindAddress().note 说明，并始终叠加来源地址门禁（见 net-scope）。
 */
export function resolveBindAddress(): { addr: string; note: string } {
  const override = process.env.LINKSPACE_BIND_IP
  if (override) return { addr: override, note: `环境变量 LINKSPACE_BIND_IP=${override}` }

  const v4 = new Set<string>()
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) v4.add(ni.address)
    }
  }

  const lan = [...v4].filter(isRoutableLanAddress)
  if (lan.length === 1) {
    return { addr: lan[0], note: `自动绑定局域网地址 ${lan[0]}` }
  }
  if (lan.length > 1) {
    // 挑不出唯一的那张：监听全部地址，但入站一律过局域网门禁。
    // 这是可访问性与暴露面的折中——门禁保证即便监听 0.0.0.0，
    // 非局域网来源也进不来。
    return {
      addr: '0.0.0.0',
      note: `检测到多个局域网地址（${lan.join(', ')}），监听全部并启用来源门禁；可用 LINKSPACE_BIND_IP 收窄`
    }
  }
  return {
    addr: '127.0.0.1',
    note: '未检测到局域网 IPv4，仅监听回环——此时本设备对局域网不可见，可设 LINKSPACE_BIND_IP 覆盖'
  }
}

/** 网卡地址是否为「可对外提供服务的局域网地址」，排除回环与链路本地 */
function isRoutableLanAddress(ip: string): boolean {
  if (!isLanAddress(ip)) return false
  const o = ip.split('.').map(Number)
  if (o[0] === 127) return false
  if (o[0] === 169 && o[1] === 254) return false
  return true
}

/**
 * 写入偏移与接收方已确认偏移不一致。
 * 说明双方认知出现偏差（会话残留、乱序、上次中断），此时不能追加，
 * 否则会静默产生损坏文件。
 */
export class ChunkConflictError extends Error {
  constructor(public readonly committedOffset: number) {
    super(`分块偏移冲突：对端已确认偏移为 ${committedOffset}`)
    this.name = 'ChunkConflictError'
  }
}

/** 单个分块请求体上限。默认块 4 MiB，放宽到 32 MiB 容忍对端自定义块大小 */
const MAX_CHUNK_BODY = 32 * 1024 * 1024
/** GET 单块读取上限，防止 length 参数打爆内存 */
const MAX_READ_CHUNK = 32 * 1024 * 1024

export async function startTransferServer(
  ctx: TransferRouteContext,
  /** 外部注入的身份证书。同进程多节点时必须传，否则会共用进程级单例 */
  identity?: { key: string; cert: string },
  opts: TransferServerOptions = {}
): Promise<StartedServer> {
  const { key, cert } = identity ?? (await getDeviceCert())
  // 归一化成对象形式：调用方可以只传地址字符串，也可以连说明一起传
  const bind =
    typeof opts.bind === 'string'
      ? { addr: opts.bind, note: `显式绑定 ${opts.bind}` }
      : (opts.bind ?? resolveBindAddress())

  // requestCert 让服务端拿到对端证书（控制通道据此做指纹锚定），
  // rejectUnauthorized: false 是必须的：对端全是自签证书，链验证必然失败，
  // 真正的判定由上层按指纹与信任清单完成
  const server = createServer({ key, cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    void handle(ctx, req, res)
  })

  // 来源地址门禁：在 TLS 握手完成、进入业务处理之前就掐断非局域网连接。
  // 放在 secureConnection 而不是 request 上，是为了让 WebSocket 升级
  // 之外的普通连接也尽早断开，少一次完整的握手开销。
  // 注意这不会阻止后续 request 事件——它只是提前关掉 socket。
  server.on('secureConnection', (socket) => {
    if (!inboundAllowed(socket.remoteAddress)) {
      log.warn(`拒绝非局域网来源的连接：${socket.remoteAddress ?? '(未知)'}（设 LINKSPACE_ALLOW_WAN=1 可放行）`)
      socket.destroy()
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // 端口 0 = 让系统分配，真实端口经 mDNS 通告（见 architecture.md 第 4 节）
    server.listen(0, bind.addr, () => {
      const addr = server.address() as AddressInfo
      log.info(`文件传输服务已监听 ${bind.addr}:${addr.port}（${bind.note}）`)
      resolve({ server, port: addr.port })
    })
  })
}

async function handle(
  ctx: TransferRouteContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = /^\/linkspace\/v1\/transfer\/([^/]+)\/chunk$/.exec(url.pathname)
  if (!match) {
    res.writeHead(404).end('not found')
    return
  }

  // 路径里可能带畸形百分号编码，解析失败按 400 处理而不是让异常逃逸
  let transferKey: string
  try {
    transferKey = decodeURIComponent(match[1])
  } catch {
    res.writeHead(400).end('bad transfer id')
    return
  }

  const deviceId = String(req.headers['x-device-id'] ?? '')
  const token = String(req.headers['x-transfer-token'] ?? '')

  if (!deviceId || !token) {
    res.writeHead(401).end('missing credentials')
    return
  }
  // 唯一闸门：设备信任 + 授权范围 + 任务 token。三者由上层统一判定
  if (!ctx.verifyTransfer(transferKey, deviceId, token)) {
    log.warn(`拒绝未授权的数据面请求: ${shortSerial(deviceId)}`)
    res.writeHead(403).end('unauthorized')
    return
  }

  const offset = Number(url.searchParams.get('offset') ?? '0')

  if (req.method === 'POST') {
    const target = ctx.resolveIncoming(transferKey)
    if (!target) {
      res.writeHead(404).end('unknown transfer')
      return
    }
    if (!Number.isFinite(offset) || offset < 0) {
      res.writeHead(400).end('bad offset')
      return
    }

    // 流式接收，不把整块缓冲在内存里；同时限制总量防止内存被打爆
    const chunks: Buffer[] = []
    let received = 0
    let tooLarge = false
    for await (const piece of req) {
      received += (piece as Buffer).length
      if (received > MAX_CHUNK_BODY) {
        tooLarge = true
        break
      }
      chunks.push(piece as Buffer)
    }
    if (tooLarge) {
      req.destroy()
      res.writeHead(413).end('chunk too large')
      return
    }
    const body = Buffer.concat(chunks)
    const written = await writtenBytes(target.path)

    // 空体 = 探针：只回报已确认的连续偏移，不写盘。
    // 发送方据此从断点继续，而不是从 0 重传。
    if (received === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({ ok: true, received: 0, committedOffset: written, expectedSize: target.expectedSize })
      )
      return
    }

    // 偏移必须衔接。否则说明双方认知不一致（例如会话残留、乱序到达），
    // 直接追加会静默产生损坏文件 —— 返回 409 让发送方重新对齐。
    if (offset !== written) {
      log.warn(`分块偏移冲突：请求 ${offset}，对端已写入 ${written}`)
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({ ok: false, committedOffset: written, expectedSize: target.expectedSize })
      )
      return
    }

    // 块级摘要校验（protocol.md 第 5 节）：与声明的 X-Chunk-Digest 不符
    // 的块不落盘，由发送方重传，而不是把坏字节写进 .part
    const declaredDigest = String(req.headers['x-chunk-digest'] ?? '')
    if (!declaredDigest || declaredDigest.toLowerCase() !== sha256Hex(body)) {
      log.warn(`分块摘要校验失败：${transferKey}@${offset}`)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'digest mismatch', committedOffset: written }))
      return
    }

    try {
      // 追加经管理器串行化并在锁内重查：取消并发到达时，
      // 排队写入放弃、在途写入排空后再删 .part，不会留下残局
      const result = await ctx.appendIncoming(transferKey, offset, body)
      if (!result) {
        res.writeHead(404).end('unknown transfer')
        return
      }
      if (result.conflict !== undefined) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ok: false,
            committedOffset: result.conflict,
            expectedSize: target.expectedSize
          })
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          received,
          /** 接收方已确认的连续偏移，供断点续传 */
          committedOffset: result.committedOffset,
          expectedSize: target.expectedSize
        })
      )
    } catch (err) {
      log.error(`写入分块失败: ${err instanceof Error ? err.message : String(err)}`)
      res.writeHead(500).end('io error')
    }
    return
  }

  if (req.method === 'GET') {
    const source = ctx.resolveOutgoing(transferKey)
    if (!source || !existsSync(source.path)) {
      res.writeHead(404).end('unknown transfer')
      return
    }
    const requested = Number(url.searchParams.get('length') ?? String(4 * 1024 * 1024))
    if (!Number.isFinite(requested) || requested <= 0) {
      res.writeHead(400).end('bad length')
      return
    }
    const length = Math.min(requested, MAX_READ_CHUNK)
    try {
      const data = await readChunk(source.path, offset, length)
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.length),
        'X-Chunk-Digest': sha256Hex(data)
      })
      res.end(data)
    } catch (err) {
      log.error(`读取分块失败: ${err instanceof Error ? err.message : String(err)}`)
      res.writeHead(500).end('io error')
    }
    return
  }

  res.writeHead(405).end('method not allowed')
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export interface SendChunkResult {
  received: number
  committedOffset: number
}

/**
 * 分块传输的连接复用。
 * 默认 agent 每请求一次握手一次 TLS——1 GB / 64 KB 意味着一万六千次握手，
 * 慢到不可用。keepAlive 让同一任务的分块复用同一条连接。
 */
const CHUNK_AGENT = new Agent({
  keepAlive: true,
  keepAliveMsecs: 10_000,
  maxSockets: 8,
  // 对端是自签证书，安全性靠指纹核对而非证书链（见 threat-model.md T3）
  rejectUnauthorized: false
})

interface ChunkResponse {
  ok?: boolean
  received?: number
  committedOffset?: number
  expectedSize?: number
}

function requestJson(
  host: string,
  port: number,
  transferId: string,
  offset: number,
  data: Buffer,
  auth: { deviceId: string; token: string },
  headers: Record<string, string>
): Promise<{ status: number; body: ChunkResponse }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        agent: CHUNK_AGENT,
        method: 'POST',
        path: `/linkspace/v1/transfer/${encodeURIComponent(transferId)}/chunk?offset=${offset}`,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.length),
          'X-Device-Id': auth.deviceId,
          'X-Transfer-Token': auth.token,
          ...headers
        },
        rejectUnauthorized: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let body: ChunkResponse = {}
          try {
            body = JSON.parse(raw) as ChunkResponse
          } catch {
            body = {}
          }
          resolve({ status: res.statusCode ?? 0, body })
        })
      }
    )
    req.on('error', (err) => reject(err))
    req.end(data.length > 0 ? data : undefined)
  })
}

/**
 * 发送一个分块到对端。
 *
 * rejectUnauthorized 设为 false 是必要的：对端是自签证书，没有 CA 链。
 * 安全性来自别处——调用方必须在建立连接前核对对端证书指纹
 * （见 threat-model.md T3），而不是依赖 TLS 证书链。
 *
 * 偏移不衔接时抛出 ChunkConflictError，调用方应以对端的 committedOffset
 * 重新对齐后重发。
 */
export async function sendChunk(
  host: string,
  port: number,
  transferId: string,
  offset: number,
  data: Buffer,
  auth: { deviceId: string; token: string }
): Promise<SendChunkResult> {
  const { status, body } = await requestJson(host, port, transferId, offset, data, auth, {
    'X-Chunk-Size': String(data.length),
    // 接收方据此校验块完整性（protocol.md 第 5 节），不符返回 400
    'X-Chunk-Digest': sha256Hex(data)
  })

  if (status === 409) {
    throw new ChunkConflictError(body.committedOffset ?? 0)
  }
  if (status !== 200) {
    throw new Error(`对端返回 ${status}`)
  }
  if (typeof body.committedOffset !== 'number') {
    throw new Error('对端响应缺少 committedOffset')
  }
  return { received: body.received ?? 0, committedOffset: body.committedOffset }
}

/** 查询接收方已确认的连续偏移，用于断点续传（不写任何数据） */
export async function probeCommittedOffset(
  host: string,
  port: number,
  transferId: string,
  auth: { deviceId: string; token: string }
): Promise<number> {
  const { status, body } = await requestJson(
    host,
    port,
    transferId,
    0,
    Buffer.alloc(0),
    auth,
    { 'X-Probe': '1' }
  )
  if (status !== 200) throw new Error(`探测偏移失败：对端返回 ${status}`)
  return body.committedOffset ?? 0
}
