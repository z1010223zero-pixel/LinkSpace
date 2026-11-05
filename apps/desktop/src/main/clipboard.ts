// 剪贴板文本同步（阶段 3）。
//
// 剪贴板同步看起来只是「把一段文本发给对方」，真正的难点在**回环**：
// 收到远端文本 → 写入本机剪贴板 → 本机的变更监听被触发 → 又把同一段
// 文本发回去 → 对方也一样 → 两台机器无限互推。只要一端漏判一次，
// 网络里就多一条永久打转的消息。
//
// 因此判重逻辑全部集中在这一个类里，且刻意做成不依赖 Electron 的纯逻辑：
// 读写剪贴板由调用方注入（ClipboardIo），这样回环抑制可以在无头环境里
// 被完整测试——它是最容易写错、也最难在真机上稳定复现的部分。
//
// 只同步文本。图片/文件走传输通道，不塞进剪贴板。

export interface ClipboardIo {
  readText(): string
  writeText(text: string): void
}

export interface ClipboardSyncOptions {
  io: ClipboardIo
  /** 广播到对端。只有确认是本机真实变更时才调用 */
  send: (text: string) => void
  /** 收到远端内容时是否接受，用于按授权范围或用户开关决定是否落盘 */
  acceptRemote?: (text: string) => boolean
  /** 单条文本上限，超出直接丢弃并在日志留痕 */
  maxBytes?: number
  /** 注入时间源，测试里才能确定性地验证抑制窗口 */
  now?: () => number
  /** 被丢弃时回调，供上层记日志 */
  onSkip?: (reason: string) => void
}

const DEFAULT_MAX_BYTES = 512 * 1024
/**
 * 收到远端文本后的抑制窗口。
 * 写入剪贴板到监听读到新值之间有窗口，期间可能读到旧内容，
 * 若不加抑制会把旧内容当成新复制再发一次，形成一次往返回环。
 */
const SUPPRESS_MS = 500

export class ClipboardSync {
  private readonly io: ClipboardIo
  private readonly opts: ClipboardSyncOptions
  private lastSeen = ''
  private suppressUntil = 0
  private running = false

  constructor(opts: ClipboardSyncOptions) {
    this.opts = opts
    this.io = opts.io
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private maxBytes(): number {
    return this.opts.maxBytes ?? DEFAULT_MAX_BYTES
  }

  private skip(reason: string): void {
    this.opts.onSkip?.(reason)
  }

  /**
   * 开始同步。先读一次基线：启动前剪贴板里的内容不是「用户刚复制的」，
   * 不该在启动瞬间被广播出去。
   */
  start(): void {
    this.running = true
    this.lastSeen = this.io.readText()
  }

  stop(): void {
    this.running = false
  }

  /** 由轮询或系统监听回调驱动：本机剪贴板可能变了 */
  poll(): void {
    if (!this.running) return
    const cur = this.io.readText()

    // 抑制窗口内直接返回。注意这里**不能**顺手更新 lastSeen：
    // 窗口内读到的可能是写入尚未生效时的旧值，把它记成基线，
    // 窗口结束后读到的真值反而成了「变更」，会再发一轮形成往返回环。
    if (this.now() < this.suppressUntil) return
    if (cur === this.lastSeen) return
    this.lastSeen = cur

    if (!cur) {
      // 剪贴板被清空：没有内容可同步，也不该把「空」推给对端
      return
    }
    const size = Buffer.byteLength(cur, 'utf8')
    if (size > this.maxBytes()) {
      this.skip(`剪贴板内容 ${size} 字节超过上限 ${this.maxBytes()} 字节，未同步`)
      return
    }
    this.opts.send(cur)
  }

  /** 收到对端推来的文本 */
  receive(text: string): void {
    if (!this.running) return
    if (typeof text !== 'string' || !text) return

    const size = Buffer.byteLength(text, 'utf8')
    if (size > this.maxBytes()) {
      this.skip(`远端剪贴板内容 ${size} 字节超过上限 ${this.maxBytes()} 字节，已丢弃`)
      return
    }
    if (this.opts.acceptRemote && !this.opts.acceptRemote(text)) {
      this.skip('远端剪贴板内容未被接受（授权范围或用户开关）')
      return
    }
    if (text === this.lastSeen) {
      // 本机已经是这段内容：再写一次没有意义，且会触发一轮无用的变更
      return
    }

    this.io.writeText(text)
    this.lastSeen = text
    this.suppressUntil = this.now() + SUPPRESS_MS
  }

  /**
   * 标记远端通过非剪贴板通道（如 screen.paste）写入了本机剪贴板：
   * 更新基线并启动抑制窗口，防止 poll() 将该写入误判为本机本地复制并回推
   */
  markRemoteWrite(text: string): void {
    if (typeof text !== 'string' || !text) return
    this.lastSeen = text
    this.suppressUntil = this.now() + SUPPRESS_MS
  }
}
