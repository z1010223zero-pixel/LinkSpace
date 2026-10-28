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

export interface IpcError {
  code: string
  message: string
  retryable: boolean
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }

export type Unsubscribe = () => void

/** preload 暴露给渲染进程的 API 形状 */
export interface LinkSpaceApi {
  listDevices(): Promise<DeviceView[]>
  refreshDevices(): Promise<IpcResult<DeviceView[]>>
  startMirror(serial: string, opts?: StartOptions): Promise<IpcResult<SessionView>>
  stopMirror(id: string): Promise<IpcResult<void>>
  listSessions(): Promise<SessionView[]>
  envInfo(): Promise<EnvInfo>
  onDevicesChanged(cb: () => void): Unsubscribe
  onSessionsChanged(cb: () => void): Unsubscribe
}
