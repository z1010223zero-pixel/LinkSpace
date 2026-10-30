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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { log } from './log'

export class ScreenStreamService {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stderrTail: string[] = []

  get running(): boolean {
    return this.proc != null
  }

  /**
   * 启动推流：抓全桌面编码，stdout 的字节块经 onChunk 交给宿主以
   * WebSocket 二进制帧发出。ffmpeg 在 stdin 保持打开期间持续产出。
   */
  start(ffmpegPath: string, onChunk: (data: Buffer) => void): void {
    if (this.proc) throw new Error('已有投屏在进行')
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab',
      '-framerate', '30',
      '-i', 'desktop',
      // 缩放到 1920 宽：中端平板（骁龙 6 系）的 AVC 硬解上限普遍是
      // 1080p 级——实测 3200 宽的流在 c2.qti 上只有顶部条带正常、
      // 其余全绿（超上限的行渲染失败），多屏全景原始 6720 宽更是
      // 完全花屏。桌面本机 ffmpeg 解同款流完全正常，分流测试已排除
      // 流本身问题。
      '-vf', 'scale=1920:-2',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      // 硬解兼容性双保险：①ultrafast+zerolatency 默认开 sliced-threads，
      // 多 slice 流在部分硬件解码器（c2.qti）上块级损坏；②baseline
      // profile（CAVLC/无 B 帧）是硬件兼容面最广的档位
      '-profile:v', 'baseline',
      '-x264-params', 'sliced-threads=0',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-f', 'h264',
      'pipe:1'
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    this.stderrTail = []
    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (!line) return
      this.stderrTail.push(line)
      if (this.stderrTail.length > 20) this.stderrTail.shift()
      log.warn(`[screen-stream] ffmpeg: ${line}`)
    })
    proc.stdout.on('data', (chunk: Buffer) => {
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
