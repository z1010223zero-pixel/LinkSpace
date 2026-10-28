// IPC 网关。
//
// 渲染进程与主进程之间唯一的通信入口。所有 channel 在此白名单登记，
// 未登记的 channel 一律拒绝——避免 renderer 被注入后直接触达系统能力。

import { ipcMain, BrowserWindow } from 'electron'
import { DeviceManager } from './device-manager'
import { ScrcpyAdapter } from './scrcpy-adapter'
import type { StartOptions } from '../shared/types'
import { locateBinaries } from './platform'
import { TransferManager } from './transfer/manager'
import { getDeviceCert } from './transfer/identity'
import { log } from './log'

export interface EnvInfo {
  scrcpyPath: string
  adbPath: string
  scrcpySource: string
  ready: boolean
}

export interface TransferInfo {
  /** 本机传输服务监听端口，0 表示未启动 */
  port: number
  /** 本机身份证书指纹，配对时供用户人工核对 */
  fingerprint: string
}

const CHANNELS = [
  'devices:list',
  'devices:refresh',
  'scrcpy:startFor',
  'scrcpy:stopFor',
  'scrcpy:sessions',
  'transfer:list',
  'transfer:cancelFor',
  'transfer:info',
  'env:info',
  'ping'
] as const

const EVENTS = ['devices:changed', 'sessions:changed', 'transfers:changed'] as const

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  devices: DeviceManager,
  adapter: ScrcpyAdapter,
  transfers: TransferManager,
  getTransferPort: () => number
): void {
  const invoke = <T>(channel: string, handler: () => Promise<T> | T): void => {
    ipcMain.handle(channel, async () => {
      try {
        return await handler()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error(`IPC ${channel} 失败: ${msg}`)
        return { ok: false as const, error: { code: 'INTERNAL', message: msg, retryable: false } }
      }
    })
  }

  invoke('devices:list', () => devices.view())
  invoke('devices:refresh', async () => {
    const view = await devices.refresh()
    return { ok: true as const, value: view }
  })

  // 带参数的方法单独注册：通用包装只处理无参调用，参数在此校验
  ipcMain.handle('scrcpy:startFor', async (_e, serial: unknown, opts: unknown) => {
    if (typeof serial !== 'string' || !serial) {
      return { ok: false as const, error: { code: 'INTERNAL', message: '缺少设备序列号', retryable: false } }
    }
    const options = (opts ?? {}) as StartOptions
    const result = await adapter.start(serial, options)
    broadcast(getWindow, 'sessions:changed')
    return result
  })

  ipcMain.handle('scrcpy:stopFor', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) {
      return { ok: false as const, error: { code: 'INTERNAL', message: '缺少会话 ID', retryable: false } }
    }
    const result = await adapter.stop(id)
    broadcast(getWindow, 'sessions:changed')
    return result
  })

  invoke('scrcpy:sessions', () => adapter.list())

  invoke('transfer:list', () => transfers.list())

  invoke('transfer:info', async (): Promise<TransferInfo> => {
    const { fingerprint } = await getDeviceCert()
    return { port: getTransferPort(), fingerprint }
  })

  ipcMain.handle('transfer:cancelFor', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) {
      return { ok: false as const, error: { code: 'INTERNAL', message: '缺少任务 ID', retryable: false } }
    }
    await transfers.cancel(id)
    broadcast(getWindow, 'transfers:changed')
    return { ok: true as const }
  })

  invoke('env:info', (): EnvInfo => {
    const b = locateBinaries()
    return {
      scrcpyPath: b.scrcpy,
      adbPath: b.adb,
      scrcpySource: b.source,
      ready: b.source !== 'winget' || b.scrcpy !== 'scrcpy'
    }
  })

  invoke('ping', () => 'pong')

  // 事件转发
  devices.on('changed', () => broadcast(getWindow, 'devices:changed'))
  adapter.on('changed', () => broadcast(getWindow, 'sessions:changed'))
  transfers.on('changed', () => broadcast(getWindow, 'transfers:changed'))

  log.info(`IPC 已注册：${CHANNELS.length} 个 channel，${EVENTS.length} 类事件`)
}

function broadcast(getWindow: () => BrowserWindow | null, channel: string): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel)
  }
}

/** 供 renderer 侧声明的合法事件名 */
export const RENDERER_EVENTS = EVENTS
export type RendererEvent = (typeof EVENTS)[number]
export type IpcChannel = (typeof CHANNELS)[number]
