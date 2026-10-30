// LinkSpace 主机：把身份、信任、控制通道、配对、传输、发现组装成一个节点。
//
// 单独一层的理由：这些模块之间有明确的依赖顺序（证书 → 传输服务 → 控制通道
// 挂到同一端口 → 配对 → 发现），散在 index.ts 里会变成一坨难以测试的胶水代码。
// 抽成 Host 之后，无头测试可以用两个 Host 跑完整的「配对 → 传输 → 取消」。
//
// 信任边界只有一道：传输服务的 isKnownDevice 直接读 TrustStore。
// 没有「顺便信任」或「开发期放行」的后门。

import { randomUUID } from 'node:crypto'
import type { Server } from 'node:https'
import { app } from 'electron'
import { getDeviceCert, setIdentityDir, deviceIdOfCert, type DeviceCert } from './transfer/identity'
import { TrustStore, type TrustEntry, type TrustScope } from './transfer/trust'
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
import type { InputEvent, ScreenSize } from './input/protocol'
import { InputLayoutStore } from './input/layout'
import { ScreenStreamService } from './screen-stream'
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
  /** 虚拟屏 bounds（投屏采集范围，物理像素）。与注入 normalizeAbsolute 同基准 */
  inputVirtualScreen?: () => { x: number; y: number; w: number; h: number }
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
  /** 屏幕投屏推流（寄生在键鼠会话内，见 screen-stream.ts） */
  private readonly screenStream = new ScreenStreamService()
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
      this.opts.bind ? { bind: this.opts.bind } : {}
    )
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
        localScreen: () => this.opts.inputLocalScreen?.() ?? this.defaultLocalScreen(),
        inject: (events, session) =>
          this.opts.inputInject
            ? this.opts.inputInject(events, session)
            : log.warn(`收到 ${events.length} 条输入事件，但未接入注入层，已丢弃`),
        releaseAll: () => this.opts.inputReleaseAll?.(),
        send: sendTo,
        log: (msg) => log.info(msg),
        onChanged: () => {
          // 会话结束（active 变 null 的过渡）时投流随之终止：画面是
          // 会话授权的一部分，没有会话就没有画面
          if (!this.inputCoordinator?.activeSession) this.screenStream.stop()
          this.emit('inputChanged')
        },
        onRequest: (req) => this.emit('inputRequested', req)
      }
    })

    this.inputController = new InputController({
      callbacks: {
        send: sendTo,
        log: (msg) => log.info(msg),
        onAccepted: () => this.emit('inputChanged'),
        onEnded: () => this.emit('inputChanged')
      }
    })

    control.on('session.start', (conn, msg) => {
      if (!conn.peerId) return
      this.inputCoordinator!.onStart(conn.peerId, msg.payload)
    })

    control.on('session.accept', (conn, msg) => {
      const p = msg.payload as { sessionId?: unknown; screen?: unknown }
      if (typeof p?.sessionId !== 'string') return
      this.inputController!.onAccepted(conn.peerId, p.sessionId, p.screen)
    })

    control.on('session.reject', (conn, msg) => {
      const p = msg.payload as { sessionId?: unknown; reason?: unknown }
      if (typeof p?.sessionId !== 'string') return
      this.inputController!.onRejected(conn.peerId, p.sessionId, String(p.reason ?? ''))
    })

    control.on('session.stop', (conn, msg) => {
      const p = msg.payload as { sessionId?: unknown }
      if (typeof p?.sessionId !== 'string') return
      // 两端都可能收到 stop：作为控制端收到被控端的终止，
      // 或作为被控端收到控制端的退出（7.4）。各自按 sessionId 匹配，
      // 不匹配的就是别人的会话，安全忽略
      this.inputController!.onStopped(conn.peerId, p.sessionId)
      this.inputCoordinator!.onStop(conn.peerId, msg.payload)
    })

    control.on('input.event', (conn, msg) => {
      if (!conn.peerId) return
      this.inputCoordinator!.onEvent(conn.peerId, msg.payload)
    })

    // ---------- 屏幕投屏（寄生在键鼠会话内，见 screen-stream.ts） ----------
    // 视频块走 WS 二进制帧复用平板连出的控制连接：平板的 ServerSocket
    // 对任何入站端口都不通（ICMP 通、TCP 全拒），唯有平板自己连出的
    // 链路可用（实测），TCP 全双工允许桌面在这个方向发数据
    control.on('screen.stream.request', (conn, _msg) => {
      const peerId = conn.peerId
      if (!peerId) return
      const active = this.inputCoordinator?.activeSession
      if (!active || active.peerId !== peerId) {
        sendTo(peerId, 'screen.stream.error', { message: '投屏需要先建立键鼠会话' })
        return
      }
      if (!this.opts.screenFfmpegPath) {
        sendTo(peerId, 'screen.stream.error', { message: '本机缺少 ffmpeg，无法投屏' })
        return
      }
      try {
        this.screenStream.start(this.opts.screenFfmpegPath, (chunk) => conn.sendBinary(chunk))
        sendTo(peerId, 'screen.stream.start', {
          w: this.opts.inputVirtualScreen?.().w ?? 1920,
          h: this.opts.inputVirtualScreen?.().h ?? 1080
        })
        log.info(`[screen-stream] 已为 ${peerId} 开启投屏`)
      } catch (err) {
        const tail = this.screenStream.lastErrors().join(' | ')
        log.warn(`[screen-stream] 启动失败: ${String(err)} ${tail}`)
        sendTo(peerId, 'screen.stream.error', { message: `投屏启动失败：${String(err)}` })
      }
    })
    control.on('screen.stream.stop', (conn, _msg) => {
      if (!conn.peerId) return
      this.screenStream.stop()
      sendTo(conn.peerId, 'screen.stream.stop', {})
    })
    // ffmpeg 意外退出（平板断开/编码器崩溃）：通知对端清 UI
    this.screenStream.onEnded = () => {
      const peer = this.inputCoordinator?.activeSession?.peerId
      if (peer) sendTo(peer, 'screen.stream.stop', {})
    }

    // 断连清理收口在 handleConnClosed（startControl 注册，带幸存者
    // 检查）。这里曾再注册一份 onClosed 推 onPeerDisconnected——双连接
    // 并存时旧连接迟到的 close 会经这份冗余注册误杀幸存连接上的会话
    // （移交清单 2026-10-30），已并入统一清理

    // 信任撤销优先于一切：立即掐断请求与会话（9.1 的安全兜底）
    this.on('revoked', (deviceId) => {
      this.inputCoordinator?.onTrustRevoked(deviceId)
      this.inputController?.onPeerDisconnected(deviceId)
      this.emit('inputChanged')
    })
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

  /** UI（被控端）：同意控制请求。会话建立后 control 授权仅在本会话内有效 */
  approveInputControl(sessionId: string): { ok: boolean; error?: string } {
    return this.inputCoordinator?.approve(sessionId) ?? { ok: false, error: '主机未启动' }
  }

  /** UI（被控端）：拒绝控制请求 */
  denyInputControl(sessionId: string, reason = 'denied by user'): void {
    this.inputCoordinator?.deny(sessionId, reason)
  }

  /** UI（被控端）：随时拔掉正在进行的控制 */
  terminateInputControl(): void {
    this.inputCoordinator?.terminate()
  }

  /** 控制端事件外发（采集层调用）。非活动会话时是安全空操作 */
  sendInputEvents(events: InputEvent[]): void {
    this.inputController?.sendEvents(events)
  }

  async stop(): Promise<void> {
    // 键鼠会话先于通道关闭收尾：让对端收到明确的 session.stop
    // 而不是等心跳超时，本机的按住状态也一并抬起
    this.inputController?.stop('app shutdown')
    this.inputCoordinator?.terminate()
    this.clipboardSync?.stop()
    this.discovery?.stop()
    this.control?.stop()
    this.fileServer?.server.close()
    this.started = false
  }
}
