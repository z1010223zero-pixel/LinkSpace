// LinkSpace 主机：把身份、信任、控制通道、配对、传输、发现组装成一个节点。
//
// 单独一层的理由：这些模块之间有明确的依赖顺序（证书 → 传输服务 → 控制通道
// 挂到同一端口 → 配对 → 发现），散在 index.ts 里会变成一坨难以测试的胶水代码。
// 抽成 Host 之后，无头测试可以用两个 Host 跑完整的「配对 → 传输 → 取消」。
//
// 信任边界只有一道：传输服务的 isKnownDevice 直接读 TrustStore。
// 没有「顺便信任」或「开发期放行」的后门。

import { createHash, randomUUID } from 'node:crypto'
import type { Server } from 'node:https'
import { app, clipboard } from 'electron'
import { getDeviceCert, setIdentityDir, deviceIdOfCert, type DeviceCert } from './transfer/identity'
import { TrustStore, type TrustEntry, type TrustScope } from './transfer/trust'
import {
  DeviceBindingStore,
  resolveScrcpyDeviceId,
  serialBelongsToDevice,
  type DeviceBinding,
  type ScrcpyIdentity,
  type ScrcpyResolveResult
} from './device-binding'
import { TransferManager, type TransferFile, type TransferTask } from './transfer/manager'
import { startTransferServer, type StartedServer } from './transfer/server'
import { ControlNode, type Connection } from './control/node'
import { PairingCoordinator, type PendingPairing } from './pairing'
import { Discovery, type DiscoveredService } from './discovery'
import { LayoutStore } from './layout'
import { ProfileStore, sanitizeDisplayName } from './profile'
import { ClipboardSync, type ClipboardIo } from './clipboard'
import {
  InputController,
  InputSessionCoordinator,
  type InputControlRequest,
  type ActiveInputSession
} from './input/session'
import {
  DisplayExtendSessionCoordinator,
  DisplayExtendController,
  type ExtendControlRequest,
  type ExtendPreferredSize
} from './extend/session'
import type { InputEvent, ScreenSize } from './input/protocol'
import { InputLayoutStore } from './input/layout'
import { ScreenStreamService, ScreenStreamReceiver, STREAM_QUALITY_PRESETS, STREAM_RECONNECT_BACKOFFS_MS, STREAM_DIRECTION_FORWARD, STREAM_DIRECTION_REVERSE, STREAM_SOURCE_VIRTUAL_DISPLAY, resolveStreamStopDirection, type ReverseStreamFrame, type ReverseStreamStatus, type ScreenStreamSource } from './screen-stream'
import { log } from './log'

export interface HostOptions {
  displayName: string
  deviceType: 'win' | 'android-phone' | 'android-tablet'
  caps?: string[]
  /** 默认授权范围，默认只给 file */
  defaultScope?: TrustScope[]
  /** 信任清单与身份目录。无头测试注入临时目录；正常运行时走 userData */
  dataDir?: string
  /**
   * 注入设备身份证书。
   * 正常运行时留空，由 getDeviceCert() 从 userData 加载/生成。
   * 同进程内跑多个 Host 时必须注入：身份模块是进程级单例，
   * 两个 Host 共用一份缓存就会拿到同一张证书、同一个指纹。
   */
  cert?: DeviceCert
  /**
   * 数据面监听地址。留空时由 resolveBindAddress() 自动选局域网地址。
   * 无头测试必须显式传 '127.0.0.1'：它们在同一进程内经回环互连，
   * 而自动选择会绑到真实网卡，回环就访问不到了。
   */
  bind?: string
  /** 本机屏幕尺寸（键鼠共享坐标映射用）。留空走 Electron screen，测试注入假值 */
  inputLocalScreen?: () => ScreenSize
  /** 显示器枚举（B-2 多显示器选择）：返回每块屏的虚拟屏坐标与尺寸 */
  inputDisplays?: () => Array<{ x: number; y: number; w: number; h: number }>
  /**
   * 输入事件注入出口。正常路径由 index.ts 接 Win32 注入层；
   * 无头测试注入捕获数组。缺省为丢弃并告警——没有注入层的
   * input.event 不该无声消失。
   */
  inputInject?: (events: InputEvent[], session: ActiveInputSession) => void
  /** 控制会话终止时抬起按住的键（防卡键），测试注入记录 */
  inputReleaseAll?: () => void
  /**
   * 心跳周期/超时注入（毫秒）。正常留空走 ControlNode 默认（5s/15s）；
   * 无头测试注入短周期，把「超时清理」路径钉进秒级回归（审查 P2-4）
   */
  heartbeat?: { intervalMs?: number; timeoutMs?: number }
  /**
   * ffmpeg 可执行路径（屏幕投屏推流用）。留空视为本机不支持投屏，
   * 平板的 screen.stream.request 会收到 error 回告
   */
  screenFfmpegPath?: string
  /**
   * dd-capture 可执行路径（虚拟显示器帧源，线 3，3.2-1）。留空时
   * source=virtual-display 的投屏请求回 error；gdigrab 镜像投屏不受影响
   */
  screenDdCapturePath?: string
  /** 虚拟屏 bounds（投屏采集范围，物理像素）。与注入 normalizeAbsolute 同基准 */
  inputVirtualScreen?: () => { x: number; y: number; w: number; h: number }
  /**
   * 虚拟显示器创建/销毁出口（线 3，display-extend 会话 accept 时调用）。
   * 正常路径由 3.2 的 VirtualDisplayManager 接线；缺省为「不可用」——
   * 创建失败时扩展请求回 session.reject，绝不先 accept 再补建。
   *
   * 异步：SWD 创建要等设备就绪 + 新输出出现（上限约 30s），Coordinator
   * 的 approve 会 await；创建期间取消由 Coordinator 处理。
   */
  extendCreateVirtualDisplay?: (
    preferred: ExtendPreferredSize | null
  ) => Promise<{ ok: true; screen: { x: number; y: number; w: number; h: number } } | { ok: false; reason: string }>
  /** 虚拟显示器销毁出口。缺省为空操作 */
  extendDestroyVirtualDisplay?: () => void | Promise<void>
  /** 当前物理光标位置（虚拟屏坐标），用于正向投屏实时推送 screen.cursor */
  inputCursorPos?: () => { x: number; y: number } | null
  /** 唤醒休眠/熄屏的显示器（被控会话开始时自动点亮屏幕） */
  inputWakeDisplay?: () => void
}

export interface HostEvents {
  /** 发现层有新服务 */
  discovered: [DiscoveredService]
  /** 某服务从发现列表消失 */
  lost: [DiscoveredService]
  /** 收到配对请求，UI 应展示配对码 */
  pairRequested: [PendingPairing]
  /** 配对成功或已有信任生效 */
  paired: [TrustEntry]
  /** 信任被撤销 */
  revoked: [string]
  /** 收到文件传输 offer，UI 应展示保存路径确认 */
  transferOffered: [TransferTask]
  /** 传输任务状态变化 */
  transferChanged: [TransferTask]
  /** 本机显示名已变更（5.4） */
  selfRenamed: [string]
  /** 对端改了它自己的名字，本机信任清单已更新 */
  peerRenamed: [TrustEntry]
  /** 收到键鼠控制请求，UI 应展示确认弹窗（9.1 授权可见） */
  inputRequested: [InputControlRequest]
  /** 键鼠共享状态变化（请求到达/确认/结束），UI 刷新 */
  inputChanged: []
  /** 收到扩展屏请求，UI 应展示确认弹窗（9.1 授权可见，线 3） */
  extendRequested: [ExtendControlRequest]
  /** 扩展屏会话状态变化（请求到达/确认/结束），UI 刷新 */
  extendChanged: []
  /** 反向投屏（平板画面）解出一帧：W7 的平板画面窗口订阅此事件渲染 */
  reverseStreamFrame: [ReverseStreamFrame]
  /** 反向投屏状态变化（开始/结束/失败/重连），UI 刷新 */
  reverseStreamChanged: []
  /** 平板回的输入失败（协议 4.9 input.error）：画面窗口订阅后提示用户 */
  reverseInputError: [{ peerId: string; code: string; reason: string }]
}

/** 对端 device.rename 的最小受理间隔（审查 P3）：每次受理都伴随落盘与 UI 事件 */
const RENAME_MIN_INTERVAL_MS = 10_000
/** 挂起传输任务的最大存活时间（审查 P3）：对端不上线即过期清扫 */
const TRANSFER_MAX_AGE_MS = 24 * 60 * 60 * 1000

type Listener<K extends keyof HostEvents> = (...args: HostEvents[K]) => void

export class Host {
  /**
   * 设备 ID 由证书派生，start() 时赋值。
   * 曾经是每进程随机 UUID——证书持久化而 ID 随机，导致重启后对端
   * 信任清单全部失效（数据面 403）。Android 侧一开始就是派生的。
   */
  private deviceId = ''
  private readonly trust: TrustStore
  /** serial↔deviceId 绑定（W2）：与信任清单同处一个 dataDir */
  private readonly bindings: DeviceBindingStore
  /** scrcpy 撤销级联出口：由 registerIpc 注入 adapter 侧实现 */
  private scrcpyRevokedHandler:
    | ((deviceId: string, matches: (serial: string) => boolean) => void | Promise<void>)
    | null = null
  private readonly layout: LayoutStore
  private readonly profile: ProfileStore
  /**
   * 本机显示名。构造时从 profile.json 恢复（5.4 改名要跨重启保持），
   * 没改过名才退回 opts.displayName 的默认值。
   */
  private selfName: string
  private clipboardSync: ClipboardSync | null = null
  /** 剪贴板同步用户开关（6.6）。关闭后收发双向静默，不产生任何流量 */
  private clipboardEnabled = false
  private readonly transfers = new TransferManager()
  private control: ControlNode | null = null
  private pairing: PairingCoordinator | null = null
  private discovery: Discovery | null = null
  private fileServer: StartedServer | null = null
  /** 键鼠共享：被控端状态机 + 控制端状态机（阶段 3） */
  private inputCoordinator: InputSessionCoordinator | null = null
  private inputController: InputController | null = null
  /** 扩展屏：被控端状态机 + 控制端状态机（线 3，与 input 会话解耦） */
  private extendCoordinator: DisplayExtendSessionCoordinator | null = null
  private extendController: DisplayExtendController | null = null
  private readonly screenStream = new ScreenStreamService()
  /** 码率自适应状态（B-3）：拥塞计分与当前档位。正数=连续拥塞采样，
   *  负数=连续空闲采样（恢复升档）；探测清零换挡 */
  private streamCongestionScore = 0
  private screenStreamCurrentTier = 0
  /** 反向投屏接收端（线 2 W6：平板画面进电脑窗口） */
  private readonly reverseStreamReceiver = new ScreenStreamReceiver()
  /** 正在看谁的反向投屏（peerId）；null = 未请求/已结束 */
  private reverseStreamPeerId: string | null = null
  private reverseStreamScaleWidth = 1920
  /** 反向投屏断线重连计时器（退避 5/10/20/30s×4，与线 1 同口径） */
  private reverseStreamReconnectTimer: NodeJS.Timeout | null = null
  private reverseStreamReconnectAttempt = 0
  /**
   * 反向窗口的键鼠会话声明（线 2 W7）：input 会话在 session.start 里
   * 声明的屏幕尺寸就是流尺寸（w/h），平板按此把窗口坐标映射回本屏。
   * 流尺寸只有 screen.stream.start 到达时才知道，因此输入会话不在开窗
   * 时发起，而在流开始后自动发起（见 start 处理里的调用）。
   * 有值 = 已发起请求（待确认）或会话活动中；会话结束/失败时清掉。
   */
  private reverseInputRequested: { peerId: string; screen: ScreenSize } | null = null
  /** 最近一次反向输入请求被拒/超时/失败的原因（窗口展示 + 重试用） */
  private reverseInputError: { peerId: string; message: string } | null = null
  /**
   * 最近一次反向流非用户主动结束的原因（线 2 W7：平板拒绝/超时/断连时
   * 主窗口提示用，用户自己点断开/关窗口时为空）。新请求发出时清掉。
   */
  private lastReverseStreamEndReason: string | null = null
  /** 本次投屏选中的显示器区域（虚拟屏坐标）；null = 未选/全桌面 */
  private streamRegion: { x: number; y: number; w: number; h: number } | null = null
  /**
   * 正向投屏归属（线 3，3.2-1/锁屏暂停）：当前流是推给谁的、什么帧源、
   * 什么区域与档位。screen.source 只区分帧源，peerId 与 started 在此。
   * 停流（对端 stop / 断连 / 锁屏暂停 / 意外退出）时一并清掉。
   */
  private forwardStreamPeerId: string | null = null
  private forwardStreamSource: ScreenStreamSource = 'screen'
  private forwardStreamRegion: { x: number; y: number; w: number; h: number } | null = null
  private forwardStreamScaleWidth = 1920
  private forwardStreamRegionArgs: string[] = []
  /** screen.stream.start 是否已发出（DD 就绪前失败时不发 stop，避免对端清掉不存在的流） */
  private forwardStreamStarted = false
  /** 正向投屏实时推送鼠标坐标的定时器（16ms 轮询变化即发 screen.cursor） */
  private forwardCursorTimer: NodeJS.Timeout | null = null
  /** 正向推流码率自适应积压采样定时器（避免换档叠加泄漏） */
  private forwardBacklogTimer: NodeJS.Timeout | null = null
  /** 最近一次虚拟显示器异步销毁 Promise，供 stop() 退出前等待完成 */
  private pendingExtendDestroy: Promise<void> | null = null
  /** 锁屏暂停的正向投屏（解锁后按原样重起）；无暂停时 null */
  private pausedForwardStream: {
    peerId: string
    source: ScreenStreamSource
    region: { x: number; y: number; w: number; h: number } | null
    scaleWidth: number
    regionArgs: string[]
  } | null = null
  private readonly inputLayout: InputLayoutStore
  private listeners: { [K in keyof HostEvents]?: Listener<K>[] } = {}
  /** 已连接的对端：deviceId → Connection */
  private readonly peers = new Map<string, Connection>()
  /** 对端 device.rename 的最近受理时间，配合 RENAME_MIN_INTERVAL_MS 限频（审查 P3） */
  private readonly renameLastAt = new Map<string, number>()
  /** 发起连接时记住的服务名 → 连接，供 UI 按发现列表里的服务名找回连接 */
  private readonly serviceConns = new Map<string, Connection>()
  /** 对端可达端点。只有主动连出去时才知道对方的监听端口 */
  private readonly endpoints = new Map<string, { host: string; port: number }>()
  /** 已连接但身份尚未声明完成的端点，announce 到达后提升到 endpoints */
  private readonly pendingEndpoints = new Map<Connection, { host: string; port: number }>()
  private started = false

  constructor(private readonly opts: HostOptions) {
    // dataDir 必须同时管住信任清单与身份证书：只设一半会让身份退回到
    // 进程级单例，同进程多个 Host 会共用同一张证书、同一个指纹。
    if (opts.dataDir) setIdentityDir(opts.dataDir)
    const dataDir = opts.dataDir ?? app.getPath('userData')
    this.trust = new TrustStore({
      dir: dataDir,
      defaultScope: opts.defaultScope ?? ['file', 'clipboard']
    })
    this.bindings = new DeviceBindingStore({ dir: dataDir })
    this.layout = new LayoutStore({ dir: dataDir })
    this.profile = new ProfileStore({ dir: dataDir })
    this.inputLayout = new InputLayoutStore({ dir: dataDir })
    this.selfName = this.profile.get() || opts.displayName
  }

  on<K extends keyof HostEvents>(event: K, cb: Listener<K>): this {
    const list = (this.listeners[event] ??= []) as Listener<K>[]
    list.push(cb)
    return this
  }

  private emit<K extends keyof HostEvents>(event: K, ...args: HostEvents[K]): void {
    const list = this.listeners[event] as Listener<K>[] | undefined
    list?.forEach((cb) => cb(...args))
  }

  get id(): string {
    return this.deviceId
  }

  /** 本机显示名（对外身份，改名会同步到对端与 mDNS 通告） */
  get displayName(): string {
    return this.selfName
  }

  /**
   * 本机改名（5.4）：持久化 → 同步配对器/发现层（重发通告）→
   * 广播 device.rename 给已连接对端。名字由 ProfileStore 落盘，
   * 对端各自更新自己的信任清单并持久化——两端重启后都保持。
   */
  setDisplayName(raw: string): { ok: boolean; name?: string; error?: string } {
    const clean = sanitizeDisplayName(raw)
    if (!clean) return { ok: false, error: '名字不能为空' }
    if (clean === this.selfName) return { ok: true, name: clean }
    this.selfName = clean
    this.profile.set(clean)
    this.pairing?.setDisplayName(clean)
    // 发现层重发通告：服务名内嵌显示名，对端重新发现时拿到新名字
    this.discovery?.setDisplayName(clean)
    let sent = 0
    for (const conn of this.peers.values()) {
      conn.send('device.rename', { displayName: clean })
      sent++
    }
    if (sent) log.info(`本机已改名为「${clean}」，通知 ${sent} 台在线设备`)
    this.emit('selfRenamed', clean)
    return { ok: true, name: clean }
  }

  get trustStore(): TrustStore {
    return this.trust
  }

  /**
   * 注入 scrcpy 撤销出口（W2）。撤销信任时 Host 回调此函数，告知调用方
   * 哪些 adb serial 属于被撤销设备；调用方负责停掉这些 serial 上的会话。
   * 判定逻辑在 Host 内，停会话的动作在外，Host 不直接依赖 ScrcpyAdapter。
   */
  setScrcpyRevokedHandler(
    cb: (deviceId: string, matches: (serial: string) => boolean) => void | Promise<void>
  ): void {
    this.scrcpyRevokedHandler = cb
  }

  get layoutStore(): LayoutStore {
    return this.layout
  }

  /** 读取持久化的设备顺序 */
  layoutOrder(): string[] {
    return this.layout.get()
  }

  /** 覆盖设备顺序。传入的应是完整列表，不是增量 */
  setLayoutOrder(order: string[]): void {
    this.layout.set(order)
  }

  get transferManager(): TransferManager {
    return this.transfers
  }

  /** 本机传输服务监听端口，0 表示未启动 */
  get port(): number {
    return this.fileServer?.port ?? 0
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    const cert = this.opts.cert ?? (await getDeviceCert())
    this.deviceId = deviceIdOfCert(cert.cert)
    const port = await this.startFileServer(cert)
    this.startControl(cert)
    this.startPairing(cert)
    this.startDiscovery(port)
    this.wireTransferBridge()
    this.wireClipboardBridge()
    this.wireRenameBridge()
    this.wireExtendBridge()
    this.wireInputBridge()

    log.info(`LinkSpace 主机已启动，id=${this.deviceId}，端口=${port}`)
  }

  /** 传输服务。信任判定只认 TrustStore 与任务 token，没有旁路 */
  private async startFileServer(cert: DeviceCert): Promise<number> {
    this.fileServer = await startTransferServer(
      {
      resolveIncoming: (id) => this.transfers.resolveIncoming(id),
      resolveOutgoing: (id) => this.transfers.resolveOutgoing(id),
        appendIncoming: (key, offset, body) => this.transfers.appendIncoming(key, offset, body),
        verifyTransfer: (transferKey, deviceId, token) =>
          this.trust.isKnown(deviceId) &&
          this.trust.hasScope(deviceId, 'file') &&
          this.transfers.verifyToken(transferKey, token)
      },
      cert,
      {
        ...(this.opts.bind ? { bind: this.opts.bind } : {}),
        preferredPort: this.profile.getLastPort() || undefined
      }
    )
    this.profile.setLastPort(this.fileServer.port)
    return this.fileServer.port
  }

  private startControl(cert: DeviceCert): void {
    this.control = new ControlNode({ deviceId: this.deviceId, tls: cert })

    // 控制通道与文件传输共用同一个端口与证书（ADR-003）
    this.control.attach(this.fileServer!.server as Server)
    this.control.startHeartbeat(
      (conn) => {
        log.warn(`对端 ${conn.peerId || '(未知)'} 心跳超时，判定离线`)
        this.handleConnClosed(conn)
      },
      this.opts.heartbeat
    )
    this.control.onClosed((conn) => this.handleConnClosed(conn))
  }

  /**
   * 连接断开（onClosed）与心跳超时（onTimeout）共用的清理。
   *
   * 超时路径必须与 close 路径做同样的事（审查 P2-4）：ws.close 是优雅
   * 关闭，对端断网时 close 握手完不成，真正的 close 事件要等 closeTimeout
   * （默认 30s）——若只删 peers 干等，被控期间的卡键要 15s 心跳 + 30s
   * close ≈ 45s 才解除，威胁模型 T4 要求立即恢复本机输入。输入会话的
   * 清理由 wireInputBridge 的 onClosed 也会推一次，onPeerDisconnected
   * 幂等，重复调用无害。
   *
   * 发送方向 offered→waiting 回退（审查 P2-2）：对端 accept 前掉线的
   * 任务必须回 waiting，否则 flushWaitingOffers（只认 waiting）永不补发。
   */
  private handleConnClosed(conn: Connection): void {
    const pid = conn.peerId
    // 同一对端可能同时存在「主动连出 + 对端连入」两条连接（移交清单
    // 2026-10-30）：旧连接的 close 常常迟到——TCP 半开要等超时，实测
    // 60s+。若按 deviceId 无脑删，会把幸存连接的 peers 登记与 endpoints
    // 端点一起删掉，迟到的 transfer.accept 便报「不知道对端的监听端点，
    // 无法推送」。有幸存连接时只摘自己这条，其余清理一律不动。
    const survivor = pid
      ? this.control?.connections().find((c) => c !== conn && c.peerId === pid)
      : undefined
    if (pid && !survivor) {
      this.peers.delete(pid)
      this.endpoints.delete(pid)
    } else if (survivor && this.peers.get(pid) === conn) {
      // 刚断的恰是 peers 表里那条，但同身份的活连接还在：登记移交过去
      this.peers.set(pid, survivor)
    }
    this.pendingEndpoints.delete(conn)
    for (const [name, c] of this.serviceConns) {
      if (c === conn) this.serviceConns.delete(name)
    }
    if (!survivor) {
      this.inputCoordinator?.onPeerDisconnected(pid)
      this.inputController?.onPeerDisconnected(pid)
      this.extendCoordinator?.onPeerDisconnected(pid)
      this.extendController?.onPeerDisconnected(pid)
      // 投流跟着连接走：会话失效钩子（onChanged）正常会停流，但断连
      // 清理链路多级间接，实测有漏网（ffmpeg 在对端重装后仍推流 20s+，
      // 挡死下一次 start）——这里直接兜底，stop 幂等
      this.screenStream.stop()
      this.streamRegion = null
      this.clearForwardStreamState()
      this.pausedForwardStream = null
      // 反向投屏跟着连接走：接收端先停（再喂帧无处去），再按
      // 5/10/20/30s×4 排期重发请求（线 1 同口径）；peerId 保留供重连用
      if (this.reverseStreamPeerId === pid) {
        this.reverseStreamReceiver.stop()
        this.scheduleReverseStreamReconnect(pid, this.reverseStreamScaleWidth)
      }
      for (const task of this.transfers.list()) {
        if (task.peerId !== pid) continue
        if (task.direction !== 'send' || task.state !== 'offered') continue
        this.transfers.markWaiting(task.id)
      }
    }
  }

  private startPairing(cert: DeviceCert): void {
    this.pairing = new PairingCoordinator({
      deviceId: this.deviceId,
      displayName: this.selfName,
      deviceType: this.opts.deviceType,
      trust: this.trust,
      node: this.control!,
      caps: () => this.opts.caps ?? ['file', 'clipboard'],
      selfFingerprint: () => cert.fingerprint
    })
    // 身份声明一到就把连接登记到 peers 表，否则 offerFiles 会以「未连接」拒绝。
    // 必须注册在 PairingCoordinator 之后：conn.peerId 由它填上，
    // 注册早了拿到的是空字符串。
    this.control!.on('device.announce', (conn) => {
      if (!conn.peerId) return
      this.peers.set(conn.peerId, conn)
      const ep = this.pendingEndpoints.get(conn)
      if (ep) {
        this.endpoints.set(conn.peerId, ep)
        this.pendingEndpoints.delete(conn)
      }
      // 端点先登记再补发：waiting 任务对端 accept 后要立即推送，
      // 推送依赖 endpoints 里的 host/port
      this.flushWaitingOffers(conn)
    })

    this.pairing
      .onPairRequested((p) => this.emit('pairRequested', p))
      .onPaired((entry) => {
        this.discovery?.refreshAdvertisement()
        this.emit('paired', entry)
      })
      .onRevoked((deviceId) => {
        // W2 撤销级联（P0）：撤销前先算出属于该设备的 adb serial——显式
        // 绑定快照 + 无线 IP-join。peers 表删掉后 remoteAddress 就拿不到了，
        // 绑定删掉后快照也失效，所以必须在删除之前捕获。
        const conn = this.peers.get(deviceId)
        const remoteIp = conn?.remoteAddress ?? null
        const boundSerials = this.bindings.serialsFor(deviceId)
        const matches = (serial: string): boolean =>
          serialBelongsToDevice(serial, { boundSerials, remoteIp })
        this.bindings.removeForDevice(deviceId)
        // 停会话的动作由 registerIpc 注入的 adapter 回调执行；回调异常
        // 不影响撤销继续推进
        void Promise.resolve(this.scrcpyRevokedHandler?.(deviceId, matches)).catch((err) => {
          log.warn(`撤销级联停止 scrcpy 会话失败: ${err instanceof Error ? err.message : String(err)}`)
        })
        this.peers.delete(deviceId)
        // 撤销必须级联（审查 2.2 P1）：不清任务的话，被撤销方持原证书
        // 重连即可收到挂起任务的 offer 并完成 accept/token 交换。
        // 先删 peers 再取消：cancelRequested 的通知就找不到连接，不会
        // 把「我撤销了你」这件事再发给被撤销方。
        this.endpoints.delete(deviceId)
        for (const task of this.transfers.list()) {
          if (task.peerId !== deviceId) continue
          if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') continue
          void this.transfers.cancel(task.id).catch(() => {})
        }
        this.emit('revoked', deviceId)
      })
  }

  private startDiscovery(port: number): void {
    this.discovery = new Discovery({
      displayName: this.selfName,
      deviceType: this.opts.deviceType,
      deviceId: this.deviceId,
      port,
      caps: this.opts.caps ?? ['file', 'clipboard'],
      isPaired: () => this.trust.list().length > 0
    })
    this.discovery
      .on('up', (svc) => this.emit('discovered', svc))
      .on('down', (svc) => this.emit('lost', svc))
    this.discovery.start()
  }

  // ---------- 配对 ----------

  /**
   * 连接到已发现的服务并声明身份。
   * 对端端点先挂起，等 device.announce 回来拿到 peerId 再正式登记——
   * 连接刚建立时 peerId 还是空的，那时候存进去会存到空键上。
   */
  async connect(svc: DiscoveredService): Promise<Connection> {
    const conn = await this.control!.connect(svc.host, svc.port)
    this.pendingEndpoints.set(conn, { host: svc.host, port: svc.port })
    // 服务名 → 连接：UI 提交配对码时只知道服务名，不能靠
    // 「服务名里碰巧包含 deviceId 前缀」这种巧合来找回连接
    this.serviceConns.set(svc.serviceName, conn)
    this.pairing!.introduce(conn)
    return conn
  }

  /** 发起配对，返回供 UI 展示的等待态 */
  requestPairing(conn: Connection): Promise<TrustEntry> {
    return this.pairing!.requestPairing(conn)
  }

  submitCode(conn: Connection, code: string): { ok: boolean; error?: string } {
    return this.pairing!.submitCode(conn, code)
  }

  approvePairing(p: PendingPairing, code: string): { ok: boolean; error?: string } {
    return this.pairing!.approve(p, code)
  }

  rejectPairing(p: PendingPairing, reason?: string): void {
    this.pairing!.reject(p, reason)
  }

  pendingPairings(): PendingPairing[] {
    return this.pairing?.pendingRequests() ?? []
  }

  revokeTrust(deviceId: string): boolean {
    return this.pairing!.revoke(deviceId)
  }

  // ---------- scrcpy 授权门禁（W2 安全修复） ----------

  /**
   * scrcpy 启动门禁：serial → 已配对 deviceId。
   * 未配对 / 未绑定的设备一律拒绝，调用方（ipc.ts）据此返回 AUTH_REQUIRED。
   */
  resolveScrcpyDevice(serial: string): ScrcpyResolveResult {
    return resolveScrcpyDeviceId(serial, {
      bindings: this.bindings,
      isTrusted: (id) => this.trust.isKnown(id),
      deviceIdByIp: (ip) => {
        for (const [deviceId, conn] of this.peers) {
          if (conn.remoteAddress === ip) return deviceId
        }
        return null
      }
    })
  }

  /**
   * scrcpy 设备身份快照（2.5-1）：供 DeviceManager.view() 把 adb 列表与
   * 配对清单并成一套。allowed 直接复用门禁判定，与 scrcpy:startFor 同口径；
   * deviceId 为 null 表示 serial 解析不到任何已配对设备（UI 上显示未配对）。
   * 注意：无线未配对设备即使在线也不会暴露 deviceId——身份只来自已配对
   * 的连接或显式绑定，不拿 IP/型号反推。
   */
  scrcpyIdentityOf(serial: string): ScrcpyIdentity {
    const boundId = this.bindings.deviceIdOf(serial)
    const gate = this.resolveScrcpyDevice(serial)
    if (gate.ok) {
      return { deviceId: gate.deviceId, paired: true, bound: gate.via === 'binding', allowed: true }
    }
    return {
      deviceId: boundId,
      paired: boundId !== null && this.trust.isKnown(boundId),
      bound: boundId !== null,
      allowed: false
    }
  }

  /**
   * 某 adb serial 是否属于某台已配对设备（2.5 反向流衔接用）：显式绑定
   * 快照 + 该设备当前 LinkSpace 连接的 remoteAddress（无线 IP-join）。
   * 与撤销级联用的是同一判定（serialBelongsToDevice），只差快照是 live 取
   * 还是撤销前捕获——这里调用时连接还在，live 取即可。
   */
  scrcpySerialBelongsTo(deviceId: string, serial: string): boolean {
    const conn = this.peers.get(deviceId)
    return serialBelongsToDevice(serial, {
      boundSerials: this.bindings.serialsFor(deviceId),
      remoteIp: conn?.remoteAddress ?? null
    })
  }

  /**
   * 用户显式建立一条 serial↔deviceId 绑定（USB 设备投屏的前置条件）。
   * deviceId 必须已配对；serial 已绑到别的设备时会被覆盖（用户纠错）。
   */
  bindScrcpyDevice(serial: string, deviceId: string): { ok: boolean; error?: string } {
    if (!serial) return { ok: false, error: '缺少设备序列号' }
    if (!deviceId) return { ok: false, error: '缺少设备 ID' }
    if (!this.trust.isKnown(deviceId)) return { ok: false, error: '该设备未配对，无法绑定' }
    this.bindings.bind(serial, deviceId)
    return { ok: true }
  }

  /** 删除一条显式绑定 */
  unbindScrcpyDevice(serial: string): boolean {
    return this.bindings.unbind(serial)
  }

  /** 当前全部显式绑定（供 UI 展示） */
  scrcpyBindings(): DeviceBinding[] {
    return this.bindings.list()
  }

  trustedDevices(): TrustEntry[] {
    return this.trust.list()
  }

  /** 本机身份信息，供配对时人工核对指纹 */
  async identityInfo(): Promise<{ port: number; fingerprint: string; deviceId: string }> {
    const cert = this.opts.cert ?? (await getDeviceCert())
    return { port: this.port, fingerprint: cert.fingerprint, deviceId: this.deviceId }
  }

  /** 按 mDNS 服务名找回已建立的连接（发起方提交配对码用） */
  connectionFor(serviceName: string): Connection | null {
    const direct = this.serviceConns.get(serviceName)
    if (direct) return direct
    // 兜底：直连注入场景（跨平台联调脚本）没有走 connect()，没有服务名记录。
    // 服务名形如 LinkSpace-<displayName>，若发布方把 id 前缀嵌进了名字，
    // 仍可按前缀匹配
    for (const conn of this.peers.values()) {
      if (conn.peerId && serviceName.includes(conn.peerId.slice(0, 12))) return conn
    }
    return null
  }

  // ---------- 文件传输 ----------

  /**
   * 发起传输。返回任务，随后由 UI 等对端 accept。
   *
   * 对端离线时不报错、不丢弃（验收 4.9「提示等待」）：只要目标设备
   * 已配对且持有 file 授权，任务就挂成 waiting，等它重新上线
   * （device.announce）时自动发出 offer。给未配对/未授权设备排队
   * 没有意义——信任都不存在，「等它上线」无从谈起，维持明确报错。
   */
  async offerFiles(peerId: string, files: TransferFile[]): Promise<TransferTask> {
    const conn = this.peers.get(peerId)
    if (!conn) {
      if (!this.trust.isKnown(peerId) || !this.trust.hasScope(peerId, 'file')) {
        throw new Error(`设备 ${peerId} 未连接或没有文件传输授权`)
      }
      const waiting = await this.transfers.offer(peerId, files, undefined, 'send', {
        waiting: true
      })
      log.info(`对端 ${peerId} 离线，传输任务 ${waiting.id} 挂起等待其上线`)
      this.emit('transferChanged', waiting)
      return waiting
    }
    if (!this.trust.hasScope(peerId, 'file')) {
      throw new Error(`设备 ${peerId} 没有文件传输授权`)
    }
    const task = await this.transfers.offer(peerId, files)
    conn.send('transfer.offer', {
      transferId: task.id,
      files: task.files.map((f) => ({ name: f.name, size: f.size })),
      totalSize: task.totalSize
    })
    this.emit('transferChanged', task)
    return task
  }

  /** 对端是否在线（有完成身份声明的连接）。UI 与测试的离线判定探针 */
  isConnected(peerId: string): boolean {
    return this.peers.has(peerId)
  }

  /**
   * 对端重新上线：把所有 waiting 的发送任务补发给它。
   * 状态翻转用 markOffered（幂等，只吃 waiting），重复 announce
   * 或多任务并发 flush 都不会产生二次 offer。
   */
  private flushWaitingOffers(conn: Connection): void {
    const peerId = conn.peerId
    // 补发前复查信任与授权（审查 2.2 P1）：announce 只锚定了「这条连接
    // 的证书确实是它声称的那把」，不保证此刻它仍在信任清单——已撤销
    // 设备持原证书重连能过身份闸，若不在此拦截，挂起任务的 offer
    // （文件名/大小元数据）会继续流向被撤销方。
    if (!this.trust.isKnown(peerId) || !this.trust.hasScope(peerId, 'file')) return
    for (const task of this.transfers.list()) {
      if (task.direction !== 'send' || task.state !== 'waiting' || task.peerId !== peerId) continue
      conn.send('transfer.offer', {
        transferId: task.id,
        files: task.files.map((f) => ({ name: f.name, size: f.size })),
        totalSize: task.totalSize
      })
      this.transfers.markOffered(task.id)
    }
  }

  /** 接收方：用户确认保存路径 */
  async acceptTransfer(id: string, saveDir: string): Promise<TransferTask> {
    const task = this.transfers.get(id)
    if (!task) throw new Error('任务不存在')
    // token 由接收方生成，经控制通道交还发送方作为数据面凭证。
    // saveDir 只在本机使用，不出网——本机文件系统布局不喂给对端
    const token = randomUUID()
    const accepted = await this.transfers.accept(id, saveDir, { token })
    const conn = this.peers.get(task.peerId)
    conn?.send('transfer.accept', { transferId: id, token })
    this.emit('transferChanged', accepted)
    return accepted
  }

  async rejectTransfer(id: string, reason: string): Promise<void> {
    const task = this.transfers.get(id)
    if (!task) return
    this.transfers.reject(id, reason)
    this.peers.get(task.peerId)?.send('transfer.reject', { transferId: id, reason })
    this.emit('transferChanged', this.transfers.get(id)!)
  }

  async cancelTransfer(id: string): Promise<void> {
    const task = this.transfers.get(id)
    if (!task) return
    await this.transfers.cancel(id)
    // 对端收到后才会清理它的 .part，这是取消闭环的另一半
    this.peers.get(task.peerId)?.send('transfer.cancel', { transferId: id, reason: 'cancelled by user' })
    this.emit('transferChanged', this.transfers.get(id)!)
  }

  transferTasks(): TransferTask[] {
    return this.transfers.list()
  }

  /**
   * 把控制消息接到传输管理器上。
   * 这一段是「取消只清理本端」这个缺口的修复点：
   * 发送方取消 → transfer.cancel → 接收方 manager.cancel → .part 被删。
   *
   * 所有消息都先核对「连接身份 == 任务对端」：传输任务的细节
   * （transferId、token）只对当事双方可见，其他已配对设备乃至
   * 任何能连上控制通道的连接，都不该能对别人的任务做任何操作。
   */
  private wireTransferBridge(): void {
    const control = this.control!

    // offer 的 id 由发送方生成，约束字符集：组合键 `${id}:${name}` 靠
    // 第一个冒号切分出任务 id，id 里混进冒号就会歧义；也避免怪字符
    // 进入数据面 URL
    const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

    control.on('transfer.offer', (conn, msg) => {
      const p = msg.payload as { transferId?: string; files?: { name: string; size: number }[] }
      if (!p.transferId || !Array.isArray(p.files)) return
      if (!TRANSFER_ID_RE.test(p.transferId)) {
        log.warn('收到非法 transferId 的 transfer.offer，已忽略')
        return
      }
      const peerId = conn.peerId
      if (!peerId) {
        log.warn('收到未声明身份连接的 transfer.offer，已忽略')
        return
      }
      // offer 必须来自持有 file 授权的已配对设备：不设这道闸，
      // 任何能连上控制通道的连接都能在本机创建垃圾传输任务
      if (!this.trust.hasScope(peerId, 'file')) {
        log.warn(`拒绝未授权设备的 transfer.offer`)
        conn.send('transfer.reject', { transferId: p.transferId, reason: 'not authorized' })
        return
      }
      const transferId = p.transferId
      this.peers.set(peerId, conn)
      void this.transfers
        .offer(
          peerId,
          p.files.map((f) => ({ name: String(f.name ?? ''), size: Number(f.size ?? -1) })),
          transferId,
          'receive'
        )
        .then((task) => this.emit('transferOffered', task))
        .catch((err) => {
          log.error(`接收 offer 失败: ${String(err)}`)
          conn.send('transfer.reject', { transferId, reason: 'invalid offer' })
        })
    })

    control.on('transfer.accept', (conn, msg) => {
      const p = msg.payload as { transferId?: string; token?: string }
      if (!p.transferId) return
      const transferId = p.transferId
      // 授权复查前置（审查 2.2 P1）：accept 携带数据面 token，未授权
      // 连接（已撤销/从未配对）不该能把它挂到任何任务上；通过后才
      // 允许注册进 peers 表。
      if (!conn.peerId || !this.trust.hasScope(conn.peerId, 'file')) {
        log.warn(`拒绝未授权连接对任务 ${transferId} 的 transfer.accept`)
        return
      }
      this.peers.set(conn.peerId, conn)
      const task = this.transfers.get(transferId)
      // 只有本任务的对端才能交还 token，其他连接的 accept 一律无视
      if (!task || task.direction !== 'send' || task.peerId !== conn.peerId) return
      // token 由接收方生成，必须挂到发送方任务上，否则数据面鉴权失败
      this.transfers.attachToken(transferId, String(p.token ?? ''))
      if (task) {
        const ep = this.endpoints.get(conn.peerId)
        if (!ep) {
          log.error(`不知道对端 ${conn.peerId} 的监听端点，无法推送`)
          return
        }
        void this.transfers
          .push(transferId, {
            host: ep.host,
            port: ep.port,
            deviceId: this.deviceId
          })
          .then((pushed) => {
            this.emit('transferChanged', pushed)
            // push() 在被取消时也正常 resolve（它返回的是任务而非抛错），
            // 所以必须先核对状态。少了这个判断，取消后仍会发出 complete，
            // 接收方便把半成品当成功落盘——正是验收项 4.4 要防的行为。
            if (pushed.state !== 'completed') return
            const digests: Record<string, string> = {}
            for (const f of pushed.files) if (f.digest) digests[f.name] = f.digest
            conn.send('transfer.complete', { transferId, digests })
          })
          .catch((err) => log.error(`推送失败: ${String(err)}`))
      }
    })

    control.on('transfer.reject', (conn, msg) => {
      const p = msg.payload as { transferId?: string; reason?: string }
      if (!p.transferId) return
      const task = this.transfers.get(p.transferId)
      if (!task || task.peerId !== conn.peerId) return
      this.transfers.reject(p.transferId, p.reason ?? 'rejected')
    })

    // 取消的真实闭环：删掉本端的 .part
    control.on('transfer.cancel', (conn, msg) => {
      const p = msg.payload as { transferId?: string }
      if (!p.transferId) return
      const task = this.transfers.get(p.transferId)
      if (!task || task.peerId !== conn.peerId) return
      void this.transfers.cancel(p.transferId)
    })

    // 接收方：发送方推完了，带着整体摘要过来。校验通过才落盘。
    control.on('transfer.complete', (conn, msg) => {
      const p = msg.payload as { transferId?: string; digests?: Record<string, string> }
      if (!p.transferId) return
      const task = this.transfers.get(p.transferId)
      // 伪造的 complete 会让接收方按假摘要比对后删掉 .part，等于让
      // 旁观连接拥有弄坏别人传输的能力，必须核对来源与本任务对端一致
      if (!task || task.direction !== 'receive' || task.peerId !== conn.peerId) return
      void this.transfers
        .finalize(p.transferId, p.digests)
        .then((task) => this.emit('transferChanged', task))
        .catch((err) => log.error(`落盘失败: ${String(err)}`))
    })

    this.transfers.on('changed', (task) => this.emit('transferChanged', task))

    // 发送方本地取消时，通知对端清理它的那一半。
    // 这是「取消只清理本端」缺口的修复点。
    this.transfers.on('cancelRequested', (e: { id: string; peerId: string }) => {
      const conn = this.peers.get(e.peerId)
      conn?.send('transfer.cancel', { transferId: e.id, reason: 'cancelled by user' })
    })
  }

  /**
   * 剪贴板同步的收口。
   *
   * 与传输一样，先过授权范围：只有持有 clipboard 授权的对端才能把内容
   * 写进本机剪贴板，也只有这类对端才会收到本机的变更。剪贴板会收到
   * 密码、令牌这类东西，范围门禁不能省。
   */
  private wireClipboardBridge(): void {
    this.control!.on('clipboard.share', (conn, msg) => {
      const p = msg.payload as { text?: string; kind?: string }
      const peerId = conn.peerId
      if (!peerId) return
      if (!this.trust.hasScope(peerId, 'clipboard')) {
        log.warn(`拒绝未授权设备的 clipboard.share：${peerId}`)
        return
      }
      // 只认文本（图片与文件走传输通道），且必须是字符串（审查 P3 收紧）：
      // String() 会把对象强转成 "[object Object]" 写进剪贴板
      if (typeof p.text !== 'string' || (p.kind && p.kind !== 'text')) return
      this.clipboardSync?.receive(p.text)
    })
  }

  /**
   * 启用剪贴板同步。读写由调用方注入，本类不直接依赖 Electron，
   * 回环抑制逻辑才能在无头测试里覆盖。
   */
  enableClipboardSync(io: ClipboardIo): void {
    this.clipboardSync = new ClipboardSync({
      io,
      send: (text) => this.broadcastClipboard(text),
      onSkip: (reason) => log.warn(reason)
    })
    this.clipboardEnabled = true
    this.clipboardSync.start()
  }

  /**
   * 剪贴板同步开关（6.6「关闭同步 → 完全不传输」）。
   * 关闭走 ClipboardSync.stop()：poll 与 receive 双向失效；
   * 重新开启时 start() 重读基线——开关期间剪贴板里的内容不是
   * 「用户刚复制的」，不该在开启瞬间被广播出去。
   */
  setClipboardEnabled(enabled: boolean): void {
    if (enabled === this.clipboardEnabled) return
    this.clipboardEnabled = enabled
    // 开关落盘（审查 P2-1）：用户的选择要跨重启保持，不能每次启动
    // 强制回开——静默双向同步是需要用户明示授权的行为
    this.profile.setClipboardEnabled(enabled)
    if (enabled) this.clipboardSync?.start()
    else this.clipboardSync?.stop()
    log.info(`剪贴板同步已${enabled ? '开启' : '关闭'}`)
  }

  isClipboardEnabled(): boolean {
    return this.clipboardEnabled
  }

  /**
   * 启动时按持久化值归位剪贴板开关（审查 P2-1）。
   * enableClipboardSync「构造即开」是无头测试的便利语义；产品路径必须
   * 在构造后调这个归位——用户上次关掉的，重启后不能悄悄打开。
   * 未设置过 = 默认关。
   */
  /**
   * 清扫超龄挂起任务（审查 P3）：对端永远不上线的 waiting/offered 任务
   * 由 index.ts 周期驱动到这里统一取消，不再无限堆积。
   */
  sweepStaleTransfers(): void {
    const swept = this.transfers.sweepExpired(TRANSFER_MAX_AGE_MS)
    if (swept > 0) log.info(`已清扫 ${swept} 个超龄挂起传输任务`)
  }

  restoreClipboardSwitch(): boolean {
    const saved = this.profile.getClipboardEnabled()
    if (!saved) this.setClipboardEnabled(false)
    return saved
  }

  /** 本机剪贴板可能变了，由上层定时调用 */
  pollClipboard(): void {
    this.clipboardSync?.poll()
  }

  /** 广播到所有持有 clipboard 授权且已连接的对端 */
  private broadcastClipboard(text: string): void {
    let sent = 0
    for (const [peerId, conn] of this.peers) {
      if (!this.trust.hasScope(peerId, 'clipboard')) continue
      conn.send('clipboard.share', { kind: 'text', text })
      sent++
    }
    if (sent) log.info(`剪贴板已同步到 ${sent} 台设备`)
  }

  /**
   * 对端改名的接收端（5.4）。只信任清单内的设备才能更新条目：
   * 名字是对端自报的，不给陌生连接改写本机状态的通道。
   */
  private wireRenameBridge(): void {
    this.control!.on('device.rename', (conn, msg) => {
      const p = msg.payload as { displayName?: string }
      const peerId = conn.peerId
      if (!peerId || !this.trust.isKnown(peerId)) {
        log.warn('忽略未信任连接的 device.rename')
        return
      }
      const clean = sanitizeDisplayName(String(p.displayName ?? ''))
      if (!clean) return
      // 按设备限频（审查 P3）：rename 每次受理都同步落盘并广播 UI 事件，
      // 不限频会被已配对对端刷 IO
      const lastAt = this.renameLastAt.get(peerId) ?? 0
      if (Date.now() - lastAt < RENAME_MIN_INTERVAL_MS) {
        log.warn(`忽略 ${peerId} 的高频 device.rename`)
        return
      }
      this.renameLastAt.set(peerId, Date.now())
      if (this.trust.rename(peerId, clean)) {
        const entry = this.trust.list().find((e) => e.deviceId === peerId)
        if (entry) this.emit('peerRenamed', entry)
        log.info(`对端 ${peerId} 已改名为「${clean}」`)
      }
    })
  }

  /**
   * 键鼠共享桥（阶段 3，第 7 组）。
   *
   * 与传输/剪贴板同一个模式：Host 只做「消息 ↔ 状态机」的搬运，
   * 授权判定与会话状态集中在 InputSessionCoordinator（被控端）与
   * InputController（控制端），两者都是可无头测试的纯逻辑。
   *
   * **control 授权是会话级内存态**：被控端 approve 后会话才算建立，
   * 结束/断连/撤销立即失效。TrustStore 不持久化 control——持久化
   * 会让 9.1「每次控制请求都有明确提示」形同虚设。
   */
  private wireInputBridge(): void {
    const control = this.control!

    const sendTo = (peerId: string, type: string, payload: Record<string, unknown>): void => {
      this.peers.get(peerId)?.send(type, payload)
    }

    this.inputCoordinator = new InputSessionCoordinator({
      callbacks: {
        isPeerAuthorized: (peerId) => this.trust.isKnown(peerId),
        localScreen: () => {
          // 选定显示器投屏时，触控映射的目标就是那块屏（而不是全虚拟屏）
          const r = this.streamRegion
          if (r) return { w: r.w, h: r.h }
          return this.opts.inputLocalScreen?.() ?? this.defaultLocalScreen()
        },
        inject: (events, session) => {
          // 选定显示器投屏时：mapPoint 已映射进该屏的本地坐标（物理
          // 像素），注入前平移回虚拟屏相对坐标——下层的 inputInject
          // 包装（index.ts）统一补回虚拟屏负 origin，这里不能再补一次
          //（此前双重加 origin 且 r 是 DIP 坐标，选屏投屏时指针严重错位）
          const r = this.streamRegion
          const vs = this.opts.inputVirtualScreen?.()
          const translated = r
            ? events.map((ev) => {
                if (ev.t !== 'move') return ev
                const bx = r.x - (vs?.x ?? 0)
                const by = r.y - (vs?.y ?? 0)
                return {
                  ...ev,
                  x: Math.min(bx + r.w - 1, Math.max(bx, ev.x + bx)),
                  y: Math.min(by + r.h - 1, Math.max(by, ev.y + by))
                }
              })
            : events
          this.opts.inputInject?.(translated, session)
        },
        releaseAll: () => this.opts.inputReleaseAll?.(),
        send: sendTo,
        log: (msg) => log.info(msg),
        onChanged: () => {
          // 会话结束（active 变 null 的过渡）时投流随之终止：画面是
          // 会话授权的一部分，没有会话就没有画面——但只停 'screen'
          // 源的流：扩展屏推流（virtual-display 源）寄生在
          // display-extend 会话而非 input 会话，input 结束不得掐断
          // 它（3.2-2 解耦；此前无条件 stop 会把扩展屏画面一并掐掉）。
          if (!this.inputCoordinator?.activeSession && this.screenStream.source === 'screen') {
            this.screenStream.stop()
            this.clearForwardStreamState()
            this.pausedForwardStream = null
          }
          this.emit('inputChanged')
        },
        onRequest: (req) => {
          // 走查自动批准：LINKSPACE_AUTO_APPROVE=1 时跳过人工确认（仅
          // 显式环境变量开启，真机走查用——approve TTL 30s 与 adb 无线
          // 链路抖动叠加会让 CDP 驱动的批准链路超时，真机踩过）。
          // 正常运行（无此变量）走 UI 弹窗人工确认，语义不变。
          if (process.env.LINKSPACE_AUTO_APPROVE === '1') {
            log.info(`[walkthrough] 自动批准 ${req.peerId} 的键鼠控制请求`)
            this.approveInputControl(req.sessionId)
            return
          }
          if (this.trust.isNoConfirmValid(req.peerId)) {
            log.info(`[trust] 免确认有效期内，自动批准 ${req.peerId} 的键鼠控制请求`)
            this.approveInputControl(req.sessionId)
            return
          }
          this.emit('inputRequested', req)
        }
      }
    })

    this.inputController = new InputController({
      callbacks: {
        send: sendTo,
        log: (msg) => log.info(msg),
        onAccepted: () => this.emit('inputChanged'),
        onRejected: () => this.emit('inputChanged'),
        onEnded: (peerId) => {
          if (this.reverseInputRequested?.peerId === peerId) this.reverseInputRequested = null
          this.emit('inputChanged')
        }
      }
    })

    control.on('session.start', (conn, msg) => {
      if (!conn.peerId) return
      // 按 sessionType 路由：input 与 display-extend 各走自己的状态机，
      // 互不感知（3.2-2 解耦点）。未知类型直接回绝，不进任何状态机。
      const sessionType = (msg.payload as { sessionType?: unknown } | null)?.sessionType
      if (sessionType === 'display-extend') {
        this.extendCoordinator!.onStart(conn.peerId, msg.payload)
        return
      }
      if (sessionType === 'input') {
        this.inputCoordinator!.onStart(conn.peerId, msg.payload)
        return
      }
      // 未知类型：沿用旧口径，由 input 状态机回 'bad request' 拒绝，
      // 不进任何状态机、不弹 UI。
      this.inputCoordinator!.onStart(conn.peerId, msg.payload)
    })

    control.on('session.accept', (conn, msg) => {
      const p = msg.payload as { sessionId?: unknown; screen?: unknown; virtualScreen?: unknown }
      if (typeof p?.sessionId !== 'string') return
      // accept 按 sessionId 各自匹配：input 与 extend 控制器各认自己的
      // 挂起请求，不匹配的安全忽略（UUID 碰撞可忽略，peerId 也须一致）
      this.inputController!.onAccepted(conn.peerId, p.sessionId, p.screen)
      this.extendController!.onAccepted(conn.peerId, p.sessionId, p.virtualScreen)
    })

    control.on('session.reject', (conn, msg) => {
      const p = msg.payload as { sessionId?: unknown; reason?: unknown }
      if (typeof p?.sessionId !== 'string') return
      this.inputController!.onRejected(conn.peerId, p.sessionId, String(p.reason ?? ''))
      this.extendController!.onRejected(conn.peerId, p.sessionId, String(p.reason ?? ''))
    })

    control.on('session.stop', (conn, msg) => {
      const p = msg.payload as { sessionId?: unknown }
      if (typeof p?.sessionId !== 'string') return
      // 两端都可能收到 stop：作为控制端收到被控端的终止，
      // 或作为被控端收到控制端的退出（7.4）。各自按 sessionId 匹配，
      // 不匹配的就是别人的会话，安全忽略
      this.inputController!.onStopped(conn.peerId, p.sessionId)
      this.inputCoordinator!.onStop(conn.peerId, msg.payload)
      this.extendController!.onStopped(conn.peerId, p.sessionId)
      this.extendCoordinator!.onStop(conn.peerId, msg.payload)
    })

    control.on('input.event', (conn, msg) => {
      if (!conn.peerId) return
      this.inputCoordinator!.onEvent(conn.peerId, msg.payload)
    })

    // ---------- 屏幕投屏（见 screen-stream.ts） ----------
    // 视频块走 WS 二进制帧复用平板连出的控制连接：平板的 ServerSocket
    // 对任何入站端口都不通（ICMP 通、TCP 全拒），唯有平板自己连出的
    // 链路可用（实测），TCP 全双工允许桌面在这个方向发数据。
    // 帧源（协议 4.7 [PROTOCOL] 2026-11-03 登记，线 3）：
    //   - source 省略/'screen'：线 1 镜像投屏，gdigrab 抓真实桌面，
    //     前置为活动 input 会话；
    //   - source='virtual-display'：扩展屏，dd-capture 抓虚拟显示器，
    //     前置为活动 display-extend 会话（不要求 input 会话）。
    control.on('screen.stream.request', (conn, msg) => {
      const peerId = conn.peerId
      const payload = (msg.payload ?? {}) as { display?: unknown; scaleWidth?: unknown; source?: unknown }
      log.info(`[screen-stream] 收到投屏请求 display=${payload.display ?? '(无)'} source=${payload.source ?? 'screen'} from=${peerId ?? '(未登记)'}`)
      if (!peerId) return
      if (!this.opts.screenFfmpegPath) {
        sendTo(peerId, 'screen.stream.error', { message: '本机缺少 ffmpeg，无法投屏' })
        return
      }
      const requestedScaleWidth =
        typeof payload.scaleWidth === 'number' ? (payload.scaleWidth as number) : 1920
      const scaleWidth = STREAM_QUALITY_PRESETS.some((p) => p.width === requestedScaleWidth)
        ? requestedScaleWidth
        : 1920
      if (payload.source === STREAM_SOURCE_VIRTUAL_DISPLAY) {
        const ext = this.extendCoordinator?.activeSession
        if (!ext || ext.peerId !== peerId) {
          log.warn('[screen-stream] 拒绝：无活动扩展屏会话，virtual-display 帧源不可用')
          sendTo(peerId, 'screen.stream.error', { message: '扩展屏投屏需要先建立扩展屏会话' })
          return
        }
        if (!this.opts.screenDdCapturePath) {
          sendTo(peerId, 'screen.stream.error', { message: '本机缺少 dd-capture，无法推虚拟显示器画面' })
          return
        }
        // display 参数此时无意义（虚拟显示器只有一块），忽略；
        // 区域就是 session.accept 回过的 virtualScreen。
        this.startForwardStream(peerId, STREAM_SOURCE_VIRTUAL_DISPLAY, { ...ext.virtualScreen }, scaleWidth)
        return
      }
      const active = this.inputCoordinator?.activeSession
      if (!active || active.peerId !== peerId) {
        log.warn(`[screen-stream] 拒绝：无活动键鼠会话（active=${active ? active.peerId : 'null'}）`)
        sendTo(peerId, 'screen.stream.error', { message: '投屏需要先建立键鼠会话' })
        return
      }
      // 多显示器选择（ToDesk 体验，用户 2026-10-31 提出）：不带 display
      // 的请求先回显示器清单，带 display 的按其虚拟屏坐标区域抓取。
      // 单显示器免选择器，直接投 0 号屏；自动重连带 lastStreamDisplayIndex
      // 时同样直连，不会再弹清单。
      let requested = payload.display
      const displays = this.opts.inputDisplays?.() ?? []
      if (typeof requested !== 'number') {
        if (displays.length === 0) {
          sendTo(peerId, 'screen.stream.error', { message: '无法枚举显示器' })
          return
        }
        if (displays.length > 1) {
          sendTo(peerId, 'screen.stream.displays', { displays })
          return
        }
        requested = 0
      }
      const vs = this.opts.inputVirtualScreen?.()
      let region: { x: number; y: number; w: number; h: number } | null =
        displays[Number(requested)] ?? null
      // 与虚拟屏物理边界求交：Electron DIP 边界乘 scaleFactor 换算物理
      // 坐标有 ±1px 舍入漂移，越界 1px gdigrab 直接拒开（实测
      // Capture area extends outside window area）
      if (region && vs) {
        const x0 = Math.max(region.x, vs.x)
        const y0 = Math.max(region.y, vs.y)
        const x1 = Math.min(region.x + region.w, vs.x + vs.w)
        const y1 = Math.min(region.y + region.h, vs.y + vs.h)
        region = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
      }
      // gdigrab 的 -offset_x/-offset_y 用的是**物理虚拟屏绝对坐标**（其
      // 报错原文实证：Capture area ... extends outside window area
      // (-3840,-188),(2880,1972)——正是物理虚拟屏边界），inputDisplays
      // 返回的物理矩形可直接用；这俩是 gdigrab 的输入选项，必须落在
      // '-i desktop' 之前（此前拼在命令尾，抓区域从未生效过）
      const regionArgs = region
        ? [
            '-offset_x',
            String(region.x),
            '-offset_y',
            String(region.y),
            '-video_size',
            `${region.w}x${region.h}`
          ]
        : []
      this.startForwardStream(peerId, 'screen', region, scaleWidth, regionArgs)
    })
    control.on('screen.stream.stop', (conn, msg) => {
      if (!conn.peerId) return
      // 方向位（协议 4.7）：direction 指明停哪一路流；缺失时按本端
      // 属于该对端的活动流解析（单路停那路、双向只停 forward），
      // 绝不顺手停掉另一路。非法值忽略。
      // forwardLive 按正向投屏归属（forwardStreamPeerId）判定，不按
      // input 会话——扩展屏流（virtual-display 源）没有 input 会话，
      // 按旧口径会被当成“无流”而忽略 stop。
      const forwardLive =
        this.screenStream.running && this.forwardStreamPeerId === conn.peerId
      const reverseLive = this.reverseStreamPeerId === conn.peerId
      const direction = resolveStreamStopDirection(msg.payload, forwardLive, reverseLive)
      if (!direction) {
        log.warn(`[screen-stream] 忽略无法解析方向的 screen.stream.stop（from=${conn.peerId}）`)
        return
      }
      let stopped = false
      if (direction === STREAM_DIRECTION_FORWARD) {
        this.screenStream.stop()
        this.clearForwardStreamState()
        this.pausedForwardStream = null
        stopped = forwardLive
      } else if (reverseLive) {
        this.stopReverseReceiver('对端停止反向投屏')
        stopped = true
      }
      // 只在确实停掉一路流时回声确认：对端收到回声时本地已无流可停，
      // 不再回声，停流确认不会来回 ping-pong。
      if (stopped) sendTo(conn.peerId, 'screen.stream.stop', { direction })
    })
    // ffmpeg/dd-capture 意外退出（平板断开/编码器崩溃/帧源丢失）：
    // 通知对端清 UI。start 尚未发出（DD 就绪前失败）时不发 stop，
    // 对端没有流可清，发了反而可能清掉它正在看的别的流。
    this.screenStream.onEnded = () => {
      const peer = this.forwardStreamPeerId
      const started = this.forwardStreamStarted
      this.clearForwardStreamState()
      this.pausedForwardStream = null
      if (peer && started) sendTo(peer, 'screen.stream.stop', { direction: STREAM_DIRECTION_FORWARD })
    }

    // ---------- 反向投屏（线 2 W6：平板画面进电脑窗口，协议 4.7 反向） ----------
    // 与线 1 的寄生关系不同：反向流不以活动 input 会话为前提——
    // 平板端的授权门是 MediaProjection 系统录屏授权，不是 input 会话。
    // 观看方（本机）只负责请求 + 收帧 + 解码；W7 的平板画面窗口消费
    // reverseStreamFrame 事件渲染，控制入口与窗口本身不在本批。
    control.onBinary((conn, data) => {
      if (!conn.peerId || conn.peerId !== this.reverseStreamPeerId) return
      this.reverseStreamReceiver.feed(data)
    })
    control.on('screen.stream.start', (conn, msg) => {
      const peerId = conn.peerId
      if (!peerId || peerId !== this.reverseStreamPeerId) return
      const p = msg.payload as { w?: unknown; h?: unknown; scaleWidth?: unknown }
      const w = typeof p?.w === 'number' ? p.w : 0
      const h = typeof p?.h === 'number' ? p.h : 0
      const scaleWidth = typeof p?.scaleWidth === 'number' ? p.scaleWidth : this.reverseStreamScaleWidth
      if (!this.opts.screenFfmpegPath) {
        log.warn('[screen-stream] 反向投屏无法解码：本机缺少 ffmpeg')
        sendTo(peerId, 'screen.stream.stop', { direction: STREAM_DIRECTION_REVERSE })
        this.stopReverseReceiver('本机缺少 ffmpeg，无法解码')
        return
      }
      const prevStatus = this.reverseStreamReceiver.status()
      const sizeChanged = w > 0 && h > 0 && (prevStatus.width !== w || prevStatus.height !== h)
      if (w > 0 && h > 0) this.reverseStreamReceiver.setExpectedSize(w, h)
      this.reverseStreamScaleWidth = scaleWidth
      this.reverseStreamReconnectAttempt = 0
      this.clearReverseStreamReconnectTimer()
      this.reverseStreamReceiver.onEnded = () => {
        // 解码器意外退出（对端编码器崩溃/流损坏）：清状态，等用户重发请求
        if (this.reverseStreamPeerId === peerId) {
          log.warn('[screen-stream] 反向接收端解码器意外退出')
          this.stopReverseReceiver('解码器意外退出')
        }
      }
      if (!this.reverseStreamReceiver.running || sizeChanged) {
        this.reverseStreamReceiver.start(this.opts.screenFfmpegPath, (frame) => {
          this.emit('reverseStreamFrame', frame)
        })
      }
      log.info(`[screen-stream] 反向投屏已开始（${peerId}，${w}x${h} @ ${scaleWidth}p）`)
      this.emit('reverseStreamChanged')
      // W7：流一开即请求键鼠控制——窗口的输入走 input.event（与线 1
      // 同通道），声明的屏幕尺寸就是流尺寸；平板端每次都要确认（9.1），
      // 未确认/拒绝时只看画面、输不进去，事件是安全空操作。
      const inputReq = this.requestInputControlWithScreen(peerId, { w, h })
      if (!inputReq.ok) log.info(`[screen-stream] 反向键鼠控制未发起：${inputReq.error}`)
    })
    control.on('screen.stream.error', (conn, msg) => {
      const peerId = conn.peerId
      if (!peerId || peerId !== this.reverseStreamPeerId) return
      const message = String((msg.payload as { message?: unknown })?.message ?? '投屏失败')
      log.warn(`[screen-stream] 反向投屏失败：${message}`)
      this.stopReverseReceiver(message)
    })

    // ---------- 投屏粘贴（协议 4.8，B-7）----------
    // 键盘通道按 vk 注入，IME 组合输入（中文）无法表达；粘贴通道把文本
    // 写进本机剪贴板再注入 Ctrl+V。寄生 input 会话：无会话/来源不符
    // 一律忽略（剪贴板写入是会话授权的一部分）
    control.on('screen.paste', (conn, msg) => {
      const peerId = conn.peerId
      if (!peerId) return
      const active = this.inputCoordinator?.activeSession
      if (!active || active.peerId !== peerId) {
        log.warn(`忽略 ${peerId} 的 screen.paste（无活动键鼠会话）`)
        return
      }
      const text = String((msg.payload as { text?: unknown } | null)?.text ?? '')
      if (!text) return
      if (Buffer.byteLength(text, 'utf8') > 512 * 1024) {
        log.warn(`screen.paste 超限（${Buffer.byteLength(text, 'utf8')} 字节），丢弃`)
        return
      }
      clipboard.writeText(text)
      this.clipboardSync?.markRemoteWrite(text)
      log.info(`[screen.paste] 已写入剪贴板（${text.length} 字符）并注入 Ctrl+V`)
      // Ctrl+V 走与对端事件完全相同的注入路径（已过会话校验与解码）
      this.inputCoordinator?.onEvent(peerId, {
        sessionId: active.sessionId,
        events: [
          { t: 'key', vk: 0x11, down: true },
          { t: 'key', vk: 0x56, down: true },
          { t: 'key', vk: 0x56, down: false },
          { t: 'key', vk: 0x11, down: false }
        ]
      })
    })

    // ---------- 输入失败回告（协议 4.9，input.error）----------
    // 平板侧 input.event / input.text / screen.paste 注入失败时回告：
    // 只认当前反向控制会话的对端与会话，旁观连接的回告忽略；原因原样
    // 透传到画面窗口（无焦点时提示点输入框，不自动点按聚焦）。
    control.on('input.error', (conn, msg) => {
      const peerId = conn.peerId
      if (!peerId || this.inputController?.controlling !== peerId) return
      const p = msg.payload as { sessionId?: unknown; code?: unknown; reason?: unknown }
      if (typeof p.sessionId !== 'string' || p.sessionId !== this.inputController.activeSession?.sessionId) return
      const code = typeof p.code === 'string' ? p.code : 'inject-failed'
      const reason = typeof p.reason === 'string' && p.reason ? p.reason : '远程输入失败'
      log.warn(`[input.error] ${peerId} ${code}：${reason}`)
      this.emit('reverseInputError', { peerId, code, reason })
    })

    // 断连清理收口在 handleConnClosed（startControl 注册，带幸存者
    // 检查）。这里曾再注册一份 onClosed 推 onPeerDisconnected——双连接
    // 并存时旧连接迟到的 close 会经这份冗余注册误杀幸存连接上的会话
    // （移交清单 2026-10-30），已并入统一清理

    // 信任撤销优先于一切：立即掐断请求与会话（9.1 的安全兜底）
    this.on('revoked', (deviceId) => {
      this.inputCoordinator?.onTrustRevoked(deviceId)
      this.inputController?.onPeerDisconnected(deviceId)
      this.extendCoordinator?.onTrustRevoked(deviceId)
      this.extendController?.onPeerDisconnected(deviceId)
      if (this.reverseStreamPeerId === deviceId) this.stopReverseReceiver('信任已被撤销')
      this.emit('inputChanged')
      this.emit('extendChanged')
    })
  }

  /**
   * 扩展屏桥（线 3，协议 4.3，sessionType: 'display-extend'）。
   *
   * 与 wireInputBridge 同构：Host 只做「消息 ↔ 状态机」的搬运，
   * 授权判定与会话状态集中在 DisplayExtendSessionCoordinator（被控端）
   * 与 DisplayExtendController（控制端），两者都是可无头测试的纯逻辑。
   * 扩展屏会话与 input 会话各占独立槽位，互不感知——无活动 input
   * 会话也能开扩展屏；input 会话结束不终止扩展屏推流。
   *
   * **虚拟显示器创建出口**：缺省（未接 VirtualDisplayManager，
   * 3.2 之前）为「不可用」——approve 时创建失败，回 session.reject，
   * 绝不先 accept 再补建。
   */
  private wireExtendBridge(): void {
    const sendTo = (peerId: string, type: string, payload: Record<string, unknown>): void => {
      this.peers.get(peerId)?.send(type, payload)
    }

    this.extendCoordinator = new DisplayExtendSessionCoordinator({
      callbacks: {
        isPeerAuthorized: (peerId) => this.trust.isKnown(peerId),
        createVirtualDisplay: async (preferred) =>
          this.opts.extendCreateVirtualDisplay?.(preferred) ?? {
            ok: false as const,
            reason: 'virtual display unavailable'
          },
        destroyVirtualDisplay: () => {
          const r = this.opts.extendDestroyVirtualDisplay?.()
          if (r && typeof (r as Promise<void>).then === 'function') {
            this.pendingExtendDestroy = (r as Promise<void>).catch(() => {}).finally(() => {
              this.pendingExtendDestroy = null
            })
          }
        },
        send: sendTo,
        log: (msg) => log.info(msg),
        onChanged: () => {
          if (!this.extendCoordinator?.activeSession && this.screenStream.source === STREAM_SOURCE_VIRTUAL_DISPLAY) {
            this.screenStream.stop()
            this.clearForwardStreamState()
            this.pausedForwardStream = null
          }
          this.emit('extendChanged')
        },
        onRequest: (req) => {
          // 走查自动批准：LINKSPACE_AUTO_APPROVE=1 时跳过人工确认（与
          // input 会话同口径，仅显式环境变量开启，真机走查用）。
          // approve 是异步的（虚拟显示器创建上限约 30s），不阻塞请求
          // 回路；创建失败时 Coordinator 自行回 session.reject。
          if (process.env.LINKSPACE_AUTO_APPROVE === '1') {
            log.info(`[walkthrough] 自动批准 ${req.peerId} 的扩展屏请求`)
            void this.approveExtendControl(req.sessionId)
            return
          }
          if (this.trust.isNoConfirmValid(req.peerId)) {
            log.info(`[trust] 免确认有效期内，自动批准 ${req.peerId} 的扩展屏请求`)
            void this.approveExtendControl(req.sessionId)
            return
          }
          this.emit('extendRequested', req)
        }
      }
    })

    this.extendController = new DisplayExtendController({
      callbacks: {
        send: sendTo,
        log: (msg) => log.info(msg),
        onAccepted: () => this.emit('extendChanged'),
        onRejected: () => this.emit('extendChanged'),
        onEnded: () => this.emit('extendChanged')
      }
    })
  }

  // ---------- 反向投屏（线 2 W6）：宿主侧状态机 ----------

  /**
   * UI（W7 的平板画面窗口）：请求看对端平板的画面。
   * 门禁：对端必须已连接且已配对；同一时刻只看一路反向流。
   * 反向流不以活动 input 会话为前提（协议 4.7 反向）；平板端的授权门
   * 是 MediaProjection 系统录屏授权，由平板用户在系统弹框里确认。
   */
  /**
   * 正向投屏启动（线 1 镜像 + 线 3 扩展屏共用，见 screen.stream.request
   * 分发）。按帧源选路：'screen' 走 gdigrab（start），'virtual-display'
   * 走 dd-capture（startDd，DD 就绪后才发 screen.stream.start）。
   * 码率自适应探针与 start 消息都在流真正跑起来后才建，避免 DD 就
   * 绪前失败留一条空转探针。锁屏暂停后解锁恢复也调这里（按原参数重起）。
   */
  private startForwardStream(
    peerId: string,
    source: ScreenStreamSource,
    region: { x: number; y: number; w: number; h: number } | null,
    scaleWidth: number,
    regionArgs: string[] = []
  ): void {
    const conn = this.peers.get(peerId)
    const ffmpegPath = this.opts.screenFfmpegPath
    if (!conn || !ffmpegPath) return
    const sendTo = (type: string, payload: Record<string, unknown>): void => {
      this.peers.get(peerId)?.send(type, payload)
    }
    try {
      let streamBytesSent = 0
      let sentHash = createHash('sha256')
      let bytesInCurrentMb = 0
      let mbCount = 0
      const onChunk = (chunk: Buffer): void => {
        streamBytesSent += chunk.length
        // 端到端取证：按精确 1MB 分段哈希（两侧对齐），零拷贝流式更新（消除 Buffer.concat）
        let offset = 0
        while (offset < chunk.length) {
          const needed = 1_048_576 - bytesInCurrentMb
          const take = Math.min(chunk.length - offset, needed)
          sentHash.update(chunk.subarray(offset, offset + take))
          bytesInCurrentMb += take
          offset += take
          if (bytesInCurrentMb === 1_048_576) {
            mbCount++
            log.info(`[screen-stream] 发送MB#${mbCount} sha=${sentHash.digest('hex').slice(0, 16)}`)
            sentHash = createHash('sha256')
            bytesInCurrentMb = 0
          }
        }
        conn.sendBinary(chunk)
      }
      // 流跑起来后的收尾：码率自适应探针 + screen.stream.start。
      // DD 源在 onReady 里调（编码器已起）；gdigrab 源直接调。
      const afterStarted = (w: number, h: number): void => {
        this.forwardStreamPeerId = peerId
        this.forwardStreamSource = source
        this.forwardStreamRegion = region ? { ...region } : null
        this.forwardStreamScaleWidth = scaleWidth
        this.forwardStreamRegionArgs = [...regionArgs]
        this.forwardStreamStarted = true
        // 码率自适应（B-3）：周期采样发送积压，持续拥塞降档、长稳升档。
        // 换档在 screen-stream 内部同步重启 ffmpeg（stop+start 同 tick，
        // 本探针不会插进间隙）；推流停止（会话结束/对端断开/手动）后
        // running=false，探针自停车并复位档位
        if (this.forwardBacklogTimer) {
          clearInterval(this.forwardBacklogTimer)
          this.forwardBacklogTimer = null
        }
        let lastProbeBytes = 0
        let probeTick = 0
        this.forwardBacklogTimer = setInterval(() => {
          if (!this.screenStream.running) {
            if (this.forwardBacklogTimer) {
              clearInterval(this.forwardBacklogTimer)
              this.forwardBacklogTimer = null
            }
            this.screenStreamCurrentTier = 0
            this.streamCongestionScore = 0
            return
          }
          // 发送速率遥测（每 8 个采样 ≈16s 一条）：ffmpeg 出了字节没有、
          // ws 堵没堵，一眼可辨（真机排障：解码端收不到帧时先分段定位）
          if (++probeTick % 8 === 0 && streamBytesSent !== lastProbeBytes) {
            log.info(
              `[screen-stream] 累计 ${(streamBytesSent / 1e6).toFixed(1)}MB，backlog ${conn.backlog()}B`
            )
            lastProbeBytes = streamBytesSent
          }
          const backlog = conn.backlog()
          if (backlog > 1_000_000) {
            this.streamCongestionScore = Math.min(3, this.streamCongestionScore + 1)
          } else if (backlog < 100_000) {
            this.streamCongestionScore = Math.max(-8, this.streamCongestionScore - 1)
          } else {
            this.streamCongestionScore = 0
          }
          // 3 个连续拥塞采样 → 降档；恢复分累积到 -8（约 30s 稳定）→ 升档
          if (this.streamCongestionScore >= 3) {
            this.streamCongestionScore = 0
            this.screenStreamCurrentTier = Math.min(this.screenStreamCurrentTier + 1, 3)
            this.screenStream.setTier(this.screenStreamCurrentTier)
          } else if (this.streamCongestionScore <= -8 && this.screenStreamCurrentTier > 0) {
            this.streamCongestionScore = 0
            this.screenStreamCurrentTier -= 1
            this.screenStream.setTier(this.screenStreamCurrentTier)
          }
        }, 2000)
        sendTo('screen.stream.start', { w, h, scaleWidth })
        if (this.forwardCursorTimer) clearInterval(this.forwardCursorTimer)
        if (this.opts.inputCursorPos) {
          let lastCursorX = -1
          let lastCursorY = -1
          this.forwardCursorTimer = setInterval(() => {
            if (!this.screenStream.running || this.forwardStreamPeerId !== peerId) {
              if (this.forwardCursorTimer) {
                clearInterval(this.forwardCursorTimer)
                this.forwardCursorTimer = null
              }
              return
            }
            const pos = this.opts.inputCursorPos?.()
            if (!pos) return
            const r = this.forwardStreamRegion
            const vs = this.opts.inputVirtualScreen?.() ?? { x: 0, y: 0, w, h }
            const baseX = r ? r.x : vs.x
            const baseY = r ? r.y : vs.y
            const curW = r ? r.w : vs.w
            const curH = r ? r.h : vs.h
            if (curW <= 0 || curH <= 0) return
            const lx = pos.x - baseX
            const ly = pos.y - baseY
            if (lx < 0 || lx >= curW || ly < 0 || ly >= curH) return
            if (lx === lastCursorX && ly === lastCursorY) return
            lastCursorX = lx
            lastCursorY = ly
            sendTo('screen.cursor', { x: lx, y: ly, w: curW, h: curH })
          }, 16)
          this.forwardCursorTimer.unref?.()
        }
        log.info(`[screen-stream] 已为 ${peerId} 开启投屏${region ? `（${source === STREAM_SOURCE_VIRTUAL_DISPLAY ? '虚拟显示器' : '显示器'} ${region.w}x${region.h} @ ${region.x},${region.y}）` : '（全桌面）'}`)
      }
      this.streamRegion = region
      if (source === STREAM_SOURCE_VIRTUAL_DISPLAY && region && this.opts.screenDdCapturePath) {
        this.screenStream.startDd({
          ffmpegPath,
          ddCapturePath: this.opts.screenDdCapturePath,
          onChunk,
          rect: region,
          scaleWidth,
          onReady: ({ w, h }) => afterStarted(w, h)
        })
        // 注意：start 发在 onReady 里；就绪前失败走 screenStream.onEnded，
        // 此时 forwardStreamStarted 仍为 false，不会误发 stop。
      } else {
        this.screenStream.start(ffmpegPath, onChunk, regionArgs, scaleWidth)
        afterStarted(
          region?.w ?? this.opts.inputVirtualScreen?.().w ?? 1920,
          region?.h ?? this.opts.inputVirtualScreen?.().h ?? 1080
        )
      }
    } catch (err) {
      const tail = this.screenStream.lastErrors().join(' | ')
      log.warn(`[screen-stream] 启动失败: ${String(err)} ${tail}`)
      sendTo('screen.stream.error', { message: `投屏启动失败：${String(err)}` })
    }
  }

  /**
   * 清掉正向投屏归属（停流/断连/意外退出时调）。锁屏暂停记录不在
   * 这里清——锁屏停流后恢复还要用它；对端 stop / 断连 / 意外退出
   * 时调用方显式清 pausedForwardStream。
   */
  private clearForwardStreamState(): void {
    this.forwardStreamPeerId = null
    this.forwardStreamStarted = false
    if (this.forwardCursorTimer) {
      clearInterval(this.forwardCursorTimer)
      this.forwardCursorTimer = null
    }
    if (this.forwardBacklogTimer) {
      clearInterval(this.forwardBacklogTimer)
      this.forwardBacklogTimer = null
    }
  }

  /** 停止正向推流并清理状态 */
  stopForwardStream(): void {
    if (this.screenStream.running) {
      this.screenStream.stop()
    }
    this.clearForwardStreamState()
    this.pausedForwardStream = null
  }

  /**
   * 锁屏：正向投屏暂停。gdigrab 在锁屏下抓不到画面（Winlogon 安全
   * 桌面不可见，ffmpeg 报 error 5 / Access denied，2026-11-03 真机
   * 复现），DD 同样看不到锁屏画面——与其让编码器空转报错，不如停
   * 流并记下恢复参数，解锁后按原样重起；对端收到 screen.stream.stop，
   * 画面收起，不会卡在最后一帧。反向流（平板→桌面）不受锁屏影响。
   */
  handleSessionLock(): void {
    if (!this.screenStream.running || !this.forwardStreamPeerId) return
    const peerId = this.forwardStreamPeerId
    // 先记恢复参数，再停流清归属（暂停记录保留到解锁）
    this.pausedForwardStream = {
      peerId,
      source: this.forwardStreamSource,
      region: this.forwardStreamRegion ? { ...this.forwardStreamRegion } : null,
      scaleWidth: this.forwardStreamScaleWidth,
      regionArgs: [...this.forwardStreamRegionArgs]
    }
    this.screenStream.stop()
    this.clearForwardStreamState()
    this.peers.get(peerId)?.send('screen.stream.stop', { direction: STREAM_DIRECTION_FORWARD })
    log.info(`[screen-stream] 电脑已锁屏，正向投屏已暂停（${peerId}），解锁后自动恢复`)
  }

  /**
   * 解锁：恢复锁屏时暂停的正向投屏。会话已不在（对端断连/扩展屏会
   * 话已结束）时不再恢复，只记日志；扩展屏恢复时区域以当前虚拟显
   * 示器为准（锁屏期间显示拓扑可能变了）。
   */
  handleSessionUnlock(): void {
    const paused = this.pausedForwardStream
    this.pausedForwardStream = null
    if (!paused) return
    if (!this.peers.has(paused.peerId)) {
      log.info('[screen-stream] 解锁后对端已断连，锁屏暂停的投屏不再恢复')
      return
    }
    if (paused.source === STREAM_SOURCE_VIRTUAL_DISPLAY) {
      const ext = this.extendCoordinator?.activeSession
      if (!ext || ext.peerId !== paused.peerId) {
        log.info('[screen-stream] 解锁后扩展屏会话已不在，锁屏暂停的投屏不再恢复')
        return
      }
      this.startForwardStream(paused.peerId, STREAM_SOURCE_VIRTUAL_DISPLAY, { ...ext.virtualScreen }, paused.scaleWidth)
    } else {
      const active = this.inputCoordinator?.activeSession
      if (!active || active.peerId !== paused.peerId) {
        log.info('[screen-stream] 解锁后键鼠会话已不在，锁屏暂停的投屏不再恢复')
        return
      }
      this.startForwardStream(paused.peerId, 'screen', paused.region, paused.scaleWidth, paused.regionArgs)
    }
    log.info(`[screen-stream] 解锁后正向投屏已恢复（${paused.peerId}）`)
  }

  requestReverseScreenStream(
    peerId: string,
    scaleWidth = 1920
  ): { ok: true } | { ok: false; error: string } {
    if (!this.started) return { ok: false, error: '主机未启动' }
    if (!this.peers.has(peerId)) return { ok: false, error: '设备不在线' }
    if (!this.trust.isKnown(peerId)) return { ok: false, error: '设备未配对' }
    if (!this.opts.screenFfmpegPath) return { ok: false, error: '本机缺少 ffmpeg，无法解码' }
    if (this.reverseStreamPeerId && this.reverseStreamPeerId !== peerId) {
      return { ok: false, error: '已有反向投屏在跑' }
    }
    const width = STREAM_QUALITY_PRESETS.some((p) => p.width === scaleWidth) ? scaleWidth : 1920
    // 同对端同分辨率重复请求：直接重发（对端幂等回 start）
    this.lastReverseStreamEndReason = null
    this.reverseStreamPeerId = peerId
    this.reverseStreamScaleWidth = width
    this.reverseStreamReconnectAttempt = 0
    this.clearReverseStreamReconnectTimer()
    this.peers.get(peerId)?.send('screen.stream.request', { scaleWidth: width })
    log.info(`[screen-stream] 反向投屏请求已发 → ${peerId}（${width}p）`)
    this.emit('reverseStreamChanged')
    return { ok: true }
  }

  /** UI（W7）：停止看反向投屏（关窗口即调这里）。幂等 */
  stopReverseScreenStream(peerId?: string): void {
    const target = peerId ?? this.reverseStreamPeerId
    if (!target) return
    this.clearReverseStreamReconnectTimer()
    this.peers.get(target)?.send('screen.stream.stop', { direction: STREAM_DIRECTION_REVERSE })
    if (this.reverseStreamPeerId === target) this.stopReverseReceiver('本机停止反向投屏', true)
  }

  /** UI（W7）：反向投屏当前状态（对端、分辨率、接收端统计） */
  reverseStreamStatus(): { peerId: string | null; scaleWidth: number; receiver: ReverseStreamStatus } {
    return {
      peerId: this.reverseStreamPeerId,
      scaleWidth: this.reverseStreamScaleWidth,
      receiver: this.reverseStreamReceiver.status()
    }
  }

  /**
   * 反向窗口的键鼠控制（线 2 W7）：以流尺寸为声明屏幕发起 input 会话。
   * 与 requestInputControl 的区别只在屏幕尺寸——后者声明本机虚拟屏，
   * 是线 1 边缘穿越的口径；反向窗口的控制面就是流画面，必须声明流尺寸，
   * 否则平板按虚拟屏比例映射会把落点缩错。
   * 同一时刻只允许一个控制会话（InputController 的唯一会话规则）；
   * 已在控制同一对端 / 已有同对端请求待确认时直接返回成功，不重发。
   * 返回的 ok 只表示「请求已发出、等平板确认」，最终结果走 inputChanged。
   */
  requestInputControlWithScreen(
    peerId: string,
    screen: ScreenSize
  ): { ok: true } | { ok: false; error: string } {
    if (!this.started) return { ok: false, error: '主机未启动' }
    if (!this.inputController) return { ok: false, error: '主机未启动' }
    if (!this.peers.has(peerId)) return { ok: false, error: '设备不在线' }
    if (!this.trust.isKnown(peerId)) return { ok: false, error: '设备未配对' }
    if (!Number.isFinite(screen.w) || !Number.isFinite(screen.h) || screen.w < 1 || screen.h < 1) {
      return { ok: false, error: '画面尺寸未知' }
    }
    if (this.inputController.controlling === peerId) return { ok: true }
    if (this.inputController.controlling !== null) return { ok: false, error: '已有键鼠共享会话进行中' }
    if (this.reverseInputRequested?.peerId === peerId) return { ok: true }
    if (this.inputController.hasPendingRequest) return { ok: false, error: '已有控制请求等待确认' }
    this.reverseInputRequested = { peerId, screen: { w: Math.round(screen.w), h: Math.round(screen.h) } }
    this.reverseInputError = null
    void this.inputController
      .request(peerId, { w: Math.round(screen.w), h: Math.round(screen.h) }, this.displayName)
      .then((r) => {
        if (!r.ok && this.reverseInputRequested?.peerId === peerId) {
          this.reverseInputRequested = null
          this.reverseInputError = { peerId, message: r.error }
        }
        this.emit('inputChanged')
      })
    return { ok: true }
  }

  /** 最近一次反向流非用户主动结束的原因，主窗口提示用；无则为 null */
  reverseStreamEndReason(): string | null {
    return this.lastReverseStreamEndReason
  }

  /** 反向窗口输入映射的目标尺寸（input 会话声明的流尺寸），未建立时为 null */
  reverseInputScreen(): ScreenSize | null {
    return this.reverseInputRequested ? { ...this.reverseInputRequested.screen } : null
  }

  /** 反向窗口的键鼠会话状态（窗口状态行 + 重试按钮用）。
   * 按声明/错误本身推导，不依赖流状态——无头测试不跑流也能断言。 */
  reverseInputStatus(): {
    state: 'none' | 'pending' | 'active' | 'failed'
    peerId: string | null
    screen: ScreenSize | null
    error: string | null
  } {
    if (this.reverseInputRequested) {
      const { peerId, screen } = this.reverseInputRequested
      if (this.inputController?.controlling === peerId) {
        return { state: 'active', peerId, screen: { ...screen }, error: null }
      }
      return { state: 'pending', peerId, screen: { ...screen }, error: null }
    }
    if (this.reverseInputError) {
      return { state: 'failed', peerId: this.reverseInputError.peerId, screen: null, error: this.reverseInputError.message }
    }
    return { state: 'none', peerId: this.reverseStreamPeerId, screen: null, error: null }
  }

  /** 停接收端并清反向流状态（不断连接、不重连） */
  private stopReverseReceiver(reason: string, userInitiated = false): void {
    this.reverseStreamReceiver.stop()
    this.reverseStreamPeerId = null
    if (!userInitiated) this.lastReverseStreamEndReason = reason
    // 流停了，依附它的键鼠会话也停：窗口随之关闭，无屏可控；不断连接
    if (this.reverseInputRequested) {
      const peerId = this.reverseInputRequested.peerId
      this.reverseInputRequested = null
      this.reverseInputError = null
      if (this.inputController?.controlling === peerId) this.inputController.stop('reverse stream ended')
    }
    log.info(`[screen-stream] 反向投屏已停：${reason}`)
    this.emit('reverseStreamChanged')
  }

  private clearReverseStreamReconnectTimer(): void {
    if (this.reverseStreamReconnectTimer) clearTimeout(this.reverseStreamReconnectTimer)
    this.reverseStreamReconnectTimer = null
  }

  /**
   * 反向投屏断线重连：退避 5/10/20/30s×4（线 1 同口径），每次等对端
   * 重新连入（peers 表里出现）后再重发 screen.stream.request；4 次
   * 未成功即停手，清状态交给用户手动重试。重发后若对端回 start，
   * start 处理里清 attempt 计数；若对端回 error，error 处理停流。
   * 若重发后既无 start 又无 error（平板用户 30s 未确认），平板侧
   * pending 超时后会回 error，桌面随之停流——等待是有界的。
   */
  private scheduleReverseStreamReconnect(peerId: string, scaleWidth: number): void {
    this.clearReverseStreamReconnectTimer()
    this.reverseStreamReconnectAttempt = 0
    const attempt = (): void => {
      if (this.reverseStreamPeerId !== peerId) return
      if (this.reverseStreamReconnectAttempt >= STREAM_RECONNECT_BACKOFFS_MS.length) {
        log.warn('[screen-stream] 反向投屏自动重连放弃（4 次未成功），等待用户手动重试')
        this.stopReverseReceiver('自动重连 4 次未成功')
        return
      }
      const backoff = STREAM_RECONNECT_BACKOFFS_MS[this.reverseStreamReconnectAttempt] ?? 5000
      this.reverseStreamReconnectAttempt++
      this.reverseStreamReconnectTimer = setTimeout(() => {
        if (this.reverseStreamPeerId !== peerId) return
        if (!this.peers.has(peerId)) {
          log.warn(`[screen-stream] 反向投屏重连第 ${this.reverseStreamReconnectAttempt} 次：对端未重新连入，稍后再试`)
          attempt()
          return
        }
        log.info(`[screen-stream] 反向投屏重连第 ${this.reverseStreamReconnectAttempt} 次：重发请求`)
        this.peers.get(peerId)?.send('screen.stream.request', { scaleWidth })
      }, backoff)
    }
    log.info('[screen-stream] 反向投屏连接断开，5s 后开始自动重连（最多 4 次）')
    attempt()
  }

  /** Electron main 里的本机屏幕尺寸。无头环境回退到常见默认值 */
  private defaultLocalScreen(): ScreenSize {
    try {
      const { screen } = require('electron') as {
        screen?: { getPrimaryDisplay: () => { size: { width: number; height: number } } }
      }
      if (screen && typeof screen.getPrimaryDisplay === 'function') {
        const d = screen.getPrimaryDisplay()
        if (d?.size?.width > 0 && d?.size?.height > 0) {
          return { w: d.size.width, h: d.size.height }
        }
      }
    } catch {
      /* 打包后的无头测试里 electron 解析为路径字符串，走回退值 */
    }
    return { w: 1920, h: 1080 }
  }

  /** 键鼠共享布局存储：设备位于本机哪一侧（7.3） */
  get inputLayoutStore(): InputLayoutStore {
    return this.inputLayout
  }

  /** 被控端：待确认的控制请求 */
  pendingInputRequest(): InputControlRequest | null {
    return this.inputCoordinator?.pendingRequest ?? null
  }

  /** 被控端：本机正被谁控制（peerId） */
  controlledByPeer(): string | null {
    return this.inputCoordinator?.controlledBy ?? null
  }

  /** 控制端：本机正在控制谁（peerId） */
  controllingPeer(): string | null {
    return this.inputController?.controlling ?? null
  }

  /** 被控端：待确认的扩展屏请求（线 3） */
  pendingExtendRequest(): ExtendControlRequest | null {
    return this.extendCoordinator?.pendingRequest ?? null
  }

  /** 被控端：本机正把扩展屏给谁（peerId，线 3） */
  extendedForPeer(): string | null {
    return this.extendCoordinator?.extendedFor ?? null
  }

  /** 控制端：本机正在扩展到谁（peerId，线 3） */
  extendingToPeer(): string | null {
    return this.extendController?.extendingTo ?? null
  }

  /** UI（控制端）：请求控制对端。对端必须已连接且已配对 */
  async requestInputControl(
    peerId: string
  ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    if (!this.inputController) return { ok: false, error: '主机未启动' }
    if (!this.peers.has(peerId)) return { ok: false, error: '设备不在线' }
    if (!this.trust.isKnown(peerId)) return { ok: false, error: '设备未配对' }
    return this.inputController.request(peerId, this.opts.inputLocalScreen?.() ?? this.defaultLocalScreen(), this.displayName)
  }

  /** UI（控制端）：本机主动退出控制（7.4 快捷键也走这里）。幂等 */
  stopInputControl(reason = 'stopped by user'): void {
    this.inputController?.stop(reason)
  }

  /** UI（被控端）：同意控制请求。可选设置免二次确认有效期（毫秒，-1 永久） */
  approveInputControl(sessionId: string, durationMs?: number): { ok: boolean; error?: string } {
    const pendingPeerId = this.inputCoordinator?.pendingRequest?.peerId
    const res = this.inputCoordinator?.approve(sessionId) ?? { ok: false, error: '主机未启动' }
    if (res.ok) {
      this.opts.inputWakeDisplay?.()
      if (pendingPeerId && typeof durationMs === 'number' && (durationMs === -1 || durationMs > 0)) {
        this.trust.setNoConfirmDuration(pendingPeerId, durationMs)
        const entry = this.trust.list().find((e) => e.deviceId === pendingPeerId)
        if (entry) this.emit('paired', entry)
      }
    }
    return res
  }

  /** 设置或清除指定已信任设备的免确认控制有效期 */
  setNoConfirmDuration(deviceId: string, durationMs: number): boolean {
    const ok = this.trust.setNoConfirmDuration(deviceId, durationMs)
    if (ok) {
      const entry = this.trust.list().find((e) => e.deviceId === deviceId)
      if (entry) this.emit('paired', entry)
    }
    return ok
  }

  /** UI（被控端）：拒绝控制请求 */
  denyInputControl(sessionId: string, reason = 'denied by user'): void {
    this.inputCoordinator?.deny(sessionId, reason)
  }

  /** UI（被控端）：随时拔掉正在进行的控制 */
  terminateInputControl(): void {
    this.inputCoordinator?.terminate()
  }

  /**
   * UI（控制端，线 3）：本机请求把对端用作扩展屏。返回的 ok 只表示
   * 「请求已发出、等对端确认」，最终结果走 extendChanged。
   * 与 input 会话独立：已有 input 会话不影响扩展请求，反之亦然。
   */
  requestExtendControl(
    peerId: string,
    preferred: ExtendPreferredSize | null = null,
    scaleWidth = 1920
  ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    if (!this.extendController) return Promise.resolve({ ok: false, error: '主机未启动' })
    if (!this.peers.has(peerId)) return Promise.resolve({ ok: false, error: '设备不在线' })
    if (!this.trust.isKnown(peerId)) return Promise.resolve({ ok: false, error: '设备未配对' })
    return this.extendController.request(peerId, preferred, scaleWidth, this.displayName)
  }

  /** UI（控制端）：本机主动收起扩展屏。幂等 */
  stopExtendControl(reason = 'stopped by user'): void {
    this.extendController?.stop(reason)
  }

  /** UI（被控端）：同意扩展屏请求。同意即创建虚拟显示器，失败不建会话 */
  async approveExtendControl(sessionId: string, durationMs?: number): Promise<{ ok: boolean; error?: string }> {
    const pendingPeerId = this.extendCoordinator?.pendingRequest?.peerId
    const res = await (this.extendCoordinator?.approve(sessionId) ?? Promise.resolve({ ok: false, error: '主机未启动' }))
    if (res.ok) {
      this.opts.inputWakeDisplay?.()
      if (pendingPeerId && typeof durationMs === 'number' && (durationMs === -1 || durationMs > 0)) {
        this.trust.setNoConfirmDuration(pendingPeerId, durationMs)
        const entry = this.trust.list().find((e) => e.deviceId === pendingPeerId)
        if (entry) this.emit('paired', entry)
      }
    }
    return res
  }

  /** UI（被控端）：拒绝扩展屏请求 */
  denyExtendControl(sessionId: string, reason = 'denied by user'): void {
    this.extendCoordinator?.deny(sessionId, reason)
  }

  /** UI（被控端）：随时收回正在提供的扩展屏（虚拟显示器随之销毁） */
  terminateExtendControl(): void {
    this.extendCoordinator?.terminate()
  }

  /** 扩展屏会话状态（UI 状态行用）：活动会话的对端与虚拟显示器矩形 */
  extendStatus(): {
    state: 'none' | 'pending' | 'active'
    peerId: string | null
    virtualScreen: { x: number; y: number; w: number; h: number } | null
  } {
    const active = this.extendCoordinator?.activeSession
    if (active) return { state: 'active', peerId: active.peerId, virtualScreen: { ...active.virtualScreen } }
    const pending = this.extendCoordinator?.pendingRequest
    if (pending) return { state: 'pending', peerId: pending.peerId, virtualScreen: null }
    return { state: 'none', peerId: null, virtualScreen: null }
  }

  /** 控制端事件外发（采集层调用）。非活动会话时是安全空操作 */
  sendInputEvents(events: InputEvent[]): void {
    this.inputController?.sendEvents(events)
  }

  /** 文本直通（协议 4.9，B2）：成品文本分段发给平板。只在反向控制会话中发送 */
  sendInputText(peerId: string, text: string): { ok: true } | { ok: false; error: string } {
    if (!this.inputController || this.inputController.controlling !== peerId) {
      return { ok: false, error: '键鼠控制尚未建立：请等平板确认控制后再操作' }
    }
    this.inputController.sendText(text)
    return { ok: true }
  }

  /** 粘贴回退（协议 4.8，C）：桌面→平板方向，发送前调用方须提示将覆盖平板剪贴板 */
  sendScreenPasteToTablet(peerId: string, text: string): { ok: true } | { ok: false; error: string } {
    if (!this.inputController || this.inputController.controlling !== peerId) {
      return { ok: false, error: '键鼠控制尚未建立：请等平板确认控制后再操作' }
    }
    if (Buffer.byteLength(text, 'utf8') > 512 * 1024) {
      return { ok: false, error: '粘贴内容超过 512 KiB 上限' }
    }
    this.inputController.sendPaste(text)
    return { ok: true }
  }

  async stop(): Promise<void> {
    // 键鼠会话先于通道关闭收尾：让对端收到明确的 session.stop
    // 而不是等心跳超时，本机的按住状态也一并抬起
    this.inputController?.stop('app shutdown')
    this.inputCoordinator?.terminate()
    // 扩展屏会话同样先收尾：虚拟显示器随之销毁，不留残留设备
    this.extendController?.stop('app shutdown')
    this.extendCoordinator?.terminate()
    if (this.pendingExtendDestroy) {
      await this.pendingExtendDestroy
    }
    this.screenStream.stop()
    this.clearForwardStreamState()
    this.reverseStreamReceiver.stop()
    this.reverseStreamPeerId = null
    this.stopForwardStream()
    this.clipboardSync?.stop()
    this.discovery?.stop()
    this.control?.stop()
    this.fileServer?.server.close()
    this.started = false
  }
}
