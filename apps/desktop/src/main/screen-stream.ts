// 屏幕投屏推流服务（MVP）。
//
// 选型：ffmpeg gdigrab 抓屏 + libx264 软编 + 裸 H.264 Annex-B 写 stdout，
// 由宿主把字节块以 **WebSocket 二进制帧**发到平板——复用平板主动连出的
// 那条控制连接。
//
// 为什么不复用 / 为什么不在桌面监听：
//   - 监听：Windows 防火墙对无放行规则的进程静默丢弃入站 SYN（实测
//     ffmpeg listen 10 秒超时 Error -138）
//   - 桌面直连平板：实测平板的任何 ServerSocket 端口对桌面都不通
//     （ICMP 通、TCP 入站全拒），唯有平板自己连出的链路可用
//   - WebSocket 二进制帧：TCP 全双工，平板连出的链路上桌面照样发；
//     控制消息（文本帧）与视频块（二进制帧）同连接共存，协议上互不
//     干扰（平板端按 opcode 分流）
//
// 采集范围是整个桌面区域（多显示器并集）。gdigrab 不支持负 offset，
// 显式传虚拟屏 bounds 会报「extends outside window area」；不传时它
// 默认抓全桌面。输出分辨率是 gdigrab 进程视角（可能经 DPI 虚拟化），
// 平板触控映射以解码输出的实际尺寸为准。
//
// 安全语义：投屏不做独立授权，它寄生在已建立的键鼠会话之内（能看到
// 画面是控制的前提）；会话结束/断连/撤销时推流随之终止（host.ts 钩子）。
//
// 码率自适应（B-3）：档位阶梯见 TIERS。宿主周期采样发送积压
// （Connection.backlog()），持续拥塞调 setTier(n) 降档、长期空闲升档；
// 换档重启 ffmpeg 进程，流内新 SPS/PPS/IDR 由解码器带内消化
// （MediaCodec 对同分辨率重配置原生支持，真机 B-1 已验证带内
// FORMAT_CHANGED 路径）。只有降档在拥塞时发生，升档需长稳窗口，
// 防振荡。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { log } from './log'

/** 码率档位（B-3）：tier 0 不限速（超快零延迟优先），往下逐级封顶 */
export const TIERS: Array<{ label: string; bps: number | null }> = [
  { label: 't0-uncapped', bps: null },
  { label: 't1-6M', bps: 6_000_000 },
  { label: 't2-3M', bps: 3_000_000 },
  { label: 't3-1.5M', bps: 1_500_000 }
]

/**
 * 用户可选分辨率档位。这里只约束目标宽度，高度按源宽高比等比缩放，
 * 并对齐 32（本机解码排障定论）。libx264 用码率除以帧率的单帧 VBV，
 * 参考 Sunshine 的低延迟策略：一帧内就能排空，不攒几百毫秒缓冲。
 */
export const STREAM_QUALITY_PRESETS: Array<{ label: string; width: number; fps: number; bps: number }> = [
  { label: '720p', width: 1280, fps: 30, bps: 4_000_000 },
  { label: '1080p', width: 1920, fps: 30, bps: 8_000_000 },
  { label: '1440p', width: 2560, fps: 30, bps: 14_000_000 },
  { label: '2160p', width: 3840, fps: 30, bps: 24_000_000 }
]

/**
 * 断线重连退避（线 1 口径）：5/10/20/30s，各一次，共 4 次，之后停手
 * 交给用户。线 1 的实现在 Android 端（LinkSpaceService
 * scheduleStreamReconnect）；反向流的观看方是桌面端，由 host.ts 的
 * 反向重连复用同一组数字，不另写一套。
 */
export const STREAM_RECONNECT_BACKOFFS_MS: readonly number[] = [5000, 10000, 20000, 30000]

/**
 * screen.stream.stop 的方向位（协议 4.7）：标识停的是哪一路流。
 * forward = 线 1（桌面 → 平板，桌面是源）；reverse = 反向（平板 →
 * 桌面，平板是源）。与 Android 端 Protocol.kt 的 STREAM_DIRECTION_*
 * 同值，约束见 protocol.json constraints.streamDirections。
 */
export const STREAM_DIRECTION_FORWARD = 'forward'
export const STREAM_DIRECTION_REVERSE = 'reverse'
/** screen.stream.stop payload.direction 的取值 */
export type ScreenStreamDirection = 'forward' | 'reverse'

/**
 * 解析 screen.stream.stop 的停流方向（与 Android 端 Protocol.kt 的
 * resolveStreamStopDirection 同规则，两端必须一致）：
 * - direction 明确给出 forward/reverse：直接采用；
 * - direction 缺失或为 null（旧版本对端）：单路在跑时停那一路；
 *   双向都在跑时只停 forward（本消息最初的语义），绝不顺手停掉
 *   另一路；两路都没跑返回 null（忽略，不回声）；
 * - direction 非法：返回 null，调用方忽略本消息并记日志。
 * forwardLive / reverseLive 由调用方按发消息的对端取数（只认属于
 * 该对端的流），不要传全局状态。
 */
export function resolveStreamStopDirection(
  payload: unknown,
  forwardLive: boolean,
  reverseLive: boolean
): ScreenStreamDirection | null {
  const direction = (payload as { direction?: unknown } | null)?.direction
  if (direction === undefined || direction === null) {
    if (forwardLive && !reverseLive) return STREAM_DIRECTION_FORWARD
    if (reverseLive && !forwardLive) return STREAM_DIRECTION_REVERSE
    if (forwardLive && reverseLive) return STREAM_DIRECTION_FORWARD
    return null
  }
  if (direction === STREAM_DIRECTION_FORWARD || direction === STREAM_DIRECTION_REVERSE) return direction
  return null
}

export class ScreenStreamService {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stderrTail: string[] = []
  private tier = 0
  private scaleWidth = 1920
  private regionArgs: string[] = []

  get running(): boolean {
    return this.proc != null
  }

  /**
   * 启动推流：抓全桌面编码，stdout 的字节块经 onChunk 交给宿主以
   * WebSocket 二进制帧发出。ffmpeg 在 stdin 保持打开期间持续产出。
   */
  start(
    ffmpegPath: string,
    onChunk: (data: Buffer) => void,
    /** 多显示器区域抓取参数（-offset_x/-offset_y/-video_size），全桌面时为空 */
    regionArgs: string[] = [],
    /** 用户选择的目标宽度，默认 1920 */
    scaleWidth: number = 1920
  ): void {
    if (this.proc) {
      // 残留推流不挡新推流：断连清理漏网（TCP 半开等超时期间对端重连）
      // 时旧 ffmpeg 还活着，直接停掉重开——用户点投屏的意图是明确的
      log.warn('[screen-stream] 发现残留推流进程，先停再启')
      this.stop()
    }
    // -offset_x/-offset_y/-video_size 是 gdigrab 的**输入**选项，必须落在
    // '-i desktop' 之前——之前拼接在整条命令末尾（pipe:1 之后），ffmpeg
    // 当输出口选项处理，区域抓取整个失效，抓出来的是全虚拟屏全景
    //（真机实证：选 display 0 解出 1920x608 的全景比例）
    // LINKSPACE_STREAM_FROM=<h264文件>：排障旁路——不走采集/编码，直接
    // 把本机已验证干净的流文件循环推给对端，分段定位「传输损坏 vs 解码
    // 配置」用（真机绿块排障 2026-10-31）
    const streamFrom = process.env.LINKSPACE_STREAM_FROM
    this.scaleWidth = scaleWidth
    this.regionArgs = regionArgs
    const args = streamFrom
      ? [
          '-hide_banner', '-loglevel', 'error',
          '-re',
          '-i', streamFrom,
          '-c', 'copy',
          '-f', 'h264',
          'pipe:1'
        ]
      : [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab',
      // draw_mouse=0：采集不含真实光标——注入移动与采集互相打架会让
      // 镜像里光标持续闪烁（用户实测）；触端按绝对坐标直接映射，
      // 不依赖画面里的光标
      '-draw_mouse', '0',
      '-framerate', '30',
      ...regionArgs,
      '-i', 'desktop',
      // 缩放三约束（真机 c2.qti 实证）：①高度必须 32 对齐——16 对齐的
      // 624/1200 均触发「顶部条带正常、其余绿块」，取最近的 32 倍数变形
      // 1.5% 以内；②宽度上限 1920——3200 宽的流只有顶部条带正常（超
      // 中端平板 AVC 硬解宽度上限），多屏全景 6720 宽完全花屏；③不放
      // 大——比显示器原生还小的屏（1440x900）强制拉到 1920 宽只会白耗
      // 码率还把高度顶进临界值。min 引号形式过 ffmpeg 图解析器（逗号
      // 不能裸露）；TS 源里别用反斜杠转义（会被字符串字面量吃掉）。
      // 缩放到 1920 宽（不放大小屏），高度取最近 32 倍数（1088 档）。
      // 编码器 h264_mf（Windows MediaFoundation）：**真机 2026-10-31 排障
      // 定论——libx264（medium/ultrafast 均试）在 1088 高度产出的流，这
      // ROM 的 C2 解码器（c2.qti 与软解 alike，ByteBuffer 模式离线复现）
      // 解出下半帧全零**；同流桌面 ffmpeg 解码完全正常、两端 WS 字节
      // sha256 分段一致，唯 MF 编码器同源同几何流全绿。不再是编码参数
      // 问题，是 libx264 位流与该 ROM 解码器栈的相性，换 MF 直接绕开。
      '-vf', `scale='min(${scaleWidth},iw)':-32`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      // zerolatency 已关 lookahead/sync lookahead；这里再显式钉住，
      // 并关 sliced-threads 保持单 slice 兼容性
      '-x264-params', 'rc-lookahead=0:sync-lookahead=0:sliced-threads=0',
      // GOP 30（1s 一个 IDR，丢帧后 1s 内自愈）
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-f', 'h264',
      'pipe:1'
      ]
    // 自适应码率与用户画质档位取交集：拥塞时仍能下降；用户选低清晰度
    // 时也不会因为 t0 无上限而把 Wi-Fi 打爆。
    const preset = STREAM_QUALITY_PRESETS.find((p) => p.width === scaleWidth)
    const presetBps = preset?.bps ?? 8_000_000
    const fps = preset?.fps ?? 30
    const tierArgs: string[] = []
    const tierBps = TIERS[this.tier]?.bps ?? null
    const bps = Math.min(tierBps ?? presetBps, presetBps)
    if (bps > 0) {
      const frameBps = Math.round(bps / fps)
      tierArgs.push('-b:v', String(bps), '-maxrate', String(bps), '-bufsize', String(frameBps))
    }
    this.ffmpegPath = ffmpegPath
    this.onChunkRef = onChunk
    // 排障旁路：把实际推流的字节原样落盘（LINKSPACE_STREAM_TEE=<路径>），
    // 与平板收到的字节（sha256 分段一致）构成三方对账
    const teePath = process.env.LINKSPACE_STREAM_TEE
    let teeStream: import('node:fs').WriteStream | null = null
    if (teePath) {
      teeStream = createWriteStream(teePath)
      log.info(`[screen-stream] 推流字节落盘: ${teePath}`)
    }
    const proc = spawn(ffmpegPath, [...args, ...tierArgs], { windowsHide: true })
    log.info(`[screen-stream] 推流启动于 ${TIERS[this.tier]?.label ?? 't0'} · ${scaleWidth}p · ${(bps / 1_000_000).toFixed(1)}Mbps`)
    this.stderrTail = []
    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (!line) return
      this.stderrTail.push(line)
      if (this.stderrTail.length > 20) this.stderrTail.shift()
      log.warn(`[screen-stream] ffmpeg: ${line}`)
    })
    proc.stdout.on('data', (chunk: Buffer) => {
      teeStream?.write(chunk)
      // 交给宿主以 WS 二进制帧发出；连接已断（会话结束）时 stop 会被
      // 钩子调用，这里只在还活着时发
      if (this.proc === proc) onChunk(chunk)
    })
    proc.on('exit', (code) => {
      log.info(`[screen-stream] ffmpeg 退出（code=${code}）`)
      if (this.proc === proc) {
        this.proc = null
        this.onEnded?.()
      }
    })
    this.proc = proc
    log.info('[screen-stream] 推流已启动（stdout → WS 二进制帧）')
  }

  /** 推流意外结束的回调（host 据此通知对端并清 UI） */
  onEnded: (() => void) | null = null

  /** 拥塞回调查询：宿主采样 backlog 后调用；换档通过重启 ffmpeg 实现 */
  setTier(tier: number): void {
    const clamped = Math.max(0, Math.min(tier, TIERS.length - 1))
    if (clamped === this.tier) return
    const wasRunning = this.proc != null
    const path = this.ffmpegPath
    const onChunk = this.onChunkRef
    if (!wasRunning || !path || !onChunk) {
      this.tier = clamped
      return
    }
    log.info(`[screen-stream] 码率档位 ${TIERS[this.tier]?.label} → ${TIERS[clamped]?.label}（重启推流，解码器带内消化）`)
    this.tier = clamped
    this.stop()
    this.start(path, onChunk, this.regionArgs, this.scaleWidth)
  }

  private ffmpegPath: string | null = null
  private onChunkRef: ((data: Buffer) => void) | null = null

  stop(): void {
    if (!this.proc) return
    const p = this.proc
    this.proc = null
    p.kill()
  }

  /** 最近的 stderr 尾巴，错误分类用 */
  lastErrors(): string[] {
    return [...this.stderrTail]
  }
}

// ---------------------------------------------------------------------------
// 反向 screen.stream 接收端（线 2 W6，协议 4.7 反向）
// ---------------------------------------------------------------------------

/** 解出的一帧：RGBA 原始像素 + 尺寸。渲染层（W7 的平板画面窗口）按帧绘制。 */
export interface ReverseStreamFrame {
  width: number
  height: number
  /** RGBA，每像素 4 字节，行优先，长度恒为 width * height * 4 */
  data: Buffer
}

export interface ReverseStreamStatus {
  running: boolean
  width: number
  height: number
  bytesReceived: number
  framesDecoded: number
  /** 背压丢到关键帧重同步的次数 */
  keyframeResyncs: number
  /** 背压丢弃的字节数 */
  droppedBytes: number
  lastError: string | null
}

/**
 * 反向投屏接收端：收 WS 二进制帧（平板推来的裸 H.264 Annex-B）→
 * ffmpeg 解码 → RGBA 帧交给渲染层。
 *
 * 传输不另起一套：帧走已有的控制连接（平板连出的那条），由宿主经
 * ControlNode.onBinary 喂进来；解码复用现有 ffmpeg 链路（与推流端
 * 同一个 ffmpeg 可执行文件，只是反过来：stdin 进 Annex-B，
 * stdout 出 rawvideo）。接口给 W7 的桌面控制端窗口直接消费：
 * start/stop/status + 帧回调。
 *
 * 帧尺寸：以 screen.stream.start 里的 w/h 为准（平板按 scaleWidth
 * 等比缩放后的编码尺寸）；若 start 没给尺寸，退到解析 ffmpeg 的
 * stderr（`Stream #0:0: Video: h264 ... 1920x1080`）。尺寸中途变化
 * （换分辨率）时宿主应先 stop 再 start——平板换分辨率会发新的
 * screen.stream.start，见 host.ts。
 *
 * 背压（复用线 1 解码端口径）：ffmpeg stdin 积压超 3MB 即丢到最近
 * 关键帧（SPS）重同步，与 Android 端 StreamDecoder 的 BACKLOG_CAP
 * 同值同语义；丢帧的正确位置是网络缓冲（整 GOP 丢弃），不是解码器
 * 的字节流内部。
 */
export class ScreenStreamReceiver {
  private proc: ChildProcessWithoutNullStreams | null = null
  private expectedWidth = 0
  private expectedHeight = 0
  private frameBuf = Buffer.alloc(0)
  private droppingToKeyframe = false
  private bytesReceived = 0
  private framesDecoded = 0
  private keyframeResyncs = 0
  private droppedBytes = 0
  private lastError: string | null = null
  private stderrTail: string[] = []
  private onFrameRef: ((frame: ReverseStreamFrame) => void) | null = null

  get running(): boolean {
    return this.proc != null
  }

  /** 解码器意外退出的回调（host 据此清 UI / 触发重连） */
  onEnded: (() => void) | null = null

  /** 帧尺寸确认的回调（start 消息尺寸或 stderr 解析，二者一致时只发一次） */
  onSize: ((width: number, height: number) => void) | null = null

  /**
   * 启动解码：ffmpeg 从 stdin 读 Annex-B，stdout 出 RGBA rawvideo。
   * 帧尺寸由 setExpectedSize 事先给定，或等 stderr 解析到再出帧。
   */
  start(ffmpegPath: string, onFrame: (frame: ReverseStreamFrame) => void): void {
    if (this.proc) this.stop()
    this.onFrameRef = onFrame
    this.frameBuf = Buffer.alloc(0)
    this.droppingToKeyframe = false
    this.stderrTail = []
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-i', 'pipe:0',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      'pipe:1'
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    log.info('[screen-stream] 反向接收端解码已启动（WS 二进制帧 → ffmpeg → RGBA）')
    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (!line) return
      this.stderrTail.push(line)
      if (this.stderrTail.length > 20) this.stderrTail.shift()
      // 尺寸兜底：start 消息没给尺寸时，从流信息里解析
      if (this.expectedWidth === 0 || this.expectedHeight === 0) {
        const m = /Video:.*?(\d+)x(\d+)/.exec(line)
        if (m) this.setExpectedSize(Number(m[1]), Number(m[2]))
      }
      log.warn(`[screen-stream] 接收端 ffmpeg: ${line}`)
    })
    proc.stdout.on('data', (chunk: Buffer) => {
      if (this.proc !== proc) return
      this.frameBuf = Buffer.concat([this.frameBuf, chunk])
      this.splitFrames()
    })
    proc.on('exit', (code) => {
      log.info(`[screen-stream] 接收端 ffmpeg 退出（code=${code}）`)
      if (this.proc === proc) {
        this.proc = null
        this.onEnded?.()
      }
    })
    proc.on('error', (err) => {
      this.lastError = String(err)
      log.warn(`[screen-stream] 接收端 ffmpeg 启动失败: ${String(err)}`)
    })
    this.proc = proc
  }

  /**
   * 喂入一个 WS 二进制帧负载（Annex-B 字节块，边界不重要，流内自带
   * 起始码）。背压时丢到最近 SPS 再恢复。
   */
  feed(data: Buffer): void {
    const proc = this.proc
    if (!proc || proc.stdin.destroyed) return
    this.bytesReceived += data.length
    if (this.droppingToKeyframe) {
      const spsAt = findSps(data)
      if (spsAt < 0) {
        this.droppedBytes += data.length
        return
      }
      this.droppingToKeyframe = false
      this.keyframeResyncs++
      log.warn('[screen-stream] 接收端背压丢帧恢复：等到关键帧，恢复解码')
      this.writeChunk(proc, data.subarray(spsAt))
      return
    }
    this.writeChunk(proc, data)
    // stdin 积压超 3MB：ffmpeg 消费跟不上，再喂只会让延迟发散——
    // 进丢帧模式，等下一个 SPS 重同步（线 1 解码端同口径）
    if (proc.stdin.writableLength > RECEIVER_BACKLOG_CAP) {
      this.droppingToKeyframe = true
      log.warn(`[screen-stream] 接收端 stdin 积压超 3MB，丢到最近关键帧（积压 ${proc.stdin.writableLength}B）`)
    }
  }

  private writeChunk(proc: ChildProcessWithoutNullStreams, data: Buffer): void {
    if (data.length === 0) return
    try {
      proc.stdin.write(data)
    } catch {
      // ffmpeg 已死（exit 事件随后到）：本块丢弃，不抛
    }
  }

  /** screen.stream.start 到达时设定编码尺寸；尺寸变化时重置帧缓冲 */
  setExpectedSize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return
    if (width === this.expectedWidth && height === this.expectedHeight) return
    const changed = this.expectedWidth !== 0 && this.expectedHeight !== 0
    this.expectedWidth = width
    this.expectedHeight = height
    this.frameBuf = Buffer.alloc(0)
    if (changed) log.info(`[screen-stream] 接收端帧尺寸变化 → ${width}x${height}（帧缓冲已重置）`)
    this.onSize?.(width, height)
  }

  /** 按已知尺寸从 stdout 缓冲里切帧；尺寸未知时攒着等（上限 16MB） */
  private splitFrames(): void {
    const onFrame = this.onFrameRef
    if (!onFrame) return
    if (this.expectedWidth === 0 || this.expectedHeight === 0) {
      if (this.frameBuf.length > 16 * 1024 * 1024) {
        log.warn('[screen-stream] 接收端尺寸未知且缓冲超 16MB，丢弃缓冲等 start 消息')
        this.frameBuf = Buffer.alloc(0)
      }
      return
    }
    const frameSize = this.expectedWidth * this.expectedHeight * 4
    if (frameSize <= 0) return
    while (this.frameBuf.length >= frameSize) {
      const frame = this.frameBuf.subarray(0, frameSize)
      this.frameBuf = this.frameBuf.subarray(frameSize)
      this.framesDecoded++
      onFrame({ width: this.expectedWidth, height: this.expectedHeight, data: Buffer.from(frame) })
    }
  }

  stop(): void {
    if (!this.proc) return
    const p = this.proc
    this.proc = null
    p.kill()
  }

  status(): ReverseStreamStatus {
    return {
      running: this.proc != null,
      width: this.expectedWidth,
      height: this.expectedHeight,
      bytesReceived: this.bytesReceived,
      framesDecoded: this.framesDecoded,
      keyframeResyncs: this.keyframeResyncs,
      droppedBytes: this.droppedBytes,
      lastError: this.lastError
    }
  }

  /** 最近的 stderr 尾巴，错误分类用 */
  lastErrors(): string[] {
    return [...this.stderrTail]
  }
}

/** 接收端 stdin 背压上限（与 Android StreamDecoder BACKLOG_CAP 同值） */
const RECEIVER_BACKLOG_CAP = 3 * 1024 * 1024

/** 在 Annex-B 字节块里找 SPS 起始码（00 00 00 01 + NAL type 7），找不到返回 -1 */
function findSps(data: Buffer): number {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      if ((data[i + 4]! & 0x1f) === 7) return i
      i += 4
    }
  }
  return -1
}
