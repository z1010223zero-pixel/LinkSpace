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
}

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
  private readonly transfers = new TransferManager()
  private control: ControlNode | null = null
  private pairing: PairingCoordinator | null = null
  private discovery: Discovery | null = null
  private fileServer: StartedServer | null = null
  private listeners: { [K in keyof HostEvents]?: Listener<K>[] } = {}
  /** 已连接的对端：deviceId → Connection */
  private readonly peers = new Map<string, Connection>()
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
    this.trust = new TrustStore({
      dir: opts.dataDir ?? app.getPath('userData'),
      defaultScope: opts.defaultScope ?? ['file']
    })
    this.layout = new LayoutStore({ dir: opts.dataDir ?? app.getPath('userData') })
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
    this.control.startHeartbeat((conn) => {
      log.warn(`对端 ${conn.peerId || '(未知)'} 心跳超时，判定离线`)
      this.peers.delete(conn.peerId)
    })
    this.control.onClosed((conn) => {
      if (conn.peerId) this.peers.delete(conn.peerId)
      this.endpoints.delete(conn.peerId)
      this.pendingEndpoints.delete(conn)
      for (const [name, c] of this.serviceConns) {
        if (c === conn) this.serviceConns.delete(name)
      }
    })
  }

  private startPairing(cert: DeviceCert): void {
    this.pairing = new PairingCoordinator({
      deviceId: this.deviceId,
      displayName: this.opts.displayName,
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
    })

    this.pairing
      .onPairRequested((p) => this.emit('pairRequested', p))
      .onPaired((entry) => {
        this.discovery?.refreshAdvertisement()
        this.emit('paired', entry)
      })
      .onRevoked((deviceId) => {
        this.peers.delete(deviceId)
        this.emit('revoked', deviceId)
      })
  }

  private startDiscovery(port: number): void {
    this.discovery = new Discovery({
      displayName: this.opts.displayName,
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

  /** 发起传输。返回任务，随后由 UI 等对端 accept */
  async offerFiles(peerId: string, files: TransferFile[]): Promise<TransferTask> {
    const conn = this.peers.get(peerId)
    if (!conn) throw new Error(`设备 ${peerId} 未连接`)
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

  async stop(): Promise<void> {
    this.discovery?.stop()
    this.control?.stop()
    this.fileServer?.server.close()
    this.started = false
  }
}
