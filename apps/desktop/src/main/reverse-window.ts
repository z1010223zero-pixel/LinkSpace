// 平板画面窗口（线 2 W7，任务 2.3-2）：嵌入的 LinkSpace 管理窗口，不是
// scrcpy 自建窗口。
//
// 职责边界：
//   - 只管窗口的生死与帧/状态转发；流的启停、解码、输入会话全在 Host。
//   - 窗口随会话结束关闭：Host 的 reverseStreamChanged 在 peerId 变 null
//     时调 close()；用户点窗口 X 时 'closed' 里调 stopReverseScreenStream，
//     流停、键鼠会话随之停（Host 的 stopReverseReceiver），无残留进程——
//     解码用的 ffmpeg 由 ScreenStreamReceiver.stop() 杀掉，不归窗口管。
//   - 同一时刻只看一路反向流（Host 的唯一流规则），因此同一时刻最多一个窗口。
//
// 帧转发说明：RGBA 帧经 webContents.send 发到渲染进程画 canvas。
// 1080p 下每帧约 8MB、30fps，走 Mojo 大负载通道；720p 档位可减半。
// 原型阶段直接转发每帧，不做抽帧（抽帧会让滑动轨迹断点）。

import { BrowserWindow, shell } from 'electron'
import type { Host } from './host'
import type { ReverseStreamFrame } from './screen-stream'
import type { ReverseStreamStatusView } from '../shared/types'
import { log } from './log'

export interface ReverseWindowDeps {
  host: Host
  /** 流在别处结束且有明确原因（平板拒绝/超时/断连）时，通知主窗口提示 */
  onEndedWithReason?: (reason: string) => void
  resolvePreload: () => string
  /** 开发模式的渲染服务地址（ELECTRON_RENDERER_URL），未设置时走打包文件 */
  rendererUrl: () => string | undefined
  /** 打包后的渲染入口（out/renderer/index.html） */
  rendererFile: () => string
}

export class ReverseWindowManager {
  private readonly host: Host
  private readonly deps: ReverseWindowDeps
  private win: BrowserWindow | null = null
  private peerId: string | null = null
  private displayName = ''
  private lastFrame: ReverseStreamFrame | null = null

  constructor(deps: ReverseWindowDeps) {
    this.host = deps.host
    this.deps = deps
    // 帧直通：Host 解出一帧就发窗口；窗口不存在时丢弃（不攒、不重放）
    this.host.on('reverseStreamFrame', (frame) => {
      this.lastFrame = frame
      this.sendFrame(frame)
    })
    this.host.on('reverseStreamChanged', () => {
      const st = this.host.reverseStreamStatus()
      if (!st.peerId) {
        // 会话在别处结束（对端停流/断连/撤销/重连失败）→ 窗口跟随关闭
        const wasOpen = this.isOpen
        this.lastFrame = null
        const reason = this.host.reverseStreamEndReason()
        this.close()
        // 流非用户主动结束且有明确原因（平板拒绝/超时/断连）：让主窗口
        // 提示原因，而不是窗口悄悄消失。用户自己关窗口/点断开时
        // reason 为空，不提示
        if (wasOpen && reason) this.deps.onEndedWithReason?.(reverseEndReasonText(reason))
        return
      }
      this.sendStatus()
    })
    this.host.on('reverseInputError', (err) => {
      // 只认当前窗口的对端；原因译成用户可执行的提示发给画面窗口
      if (err.peerId !== this.peerId) return
      this.sendNotice(inputErrorNoticeText(err.code, err.reason))
    })
  }

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  isOpenFor(peerId: string): boolean {
    return this.isOpen && this.peerId === peerId
  }

  /** 打开（或聚焦已打开的）平板画面窗口。调用前须已请求反向流成功 */
  open(peerId: string, displayName: string): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      if (this.peerId === peerId) {
        if (this.win.isMinimized()) this.win.restore()
        this.win.focus()
        return this.win
      }
      // 不应发生：Host 只允许一路反向流。防御性关掉旧窗口再开新的
      this.close()
    }
    this.peerId = peerId
    this.displayName = displayName
    const win = new BrowserWindow({
      width: 1000,
      height: 700,
      minWidth: 640,
      minHeight: 480,
      title: `LinkSpace - ${displayName}`,
      backgroundColor: '#111417',
      show: false,
      webPreferences: {
        preload: this.deps.resolvePreload(),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    win.on('ready-to-show', () => win.show())
    // 与主窗口同款防护：渲染层被注入后导航到攻击者页面是一律拦下的逃逸路径
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    const hash = `#/reverse-stream?peer=${encodeURIComponent(peerId)}&name=${encodeURIComponent(displayName)}`
    const devUrl = this.deps.rendererUrl()
    if (devUrl) {
      void win.loadURL(`${devUrl}#/${hash}`)
    } else {
      void win.loadFile(this.deps.rendererFile(), { hash })
    }
    win.webContents.once('did-finish-load', () => {
      // 静态画面可能不会再推新帧；窗口打开/刷新时立刻补绘最近一帧。
      if (this.lastFrame) this.sendFrame(this.lastFrame)
    })
    win.on('closed', () => {
      const peer = this.peerId
      this.win = null
      this.peerId = null
      this.displayName = ''
      // 用户关窗口 = 结束控制会话。流若已在别处结束（peerId 已空），
      // 不再补发 screen.stream.stop，避免给对端发重复停流
      if (peer && this.host.reverseStreamStatus().peerId === peer) {
        this.host.stopReverseScreenStream(peer)
      }
    })
    this.win = win
    log.info(`[reverse-window] 平板画面窗口已打开（${displayName}）`)
    return win
  }

  /** 关窗口（不断流：'closed' 里按需停流）。幂等 */
  close(): void {
    const win = this.win
    if (!win || win.isDestroyed()) {
      this.win = null
      return
    }
    win.close()
  }

  /** 渲染进程轮询/推送共用的状态快照 */
  statusSnapshot(): ReverseStreamStatusView {
    const st = this.host.reverseStreamStatus()
    return {
      peerId: st.peerId,
      displayName: st.peerId ? this.displayName || st.peerId : '',
      scaleWidth: st.scaleWidth,
      receiver: st.receiver,
      input: this.host.reverseInputStatus(),
      clipboardEnabled: this.host.isClipboardEnabled()
    }
  }

  private sendFrame(frame: ReverseStreamFrame): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send('reverse-stream:frame', {
      width: frame.width,
      height: frame.height,
      data: frame.data
    })
  }

  private sendStatus(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send('reverse-stream:changed', this.statusSnapshot())
  }

  private sendNotice(message: string): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send('reverse-stream:notice', message)
  }
}

/**
 * 平板回的输入失败 code → 画面窗口提示文案（协议 4.9 input.error）。
 * 无焦点时只提示手动点输入框，不自动点按聚焦（D-4）。
 */
export function inputErrorNoticeText(code: string, reason: string): string {
  switch (code) {
    case 'no-focus':
      return '平板上没有获得焦点的输入框：请先点一下平板画面里的输入框，再打字'
    case 'accessibility-disabled':
      return '平板无障碍服务未开启，远程输入已停'
    case 'unsupported-version':
      return '平板 Android 版本低于 13，文本输入不可用，可改用粘贴'
    case 'too-large':
      return `文本过长，已被平板拒绝：${reason}`
    default:
      return `远程输入失败：${reason}`
  }
}

/**
 * 平板侧回的结束原因 → 主窗口提示文案（只做已知原因的翻译，未知原因原文透传）。
 * 原因来自 screen.stream.error 的 message 或本机流结束理由。
 */
export function reverseEndReasonText(reason: string): string {
  switch (reason) {
    case 'denied by user':
      return '平板拒绝了录屏请求：对方在确认框点了拒绝'
    case 'expired':
      return '平板 90 秒内未确认录屏请求，请求已过期'
    case 'not trusted':
      return '平板拒绝了录屏请求：设备未配对'
    case 'resource busy':
      return '平板正向另一台电脑推流，忙'
    case '确认 UI 未接':
      return '平板暂不支持录屏确认（旧版本）'
    case 'failed to start screen capture':
      return '平板启动录屏失败'
    case '信任已被撤销':
      return '信任已被撤销，反向投屏已停止'
    case '自动重连 4 次未成功':
      return '平板断开后自动重连 4 次未成功，请确认平板在线后重试'
    case '解码器意外退出':
      return '本机解码器意外退出，请重试'
    default:
      return `反向投屏已结束：${reason}`
  }
}
