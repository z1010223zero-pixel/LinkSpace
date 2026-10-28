// 传输任务状态机与编排。
//
// 对应 docs/protocol.md 第 4.5 节的消息流：
//   offer → accept → chunk* → complete
//                  ↘ reject / cancel / error
//
// 关键行为（都有对应验收项）：
//   - 接收方确认保存路径后才开始（transfer.accept）
//   - 同名文件默认重命名，不静默覆盖
//   - 传输中写 .part 临时文件，完成后才改名，半成品不会被我方或对方误判为成品
//   - 块级校验失败自动重传该块
//   - 断点续传基于 committedOffset，不重传整个文件
//   - 取消后清理临时文件

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  DEFAULT_CHUNK_SIZE,
  ensureFile,
  hashBuffer,
  hashFile,
  partPathFor,
  readChunk,
  uniquePath,
  writtenBytes
} from './chunker'
import { sendChunk, probeCommittedOffset, ChunkConflictError } from './server'
import { log } from '../log'

export type TransferState =
  | 'offered' // 已发起，等待对端确认
  | 'accepted' // 对端已接受，准备/正在传输
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TransferFile {
  name: string
  size: number
  /** 发送方本地路径（仅发送方有） */
  path?: string
  /** 接收方最终保存路径（仅接收方有） */
  savePath?: string
  /**
   * 整个文件的 SHA-256。由发送方在推送完成后算出，随 transfer.complete
   * 交给接收方，接收方落盘前比对（protocol.md 5.4）。
   */
  digest?: string
}

export interface TransferTask {
  id: string
  direction: 'send' | 'receive'
  peerId: string
  state: TransferState
  files: TransferFile[]
  totalSize: number
  transferred: number
  createdAt: number
  finishedAt?: number
  error?: string
  /** 接收方生成的令牌，交还发送方后作为数据面凭证 */
  token?: string
}

export interface TransferManagerEvents {
  changed: [TransferTask]
  /**
   * 发送方取消了任务。上层应把它转发成一条 transfer.cancel 控制消息，
   * 否则接收方的 .part 不会被清理——取消只做了一半。
   */
  cancelRequested: [{ id: string; peerId: string }]
}

export class TransferManager extends EventEmitter {
  private tasks = new Map<string, TransferTask>()
  /** 接收方：transferId → 落盘信息 */
  private incoming = new Map<string, { partPath: string; finalPath: string; expectedSize: number }>()
  /** 发送方：transferId → 源文件 */
  private outgoing = new Map<string, { path: string }>()
  /** 已接受但尚未完成的 token，用于数据面鉴权 */
  private tokens = new Map<string, string>()
  /**
   * 已被取消的任务 id。
   * cleanup() 不能清这个集合：push 的异常分支要靠它区分「用户取消」
   * 和「真的出错」，否则取消会被误报成 failed。
   * 集合只增不减，任务 id 本身唯一，不构成内存问题。
   */
  private cancelled = new Set<string>()
  private seq = 0

  constructor(private readonly opts: { chunkSize?: number } = {}) {
    super()
    this.setMaxListeners(50)
  }

  list(): TransferTask[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): TransferTask | undefined {
    return this.tasks.get(id)
  }

  // ---------- 发送方 ----------

  /**
   * 创建传输任务。发送方与接收方都会调用，因此用 direction 区分：
   *   - 发送方（默认）：校验源文件存在，并登记 outgoing 路由
   *   - 接收方：不校验文件（它没有源文件），只登记 incoming 路由
   *
   * transferId 由发送方生成（protocol.md：offer 由发送方发起并携带
   * transferId）。接收方收到 offer 后必须传入同一个 id，否则数据面的
   * transferId 命名空间对不上。
   */
  async offer(
    peerId: string,
    files: TransferFile[],
    transferId?: string,
    direction: 'send' | 'receive' = 'send'
  ): Promise<TransferTask> {
    if (files.length === 0) throw new Error('没有要传输的文件')

    const isSend = direction === 'send'
    if (isSend) {
      for (const f of files) {
        if (!f.path || !existsSync(f.path)) {
          throw new Error(`文件不存在: ${f.name}`)
        }
      }
    }

    const id = transferId ?? `tr-${++this.seq}-${randomUUID().slice(0, 8)}`
    const task: TransferTask = {
      id,
      direction: isSend ? 'send' : 'receive',
      peerId,
      state: 'offered',
      files,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      transferred: 0,
      createdAt: Date.now()
    }
    this.tasks.set(id, task)
    if (isSend) {
      for (const f of files) {
        this.outgoing.set(`${id}:${f.name}`, { path: f.path! })
      }
    }
    log.info(`创建传输任务 ${id}，${files.length} 个文件，共 ${task.totalSize} 字节`)
    this.emit('changed', task)
    return task
  }

  /** 接收方接受了 offer。token 由接收方生成，回传给发送方作为数据面凭证 */
  async accept(
    id: string,
    saveDir: string,
    opts: { token: string; renames?: Record<string, string> }
  ): Promise<TransferTask> {
    const task = this.tasks.get(id)
    if (!task) throw new Error('任务不存在')
    if (task.state !== 'offered') throw new Error(`任务状态为 ${task.state}，不能接受`)

    task.token = opts.token
    this.tokens.set(id, opts.token)
    task.state = 'accepted'

    for (const f of task.files) {
      const finalPath = opts.renames?.[f.name] ?? uniquePath(saveDir, f.name, (p) => existsSync(p))
      f.savePath = finalPath
      const partPath = partPathFor(finalPath)
      // 空文件没有分块可写，.part 必须在此建好，否则 finalize 的 rename 会 ENOENT
      await ensureFile(partPath)
      this.incoming.set(`${id}:${f.name}`, {
        partPath,
        finalPath,
        expectedSize: f.size
      })
    }

    log.info(`传输任务 ${id} 已被接受`)
    this.emit('changed', task)
    return task
  }

  reject(id: string, reason: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.state = 'failed'
    task.error = reason
    task.finishedAt = Date.now()
    log.info(`传输任务 ${id} 被拒绝: ${reason}`)
    this.emit('changed', task)
    this.cleanup(id)
  }

  /**
   * 接收方通过控制通道把 token 交还发送方。
   * token 由接收方在 accept 时生成，发送方必须拿到它才能通过数据面鉴权
   * （见 protocol.md 4.5 与 server.ts 的 X-Transfer-Token 校验）。
   */
  attachToken(id: string, token: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    task.token = token
    log.info(`传输任务 ${id} 已挂接传输令牌`)
  }

  // ---------- 数据面 ----------

  /**
   * 发送方：把所有分块推给对端。
   * host/port 由对端的 mDNS 记录提供。
   */
  async push(
    id: string,
    peer: { host: string; port: number; deviceId: string },
    onProgress?: (transferred: number, total: number) => void
  ): Promise<TransferTask> {
    const task = this.tasks.get(id)
    if (!task) throw new Error('任务不存在')
    if (task.direction !== 'send') throw new Error('只有发送方可以推送')
    if (!task.token) throw new Error('任务未被接受，没有传输令牌')

    const chunkSize = this.opts.chunkSize ?? DEFAULT_CHUNK_SIZE
    task.state = 'accepted'
    this.emit('changed', task)

    try {
      for (const file of task.files) {
        const path = file.path!
        const transferKey = `${id}:${file.name}`
        const auth = { deviceId: peer.deviceId, token: task.token }

        // 从对端已确认的偏移开始，这样中断后重连不会把已传的字节再追加一遍
        let offset = await probeCommittedOffset(peer.host, peer.port, transferKey, auth)
        let realigns = 0

        while (offset < file.size) {
          if (this.cancelled.has(id)) throw new Error('已取消')

          const length = Math.min(chunkSize, file.size - offset)
          const data = await readChunk(path, offset, length)

          // 块级校验：对端只认带正确摘要的块。摘要不符时重传，最多 3 次。
          let done = false
          let lastErr: unknown = null
          for (let attempt = 0; attempt < 3 && !done; attempt++) {
            try {
              const res = await sendChunk(peer.host, peer.port, transferKey, offset, data, auth)
              // 以对端确认的连续偏移为准，避免双方认知不一致
              offset = res.committedOffset
              done = true
            } catch (err) {
              if (err instanceof ChunkConflictError) {
                // 不消耗重试次数，以对端为准重新对齐后重发
                if (err.committedOffset === offset || ++realigns > 10) {
                  throw new Error(`分块偏移无法收敛：本机 ${offset}，对端 ${err.committedOffset}`)
                }
                log.warn(`分块偏移冲突，重新对齐 ${offset} → ${err.committedOffset}`)
                offset = err.committedOffset
                done = true
                break
              }
              lastErr = err
              log.warn(`分块 ${transferKey}@${offset} 第 ${attempt + 1} 次失败: ${String(err)}`)
            }
          }
          if (!done) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))

          task.transferred = offset
          this.emit('changed', task)
          onProgress?.(offset, file.size)
        }

        // 整体摘要：随 complete 交给接收方比对，是内容一致性的最终判据
        const localDigest = await hashFile(path)
        file.digest = localDigest
        task.transferred = task.files
          .filter((f) => f !== file)
          .reduce((s, f) => s + f.size, 0) + file.size
        this.emit('changed', task)
        log.info(`文件 ${basename(file.name)} 推送完成，摘要 ${localDigest.slice(0, 12)}…`)
      }

      task.state = 'completed'
      task.finishedAt = Date.now()
      log.info(`传输任务 ${id} 完成`)
      this.emit('changed', task)
      return task
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (this.cancelled.has(id)) {
        task.state = 'cancelled'
      } else {
        task.state = 'failed'
        task.error = msg
        log.error(`传输任务 ${id} 失败: ${msg}`)
      }
      task.finishedAt = Date.now()
      this.emit('changed', task)
      this.cleanup(id)
      return task
    }
  }

  /** 取消任务，清理接收方的 .part 临时文件 */
  async cancel(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    this.cancelled.add(id)
    if (task.state !== 'completed' && task.state !== 'failed') {
      task.state = 'cancelled'
      task.finishedAt = Date.now()
    }
    // 先删临时文件，再清映射（cleanup 会删掉 incoming，之后就找不到路径了）
    for (const file of task.files) {
      const entry = this.incoming.get(`${id}:${file.name}`)
      if (entry) {
        await rm(entry.partPath, { force: true }).catch(() => {
          /* 文件可能本就不存在 */
        })
      }
    }

    // 发送方取消时，接收方那边还留着 .part，必须通知它清理。
    // 真实实现是经控制通道发一条 transfer.cancel（protocol.md 4.5）；
    // 原型阶段还没有控制通道，这里把这一步作为事件抛给上层接线，
    // 避免「取消只清理了本端」这个缺口被悄悄吞掉。
    if (task.direction === 'send') {
      this.emit('cancelRequested', { id, peerId: task.peerId })
    }

    log.info(`取消传输任务 ${id}`)
    this.emit('changed', task)
    this.cleanup(id)
  }

  /** 调试/测试用：读取某任务 .part 当前已写入的字节数 */
  async partSize(id: string, name: string): Promise<number> {
    const entry = this.incoming.get(`${id}:${name}`)
    if (!entry) return 0
    return writtenBytes(entry.partPath)
  }

  /** 调试/测试用：取某任务 .part 的落盘路径 */
  partPath(id: string, name: string): string | null {
    return this.incoming.get(`${id}:${name}`)?.partPath ?? null
  }

  private cleanup(id: string): void {
    this.tokens.delete(id)
    this.outgoing.delete(id)
    for (const key of [...this.incoming.keys()]) {
      if (key.startsWith(`${id}:`)) this.incoming.delete(key)
    }
  }

  /**
   * 接收方：把 .part 改名为最终文件。
   * digests 由发送方随 transfer.complete 提供（文件名 → SHA-256），
   * 大小或摘要不符一律删除临时文件并报错——宁可失败，也不落一个坏文件。
   */
  async finalize(id: string, digests?: Record<string, string>): Promise<TransferTask> {
    const task = this.tasks.get(id)
    if (!task) throw new Error('任务不存在')
    // 取消/失败的任务不得落盘。complete 消息可能乱序到达（取消与完成
    // 几乎同时发生时就会），此时必须拒绝，否则半成品会变成正式文件。
    if (task.state === 'cancelled' || task.state === 'failed') {
      throw new Error(`任务 ${id} 状态为 ${task.state}，不能落盘`)
    }

    for (const file of task.files) {
      const entry = this.incoming.get(`${id}:${file.name}`)
      if (!entry) continue
      const written = await writtenBytes(entry.partPath)
      if (written !== entry.expectedSize) {
        await rm(entry.partPath, { force: true })
        throw new Error(`文件 ${file.name} 大小不符：期望 ${entry.expectedSize}，实际 ${written}`)
      }
      const expectedDigest = digests?.[file.name]
      if (expectedDigest) {
        const actual = await hashFile(entry.partPath)
        if (actual !== expectedDigest) {
          await rm(entry.partPath, { force: true })
          throw new Error(`文件 ${file.name} 摘要不符：期望 ${expectedDigest.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
        }
      }
      await rename(entry.partPath, entry.finalPath)
    }

    task.state = 'completed'
    task.finishedAt = Date.now()
    log.info(`传输任务 ${id} 已完成落盘`)
    this.emit('changed', task)
    return task
  }

  /** 供服务端路由查询：本机已接受的传入传输 */
  resolveIncoming(transferId: string): { path: string; expectedSize: number } | null {
    const entry = this.incoming.get(transferId)
    return entry ? { path: entry.partPath, expectedSize: entry.expectedSize } : null
  }

  resolveOutgoing(transferId: string): { path: string } | null {
    return this.outgoing.get(transferId) ?? null
  }

  /** 供服务端校验数据面令牌 */
  verifyToken(transferId: string, token: string): boolean {
    return this.tokens.get(transferId) === token
  }

  /** 便捷方法：计算一个 Buffer 的摘要（测试用） */
  digest(buf: Buffer): string {
    return hashBuffer(buf)
  }
}
