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

export class ScreenStreamService {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stderrTail: string[] = []
  private tier = 0

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
    regionArgs: string[] = []
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
      '-vf', "scale='min(1920,iw)':-32",
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
    // 码率档位：tier 0 不限（原始行为），其余加 maxrate/bufsize 硬顶。
    // libx264 的 ultrafast 本身不产恒定码率，封顶防止 Wi-Fi 拥塞堆积
    const tierArgs: string[] = []
    const bps = TIERS[this.tier]?.bps ?? null
    if (bps) {
      tierArgs.push('-b:v', String(bps), '-maxrate', String(bps), '-bufsize', String(bps * 2))
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
    log.info(`[screen-stream] 推流启动于 ${TIERS[this.tier]?.label ?? 't0'}`)
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
    this.start(path, onChunk)
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
