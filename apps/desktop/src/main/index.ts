import { app, BrowserWindow, clipboard, Menu, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DeviceManager } from './device-manager'
import { ScrcpyAdapter } from './scrcpy-adapter'
import { registerIpc } from './ipc'
import { locateBinaries } from './platform'
import { log } from './log'
import { Host } from './host'
import type { DiscoveredService } from './discovery'
import type { PendingPairing } from './pairing'
import type { TransferTask } from './transfer/manager'

// ---------- 单实例 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// 应用名影响 userData 目录。package.json 的 name 若带 npm scope
// （如 @linkspace/desktop），userData 会变成含 @ 和 / 的异常路径，
// 其下的 GPUPersistentCache 会导致 GPU 进程反复崩溃。这里显式指定
// 一个干净路径，双保险。
app.setPath('userData', join(app.getPath('appData'), 'LinkSpace'))

// 本机 GPU 子进程必然以 -1073741819 崩溃，重试若干次后 Chromium 直接
// FATAL（"GPU process isn't usable. Goodbye."），拖垮整个应用。
// 已排除：Electron 版本（37/45 均复现）、userData 路径、沙箱。
// 改为把 GPU 服务放进主进程，不再单独拉起 GPU 子进程。
// 这是针对本机图形环境的规避，不是通用配置，排查到根因后应移除。
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
app.disableHardwareAcceleration()

const adapter = new ScrcpyAdapter()
const devices = new DeviceManager(adapter)
const host = new Host({ displayName: 'LinkSpace Desktop', deviceType: 'win' })

let mainWindow: BrowserWindow | null = null
let quitting = false

// 供 IPC 读取的运行时状态（渲染层只拿快照，不直接摸 Host）
const runtime = {
  discovered: [] as DiscoveredService[],
  pendingPairings: [] as PendingPairing[],
  transfers: [] as TransferTask[]
}

/** electron-vite 的 preload 输出扩展名随配置而变，这里做兼容探测 */
function resolvePreload(): string {
  const base = join(__dirname, '../preload')
  for (const name of ['index.mjs', 'index.js', 'index.cjs']) {
    const p = join(base, name)
    if (existsSync(p)) return p
  }
  return join(base, 'index.mjs')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'LinkSpace',
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      preload: resolvePreload(),
      // preload 以 ESM(.mjs) 输出，而沙箱化 preload 只支持 CJS，因此
      // 保持关闭沙箱；隔离由 contextIsolation + IPC 白名单承担
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 渲染层被注入后最常见的逃逸路径是导航到攻击者页面（preload 随之
  // 被重新注入到新页面）。一律拦下，外链交给系统浏览器
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---------- 剪贴板同步 ----------
//
// 用轮询而不是 clipboard.watch()：后者在部分 Windows / Linux 环境上
// 回调不稳定，而剪贴板同步对延迟不敏感（1 秒内到达足够），
// 800ms 一轮的 readText 开销可以忽略。
const CLIPBOARD_POLL_MS = 800
let clipboardTimer: NodeJS.Timeout | null = null

function startClipboardSync(): void {
  if (clipboardTimer) return
  host.enableClipboardSync({
    readText: () => {
      try {
        return clipboard.readText()
      } catch {
        // 剪贴板被其他进程独占时 readText 会抛，不能因此中断同步
        return ''
      }
    },
    writeText: (t) => clipboard.writeText(t)
  })
  clipboardTimer = setInterval(() => host.pollClipboard(), CLIPBOARD_POLL_MS)
}

function stopClipboardSync(): void {
  if (!clipboardTimer) return
  clearInterval(clipboardTimer)
  clipboardTimer = null
}

// ---------- 应用菜单 ----------
//
// 1.4「正常退出」的验收路径是菜单退出：必须有走 app.quit() 的产品级
// 退出入口，才能触发 before-quit 里的投屏会话清理（标题栏 X 也走同一
// 路径，但菜单是验收明确要求的入口）。同时收编 Electron 的默认英文
// 菜单，避免窗口顶栏出现与产品无关的默认项。
// role 菜单项（编辑/视图/窗口）由 Electron 按 app locale 自动本地化。
function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          click: () => app.quit()
        }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  const b = locateBinaries()
  log.info(`LinkSpace 启动，scrcpy=${b.scrcpy}（来源 ${b.source}）`)

  buildAppMenu()
  registerIpc(() => mainWindow, devices, adapter, host, runtime)
  createWindow()

  // 启动主机：证书 → 传输服务 → 控制通道（同端口）→ 配对 → mDNS 发现
  try {
    await host.start()
    host
      .on('discovered', (svc) => {
        runtime.discovered = runtime.discovered.filter((d) => d.serviceName !== svc.serviceName)
        runtime.discovered.push(svc)
        broadcast('discovered:changed')
      })
      .on('lost', (svc) => {
        runtime.discovered = runtime.discovered.filter((d) => d.serviceName !== svc.serviceName)
        broadcast('discovered:changed')
      })
      .on('pairRequested', () => {
        runtime.pendingPairings = host.pendingPairings()
        broadcast('pairings:changed')
      })
      .on('transferOffered', () => {
        runtime.transfers = host.transferTasks()
        broadcast('transfers:changed')
      })
      .on('transferChanged', () => {
        runtime.transfers = host.transferTasks()
        broadcast('transfers:changed')
      })
  } catch (err) {
    log.error(`主机启动失败: ${String(err)}`)
  }

  startClipboardSync()

  // 首次扫描设备
  await devices.refresh().catch((err) => log.error(`首次设备扫描失败: ${String(err)}`))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// 退出前必须清理所有投屏会话，否则会残留 scrcpy / adb 进程
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  log.info('应用退出，清理投屏会话')
  stopClipboardSync()
  adapter
    .stopAll()
    .catch((err) => log.error(`清理会话失败: ${String(err)}`))
    .finally(() => {
      void host.stop()
      app.exit(0)
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function broadcast(channel: string): void {
  const win = mainWindow
  if (win && !win.isDestroyed()) win.webContents.send(channel)
}

process.on('uncaughtException', (err) => {
  log.error(`未捕获异常: ${err.message}`)
})

process.on('unhandledRejection', (reason) => {
  log.error(`未处理的 Promise 拒绝: ${String(reason)}`)
})
