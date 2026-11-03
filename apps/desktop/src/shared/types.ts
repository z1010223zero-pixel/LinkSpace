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
  /**
   * 2.5-1 统一设备模型：adb serial 解析到的 LinkSpace 身份。
   * 未解析到已配对设备时 deviceId 为 null、paired/bound/scrcpyAllowed 全假；
   * UI 据此决定「启动投屏」是否可点、是否要先绑定，不再拿两套模型各说各话。
   */
  deviceId: string | null
  /** 是否已配对（信任清单内） */
  paired: boolean
  /** 是否存在用户显式建立的 serial↔deviceId 绑定 */
  bound: boolean
  /** 门禁是否会放行（配对 + 绑定/IP-join 已满足），与 scrcpy:startFor 同口径 */
  scrcpyAllowed: boolean
}

/** 显式绑定条目（serial↔deviceId，USB 投屏前置条件），供屏幕页绑定入口展示 */
export interface DeviceBindingView {
  serial: string
  deviceId: string
  boundAt: number
}

/** 投屏画质档位。高清不压分辨率，代价是 Wi-Fi 下更吃带宽 */
export type QualityPreset = 'sharp' | 'balanced' | 'smooth'

export interface StartOptions {
  maxSize?: number
  /**
   * 画质档位（App.vue 下拉选择）。与 maxSize 的优先级：显式 maxSize 优先，
   * 未指定时由档位决定——sharp 不限制分辨率。
   */
  quality?: QualityPreset
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

// ---------- 反向投屏：平板画面窗口（线 2 W7，2.3-2） ----------

/** 解出的一帧（渲染进程收到的是 Uint8Array，不是 Node Buffer） */
export interface ReverseStreamFrameView {
  width: number
  height: number
  /** RGBA，每像素 4 字节，行优先，长度恒为 width * height * 4 */
  data: Uint8Array
}

export type ReverseInputState = 'none' | 'pending' | 'active' | 'failed'

export interface ReverseStreamStatusView {
  /** 正在看谁的反向投屏，null = 未请求/已结束 */
  peerId: string | null
  displayName: string
  /** 当前分辨率档位（目标宽） */
  scaleWidth: number
  receiver: {
    running: boolean
    width: number
    height: number
    bytesReceived: number
    framesDecoded: number
    keyframeResyncs: number
    droppedBytes: number
    lastError: string | null
  }
  input: {
    state: ReverseInputState
    peerId: string | null
    screen: { w: number; h: number } | null
    error: string | null
  }
  /**
   * Bug 1：画面窗口失焦/最小化时输入暂停（全局采集挂起、IPC 输入被拒）。
   * 恢复焦点后自动解除。线 1 会话没有画面窗口，不受此门限制。
   */
  inputPaused: boolean
  clipboardEnabled: boolean
}

/** 反向窗口发来的单条输入（主进程映射到会话声明的流尺寸后外发） */
export type ReverseWindowInput =
  | { kind: 'move'; x: number; y: number; canvasW: number; canvasH: number }
  | { kind: 'down'; b: 'left' | 'right' | 'middle'; x: number; y: number; canvasW: number; canvasH: number }
  | { kind: 'up'; b: 'left' | 'right' | 'middle'; x: number; y: number; canvasW: number; canvasH: number }
  | { kind: 'wheel'; dx: number; dy: number }
  | { kind: 'key'; vk: number; down: boolean }

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
/** VDD 驱动状态快照（线 3，⑤；见 src/main/extend/vdd-driver.ts） */
export interface VddDriverStatus {
  /** 驱动包是否已在驱动库（mttvdd.inf） */
  installed: boolean
  /** 已装驱动版本（期望 11.30.4.434），未装时 null */
  installedVersion: string | null
  /** 已发布 INF 名（如 oem116.inf），未装时 null */
  oemInf: string | null
  /** 设备节点（按硬件 ID Root\MttVDD 查到）是否启用 */
  deviceEnabled: boolean
  /** 设备节点是否存在 */
  devicePresent: boolean
  /** 按硬件 ID 查到的设备节点实例 ID（如 ROOT\DISPLAY\0001），不存在时 null */
  deviceInstanceId: string | null
  /** 随包的驱动 zip 是否就位 */
  packageBundled: boolean
  /** 当前进程是否有管理员权限 */
  isAdmin: boolean
}

export interface LinkSpaceApi {
  listDevices(): Promise<DeviceView[]>
  refreshDevices(): Promise<IpcResult<DeviceView[]>>
  startMirror(serial: string, opts?: StartOptions): Promise<IpcResult<SessionView>>
  stopMirror(id: string): Promise<IpcResult<void>>
  listSessions(): Promise<SessionView[]>
  /** 显式绑定清单（serial↔deviceId，USB 投屏前置条件） */
  listBindings(): Promise<DeviceBindingView[]>
  /** 把一台 adb 设备绑定到一台已配对设备（deviceId 须已配对） */
  bindDevice(serial: string, deviceId: string): Promise<IpcResult<void>>
  /** 删除一条显式绑定 */
  unbindDevice(serial: string): Promise<IpcResult<void>>
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
  /** VDD 驱动状态快照（线 3，⑤，只读） */
  vddDriverStatus(): Promise<VddDriverStatus>
  /** 安装 VDD 驱动（线 3，⑤，用户显式动作：设置页按钮）。已装且版本符合时直接返回 */
  installVddDriver(): Promise<IpcResult<{ alreadyInstalled: boolean }>>
  /** 反向投屏（线 2 W7）：请求看对端平板画面并打开画面窗口 */
  requestReverseControl(peerId: string, scaleWidth?: number): Promise<IpcResult<void>>
  /** 反向投屏状态快照（画面窗口轮询/推送用） */
  reverseStreamStatus(): Promise<ReverseStreamStatusView>
  /** 换分辨率档位（目标宽，须是 1280/1920/2560/3840 其中一档） */
  setReverseStreamQuality(peerId: string, width: number): Promise<IpcResult<void>>
  /** 关闭画面窗口并结束反向投屏 + 键鼠会话 */
  stopReverseControl(peerId?: string): Promise<IpcResult<void>>
  /** 键鼠会话未建立时手动重试（流尺寸已知时才有效） */
  retryReverseInput(peerId: string): Promise<IpcResult<void>>
  /** 画面窗口的输入事件（主进程映射坐标后走 input.event 外发） */
  sendReverseInput(input: ReverseWindowInput): Promise<IpcResult<void>>
  /** 画面窗口的成品文本（协议 4.9 B2）：主进程分段发 input.text */
  sendReverseText(peerId: string, text: string): Promise<IpcResult<void>>
  /** 画面窗口的粘贴回退（协议 4.8 C）：主进程发 screen.paste */
  sendReversePaste(peerId: string, text: string): Promise<IpcResult<void>>
  /** 反向投屏解出的 RGBA 帧（画面窗口订阅） */
  onReverseStreamFrame(cb: (frame: ReverseStreamFrameView) => void): Unsubscribe
  /** 反向投屏状态变化（画面窗口订阅，收到的是完整快照） */
  onReverseStreamChanged(cb: (status: ReverseStreamStatusView) => void): Unsubscribe
  /** 反向投屏在别处结束且有明确原因（主窗口订阅，显示提示） */
  onReverseStreamNotice(cb: (message: string) => void): Unsubscribe
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
