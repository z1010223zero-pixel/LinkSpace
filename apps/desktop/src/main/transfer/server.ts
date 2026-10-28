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
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { getDeviceCert } from './identity'
import { appendChunk, readChunk, writtenBytes } from './chunker'
import { log, shortSerial } from '../log'

export interface TransferRouteContext {
  /** 该 transferId 是否已被本机接受，以及其落盘路径 */
  resolveIncoming(transferId: string): { path: string; expectedSize: number } | null
  /** 对端请求拉取（下载方向）：本机是否同意提供该文件 */
  resolveOutgoing(transferId: string): { path: string } | null
  /** 对端设备身份，用于拒绝未授权访问 */
  isKnownDevice(deviceId: string): boolean
}

export interface StartedServer {
  server: Server
  port: number
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

export async function startTransferServer(
  ctx: TransferRouteContext,
  /** 外部注入的身份证书。同进程多节点时必须传，否则会共用进程级单例 */
  identity?: { key: string; cert: string }
): Promise<StartedServer> {
  const { key, cert } = identity ?? (await getDeviceCert())

  const server = createServer({ key, cert }, (req, res) => {
    void handle(ctx, req, res)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // 端口 0 = 让系统分配，真实端口经 mDNS 通告（见 architecture.md 第 4 节）
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address() as AddressInfo
      log.info(`文件传输服务已监听 0.0.0.0:${addr.port}`)
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

  const deviceId = String(req.headers['x-device-id'] ?? '')
  const token = String(req.headers['x-transfer-token'] ?? '')

  if (!deviceId || !token) {
    res.writeHead(401).end('missing credentials')
    return
  }
  if (!ctx.isKnownDevice(deviceId)) {
    log.warn(`拒绝未授权设备的传输请求: ${shortSerial(deviceId)}`)
    res.writeHead(403).end('unknown device')
    return
  }

  const transferId = decodeURIComponent(match[1])
  const offset = Number(url.searchParams.get('offset') ?? '0')

  if (req.method === 'POST') {
    const target = ctx.resolveIncoming(transferId)
    if (!target) {
      res.writeHead(404).end('unknown transfer')
      return
    }
    if (!Number.isFinite(offset) || offset < 0) {
      res.writeHead(400).end('bad offset')
      return
    }

    // 流式接收，不把整块缓冲在内存里
    const chunks: Buffer[] = []
    let received = 0
    for await (const piece of req) {
      const buf = piece as Buffer
      chunks.push(buf)
      received += buf.length
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

    try {
      await appendChunk(target.path, body)
      const nowWritten = await writtenBytes(target.path)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          received,
          /** 接收方已确认的连续偏移，供断点续传 */
          committedOffset: nowWritten,
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
    const source = ctx.resolveOutgoing(transferId)
    if (!source || !existsSync(source.path)) {
      res.writeHead(404).end('unknown transfer')
      return
    }
    const length = Number(url.searchParams.get('length') ?? String(4 * 1024 * 1024))
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
    'X-Chunk-Size': String(data.length)
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
