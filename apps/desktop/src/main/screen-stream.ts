// 屏幕投屏推流服务（MVP）。
//
// 选型：ffmpeg gdigrab 抓屏 + libx264 软编 + 裸 H.264 Annex-B over TCP。
// 为什么不用 Media Foundation / Windows.Graphics.Capture：那两条路要
// koffi 打 COM，复杂度远超 MVP 收益；ffmpeg 是外部进程，与 scrcpy
// 适配器同一治理模式（spawn/退出码/stderr 尾巴），复杂度可控。
// 为什么推 TCP 而非 RTSP：平板端 MediaCodec 吃裸 Annex-B 字节流即可，
// 不需要解封装器，少一个 RTSP 栈。
//
// 采集范围是**虚拟屏**（多显示器并集，物理像素），与键鼠注入的
// normalizeAbsolute 同一基准——平板上的触控点按画面比例映射后就是
// 注入坐标，无需任何换算层。
//
// 安全语义：投屏不做独立授权，它寄生在已建立的键鼠会话之内（能看到
// 画面是控制的前提）；会话结束/断连/撤销时推流随之终止（host.ts 钩子）。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { log } from './log'

export interface ScreenStreamInfo {
  port: number
  w: number
  h: number
}

export class ScreenStreamService {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stderrTail: string[] = []

  get running(): boolean {
    return this.proc != null
  }

  /**
   * 启动推流。ffmpeg 在 tcp listen 模式下等平板来连，连接建立后才开始
   * 编码——流头（SPS/PPS/首个 IDR）完整，平板中途加入不存在解码黑窗。
   * 端口用 Node 预占法拿空闲端口（ffmpeg 的 tcp:// 不支持 :0 随机回显）。
   *
   * 采集不传 offset/size：gdigrab 的 desktop 模式默认抓取整个桌面区域
   * （多显示器并集），且它不支持负 offset——显式传虚拟屏 bounds 反而
   * 报「extends outside window area」。实际输出分辨率是 gdigrab 进程
   * 视角的虚拟屏（可能经 DPI 虚拟化），平板触控映射以解码输出尺寸为
   * 准（payload 的 w/h 仅作初始值回退）。
   */
  async start(ffmpegPath: string, vs: { x: number; y: number; w: number; h: number }): Promise<ScreenStreamInfo> {
    if (this.proc) throw new Error('已有投屏在进行')
    const port = await reservePort()
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
      `tcp://0.0.0.0:${port}?listen=1&listen_timeout=10000`
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
    log.info(`[screen-stream] 推流已启动，监听 :${port}`)
    return { port, w: vs.w, h: vs.h }
  }

  /** 推流意外结束的回调（host 据此通知对端并清 UI） */
  onEnded: (() => void) | null = null

  stop(): void {
    if (!this.proc) return
    const p = this.proc
    this.proc = null
    // ffmpeg 对 listen socket 的 SIGTERM 处理干净，q/kill 都行；Windows
    // 上没有 SIGTERM，taskkill 语义由 Node 的 kill 覆盖（单进程无子树）
    p.kill()
  }

  /** 最近的 stderr 尾巴，错误分类用 */
  lastErrors(): string[] {
    return [...this.stderrTail]
  }
}

/** 预占一个空闲 TCP 端口：listen(0) 拿到端口后立刻释放，交给 ffmpeg */
async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '0.0.0.0', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('端口分配失败'))))
    })
    srv.on('error', reject)
  })
}
