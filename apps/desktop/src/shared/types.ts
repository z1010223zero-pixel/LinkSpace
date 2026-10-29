// 主进程与渲染进程共享的类型契约。
// 渲染层只应依赖本文件，不直接 import main/ 下的实现。

export type AdbState = 'device' | 'offline' | 'unauthorized' | 'unknown'

export type SessionState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

export interface SessionView {
  id: string
  serial: string
  state: SessionState
  startedAt: number
  stoppedAt?: number
  exitCode?: number | null
  error?: {
    code: string
    message: string
    retryable: boolean
  }
}

export interface DeviceView {
  serial: string
  model?: string
  state: AdbState
  wireless: boolean
  /** 该设备上处于活跃状态的会话 */
  activeSessions: SessionView[]
}

export interface StartOptions {
  maxSize?: number
  windowTitle?: string
  windowX?: number
  windowY?: number
  windowWidth?: number
  showTouches?: boolean
  stayAwake?: boolean
  /** 无窗口模式：不显示画面，仅采集。用于自动化测试与后台录制 */
  noWindow?: boolean
}

export interface EnvInfo {
  scrcpyPath: string
  adbPath: string
  scrcpySource: 'env' | 'resources' | 'path' | 'winget'
  ready: boolean
}

// ---------- 文件传输 ----------

export type TransferState =
  | 'waiting' // 对端离线，任务挂起等待其上线
  | 'offered' // 已发起，等待对端确认
  | 'accepted' // 对端已接受，准备/正在传输
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface TransferFileView {
  name: string
  size: number
  savePath?: string
}

export interface TransferTaskView {
  id: string
  direction: 'send' | 'receive'
  peerId: string
  state: TransferState
  files: TransferFileView[]
  totalSize: number
  transferred: number
  createdAt: number
  finishedAt?: number
  error?: string
}

export interface TransferInfo {
  /** 本机传输服务监听端口，0 表示未启动 */
  port: number
  /** 本机身份证书指纹，配对时供用户人工核对 */
  fingerprint: string
  deviceId: string
}

// ---------- 发现与配对 ----------

export interface DiscoveredDevice {
  serviceName: string
  idPrefix: string
  displayName: string
  deviceType: 'win' | 'android-phone' | 'android-tablet'
  caps: string[]
  host: string
  port: number
  paired: boolean
}

export interface PendingPairingView {
  id: string
  peerId: string
  displayName: string
  deviceType: string
  /** 6 位配对码，只应显示在接收方界面上 */
  code: string
  expiresAt: number
}

export interface TrustedDevice {
  deviceId: string
  displayName: string
  deviceType: string
  fingerprint: string
  scope: string[]
  trustedAt: number
}

export interface IpcError {
  code: string
  message: string
  retryable: boolean
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }

export type Unsubscribe = () => void

// ---------- 键鼠共享（阶段 3） ----------

/** 设备在本机的哪一侧（7.3）。null 表示未参与键鼠共享 */
export type DeviceEdge = 'left' | 'right' | 'top' | 'bottom'

/** 被控端待确认的控制请求（9.1：每次控制请求都有明确提示） */
export interface InputRequestView {
  sessionId: string
  peerId: string
  displayName: string
  expiresAt: number
}

export interface InputStateView {
  /** 被控端：待确认的请求 */
  pending: InputRequestView | null
  /** 本机正被谁控制（显示名），无人控制时为 null */
  controlledBy: string | null
  /** 本机正在控制谁（显示名），未控制时为 null */
  controlling: string | null
  /** 设备方位布局（deviceId → 边），驱动边缘穿越 */
  layout: Record<string, DeviceEdge>
  /** Win32 注入层是否可用（不可用时入口降级提示） */
  nativeReady: boolean
}

/** preload 暴露给渲染进程的 API 形状 */
export interface LinkSpaceApi {
  listDevices(): Promise<DeviceView[]>
  refreshDevices(): Promise<IpcResult<DeviceView[]>>
  startMirror(serial: string, opts?: StartOptions): Promise<IpcResult<SessionView>>
  stopMirror(id: string): Promise<IpcResult<void>>
  listSessions(): Promise<SessionView[]>
  envInfo(): Promise<EnvInfo>
  listTransfers(): Promise<TransferTaskView[]>
  /** 接收方：弹目录选择框并接受传输，value 为所选目录（取消时为 null） */
  acceptTransfer(id: string): Promise<IpcResult<string | null>>
  cancelTransfer(id: string): Promise<IpcResult<void>>
  transferInfo(): Promise<TransferInfo>
  listDiscovered(): Promise<DiscoveredDevice[]>
  connectAndPair(serviceName: string): Promise<IpcResult<void>>
  listPendingPairings(): Promise<PendingPairingView[]>
  rejectPairing(id: string): Promise<IpcResult<void>>
  submitPairingCode(serviceName: string, code: string): Promise<IpcResult<void>>
  listTrusted(): Promise<TrustedDevice[]>
  revokeTrust(deviceId: string): Promise<IpcResult<void>>
  pickAndOffer(peerId: string): Promise<IpcResult<TransferTaskView | null>>
  /** 持久化的设备卡片顺序，未知设备追加在末尾 */
  getDeviceLayout(): Promise<string[]>
  /** 保存设备卡片顺序，应传入完整列表 */
  saveDeviceLayout(order: string[]): Promise<IpcResult<void>>
  /** 本机显示名（对端看到的名字） */
  selfDisplayName(): Promise<string>
  /** 修改本机显示名，改名会经 device.rename 同步到已连接的对端 */
  renameSelf(name: string): Promise<IpcResult<string>>
  /** 剪贴板同步开关（6.6）。关闭后收发双向静默，不产生任何流量 */
  clipboardEnabled(): Promise<boolean>
  setClipboardEnabled(enabled: boolean): Promise<IpcResult<boolean>>
  /** 键鼠共享状态快照（9.1） */
  inputState(): Promise<InputStateView>
  /** 请求控制对端键鼠（对端会收到确认弹窗） */
  requestInputControl(peerId: string): Promise<IpcResult<void>>
  /** 被控端：同意控制请求。授权仅本会话内有效 */
  approveInputControl(sessionId: string): Promise<IpcResult<void>>
  /** 被控端：拒绝控制请求 */
  denyInputControl(sessionId: string): Promise<IpcResult<void>>
  /** 被控端：随时拔掉正在进行的控制 */
  terminateInputControl(): Promise<IpcResult<void>>
  /** 控制端：退出当前控制会话（7.4，快捷键也走这里） */
  exitInputControl(): Promise<IpcResult<void>>
  /** 设置设备位于本机哪一侧（7.3），null 清除 */
  setDeviceEdge(deviceId: string, edge: DeviceEdge | null): Promise<IpcResult<void>>
  onDevicesChanged(cb: () => void): Unsubscribe
  onSessionsChanged(cb: () => void): Unsubscribe
  onTransfersChanged(cb: () => void): Unsubscribe
  onDiscoveredChanged(cb: () => void): Unsubscribe
  onPairingsChanged(cb: () => void): Unsubscribe
  /** 对端改名导致信任清单变化 */
  onTrustChanged(cb: () => void): Unsubscribe
  /** 本机显示名变化（含其他窗口/路径触发的改名） */
  onSelfNameChanged(cb: () => void): Unsubscribe
  /** 键鼠共享状态变化（请求到达/确认/结束） */
  onInputChanged(cb: () => void): Unsubscribe
}
