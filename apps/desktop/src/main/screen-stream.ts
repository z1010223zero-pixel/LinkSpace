// 屏幕投屏推流服务（MVP）。
//
// 选型：ffmpeg gdigrab 抓屏 + libx264 软编 + 裸 H.264 Annex-B over TCP。
// 为什么不用 Media Foundation / Windows.Graphics.Capture：那两条路要
// koffi 打 COM，复杂度远超 MVP 收益；ffmpeg 是外部进程，与 scrcpy
// 适配器同一治理模式（spawn/退出码/stderr 尾巴），复杂度可控。
// 为什么推 TCP 而非 RTSP：平板端 MediaCodec 吃裸 Annex-B 字节流即可，
// 不需要解封装器，少一个 RTSP 栈。
//
// 连接方向是**桌面连出**（ffmpeg 作 TCP 客户端连平板的 ServerSocket），
// 而不是桌面监听：Windows 防火墙对无放行规则的进程会静默丢弃入站
// SYN（实测 ffmpeg listen 10 秒超时 Error -138），而出站默认放行；
// 平板端 Android 没有默认入站防火墙。平板把随机端口放进
// screen.stream.request，桌面拿 conn 的 remoteAddress 拼 target。
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
   * 启动推流：抓全桌面编码后推到平板的 ip:port。平板先起 ServerSocket
   * 并把端口放进 screen.stream.request，这里直接作为 TCP 客户端连出；
   * 连接建立后 ffmpeg 才开始编码，流头（SPS/PPS/IDR）完整。
   */
  start(ffmpegPath: string, target: { ip: string; port: number }): void {
    if (this.proc) throw new Error('已有投屏在进行')
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'gdigrab',
      '-framerate', '30',
      '-i', 'desktop',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-g', '30',
      '-pix_fmt', 'yuv420p',
      '-f', 'h264',
      `tcp://${target.ip}:${target.port}`
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
    proc.on('exit', (code) => {
      log.info(`[screen-stream] ffmpeg 退出（code=${code}）`)
      this.proc = null
      this.onEnded?.()
    })
    this.proc = proc
    log.info(`[screen-stream] 推流已启动 → ${target.ip}:${target.port}`)
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
