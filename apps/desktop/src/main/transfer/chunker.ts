// 分块传输的校验与流式工具。
//
// 设计依据 docs/protocol.md 第 5 节：
//   - 固定块大小（默认 4 MiB），块级摘要校验
//   - 整体摘要在全部完成后比对
//   - 断点续传基于接收方已确认的连续偏移 committedOffset
//
// 大文件不能整块读进内存：1 GB 文件若一次 readFile 会直接吃满内存。
// 因此发送端按块读取，接收端按块追加，只在块边界上做摘要。

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024

/** 计算文件整体 SHA-256，流式进行，不占内存 */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** 计算 Buffer 的 SHA-256 十六进制 */
export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function statFile(path: string): Promise<{ size: number }> {
  const s = await stat(path)
  return { size: s.size }
}

/**
 * 从指定偏移读取一个块。
 * 用文件句柄 + read 而非 createReadStream({ start })，避免为每次续传
 * 新建流对象，也便于精确控制读取长度。
 */
export async function readChunk(path: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buf, 0, length, offset)
    return bytesRead === length ? buf : buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** 把一个 Buffer 追加写入目标路径 */
export async function appendChunk(path: string, data: Buffer): Promise<void> {
  const handle = await open(path, 'a')
  try {
    await handle.write(data)
  } finally {
    await handle.close()
  }
}

/**
 * 确保目标文件存在，且不截断已有内容。
 *
 * 空文件（0 字节）一个分块都不会产生，接收端永远等不到 appendChunk，
 * .part 就不会被创建，最终 rename 必然 ENOENT。因此接收端在 accept 时
 * 就要把 .part 建出来。
 *
 * 用 'a' 而非 'w'：断点续传时若 .part 已有数据，'w' 会把它清空。
 */
export async function ensureFile(path: string): Promise<void> {
  const handle = await open(path, 'a')
  try {
    await handle.close()
  } catch {
    // 关闭失败不影响文件已创建的事实
  }
}

/** 目标文件当前已写入的字节数，用于计算 committedOffset */
export async function writtenBytes(path: string): Promise<number> {
  try {
    const s = await stat(path)
    return s.size
  } catch {
    return 0
  }
}

/**
 * 生成不覆盖的保存路径：name (1).ext、name (2).ext …
 * 默认重命名而非询问，覆盖必须显式确认（方案 14.5、protocol.md 第 5 节）。
 */
export function uniquePath(dir: string, name: string, exists: (p: string) => boolean): string {
  const direct = join(dir, name)
  if (!exists(direct)) return direct

  const ext = extname(name)
  const stem = basename(name, ext)

  for (let i = 1; i < 10000; i++) {
    const candidate = join(dir, `${stem} (${i})${ext}`)
    if (!exists(candidate)) return candidate
  }
  throw new Error(`无法为 ${name} 生成不重复的文件名`)
}

/** 临时文件名：传输中的文件先写 .part，完成后再改名，避免半成品被当成成品 */
export function partPathFor(finalPath: string): string {
  const dir = dirname(finalPath)
  const base = basename(finalPath)
  return join(dir, `.${base}.linkspace.part`)
}
