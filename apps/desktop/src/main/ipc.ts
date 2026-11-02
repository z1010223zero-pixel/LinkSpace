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
import { STREAM_QUALITY_PRESETS } from './screen-stream'
import { decodeInputEvents, mapPoint, type InputEvent } from './input/protocol'
import type { ReverseWindowManager } from './reverse-window'
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
  'devices:bindings',
  'devices:bind',
  'devices:unbind',
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
  'reverse-control:start',
  'reverse-stream:status',
  'reverse-stream:setQuality',
  'reverse-stream:stop',
  'reverse-stream:retryInput',
  'reverse-stream:input',
  'reverse-stream:text',
  'reverse-stream:paste',
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
  'input:changed',
  // 反向投屏的帧与状态是带数据的推送，由 ReverseWindowManager 直接发
  // 给画面窗口，不走下面的 broadcast()（只发主窗口、无载荷）；
  // reverse-stream:notice 由 index.ts 发给主窗口（流结束原因提示）
  'reverse-stream:frame',
  'reverse-stream:changed',
  'reverse-stream:notice'
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
  runtime: RuntimeSource,
  reverseWindows: ReverseWindowManager
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

  // ---------- adb serial ↔ deviceId 显式绑定（W2） ----------
  // USB 设备没有 IP 可 join，投屏前须由用户显式绑定到一台已配对设备一次。
  // 绑定只认 serial 与 deviceId，不做型号/显示名模糊匹配。
  invoke('devices:bindings', () => host.scrcpyBindings())

  ipcMain.handle('devices:bind', async (_e, serial: unknown, deviceId: unknown) => {
    if (typeof serial !== 'string' || !serial) return fail('缺少设备序列号')
    if (typeof deviceId !== 'string' || !deviceId) return fail('缺少设备 ID')
    if (!devices.view().some((d) => d.serial === serial)) return fail('该设备当前未连接')
    const r = host.bindScrcpyDevice(serial, deviceId)
    return r.ok ? { ok: true as const } : fail(r.error ?? '绑定失败')
  })

  ipcMain.handle('devices:unbind', async (_e, serial: unknown) => {
    if (typeof serial !== 'string' || !serial) return fail('缺少设备序列号')
    host.unbindScrcpyDevice(serial)
    return { ok: true as const }
  })

  ipcMain.handle('scrcpy:startFor', async (_e, serial: unknown, opts: unknown) => {
    if (typeof serial !== 'string' || !serial) return fail('缺少设备序列号')
    // W2 门禁（main 进程）：serial 必须解析到一台已配对设备，否则拒绝。
    // 未配对返回 AUTH_REQUIRED，不静默放行。
    const gate = host.resolveScrcpyDevice(serial)
    if (!gate.ok) {
      return {
        ok: false as const,
        error: { code: 'AUTH_REQUIRED', message: gate.error, retryable: false }
      }
    }
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

  // ---------- 反向投屏：平板画面窗口（线 2 W7，2.3-2） ----------

  /** 入口错误 → 用户可照做的引导（2.3-1：未授权/不在线时不静默无反应） */
  const reverseStartGuidance = (error: string): string => {
    switch (error) {
      case '设备不在线':
        return '平板不在线：请确认平板已开机、连入同一局域网并打开 LinkSpace，然后点主界面的「刷新」'
      case '设备未配对':
        return '该设备尚未配对：请先在「局域网内的其他设备」里完成配对，再点控制'
      case '本机缺少 ffmpeg，无法解码':
        return '本机缺少 ffmpeg，无法解码平板画面：请安装 ffmpeg 后重启应用'
      case '已有反向投屏在跑':
        return '已有平板画面窗口在跑：请先断开当前窗口，再控制这台设备'
      default:
        return error
    }
  }

  ipcMain.handle('reverse-control:start', (_e, peerId: unknown, scaleWidth: unknown) => {
    if (typeof peerId !== 'string' || !peerId) return fail('缺少对端 ID')
    if (reverseWindows.isOpenFor(peerId)) {
      reverseWindows.open(peerId, reverseWindows.statusSnapshot().displayName || peerId)
      return { ok: true as const }
    }
    const width = typeof scaleWidth === 'number' ? scaleWidth : 1920
    const r = host.requestReverseScreenStream(peerId, width)
    if (!r.ok) return fail(reverseStartGuidance(r.error))
    const trusted = host.trustedDevices().find((t) => t.deviceId === peerId)
    reverseWindows.open(peerId, trusted?.displayName ?? peerId)
    return { ok: true as const }
  })

  invoke('reverse-stream:status', () => reverseWindows.statusSnapshot())

  ipcMain.handle('reverse-stream:setQuality', (_e, peerId: unknown, width: unknown) => {
    if (typeof peerId !== 'string' || !peerId) return fail('缺少对端 ID')
    if (typeof width !== 'number' || !STREAM_QUALITY_PRESETS.some((p) => p.width === width)) {
      return fail('分辨率档位不合法')
    }
    const r = host.requestReverseScreenStream(peerId, width)
    return r.ok ? { ok: true as const } : fail(r.error)
  })

  ipcMain.handle('reverse-stream:stop', (_e, peerId: unknown) => {
    if (typeof peerId === 'string' && peerId) host.stopReverseScreenStream(peerId)
    else host.stopReverseScreenStream()
    reverseWindows.close()
    return { ok: true as const }
  })

  ipcMain.handle('reverse-stream:retryInput', (_e, peerId: unknown) => {
    if (typeof peerId !== 'string' || !peerId) return fail('缺少对端 ID')
    const st = host.reverseStreamStatus()
    if (!st.peerId || st.peerId !== peerId) return fail('反向投屏未在跑')
    if (st.receiver.width < 1 || st.receiver.height < 1) return fail('画面尺寸未知：请等画面出现后再试')
    const r = host.requestInputControlWithScreen(peerId, { w: st.receiver.width, h: st.receiver.height })
    return r.ok ? { ok: true as const } : fail(r.error)
  })

  ipcMain.handle('reverse-stream:input', (_e, input: unknown) => {
    // 窗口输入 → input.event：先把画布坐标映射到会话声明的流尺寸，
    // 再过一遍与线上事件相同的解码校验（字段白名单 + 数值钳制）。
    // 非活动会话时 sendInputEvents 是安全空操作；会话未建立时明确拒绝，
    // 让窗口显示原因而不是让点击静默落掉。
    const screen = host.reverseInputScreen()
    if (!screen) return fail('键鼠控制尚未建立：请等平板确认控制后再操作')
    const events = decodeReverseWindowInput(input, screen)
    if (!events) return fail('输入事件不合法')
    host.sendInputEvents(events)
    return { ok: true as const }
  })

  ipcMain.handle('reverse-stream:text', (_e, peerId: unknown, text: unknown) => {
    // 成品输入（协议 4.9，B2）：控制端已组字好的文本分段发 input.text
    if (typeof peerId !== 'string' || !peerId) return fail('缺少对端 ID')
    if (typeof text !== 'string' || !text) return fail('请输入要发送的文本')
    const r = host.sendInputText(peerId, text)
    return r.ok ? { ok: true as const } : fail(r.error)
  })

  ipcMain.handle('reverse-stream:paste', (_e, peerId: unknown, text: unknown) => {
    // 粘贴回退（协议 4.8，C）：渲染层发送前已两步确认“将覆盖平板剪贴板”
    if (typeof peerId !== 'string' || !peerId) return fail('缺少对端 ID')
    if (typeof text !== 'string' || !text) return fail('请输入要粘贴的文本')
    const r = host.sendScreenPasteToTablet(peerId, text)
    return r.ok ? { ok: true as const } : fail(r.error)
  })

  invoke('ping', () => 'pong')

  // W2 撤销级联：Host 撤销信任时算出属于该设备的 serial，停掉对应会话。
  // 判定在 Host 内，停会话的动作在这里（adapter 侧）。
  host.setScrcpyRevokedHandler(async (_deviceId, matches) => {
    const targets = adapter
      .list()
      .filter((s) => (s.state === 'starting' || s.state === 'running') && matches(s.serial))
    await Promise.all(targets.map((s) => adapter.stop(s.id)))
  })

  // 事件转发
  devices.on('changed', () => broadcast(getWindow, 'devices:changed'))
  adapter.on('changed', () => broadcast(getWindow, 'sessions:changed'))

  log.info(`IPC 已注册：${CHANNELS.length} 个 channel，${EVENTS.length} 类事件`)
}

/**
 * 反向窗口输入的收敛：画布像素 → 会话声明的流尺寸（mapPoint，与线 1
 * 被控端同口径的比例映射），再过 decodeInputEvents 的字段白名单。
 * 画布可能比流画面大（letterbox 黑边已由渲染层扣掉，见组件内注释）；
 * 越界坐标钳进画布，不合法的按钮/vk 整批丢弃。
 */
function decodeReverseWindowInput(
  input: unknown,
  screen: { w: number; h: number }
): InputEvent[] | null {
  if (typeof input !== 'object' || input === null) return null
  const p = input as Record<string, unknown>
  const mapXY = (x: unknown, y: unknown, canvasW: unknown, canvasH: unknown): { x: number; y: number } | null => {
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof canvasW !== 'number' ||
      typeof canvasH !== 'number'
    ) {
      return null
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || canvasW < 1 || canvasH < 1 || canvasW > 32768 || canvasH > 32768) {
      return null
    }
    const cx = Math.min(canvasW, Math.max(0, x))
    const cy = Math.min(canvasH, Math.max(0, y))
    return mapPoint(cx, cy, { w: canvasW, h: canvasH }, screen)
  }
  switch (p.kind) {
    case 'move': {
      const pt = mapXY(p.x, p.y, p.canvasW, p.canvasH)
      if (!pt) return null
      return decodeInputEvents({ events: [{ t: 'move', x: pt.x, y: pt.y }] })
    }
    case 'down':
    case 'up': {
      if (p.b !== 'left' && p.b !== 'right' && p.b !== 'middle') return null
      const pt = mapXY(p.x, p.y, p.canvasW, p.canvasH)
      if (!pt) return null
      // 按键必须带落点：先 move 到位置再 down/up，平板按手势落点注入
      return decodeInputEvents({
        events: [
          { t: 'move', x: pt.x, y: pt.y },
          { t: p.kind, b: p.b }
        ]
      })
    }
    case 'wheel': {
      if (typeof p.dx !== 'number' || typeof p.dy !== 'number') return null
      if (!Number.isFinite(p.dx) || !Number.isFinite(p.dy)) return null
      return decodeInputEvents({ events: [{ t: 'wheel', dx: p.dx, dy: p.dy }] })
    }
    case 'key': {
      if (typeof p.vk !== 'number' || typeof p.down !== 'boolean') return null
      return decodeInputEvents({ events: [{ t: 'key', vk: p.vk, down: p.down }] })
    }
    default:
      return null
  }
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
