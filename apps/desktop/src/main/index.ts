import { app, BrowserWindow, clipboard, globalShortcut, Menu, powerMonitor, screen, shell } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DeviceManager } from './device-manager'
import { ScrcpyAdapter } from './scrcpy-adapter'
import { registerIpc } from './ipc'
import { locateBinaries, locateVirtualDisplayBinaries, locateVddPackageZip, locateRootdevHelper } from './platform'
import { VddVirtualDisplayManager } from './extend/vdd-display'
import { VddDriverManager } from './extend/vdd-driver'
import { log } from './log'
import { Host } from './host'
import { ReverseWindowManager } from './reverse-window'
import { EdgeSwitcher } from './input/edge'
import { loadWin32 } from './input/win32/native'
import { SendInputSink } from './input/win32/sink'
import { Win32InputCapture, decideCaptureMode } from './input/win32/capture'
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

// ---------- Win32 键鼠层（阶段 3） ----------
//
// 加载失败（非 Windows/缺少 koffi/DLL 异常）一律降级：注入回调缺省，
// UI 侧用 nativeReady=false 提示，主进程启动不受影响。
const win32 = loadWin32()
const inputSink = win32 ? new SendInputSink(win32, (m) => log.warn(m)) : null
if (!win32) log.warn('Win32 输入层不可用，键鼠共享功能将不可用')

const adapter = new ScrcpyAdapter()
const devices = new DeviceManager(adapter)
// 映射与注入必须同一坐标基准：SendInput 的归一化基准是虚拟屏**物理**像素
// （GetSystemMetrics 系），而 Electron screen.getPrimaryDisplay().size 是
// DIP 逻辑分辨率——此前用后者做 mapPoint 目标，DPI 缩放 + 只映射主屏
// 让指针只能走到虚拟屏的一小块（用户实测「只在其中一屏的一半区域」）。
// 改为虚拟屏物理 bounds 作为映射目标，注入时补回负 origin 偏移，
// 指针即可覆盖全部显示器。
const inputLocalScreen = win32
  ? () => {
      const vs = win32.virtualScreen()
      return { w: vs.w, h: vs.h }
    }
  : undefined

// ffmpeg 探测（屏幕投屏推流用）：PATH 命中即可用，找不到则投屏能力
// 关闭，平板的 screen.stream.request 会收到「缺少 ffmpeg」回告
function locateFfmpeg(): string | undefined {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000 })
    if (r.status === 0) return 'ffmpeg'
  } catch {
    /* PATH 里没有 */
  }
  return undefined
}

// 显示器枚举（物理像素）：gdigrab 抓取、SendInput 归一化、DD 帧源与
// 虚拟显示器差分都以物理像素为基准（GetSystemMetrics 系，实测虚拟屏
// 6720x2160），而 Electron bounds 是 DIP 逻辑分辨率（200%/175% 缩放
// 下各差 2/1.75 倍）——必须乘回 scaleFactor，否则选屏抓区域偏、触控
// 映射错位、虚拟显示器矩形对不上 DD 输出。
function listPhysicalDisplays(): Array<{ x: number; y: number; w: number; h: number }> {
  return screen
    .getAllDisplays()
    .map((d) => ({
      x: Math.round(d.bounds.x * d.scaleFactor),
      y: Math.round(d.bounds.y * d.scaleFactor),
      w: Math.round(d.bounds.width * d.scaleFactor),
      h: Math.round(d.bounds.height * d.scaleFactor)
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y)
}

// 虚拟显示器帧源（线 3）：dd-capture 抓虚拟显示器画面（screen-stream.ts
// 的 startDd）；dd-capture 缺失时扩展屏投屏不可用（扩展请求回
// session.reject），不影响镜像投屏与键鼠会话。
const nativeDisplayBins = locateVirtualDisplayBinaries()
log.info(
  `虚拟显示器帧源：dd-capture=${nativeDisplayBins.ddCapture ?? '缺失（扩展屏投屏不可用）'}`
)

// VDD 驱动生命周期（线 3，⑤）：安装/启用/卸载由用户在设置页显式触发
// （IPC vdd-driver:install），本处只构造管理器、不自动安装。
// zip 缺失时 status() 报 packageBundled=false，安装以 package-missing 拒绝。
const vddDriverManager = new VddDriverManager({ zipPath: locateVddPackageZip(), helperPath: locateRootdevHelper() })

// 扩展屏后端（线 3，④）：VDD 设备节点 + VddDriverManager，替代 swd-host
// 的 VirtualDisplayManager（类文件保留，不删）。approve 时启用节点创建
// 虚拟显示器，会话结束的任何路径都销毁；未安装驱动时创建直接失败，
// 绝不在会话里自动安装。
const vddVirtualDisplayManager = new VddVirtualDisplayManager({
  driver: vddDriverManager,
  listDisplays: listPhysicalDisplays
})
log.info('[extend] 扩展屏后端已切换到 VDD（Virtual Display Driver 25.7.23）')

const host = new Host({
  displayName: 'LinkSpace Desktop',
  deviceType: 'win',
  // input 能力位让对端在发现列表里知道本机支持键鼠共享；
  // scrcpy 投屏走 adb 不走局域网控制通道，但保持声明一致
  caps: ['file', 'clipboard', 'scrcpy', 'input'],
  inputLocalScreen,
  inputDisplays: win32 ? listPhysicalDisplays : undefined,
  screenFfmpegPath: locateFfmpeg(),
  // 虚拟显示器帧源（线 3，3.2-1）：source=virtual-display 的投屏请求
  // 由 screen-stream.ts 的 startDd 经 dd-capture 取帧
  screenDdCapturePath: nativeDisplayBins.ddCapture ?? undefined,
  // 扩展屏创建/销毁出口（线 3，④ VDD 后端）：approve 时创建虚拟显示器，
  // 会话结束的任何路径都销毁
  extendCreateVirtualDisplay: (preferred) => vddVirtualDisplayManager.create(preferred),
  extendDestroyVirtualDisplay: () => vddVirtualDisplayManager.destroy(),
  inputVirtualScreen: win32 ? () => win32.virtualScreen() : undefined,
  inputInject: inputSink
    ? (events) => {
        // 走查诊断：键盘注入链路取证（含 key 的批次低频，move 不打）
        if (events.some((ev) => ev.t === 'key')) {
          console.log('[inject-key]', JSON.stringify(events))
        }
        // mapPoint 产出的是「虚拟屏相对坐标」（0..w-1）；注入归一化
        // 需要虚拟屏绝对坐标（可为负），这里补回 origin 偏移
        const vs = win32!.virtualScreen()
        const absolute = events.map((ev) =>
          ev.t === 'move' ? { ...ev, x: ev.x + vs.x, y: ev.y + vs.y } : ev
        )
        inputSink.inject(absolute)
      }
    : undefined,
  inputReleaseAll: inputSink ? () => inputSink.releaseAll() : undefined
})

// 2.5-1 统一设备模型：设备列表（adb 枚举）经 Host 的身份解析并上 LinkSpace
// 身份（deviceId/配对/绑定），UI 不再拿两套模型各说各话。DeviceManager 本身
// 不直接依赖 Host（保持可测试），只接一个解析回调。
devices.setIdentityResolver((serial) => host.scrcpyIdentityOf(serial))

// 边缘穿越（7.1）：光标贴到已分配设备的边缘即自动发起控制请求。
// 采集层只在非控制态喂坐标，控制中不会再次触发。
const edgeSwitcher = new EdgeSwitcher({
  onSwitch: (edge, deviceId) => {
    log.info(`光标到达${edge}边缘，向 ${deviceId} 发起键鼠控制请求`)
    void host.requestInputControl(deviceId).then((r) => {
      if (!r.ok) log.info(`键鼠控制请求未发出：${r.error}`)
    })
  }
})

function refreshEdgeLayout(): void {
  edgeSwitcher.setLayout(host.inputLayoutStore.all())
}

let mainWindow: BrowserWindow | null = null
let quitting = false

// 供 IPC 读取的运行时状态（渲染层只拿快照，不直接摸 Host）
const runtime = {
  discovered: [] as DiscoveredService[],
  pendingPairings: [] as PendingPairing[],
  transfers: [] as TransferTask[],
  inputNativeReady: win32 !== null
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

// 平板画面窗口（线 2 W7，2.3-2）：Host 事件订阅在构造时完成；
// registerIpc 里经它开窗/关窗/取状态快照
const reverseWindows = new ReverseWindowManager({
  host,
  // 流在别处结束且有明确原因（平板拒绝/超时/断连）：主窗口提示，
  // 而不是画面窗口悄悄消失
  onEndedWithReason: (reason) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('reverse-stream:notice', reason)
    }
  },
  // Bug 1：画面窗口失焦/最小化 → 输入暂停，刷新全局采集模式
  onInputPausedChange: () => refreshInputCaptureMode(),
  resolvePreload,
  rendererUrl: () => process.env.ELECTRON_RENDERER_URL,
  rendererFile: () => join(__dirname, '../renderer/index.html')
})

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

// ---------- 挂起传输清扫（审查 P3） ----------
// 对端不上线的 waiting/offered 任务每 24h 过期一次，每小时查一趟即可
let transferSweepTimer: NodeJS.Timeout | null = null

function startTransferSweep(): void {
  if (transferSweepTimer) return
  transferSweepTimer = setInterval(() => host.sweepStaleTransfers(), 60 * 60 * 1000)
}

function stopTransferSweep(): void {
  if (!transferSweepTimer) return
  clearInterval(transferSweepTimer)
  transferSweepTimer = null
}

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
    writeText: (t) => {
      // 与 readText 对称的兜底（审查 P3）：剪贴板被其他进程独占时
      // writeText 也会抛，不能让单次同步失败打断轮询
      try {
        clipboard.writeText(t)
      } catch (err) {
        log.error(`写入剪贴板失败: ${String(err)}`)
      }
    }
  })
  // 按上次的选择归位（审查 P2-1）：默认关，用户开过才开。必须在
  // enableClipboardSync 之后调——构造完成才有对象可停
  host.restoreClipboardSwitch()
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

// ---------- 键鼠采集循环 ----------
//
// 12ms 一轮（~83Hz）：鼠标轨迹够顺滑，键状态轮询的 CPU 开销可忽略。
// 采集器 idle 态只喂边缘检测，控制态才转发事件——模式切换由
// inputChanged 事件驱动（会话建立/结束时触发）。
const INPUT_TICK_MS = 12
let inputTimer: NodeJS.Timeout | null = null
let inputCapture: Win32InputCapture | null = null

/**
 * 控制端采集模式刷新（Bug 1：反向窗口失焦仍同步输入）。
 * 决策见 input/win32/capture.ts 的 decideCaptureMode：被控挂起优先；
 * 反向窗口会话（控平板）只在画面窗口获得焦点时开全局采集，失焦/
 * 最小化时挂起——输入只走画面窗口本身的 IPC；线 1 边缘穿越会话
 * 没有画面窗口，不受焦点门限制。调用点：inputChanged（会话变迁）
 * 与反向窗口焦点变化（ReverseWindowManager.onInputPausedChange）。
 */
function refreshInputCaptureMode(): void {
  if (!inputCapture) return
  inputCapture.setMode(
    decideCaptureMode({
      controlledByPeer: host.controlledByPeer() !== null,
      controllingPeer: host.controllingPeer() !== null,
      reverseSession: host.reverseInputScreen() !== null,
      reverseInputPaused: reverseWindows.isInputPaused()
    })
  )
}

function startInputLoop(): void {
  if (!win32 || inputTimer) return
  try {
    const primary = screen.getPrimaryDisplay()
    const size = { w: primary.size.width, h: primary.size.height }
    edgeSwitcher.setScreen(size)
    inputCapture = new Win32InputCapture({
      native: win32,
      screen: size,
      onEvents: (events) => host.sendInputEvents(events),
      onEdgeMove: (x, y) => edgeSwitcher.feed(x, y)
    })
    inputTimer = setInterval(() => inputCapture?.tick(), INPUT_TICK_MS)
    refreshEdgeLayout()
    log.info(`键鼠采集循环已启动（${INPUT_TICK_MS}ms）`)
  } catch (err) {
    log.error(`键鼠采集循环启动失败: ${String(err)}`)
  }
}

function stopInputLoop(): void {
  if (inputTimer) {
    clearInterval(inputTimer)
    inputTimer = null
  }
  inputCapture = null
}

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  const b = locateBinaries()
  log.info(`LinkSpace 启动，scrcpy=${b.scrcpy}（来源 ${b.source}）`)

  buildAppMenu()
  registerIpc(() => mainWindow, devices, adapter, host, runtime, reverseWindows, vddDriverManager)
  createWindow()

  // 7.4 退出快捷键：任何时候可退出控制，无需对端同意。未在控制时
  // stopInputControl 是安全空操作，全局注册即可
  globalShortcut.register('Control+Alt+Space', () => host.stopInputControl('exit hotkey'))

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
      .on('peerRenamed', () => {
        // 对端改名会更新信任清单，已信任列表要刷新
        broadcast('trust:changed')
      })
      .on('inputRequested', () => {
        // 9.1：请求必须让用户看到，渲染层据此弹确认条
        broadcast('input:changed')
      })
      .on('inputChanged', () => {
        // 会话建立/结束时同步采集模式；布局也可能在会话间隙被 UI 改过。
        // 被控期间强制挂起采集并锁定边缘（审查 P2-3）：本机输入正由
        // 对端注入驱动，采集若继续跑，注入产生的移动会被当成本机输入
        // 再次转发/触发边缘穿越——对端无需授权即可借本机驱动第三方
        refreshInputCaptureMode()
        if (host.controlledByPeer()) edgeSwitcher.lock()
        refreshEdgeLayout()
        broadcast('input:changed')
      })
      .on('extendRequested', () => {
        // 9.1：扩展屏请求改动本机显示拓扑，同样必须让用户看到，
        // 渲染层据此弹确认条（extend:state 取待确认请求）。
        broadcast('extend:changed')
      })
      .on('extendChanged', () => {
        broadcast('extend:changed')
      })
  } catch (err) {
    log.error(`主机启动失败: ${String(err)}`)
  }

  // 锁屏/解锁（线 3 收尾）：锁屏下 gdigrab 与 DD 都抓不到画面
  // （Winlogon 安全桌面不可见，ffmpeg 报 error 5），Host 收到锁屏
  // 即停正向投屏并记恢复参数，解锁后按原样重起；反向流不受影响。
  powerMonitor.on('lock-screen', () => host.handleSessionLock())
  powerMonitor.on('unlock-screen', () => host.handleSessionUnlock())

  startClipboardSync()
  startInputLoop()
  startTransferSweep()

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
  stopTransferSweep()
  stopInputLoop()
  // 画面窗口先关：'closed' 里停反向流 + 键鼠会话，再走 host.stop()
  reverseWindows.close()
  // 快捷键挂着全局钩子，退出前必须释放，否则会劫持系统组合键
  globalShortcut.unregisterAll()
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
