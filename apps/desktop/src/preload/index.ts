// preload 桥：渲染进程访问主进程能力的唯一入口。
//
// 只暴露 src/shared/types.ts 中 LinkSpaceApi 声明的方法，
// 不暴露 ipcRenderer 本身，避免 renderer 任意调用 channel。

import { contextBridge, ipcRenderer } from 'electron'
import type {
  DeviceBindingView,
  DeviceEdge,
  DeviceView,
  DiscoveredDevice,
  EnvInfo,
  IpcResult,
  InputStateView,
  LinkSpaceApi,
  PendingPairingView,
  ReverseStreamFrameView,
  ReverseStreamStatusView,
  ReverseWindowInput,
  SessionView,
  StartOptions,
  TransferInfo,
  TransferTaskView,
  TrustedDevice,
  Unsubscribe
} from '../shared/types'

function subscribe(channel: string, cb: () => void): Unsubscribe {
  const listener = () => cb()
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/** 带数据的推送订阅（反向投屏的帧与状态快照） */
function subscribeData<T>(channel: string, cb: (data: T) => void): Unsubscribe {
  const listener = (_e: unknown, data: T) => cb(data)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: LinkSpaceApi = {
  listDevices: () => ipcRenderer.invoke('devices:list') as Promise<DeviceView[]>,

  refreshDevices: () => ipcRenderer.invoke('devices:refresh') as Promise<IpcResult<DeviceView[]>>,

  startMirror: (serial: string, opts?: StartOptions) =>
    ipcRenderer.invoke('scrcpy:startFor', serial, opts ?? {}) as Promise<IpcResult<SessionView>>,

  stopMirror: (id: string) => ipcRenderer.invoke('scrcpy:stopFor', id) as Promise<IpcResult<void>>,

  listSessions: () => ipcRenderer.invoke('scrcpy:sessions') as Promise<SessionView[]>,

  listBindings: () => ipcRenderer.invoke('devices:bindings') as Promise<DeviceBindingView[]>,

  bindDevice: (serial: string, deviceId: string) =>
    ipcRenderer.invoke('devices:bind', serial, deviceId) as Promise<IpcResult<void>>,

  unbindDevice: (serial: string) =>
    ipcRenderer.invoke('devices:unbind', serial) as Promise<IpcResult<void>>,

  envInfo: () => ipcRenderer.invoke('env:info') as Promise<EnvInfo>,

  listTransfers: () => ipcRenderer.invoke('transfer:list') as Promise<TransferTaskView[]>,

  acceptTransfer: (id: string) =>
    ipcRenderer.invoke('transfer:accept', id) as Promise<IpcResult<string | null>>,

  cancelTransfer: (id: string) =>
    ipcRenderer.invoke('transfer:cancelFor', id) as Promise<IpcResult<void>>,

  transferInfo: () => ipcRenderer.invoke('transfer:info') as Promise<TransferInfo>,

  listDiscovered: () => ipcRenderer.invoke('discovery:list') as Promise<DiscoveredDevice[]>,

  connectAndPair: (serviceName: string) =>
    ipcRenderer.invoke('discovery:connect', serviceName) as Promise<IpcResult<void>>,

  listPendingPairings: () =>
    ipcRenderer.invoke('pairing:list') as Promise<PendingPairingView[]>,

  rejectPairing: (id: string) =>
    ipcRenderer.invoke('pairing:reject', id) as Promise<IpcResult<void>>,

  submitPairingCode: (serviceName: string, code: string) =>
    ipcRenderer.invoke('pairing:submitCode', serviceName, code) as Promise<IpcResult<void>>,

  listTrusted: () => ipcRenderer.invoke('trust:list') as Promise<TrustedDevice[]>,

  revokeTrust: (deviceId: string) =>
    ipcRenderer.invoke('trust:revoke', deviceId) as Promise<IpcResult<void>>,

  pickAndOffer: (peerId: string) =>
    ipcRenderer.invoke('transfer:pickAndOffer', peerId) as Promise<
      IpcResult<TransferTaskView | null>
    >,

  getDeviceLayout: () => ipcRenderer.invoke('layout:get') as Promise<string[]>,

  saveDeviceLayout: (order: string[]) =>
    ipcRenderer.invoke('layout:save', order) as Promise<IpcResult<void>>,

  selfDisplayName: () => ipcRenderer.invoke('profile:get') as Promise<string>,

  renameSelf: (name: string) =>
    ipcRenderer.invoke('profile:rename', name) as Promise<IpcResult<string>>,

  clipboardEnabled: () => ipcRenderer.invoke('clipboard:get') as Promise<boolean>,

  setClipboardEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('clipboard:setEnabled', enabled) as Promise<IpcResult<boolean>>,

  inputState: () => ipcRenderer.invoke('input:state') as Promise<InputStateView>,

  requestInputControl: (peerId: string) =>
    ipcRenderer.invoke('input:request', peerId) as Promise<IpcResult<void>>,

  approveInputControl: (sessionId: string) =>
    ipcRenderer.invoke('input:approve', sessionId) as Promise<IpcResult<void>>,

  denyInputControl: (sessionId: string) =>
    ipcRenderer.invoke('input:deny', sessionId) as Promise<IpcResult<void>>,

  terminateInputControl: () =>
    ipcRenderer.invoke('input:terminate') as Promise<IpcResult<void>>,

  exitInputControl: () => ipcRenderer.invoke('input:exit') as Promise<IpcResult<void>>,

  setDeviceEdge: (deviceId: string, edge: DeviceEdge | null) =>
    ipcRenderer.invoke('input:setEdge', deviceId, edge) as Promise<IpcResult<void>>,

  // ---------- 反向投屏：平板画面窗口（线 2 W7，2.3-2） ----------

  requestReverseControl: (peerId: string, scaleWidth?: number) =>
    ipcRenderer.invoke('reverse-control:start', peerId, scaleWidth) as Promise<IpcResult<void>>,

  reverseStreamStatus: () =>
    ipcRenderer.invoke('reverse-stream:status') as Promise<ReverseStreamStatusView>,

  setReverseStreamQuality: (peerId: string, width: number) =>
    ipcRenderer.invoke('reverse-stream:setQuality', peerId, width) as Promise<IpcResult<void>>,

  stopReverseControl: (peerId?: string) =>
    ipcRenderer.invoke('reverse-stream:stop', peerId) as Promise<IpcResult<void>>,

  retryReverseInput: (peerId: string) =>
    ipcRenderer.invoke('reverse-stream:retryInput', peerId) as Promise<IpcResult<void>>,

  sendReverseInput: (input: ReverseWindowInput) =>
    ipcRenderer.invoke('reverse-stream:input', input) as Promise<IpcResult<void>>,

  sendReverseText: (peerId: string, text: string) =>
    ipcRenderer.invoke('reverse-stream:text', peerId, text) as Promise<IpcResult<void>>,

  sendReversePaste: (peerId: string, text: string) =>
    ipcRenderer.invoke('reverse-stream:paste', peerId, text) as Promise<IpcResult<void>>,

  onReverseStreamFrame: (cb: (frame: ReverseStreamFrameView) => void) =>
    subscribeData<ReverseStreamFrameView>('reverse-stream:frame', cb),

  onReverseStreamChanged: (cb: (status: ReverseStreamStatusView) => void) =>
    subscribeData<ReverseStreamStatusView>('reverse-stream:changed', cb),

  onReverseStreamNotice: (cb: (message: string) => void) =>
    subscribeData<string>('reverse-stream:notice', cb),

  onDevicesChanged: (cb) => subscribe('devices:changed', cb),
  onSessionsChanged: (cb) => subscribe('sessions:changed', cb),
  onTransfersChanged: (cb) => subscribe('transfers:changed', cb),
  onDiscoveredChanged: (cb) => subscribe('discovered:changed', cb),
  onPairingsChanged: (cb) => subscribe('pairings:changed', cb),
  onTrustChanged: (cb) => subscribe('trust:changed', cb),
  onSelfNameChanged: (cb) => subscribe('selfName:changed', cb),
  onInputChanged: (cb) => subscribe('input:changed', cb)
}

contextBridge.exposeInMainWorld('linkspace', api)
