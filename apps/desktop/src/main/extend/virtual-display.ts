// 虚拟显示器管理器（线 3，3.2-1）：会话级创建/销毁虚拟显示器。
//
// 驱动本身（IddCx 样例驱动）在 native/virtual-display/，创建设备这
// 件事由 native/swd-host/swd-host.exe 承担：本管理器 spawn 它，等
// stdout 上的 SWD-READY / SWD-DISPLAY-APPEARED，会话结束时关 stdin
//（或杀进程）让它 SwDeviceClose 摘掉设备。
//
// 模式选定：驱动 INF 预置的是一组固定模式（样例三路 2560×1440 /
// 1024×768 / 2560×1440），创建后按“最接近请求尺寸”挑已出现的显示
// 器——通过创建前后的显示器列表差分定位新显示器。按请求尺寸选模式
// （改驱动模式表或给 swd-host 加 --mode）以后再加。
//
// 前置与失败：
//   - swd-host 不存在（未构建 / 打包未带）：create 直接报
//     'virtual display unavailable'，会话不建立。
//   - SwDeviceCreate 失败（如非管理员 0x80070005）：swd-host 退出
//     码 1，stderr 尾巴进 reason。
//   - 驱动未装 / 测试签名未开（Secure Boot 开启时）：设备建得成但
//     新输出 20s 不出现，swd-host 打 SWD-DISPLAY-TIMEOUT，create
//     报 'virtual display did not appear'。这是当前真机环境的
//     常态（见 native/swd-host/README.md 验证记录），不是 bug。
//   - 创建是异步的（READY 10s + 出现 20s 上限）：调用方（Coordinator
//     的 approve）必须 await，创建期间 deny/过期/断连会取消本次
//     创建——显示器若已建成则立即销毁，不留残留设备。
//
// 注意：本管理器不判断“该不该建”，只执行创建/销毁；授权与会话
// 状态在 DisplayExtendSessionCoordinator。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { log } from '../log'

export interface VirtualDisplayRect {
  x: number
  y: number
  w: number
  h: number
}

export type VirtualDisplayCreateResult =
  | { ok: true; screen: VirtualDisplayRect }
  | { ok: false; reason: string }

export interface VirtualDisplayManagerOptions {
  /** swd-host.exe 路径；null = 未定位到二进制，create 直接失败 */
  swdHostPath: string | null
  /** 传给 swd-host 的额外参数（默认无；测试用 fake 脚本路径由此注入，生产不传） */
  swdHostArgs?: string[]
  /** 当前显示器列表（物理像素，与 DD rect / Win32 虚拟屏同基准） */
  listDisplays: () => VirtualDisplayRect[]
  /** 等 SWD-READY 的上限，默认 10s（与 swd-host 内部回调超时一致） */
  readyTimeoutMs?: number
  /** 等 SWD-DISPLAY-APPEARED 的上限，默认 25s（swd-host 自身 20s 先超时） */
  appearTimeoutMs?: number
}

const DEFAULT_READY_TIMEOUT_MS = 10_000
const DEFAULT_APPEAR_TIMEOUT_MS = 25_000

/** 两矩形是否同一块显示器（创建前后差分用） */
function sameRect(a: VirtualDisplayRect, b: VirtualDisplayRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/** 与请求尺寸的距离：宽高差之和，越小越接近 */
function sizeDistance(r: VirtualDisplayRect, preferred: { width: number; height: number } | null): number {
  if (!preferred) return 0
  return Math.abs(r.w - preferred.width) + Math.abs(r.h - preferred.height)
}

export class VirtualDisplayManager {
  private proc: ChildProcessWithoutNullStreams | null = null
  private screen: VirtualDisplayRect | null = null
  private readonly swdHostPath: string | null
  private readonly swdHostArgs: string[]
  private readonly listDisplays: () => VirtualDisplayRect[]
  private readonly readyTimeoutMs: number
  private readonly appearTimeoutMs: number

  constructor(opts: VirtualDisplayManagerOptions) {
    this.swdHostPath = opts.swdHostPath
    this.swdHostArgs = opts.swdHostArgs ?? []
    this.listDisplays = opts.listDisplays
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.appearTimeoutMs = opts.appearTimeoutMs ?? DEFAULT_APPEAR_TIMEOUT_MS
  }

  /** swd-host 二进制是否就位（未就位时 create 直接失败，不 spawn） */
  get available(): boolean {
    return this.swdHostPath !== null
  }

  /** 当前是否有本管理器创建的虚拟显示器 */
  get active(): boolean {
    return this.screen !== null
  }

  /** 当前虚拟显示器的矩形；未创建时 null */
  get currentScreen(): VirtualDisplayRect | null {
    return this.screen ? { ...this.screen } : null
  }

  /**
   * 创建虚拟显示器。成功返回其矩形；失败返回原因（调用方据此回
   * session.reject）。同一时刻只允许一个：已创建时直接返回当前矩形。
   */
  async create(preferred: { width: number; height: number } | null): Promise<VirtualDisplayCreateResult> {
    if (this.screen) return { ok: true, screen: { ...this.screen } }
    if (!this.swdHostPath) {
      return { ok: false, reason: 'virtual display unavailable' }
    }
    if (this.proc) {
      // 上一次创建正在进行中（Coordinator 保证不会重入，此处是防御）
      return { ok: false, reason: 'virtual display creation in progress' }
    }

    const before = this.listDisplays()
    const proc = spawn(this.swdHostPath, this.swdHostArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    const stderrTail: string[] = []
    let stdoutBuf = ''
    let ready = false
    let appeared: number | null = null
    let timedOut = false
    let exitCode: number | null = null
    let spawnError: string | null = null

    const onLine = (line: string): void => {
      const t = line.trim()
      if (!t) return
      if (t === 'SWD-READY') ready = true
      else if (t.startsWith('SWD-DISPLAY-APPEARED')) {
        const n = Number(t.split(/\s+/)[1])
        appeared = Number.isFinite(n) ? n : 0
      } else if (t === 'SWD-DISPLAY-TIMEOUT') timedOut = true
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      const lines = stdoutBuf.split(/\r?\n/)
      stdoutBuf = lines.pop() ?? ''
      for (const l of lines) onLine(l)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      for (const l of chunk.toString().split(/\r?\n/)) {
        const t = l.trim()
        if (!t) continue
        stderrTail.push(t)
        if (stderrTail.length > 10) stderrTail.shift()
      }
    })
    const exitPromise = new Promise<number | null>((resolve) => {
      proc.on('exit', (code) => {
        exitCode = code
        resolve(code)
      })
      proc.on('error', (err) => {
        spawnError = String(err)
        exitCode = -1
        log.warn(`[virtual-display] swd-host 启动失败: ${String(err)}`)
        resolve(null)
      })
    })

    const fail = (reason: string): VirtualDisplayCreateResult => {
      this.killProc()
      return { ok: false, reason }
    }

    // 阶段一：等 SWD-READY（设备节点已创建）。超时或进程提前退出都算失败。
    const readyOk = await this.waitFor(
      () => ready || exitCode !== null,
      this.readyTimeoutMs
    )
    if (!readyOk || !ready) {
      const tail = stderrTail.join(' | ')
      return fail(
        exitCode !== null
          ? `virtual display unavailable (${(spawnError ?? tail) || `swd-host exited ${exitCode}`})`
          : 'virtual display creation timed out'
      )
    }
    log.info('[virtual-display] swd-host 已就绪，等待新输出出现')

    // 阶段二：等 SWD-DISPLAY-APPEARED / TIMEOUT。驱动未装或签名不
    // 通过时 swd-host 20s 后自己打 TIMEOUT；这里再设一道上限兜底。
    const appearOk = await this.waitFor(
      () => appeared !== null || timedOut || exitCode !== null,
      this.appearTimeoutMs
    )
    if (!appearOk || appeared === null) {
      const tail = stderrTail.join(' | ')
      return fail(
        timedOut
          ? 'virtual display did not appear (driver not installed or signature issue)'
          : `virtual display did not appear (${tail || 'swd-host exited early'})`
      )
    }
    // 进程可能在 APPEARED 后立刻退出（异常路径）：以 exit 为准不取帧
    void exitPromise

    // 阶段三：差分定位新显示器，按最接近请求尺寸挑一块。
    const after = this.listDisplays()
    const fresh = after.filter((r) => !before.some((b) => sameRect(b, r)))
    if (fresh.length === 0) {
      return fail('virtual display did not appear (no new output enumerated)')
    }
    fresh.sort((a, b) => sizeDistance(a, preferred) - sizeDistance(b, preferred))
    const chosen = fresh[0]!
    this.screen = { ...chosen }
    log.info(
      `[virtual-display] 虚拟显示器已创建：${chosen.w}x${chosen.h} @ ${chosen.x},${chosen.y}` +
        (fresh.length > 1 ? `（同批新出现 ${fresh.length} 块，按最接近请求尺寸挑）` : '')
    )
    return { ok: true, screen: { ...chosen } }
  }

  /**
   * 销毁虚拟显示器：先关 stdin（swd-host 收到 EOF 后正常 SwDeviceClose），
   * 3s 未退出再杀进程。同步返回，不等进程退出——调用方（会话结束路
   * 径）不应被销毁阻塞；残留进程由 kill 兜底。
   */
  destroy(): void {
    if (!this.proc && !this.screen) return
    const proc = this.proc
    this.proc = null
    this.screen = null
    if (!proc) return
    try {
      proc.stdin.end()
    } catch {
      /* stdin 已关 */
    }
    const killer = setTimeout(() => {
      if (!proc.killed) proc.kill()
    }, 3000)
    killer.unref?.()
    proc.on('exit', () => clearTimeout(killer))
    log.info('[virtual-display] 虚拟显示器销毁中（swd-host 退出信号已发）')
  }

  /** 立即杀掉 swd-host 进程并清状态（创建失败路径用） */
  private killProc(): void {
    const proc = this.proc
    this.proc = null
    this.screen = null
    if (proc && !proc.killed) proc.kill()
  }

  /** 轮询等待条件成立或超时 */
  private waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now()
      const tick = (): void => {
        if (cond()) {
          resolve(true)
          return
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(false)
          return
        }
        setTimeout(tick, 100)
      }
      tick()
    })
  }
}
