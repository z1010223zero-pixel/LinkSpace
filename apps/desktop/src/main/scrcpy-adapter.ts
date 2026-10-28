// scrcpy 会话适配器 —— 架构 L4 层。
//
// 对应 docs/architecture.md 6.1 的 CapabilityAdapter 接口草案。
// 第一阶段只做进程编排：启动、停止、生命周期跟踪、错误分类。
// 不解析视频流，不接管输入，不修改 scrcpy 源码（方案 3.1）。
//
// 实测依据（2026-10-28，scrcpy 5.0.1）：
//   - 正常结束 / --time-limit 到期 → 退出码 0
//   - 设备不存在 → 退出码 1，stderr 含 "ERROR: Could not find ADB device <serial>:"
//   - --window-title / --window-x|y|width 可控制窗口
//   详见 modules/scrcpy-adapter/README.md

import { ChildProcess, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { locateBinaries } from './platform'
import { log, shortSerial } from './log'
// StartOptions 必须来自共享契约，避免主进程与渲染层两处定义漂移
import type { StartOptions } from '../shared/types'

export type SessionState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

export type AdapterErrorCode =
  | 'BINARY_MISSING'
  | 'SESSION_EXISTS'
  | 'DEVICE_NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'RESOURCE_BUSY'
  | 'INTERNAL'

export interface AdapterError {
  code: AdapterErrorCode
  /** 可展示给用户的原因，不得含凭据或剪贴板内容 */
  message: string
  retryable: boolean
}

export interface ScrcpySession {
  id: string
  serial: string
  pid: number | null
  state: SessionState
  startedAt: number
  stoppedAt?: number
  exitCode?: number | null
  error?: AdapterError
}

type Result<T> = { ok: true; value: T } | { ok: false; error: AdapterError }

const STARTUP_GRACE_MS = 4000
// Windows 上 taskkill 不带 /F 只发送 WM_CLOSE，无窗口进程收不到，
// 因此优雅停止实际上必然超时。压到 1.5s 以减少用户等待，随后杀进程树。
const STOP_TIMEOUT_MS = 1500

export class ScrcpyAdapter extends EventEmitter {
  private sessions = new Map<string, ScrcpySession>()
  private procs = new Map<string, ChildProcess>()
  private stderrTails = new Map<string, string[]>()
  private seq = 0

  constructor() {
    super()
    this.setMaxListeners(50)
  }

  list(): ScrcpySession[] {
    return [...this.sessions.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  get(id: string): ScrcpySession | undefined {
    return this.sessions.get(id)
  }

  findBySerial(serial: string): ScrcpySession[] {
    return this.list().filter((s) => s.serial === serial)
  }

  async start(serial: string, opts: StartOptions = {}): Promise<Result<ScrcpySession>> {
    const { scrcpy, scrcpyFound } = locateBinaries()

    // 双重保险：scrcpyFound 是 locateBinaries 的权威判定，
    // existsSync 兜住环境变量注入后文件又被移走的情形
    if (!scrcpyFound || !existsSync(scrcpy)) {
      return this.fail('BINARY_MISSING', '未找到 scrcpy 可执行文件，请先安装或配置路径')
    }

    // 同一设备已有活跃会话 → 拒绝（实测两台设备并发无冲突，但同设备会互相抢占）
    const existing = this.findBySerial(serial).find((s) => s.state === 'starting' || s.state === 'running')
    if (existing) {
      return this.fail('SESSION_EXISTS', '该设备已有投屏会话正在运行')
    }

    const id = `scr-${++this.seq}-${randomUUID().slice(0, 8)}`
    const args = buildArgs(serial, sanitizeOptions(opts))

    log.info(`启动投屏会话 ${id} 设备 ${shortSerial(serial)}`)

    let proc: ChildProcess
    try {
      proc = spawn(scrcpy, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      return this.fail('INTERNAL', err instanceof Error ? err.message : String(err))
    }

    const session: ScrcpySession = {
      id,
      serial,
      pid: proc.pid ?? null,
      state: 'starting',
      startedAt: Date.now()
    }
    this.sessions.set(id, session)
    this.procs.set(id, proc)
    this.stderrTails.set(id, [])
    this.emit('changed', session)

    const tail = this.stderrTails.get(id)!
    proc.stderr?.on('data', (chunk: Buffer) => {
      tail.push(String(chunk))
      if (tail.length > 60) tail.splice(0, tail.length - 60)
    })
    proc.stdout?.on('data', () => {
      /* scrcpy 的 INFO 输出不需要解析，保留管道以背压 */
    })

    proc.on('error', (err) => {
      log.error(`会话 ${id} 进程错误: ${err.message}`)
      this.markError(id, 'INTERNAL', `无法启动 scrcpy：${err.message}`)
    })

    proc.on('close', (code, signal) => {
      this.handleClose(id, code, signal)
    })

    // 启动宽限期：若进程在宽限期内退出且非 0，直接判定失败
    await new Promise((resolve) => setTimeout(resolve, STARTUP_GRACE_MS))

    const current = this.sessions.get(id)
    if (current && current.state === 'starting') {
      current.state = 'running'
      this.emit('changed', current)
      return { ok: true, value: current }
    }
    if (current && current.state === 'error') {
      return { ok: false, error: current.error! }
    }
    if (current && current.state === 'stopped') {
      return { ok: false, error: current.error ?? { code: 'INTERNAL', message: '会话已停止', retryable: true } }
    }
    return { ok: true, value: current! }
  }

  async stop(id: string): Promise<Result<void>> {
    const session = this.sessions.get(id)
    const proc = this.procs.get(id)
    if (!session) return this.fail('INTERNAL', '会话不存在')
    if (session.state === 'stopped' || session.state === 'error') return { ok: true, value: undefined }

    session.state = 'stopping'
    this.emit('changed', session)

    const pid = proc?.pid ?? session.pid
    log.info(`停止投屏会话 ${id}`)

    if (pid) {
      await this.killTree(pid, false)
      // 等待进程退出；超时后强杀
      const exited = await this.waitExit(id, STOP_TIMEOUT_MS)
      if (!exited) {
        log.warn(`会话 ${id} 未在 ${STOP_TIMEOUT_MS}ms 内退出，强制结束进程树`)
        await this.killTree(pid, true)
        await this.waitExit(id, STOP_TIMEOUT_MS)
      }
    }

    this.cleanup(id)
    return { ok: true, value: undefined }
  }

  /** 停止全部会话，供应用退出时调用 */
  async stopAll(): Promise<void> {
    const ids = this.list().map((s) => s.id)
    await Promise.all(ids.map((id) => this.stop(id)))
  }

  // ---------- 内部 ----------

  private handleClose(id: string, code: number | null, signal: NodeJS.Signals | null): void {
    const session = this.sessions.get(id)
    if (!session) return

    const tail = (this.stderrTails.get(id) ?? []).join('')
    session.exitCode = code
    session.stoppedAt = Date.now()

    if (session.state === 'stopping') {
      // 用户主动停止
      session.state = 'stopped'
      log.info(`会话 ${id} 已停止（退出码 ${code ?? signal}）`)
      this.emit('changed', session)
      this.cleanup(id)
      return
    }

    if (code === 0 || signal === 'SIGTERM') {
      session.state = 'stopped'
      this.emit('changed', session)
      this.cleanup(id)
      return
    }

    const { code: errCode, message } = classify(code, tail)
    log.error(`会话 ${id} 异常退出（退出码 ${code}，信号 ${signal}）：${message}`)
    this.markError(id, errCode, message)
  }

  private markError(id: string, code: AdapterErrorCode, message: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.state = 'error'
    session.error = { code, message, retryable: code !== 'BINARY_MISSING' }
    session.stoppedAt = Date.now()
    this.emit('changed', session)
    this.cleanup(id)
  }

  private cleanup(id: string): void {
    this.procs.delete(id)
    this.stderrTails.delete(id)
  }

  private waitExit(id: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = this.procs.get(id)
      if (!proc) return resolve(true)
      const timer = setTimeout(() => {
        proc.off('close', onClose)
        resolve(false)
      }, timeoutMs)
      const onClose = () => {
        clearTimeout(timer)
        resolve(true)
      }
      proc.once('close', onClose)
    })
  }

  private killTree(pid: number, force: boolean): Promise<void> {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        // /T 杀整个进程树：scrcpy 会拉起 adb 子进程，只杀自身会残留
        const args = ['/pid', String(pid), '/T']
        if (force) args.push('/F')
        execFile('taskkill', args, { windowsHide: true }, () => resolve())
        return
      }
      try {
        process.kill(force ? -pid : pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        /* 进程可能已退出 */
      }
      resolve()
    })
  }

  private fail(code: AdapterErrorCode, message: string): { ok: false; error: AdapterError } {
    return { ok: false, error: { code, message, retryable: code !== 'BINARY_MISSING' } }
  }
}

/**
 * 过滤来自渲染层的启动参数。IPC 传来的字段类型不可信：
 * 非法数字会变成 `--max-size=NaN` 直通 scrcpy，标题也可能超长。
 * 不认识的类型一律丢弃，而不是猜测转换。
 */
function sanitizeOptions(opts: StartOptions): StartOptions {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
  return {
    maxSize: num(opts.maxSize),
    windowTitle:
      typeof opts.windowTitle === 'string' && opts.windowTitle.trim()
        ? opts.windowTitle.trim().slice(0, 120)
        : undefined,
    windowX: typeof opts.windowX === 'number' && Number.isFinite(opts.windowX) ? opts.windowX : undefined,
    windowY: typeof opts.windowY === 'number' && Number.isFinite(opts.windowY) ? opts.windowY : undefined,
    windowWidth: num(opts.windowWidth),
    showTouches: opts.showTouches === true,
    stayAwake: opts.stayAwake === true,
    noWindow: opts.noWindow === true
  }
}

function buildArgs(serial: string, opts: StartOptions): string[] {
  const args = ['-s', serial]

  if (opts.windowTitle) args.push(`--window-title=${opts.windowTitle}`)
  if (opts.windowX !== undefined) args.push(`--window-x=${opts.windowX}`)
  if (opts.windowY !== undefined) args.push(`--window-y=${opts.windowY}`)
  if (opts.windowWidth !== undefined) args.push(`--window-width=${opts.windowWidth}`)
  if (opts.maxSize) args.push(`--max-size=${opts.maxSize}`)
  if (opts.showTouches) args.push('--show-touches')
  if (opts.stayAwake) args.push('--stay-awake')
  if (opts.noWindow) args.push('--no-window')

  return args
}

/** 依据退出码与 stderr 分类错误（实测依据见文件头） */
function classify(code: number | null, stderr: string): { code: AdapterErrorCode; message: string } {
  if (/could not find adb device/i.test(stderr)) {
    return { code: 'DEVICE_NOT_FOUND', message: '设备未连接或已离线，请检查 USB / 无线连接' }
  }
  if (/device unauthorized|failed to authenticate|authentication failed/i.test(stderr)) {
    return { code: 'AUTH_REQUIRED', message: '设备未授权调试，请在设备上确认 USB 调试授权' }
  }
  if (/address already in use|bind failed|port.*in use/i.test(stderr)) {
    return { code: 'RESOURCE_BUSY', message: '端口被占用，请关闭其他投屏程序后重试' }
  }
  if (/no such file|cannot find|is not recognized/i.test(stderr)) {
    return { code: 'BINARY_MISSING', message: '未找到 scrcpy 或 adb 可执行文件' }
  }
  return {
    code: 'INTERNAL',
    message: `scrcpy 异常退出（退出码 ${code ?? 'unknown'}）`
  }
}
