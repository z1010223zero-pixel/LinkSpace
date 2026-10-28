// preload 桥：渲染进程访问主进程能力的唯一入口。
//
// 只暴露 src/shared/types.ts 中 LinkSpaceApi 声明的方法，
// 不暴露 ipcRenderer 本身，避免 renderer 任意调用 channel。

import { contextBridge, ipcRenderer } from 'electron'
import type {
  DeviceView,
  EnvInfo,
  IpcResult,
  LinkSpaceApi,
  SessionView,
  StartOptions,
  TransferInfo,
  TransferTaskView,
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

  cancelTransfer: (id: string) =>
    ipcRenderer.invoke('transfer:cancelFor', id) as Promise<IpcResult<void>>,

  transferInfo: () => ipcRenderer.invoke('transfer:info') as Promise<TransferInfo>,

  onDevicesChanged: (cb) => subscribe('devices:changed', cb),
  onSessionsChanged: (cb) => subscribe('sessions:changed', cb),
  onTransfersChanged: (cb) => subscribe('transfers:changed', cb)
}

contextBridge.exposeInMainWorld('linkspace', api)
