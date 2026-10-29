// IPC 网关。
//
// 渲染进程与主进程之间唯一的通信入口。所有 channel 在此白名单登记，
// 未登记的 channel 一律拒绝——避免 renderer 被注入后直接触达系统能力。
//
// 注意：渲染层拿到的都是**快照**（普通对象），不接触 Host、Connection
// 这类活对象。活对象无法结构化克隆，也不该跨进程边界暴露。

import { ipcMain, BrowserWindow, dialog } from 'electron'
import { DeviceManager } from './device-manager'
import { ScrcpyAdapter } from './scrcpy-adapter'
import type { StartOptions } from '../shared/types'
import { locateBinaries } from './platform'
import type { Host } from './host'
import type { DiscoveredService } from './discovery'
import type { PendingPairing } from './pairing'
import type { TransferTask } from './transfer/manager'
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
  /** 本机身份证书指纹，配对时供人工核对 */
  fingerprint: string
  deviceId: string
}

const CHANNELS = [
  'devices:list',
  'devices:refresh',
  'scrcpy:startFor',
  'scrcpy:stopFor',
  'scrcpy:sessions',
  'discovery:list',
  'discovery:connect',
  'pairing:list',
  'pairing:reject',
  'pairing:submitCode',
  'trust:list',
  'trust:revoke',
  'transfer:list',
  'transfer:accept',
  'transfer:acceptFor',
  'transfer:cancelFor',
  'transfer:pickAndOffer',
  'transfer:info',
  'env:info',
  'layout:get',
  'layout:save',
  'profile:get',
  'profile:rename',
  'clipboard:get',
  'clipboard:setEnabled',
  'input:state',
  'input:request',
  'input:approve',
  'input:deny',
  'input:terminate',
  'input:exit',
  'input:setEdge',
  'ping'
] as const

const EVENTS = [
  'devices:changed',
  'sessions:changed',
  'discovered:changed',
  'pairings:changed',
  'transfers:changed',
  'trust:changed',
  'selfName:changed',
  'input:changed'
] as const

/** 渲染层可见的运行时快照来源 */
export interface RuntimeSource {
  discovered: DiscoveredService[]
  pendingPairings: PendingPairing[]
  transfers: TransferTask[]
  /** Win32 注入层是否可用（键鼠共享入口降级提示用） */
  inputNativeReady: boolean
}

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  devices: DeviceManager,
  adapter: ScrcpyAdapter,
  host: Host,
  runtime: RuntimeSource
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

  const fail = (message: string) => ({
    ok: false as const,
    error: { code: 'INTERNAL', message, retryable: false }
  })

  // 设备列表一律按用户保存的顺序返回：adb 的返回顺序不稳定，
  // 不该让用户每次启动重新认一遍设备
  invoke('devices:list', () => host.layoutStore.sort(devices.view(), (d) => d.serial))
  invoke('devices:refresh', async () => {
    const view = await devices.refresh()
    return { ok: true as const, value: host.layoutStore.sort(view, (d) => d.serial) }
  })

  ipcMain.handle('scrcpy:startFor', async (_e, serial: unknown, opts: unknown) => {
    if (typeof serial !== 'string' || !serial) return fail('缺少设备序列号')
    const options = (opts ?? {}) as StartOptions
    const result = await adapter.start(serial, options)
    broadcast(getWindow, 'sessions:changed')
    return result
  })

  ipcMain.handle('scrcpy:stopFor', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('缺少会话 ID')
    const result = await adapter.stop(id)
    broadcast(getWindow, 'sessions:changed')
    return result
  })

  invoke('scrcpy:sessions', () => adapter.list())

  // ---------- 发现与配对 ----------

  invoke('discovery:list', () => runtime.discovered)

  ipcMain.handle('discovery:connect', async (_e, serviceName: unknown) => {
    if (typeof serviceName !== 'string') return fail('缺少服务名')
    const svc = runtime.discovered.find((d) => d.serviceName === serviceName)
    if (!svc) return fail('该设备已不在线')
    try {
      const conn = await host.connect(svc)
      await host.requestPairing(conn)
      return { ok: true as const }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle('pairing:submitCode', async (_e, serviceName: unknown, code: unknown) => {
    if (typeof serviceName !== 'string' || typeof code !== 'string') return fail('参数不完整')
    const conn = host.connectionFor(serviceName)
    if (!conn) return fail('连接不存在，请重新发现设备')
    const result = host.submitCode(conn, code)
    return result.ok ? { ok: true as const } : fail(result.error ?? '提交失败')
  })

  ipcMain.handle('pairing:reject', async (_e, id: unknown) => {
    if (typeof id !== 'string') return fail('缺少配对 ID')
    const p = host.pendingPairings().find((x) => x.id === id)
    if (p) host.rejectPairing(p, '用户拒绝')
    runtime.pendingPairings = host.pendingPairings()
    broadcast(getWindow, 'pairings:changed')
    return { ok: true as const }
  })

  invoke('pairing:list', () => host.pendingPairings())

  invoke('trust:list', () => host.trustedDevices())

  ipcMain.handle('trust:revoke', async (_e, deviceId: unknown) => {
    if (typeof deviceId !== 'string') return fail('缺少设备 ID')
    host.revokeTrust(deviceId)
    broadcast(getWindow, 'pairings:changed')
    return { ok: true as const }
  })

  // ---------- 文件传输 ----------

  invoke('transfer:list', () => host.transferTasks())

  ipcMain.handle('transfer:acceptFor', async (_e, id: unknown, saveDir: unknown) => {
    if (typeof id !== 'string' || typeof saveDir !== 'string') return fail('参数不完整')
    try {
      await host.acceptTransfer(id, saveDir)
      broadcast(getWindow, 'transfers:changed')
      return { ok: true as const }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  // 接收方确认入口：保存目录在主进程里选，渲染层只给任务 id
  ipcMain.handle('transfer:accept', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('缺少任务 ID')
    const win = getWindow()
    if (!win) return fail('窗口不存在')
    const task = host.transferTasks().find((t) => t.id === id)
    if (!task) return fail('任务不存在')
    const picked = await dialog.showOpenDialog(win, {
      title: `选择保存位置（${task.files.map((f) => f.name).join('、')}）`,
      buttonLabel: '保存到这里',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: true as const, value: null }
    }
    try {
      await host.acceptTransfer(id, picked.filePaths[0])
      broadcast(getWindow, 'transfers:changed')
      return { ok: true as const, value: picked.filePaths[0] }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle('transfer:cancelFor', async (_e, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('缺少任务 ID')
    await host.cancelTransfer(id)
    broadcast(getWindow, 'transfers:changed')
    return { ok: true as const }
  })

  // 文件选择放在主进程：渲染进程没有文件系统访问权
  ipcMain.handle('transfer:pickAndOffer', async (_e, peerId: unknown) => {
    if (typeof peerId !== 'string') return fail('缺少对端 ID')
    const win = getWindow()
    if (!win) return fail('窗口不存在')
    const picked = await dialog.showOpenDialog(win, {
      title: '选择要发送的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: true as const, value: null }
    }
    try {
      const { stat } = await import('node:fs/promises')
      const files = await Promise.all(
        picked.filePaths.map(async (p) => {
          const s = await stat(p)
          const name = p.split(/[\\/]/).pop() ?? p
          return { name, path: p, size: s.size }
        })
      )
      const task = await host.offerFiles(peerId, files)
      broadcast(getWindow, 'transfers:changed')
      return { ok: true as const, value: task }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  invoke('transfer:info', async (): Promise<TransferInfo> => host.identityInfo())

  invoke('env:info', (): EnvInfo => {
    const b = locateBinaries()
    return {
      scrcpyPath: b.scrcpy,
      adbPath: b.adb,
      scrcpySource: b.source,
      // 就绪与否只看 scrcpy 是否真的被找到，不能拿「来源不是占位值」推断
      ready: b.scrcpyFound
    }
  })

  invoke('layout:get', () => host.layoutOrder())

  ipcMain.handle('layout:save', async (_e, order: unknown) => {
    if (!Array.isArray(order) || order.some((s) => typeof s !== 'string')) {
      return fail('布局顺序格式不正确')
    }
    host.setLayoutOrder(order as string[])
    return { ok: true as const }
  })

  // ---------- 本机显示名（5.4） ----------

  invoke('profile:get', () => host.displayName)

  ipcMain.handle('profile:rename', async (_e, name: unknown) => {
    if (typeof name !== 'string') return fail('缺少显示名')
    const result = host.setDisplayName(name)
    if (!result.ok) return fail(result.error ?? '改名失败')
    broadcast(getWindow, 'selfName:changed')
    return { ok: true as const, value: result.name }
  })

  // ---------- 剪贴板同步开关（6.6） ----------

  invoke('clipboard:get', () => host.isClipboardEnabled())

  ipcMain.handle('clipboard:setEnabled', async (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return fail('缺少开关状态')
    host.setClipboardEnabled(enabled)
    return { ok: true as const, value: host.isClipboardEnabled() }
  })

  // ---------- 键鼠共享（阶段 3，第 7 组） ----------

  invoke('input:state', () => {
    const pending = host.pendingInputRequest()
    const trusted = host.trustedDevices()
    // 显示名优先取信任清单里的名字；对端改名后跟着变
    const nameOf = (id: string): string =>
      trusted.find((t) => t.deviceId === id)?.displayName ?? id
    const controlledBy = host.controlledByPeer()
    const controlling = host.controllingPeer()
    return {
      pending: pending
        ? {
            sessionId: pending.sessionId,
            peerId: pending.peerId,
            displayName: pending.displayName,
            expiresAt: pending.expiresAt
          }
        : null,
      controlledBy: controlledBy ? nameOf(controlledBy) : null,
      controlling: controlling ? nameOf(controlling) : null,
      layout: host.inputLayoutStore.all(),
      nativeReady: runtime.inputNativeReady
    }
  })

  ipcMain.handle('input:request', async (_e, peerId: unknown) => {
    if (typeof peerId !== 'string' || !peerId) return fail('缺少对端 ID')
    const r = await host.requestInputControl(peerId)
    broadcast(getWindow, 'input:changed')
    return r.ok ? { ok: true as const } : fail(r.error)
  })

  ipcMain.handle('input:approve', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return fail('缺少会话 ID')
    const r = host.approveInputControl(sessionId)
    broadcast(getWindow, 'input:changed')
    return r.ok ? { ok: true as const } : fail(r.error ?? '批准失败')
  })

  ipcMain.handle('input:deny', (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return fail('缺少会话 ID')
    host.denyInputControl(sessionId)
    broadcast(getWindow, 'input:changed')
    return { ok: true as const }
  })

  ipcMain.handle('input:terminate', () => {
    host.terminateInputControl()
    broadcast(getWindow, 'input:changed')
    return { ok: true as const }
  })

  // 控制端退出（7.4）。与被控端拔掉是两条独立路径，不能混用：
  // terminate 走被控状态机，exit 走控制状态机
  ipcMain.handle('input:exit', () => {
    host.stopInputControl('stopped by user')
    broadcast(getWindow, 'input:changed')
    return { ok: true as const }
  })

  ipcMain.handle('input:setEdge', (_e, deviceId: unknown, edge: unknown) => {
    if (typeof deviceId !== 'string' || !deviceId) return fail('缺少设备 ID')
    if (edge !== null && edge !== 'left' && edge !== 'right' && edge !== 'top' && edge !== 'bottom') {
      return fail('方位取值不合法')
    }
    host.inputLayoutStore.setEdge(deviceId, edge)
    return { ok: true as const }
  })

  invoke('ping', () => 'pong')

  // 事件转发
  devices.on('changed', () => broadcast(getWindow, 'devices:changed'))
  adapter.on('changed', () => broadcast(getWindow, 'sessions:changed'))

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
