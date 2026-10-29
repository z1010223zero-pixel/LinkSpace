// preload 桥：渲染进程访问主进程能力的唯一入口。
//
// 只暴露 src/shared/types.ts 中 LinkSpaceApi 声明的方法，
// 不暴露 ipcRenderer 本身，避免 renderer 任意调用 channel。

import { contextBridge, ipcRenderer } from 'electron'
import type {
  DeviceView,
  DiscoveredDevice,
  EnvInfo,
  IpcResult,
  LinkSpaceApi,
  PendingPairingView,
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

const api: LinkSpaceApi = {
  listDevices: () => ipcRenderer.invoke('devices:list') as Promise<DeviceView[]>,

  refreshDevices: () => ipcRenderer.invoke('devices:refresh') as Promise<IpcResult<DeviceView[]>>,

  startMirror: (serial: string, opts?: StartOptions) =>
    ipcRenderer.invoke('scrcpy:startFor', serial, opts ?? {}) as Promise<IpcResult<SessionView>>,

  stopMirror: (id: string) => ipcRenderer.invoke('scrcpy:stopFor', id) as Promise<IpcResult<void>>,

  listSessions: () => ipcRenderer.invoke('scrcpy:sessions') as Promise<SessionView[]>,

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

  onDevicesChanged: (cb) => subscribe('devices:changed', cb),
  onSessionsChanged: (cb) => subscribe('sessions:changed', cb),
  onTransfersChanged: (cb) => subscribe('transfers:changed', cb),
  onDiscoveredChanged: (cb) => subscribe('discovered:changed', cb),
  onPairingsChanged: (cb) => subscribe('pairings:changed', cb),
  onTrustChanged: (cb) => subscribe('trust:changed', cb),
  onSelfNameChanged: (cb) => subscribe('selfName:changed', cb)
}

contextBridge.exposeInMainWorld('linkspace', api)
