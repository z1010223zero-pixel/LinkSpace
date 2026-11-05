// 高性能投屏（"fast" 模式）：DXGI 桌面复制 + GPU 硬件编码 + 按帧封包。
//
// 与兼容模式（gdigrab + libx264 + 裸字节流）的区别见 docs 方案文档：
//   - 抓屏用 ffmpeg ddagrab（DXGI 桌面复制，帧留在 GPU 纹理里）
//   - 缩放/转 NV12 在 GPU 上完成，输出平板原生分辨率（1:1 显示，不二次缩放）
//   - 硬件编码器 QSV / NVENC / AMF 自动探测，逐条候选实测，一个都不行就回退兼容模式
//   - 输出带 AUD 的 Annex-B，按访问单元（一帧）切开，一帧一个 WebSocket 二进制消息
//
// 帧消息格式（桌面→平板，WebSocket 二进制帧）：
//   [0]      flags：bit0 = 关键帧（含 SPS/PPS/IDR）
//   [1..8]   发送时间戳，u64 小端，Unix 毫秒（平板据此估算网络+排队延迟）
//   [9..]    一个完整的 H.264 访问单元（Annex-B，以 AUD 开头）

import { spawn, spawnSync } from 'node:child_process'
import { log } from './log'

export const FAST_FRAME_HEADER_BYTES = 9
export const FAST_FLAG_KEY = 0x01

/** 高性能模式的流编码器标识（写进 screen.stream.start 的 codec 字段） */
export const FAST_CODEC_H264 = 'h264'

export type FastEncoderName = 'h264_qsv' | 'h264_nvenc' | 'h264_amf'

/** 一条可尝试的"抓屏→缩放→编码"通路 */
export interface FastCandidate {
  /** 稳定标识，日志与缓存用 */
  id: string
  encoder: FastEncoderName
  /** true = 帧全程留在 GPU；false = 抓屏后下载到内存再 CPU 缩放（编码仍是硬件） */
  zeroCopy: boolean
}

export interface FastParams {
  /** DXGI 输出序号（ddagrab output_idx） */
  outputIdx: number
  /** 输出分辨率（已对齐 32） */
  width: number
  height: number
  fps: number
  /** 目标码率 bps */
  bitrate: number
}

/** 候选按优先级排序：同一编码器先零拷贝、再下载回内存 */
export function candidatesFor(encoders: FastEncoderName[]): FastCandidate[] {
  const out: FastCandidate[] = []
  for (const encoder of encoders) {
    out.push({ id: `${encoder}/gpu`, encoder, zeroCopy: true })
    out.push({ id: `${encoder}/cpu-scale`, encoder, zeroCopy: false })
  }
  return out
}

/** 向下对齐到 32 的倍数（平板硬解对齐约束，见 screen-stream.ts 缩放三约束） */
export function alignDown32(v: number): number {
  return Math.max(32, Math.floor(v / 32) * 32)
}

/** 取最近的 32 的倍数 */
export function alignNearest32(v: number): number {
  return Math.max(32, Math.round(v / 32) * 32)
}

/**
 * 由源区域尺寸和平板给出的期望盒子算输出分辨率：不放大、保持宽高比，
 * 宽向下对齐 32，高取最近 32 的倍数（变形 1.5% 以内）。
 */
export function computeFastSize(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number
): { width: number; height: number } {
  const safeSrcW = Math.max(2, srcW)
  const safeSrcH = Math.max(2, srcH)
  const fit = Math.min(1, boxW / safeSrcW, boxH / safeSrcH)
  const width = alignDown32(safeSrcW * fit)
  const height = alignNearest32((width * safeSrcH) / safeSrcW)
  return { width, height }
}

/** 每像素每帧 0.1 bit：1080p60 ≈ 12Mbps；夹在 6~40Mbps */
export function computeFastBitrate(width: number, height: number, fps: number): number {
  const raw = Math.round(width * height * fps * 0.1)
  return Math.min(40_000_000, Math.max(6_000_000, raw))
}

/** 构造 ffmpeg 参数。stdout 输出带 AUD 与逐关键帧 SPS/PPS 的 Annex-B */
export function buildFastArgs(c: FastCandidate, p: FastParams, probeFrames?: number): string[] {
  const { width: w, height: h, fps, outputIdx, bitrate } = p
  const grab = `ddagrab=output_idx=${outputIdx}:framerate=${fps}:draw_mouse=0`
  let chain: string
  if (c.zeroCopy) {
    chain =
      c.encoder === 'h264_qsv'
        ? `${grab},hwmap=derive_device=qsv,scale_qsv=w=${w}:h=${h}:format=nv12`
        : `${grab},scale_d3d11=w=${w}:h=${h}:format=nv12`
  } else {
    chain = `${grab},hwdownload,format=bgra,scale=${w}:${h}:flags=fast_bilinear,format=nv12`
  }
  // 码控缓冲约 150ms 码率：既装得下 IDR，又把最坏排空延迟压在百毫秒内
  const bufsize = Math.round(bitrate * 0.15)
  const gop = String(fps * 2)
  const enc: string[] = []
  if (c.encoder === 'h264_qsv') {
    enc.push(
      '-c:v', 'h264_qsv',
      '-preset', 'veryfast',
      '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bufsize),
      '-look_ahead', '0', '-async_depth', '1', '-bf', '0', '-g', gop, '-forced_idr', '1'
    )
  } else if (c.encoder === 'h264_nvenc') {
    enc.push(
      '-c:v', 'h264_nvenc',
      '-preset', 'p1', '-tune', 'll', '-rc', 'cbr', '-zerolatency', '1',
      '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bufsize),
      '-bf', '0', '-g', gop, '-forced-idr', '1'
    )
  } else {
    enc.push(
      '-c:v', 'h264_amf',
      '-usage', 'ultralowlatency', '-quality', 'speed', '-rc', 'cbr',
      '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bufsize),
      '-bf', '0', '-g', gop
    )
  }
  return [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', 'nobuffer',
    '-f', 'lavfi', '-i', chain,
    ...(probeFrames ? ['-frames:v', String(probeFrames)] : []),
    ...enc,
    // 逐关键帧补 SPS/PPS，再给每个访问单元插 AUD：平板解码器随时能从关键帧起播，
    // 帧切分也只需认 AUD
    '-bsf:v', 'dump_extra=freq=keyframe,h264_metadata=aud=insert',
    '-flush_packets', '1',
    '-f', 'h264',
    'pipe:1'
  ]
}

/**
 * Annex-B 访问单元切分器：以 AUD（NAL type 9）为界。一个 AU 要等到下一个
 * AUD 出现才算完整，所以会多等一帧间隔（60fps ≈ 16ms）；换原生编码助手后可消除。
 */
export class AuSplitter {
  private buf: Buffer = Buffer.alloc(0)
  /** 当前 AU 起点（buf 内偏移）；-1 = 尚未见到第一个 AUD */
  private start = -1
  private scan = 0

  /** 喂入一块数据，返回此刻已完整的 AU 列表 */
  push(chunk: Buffer): Array<{ au: Buffer; key: boolean }> {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const out: Array<{ au: Buffer; key: boolean }> = []
    const b = this.buf
    let i = this.scan
    while (i + 3 < b.length) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
        if ((b[i + 3]! & 0x1f) === 9) {
          // 4 字节起始码时把前导 00 一并划进这个 AUD
          const at = i > 0 && b[i - 1] === 0 ? i - 1 : i
          if (this.start >= 0 && at > this.start) {
            const au = b.subarray(this.start, at)
            out.push({ au: Buffer.from(au), key: AuSplitter.hasIdr(au) })
          }
          this.start = at
        }
        i += 3
      } else {
        i++
      }
    }
    // 留一个起始码长度的尾巴，避免起始码被切在块边界漏扫
    this.scan = Math.max(i, b.length - 3)
    if (this.start > 0) {
      this.buf = b.subarray(this.start)
      this.scan -= this.start
      this.start = 0
    } else if (this.start < 0 && b.length > 4096) {
      // 第一个 AUD 之前的杂字节没有价值，丢掉防止无界增长
      this.buf = b.subarray(b.length - 3)
      this.scan = 0
    }
    return out
  }

  static hasIdr(au: Buffer): boolean {
    for (let i = 0; i + 3 < au.length; i++) {
      if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
        if ((au[i + 3]! & 0x1f) === 5) return true
        i += 2
      }
    }
    return false
  }

  /** 当前未结算的 AU 是否已经包含至少一个 VCL 切片（NAL type 1 或 5） */
  hasPendingVcl(): boolean {
    if (this.start < 0) return false
    const b = this.buf
    for (let i = this.start; i + 3 < b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
        const t = b[i + 3]! & 0x1f
        if (t === 1 || t === 5) return true
        i += 2
      }
    }
    return false
  }

  /**
   * 立即结算当前缓冲中的 AU（供实时流在 OS 管道单包冲刷完毕时零等待吐帧，
   * 消除「等下一帧 AUD 才出上一帧」的 16~33ms 固有延迟与静止画面尾帧滞留）。
   */
  flushPending(): { au: Buffer; key: boolean } | null {
    if (this.start < 0 || !this.hasPendingVcl()) return null
    const au = Buffer.from(this.buf.subarray(this.start))
    this.reset()
    return { au, key: AuSplitter.hasIdr(au) }
  }

  reset(): void {
    this.buf = Buffer.alloc(0)
    this.start = -1
    this.scan = 0
  }
}

/** 给 AU 加上 9 字节帧头，得到可直接 sendBinary 的消息 */
export function packFastFrame(au: Buffer, key: boolean, sendTsMs: number): Buffer {
  const out = Buffer.allocUnsafe(FAST_FRAME_HEADER_BYTES + au.length)
  out[0] = key ? FAST_FLAG_KEY : 0
  out.writeBigUInt64LE(BigInt(Math.floor(sendTsMs)), 1)
  au.copy(out, FAST_FRAME_HEADER_BYTES)
  return out
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

function runCapture(
  ffmpegPath: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    const outs: Buffer[] = []
    let errText = ''
    proc.stdout.on('data', (d: Buffer) => outs.push(d))
    proc.stderr.on('data', (d: Buffer) => {
      errText += d.toString()
    })
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    proc.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: Buffer.concat(outs), stderr: errText })
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(outs), stderr: errText })
    })
  })
}

/** ffmpeg 里有哪些我们关心的硬件编码器（只看是否编进去，不代表本机可用） */
export async function listCompiledEncoders(ffmpegPath: string): Promise<FastEncoderName[]> {
  const r = await runCapture(ffmpegPath, ['-hide_banner', '-encoders'], 8000)
  const text = r.stdout.toString()
  const all: FastEncoderName[] = ['h264_nvenc', 'h264_amf', 'h264_qsv']
  return all.filter((n) => text.includes(n))
}

/** ffmpeg 是否带 ddagrab 滤镜 */
export async function hasDdagrab(ffmpegPath: string): Promise<boolean> {
  const r = await runCapture(ffmpegPath, ['-hide_banner', '-filters'], 8000)
  return r.stdout.toString().includes('ddagrab')
}

/**
 * 实测某硬件编码器是否真能在本机初始化并产出 IDR 访问单元（用内存合成帧探测，
 * 耗时 <500ms，不争抢 DXGI DuplicateOutput，可在应用启动时预热）。
 */
export async function probeEncoder(
  ffmpegPath: string,
  encoder: FastEncoderName
): Promise<{ ok: boolean; detail: string }> {
  const dummyCand: FastCandidate = { id: `${encoder}/probe`, encoder, zeroCopy: false }
  const dummyParams: FastParams = {
    outputIdx: 0,
    width: 256,
    height: 256,
    fps: 60,
    bitrate: 2_000_000
  }
  const full = buildFastArgs(dummyCand, dummyParams, 2)
  const iIdx = full.indexOf('-i')
  full[iIdx + 1] = 'color=c=black:s=256x256:r=60,format=nv12'
  const r = await runCapture(ffmpegPath, full, 4000)
  const splitter = new AuSplitter()
  const aus = splitter.push(r.stdout)
  const tailAu = splitter.flushPending()
  if (tailAu) aus.push(tailAu)
  const hasKey = aus.some((a) => a.key)
  if (r.stdout.length > 100 && hasKey) {
    return { ok: true, detail: `${aus.length} 帧 ${r.stdout.length}B` }
  }
  const tail = r.stderr.trim().split(/\r?\n/).slice(-2).join(' | ')
  return { ok: false, detail: `code=${r.code} bytes=${r.stdout.length} key=${hasKey} ${tail}` }
}

/**
 * 端到端实测一条候选：真起 ddagrab + 编码，抓若干帧，必须在限时内产出
 * 至少一个带 IDR 的完整访问单元才算通过。
 */
export async function probeCandidate(
  ffmpegPath: string,
  c: FastCandidate,
  p: FastParams
): Promise<{ ok: boolean; detail: string }> {
  const args = buildFastArgs(c, p, 3)
  const r = await runCapture(ffmpegPath, args, 5000)
  const splitter = new AuSplitter()
  const aus = splitter.push(r.stdout)
  const tailAu = splitter.flushPending()
  if (tailAu) aus.push(tailAu)
  const hasKey = aus.some((a) => a.key)
  if (r.stdout.length > 500 && hasKey) {
    return { ok: true, detail: `${aus.length} 帧 ${r.stdout.length}B` }
  }
  const tail = r.stderr.trim().split(/\r?\n/).slice(-2).join(' | ')
  return { ok: false, detail: `code=${r.code} bytes=${r.stdout.length} key=${hasKey} ${tail}` }
}

/**
 * 用 dd-capture 枚举的 DXGI 输出矩形，把选中的物理显示器区域映射到准确的
 * ddagrab output_idx（多显示器顺序可能与按 X 坐标排序不同）。失败时回退 fallbackIdx。
 */
export function resolveDxgiOutputIdx(
  ddCapturePath: string | undefined,
  region: { x: number; y: number; w: number; h: number } | null,
  fallbackIdx: number
): number {
  if (!ddCapturePath || !region) return fallbackIdx
  try {
    const r = spawnSync(ddCapturePath, ['--rect', '0', '0', '1', '1'], {
      timeout: 1500,
      windowsHide: true
    })
    const stderr = r.stderr?.toString() ?? ''
    const re = /rect=\((-?\d+),(-?\d+)\s+(\d+)x(\d+)\)/g
    let idx = 0
    for (const m of stderr.matchAll(re)) {
      // 第一行是 "no output at rect=(0,0 1x1)"，跳过
      const x = Number(m[1])
      const y = Number(m[2])
      const w = Number(m[3])
      const h = Number(m[4])
      if (w === 1 && h === 1) continue
      if (Math.abs(x - region.x) <= 2 && Math.abs(y - region.y) <= 2 && Math.abs(w - region.w) <= 2 && Math.abs(h - region.h) <= 2) {
        return idx
      }
      idx++
    }
  } catch {
    /* ignore */
  }
  return fallbackIdx
}

const probeCache = new Map<string, FastCandidate | null>()

/**
 * 选出本机能用的最佳硬件编码通路；全部失败返回 null（调用方回退兼容模式）。
 * 先选 zeroCopy=true（帧全程留在 GPU），若某台机器的驱动在实流 ddagrab 零拷贝缩放
 * 失败，startFast 的首帧看门狗会降级到同编码器的 zeroCopy=false 或兼容模式。
 */
export async function pickFastCandidate(
  ffmpegPath: string,
  _p?: FastParams
): Promise<FastCandidate | null> {
  const key = ffmpegPath
  if (probeCache.has(key)) return probeCache.get(key) ?? null
  if (!(await hasDdagrab(ffmpegPath))) {
    log.warn('[fast-stream] ffmpeg 不含 ddagrab 滤镜，高性能模式不可用')
    probeCache.set(key, null)
    return null
  }
  const encoders = await listCompiledEncoders(ffmpegPath)
  for (const encoder of encoders) {
    const t0 = Date.now()
    const r = await probeEncoder(ffmpegPath, encoder)
    log.info(`[fast-stream] 探测编码器 ${encoder}：${r.ok ? '通过' : '失败'}（${Date.now() - t0}ms）${r.detail}`)
    if (r.ok) {
      const cand: FastCandidate = { id: `${encoder}/gpu`, encoder, zeroCopy: true }
      probeCache.set(key, cand)
      return cand
    }
  }
  probeCache.set(key, null)
  return null
}

/** 测试/热重载用：清探测缓存 */
export function clearFastProbeCache(): void {
  probeCache.clear()
}
