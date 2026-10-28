// adb 设备枚举。
//
// 只做「读」：列设备、取属性。不做任何写操作（不 push、不 connect、
// 不开启无线调试）——开启无线调试属于高权限动作，必须显式授权，
// 见 docs/threat-model.md T7。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { locateBinaries } from './platform'
import { log, shortSerial } from './log'

const execFileAsync = promisify(execFile)

export type AdbState = 'device' | 'offline' | 'unauthorized' | 'unknown'

export interface AdbDevice {
  serial: string
  state: AdbState
  model?: string
  product?: string
  transportId?: string
  /** 是否无线连接（序列号含 ._adb-tls-connect._tcp 等） */
  wireless: boolean
}

const KNOWN_STATES = new Set(['device', 'offline', 'unauthorized', 'bootloader', 'recovery'])

function isWireless(serial: string): boolean {
  return serial.includes('._adb-tls-connect._tcp') || serial.includes(':5555')
}

/** 解析 `adb devices -l` 输出 */
export function parseDevicesOutput(stdout: string): AdbDevice[] {
  const lines = stdout.split(/\r?\n/)
  const out: AdbDevice[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('List of devices attached')) continue
    if (trimmed.startsWith('adb server')) continue
    if (trimmed.startsWith('* daemon')) continue

    const [serial, ...rest] = trimmed.split(/\s+/)
    if (!serial || rest.length === 0) continue

    const rawState = rest[0] ?? ''
    const state: AdbState = (KNOWN_STATES.has(rawState) ? rawState : 'unknown') as AdbState

    const device: AdbDevice = { serial, state, wireless: isWireless(serial) }

    for (const token of rest.slice(1)) {
      const idx = token.indexOf(':')
      if (idx <= 0) continue
      const key = token.slice(0, idx)
      const value = token.slice(idx + 1)
      if (key === 'model') device.model = value
      else if (key === 'product') device.product = value
      else if (key === 'transport_id') device.transportId = value
    }

    out.push(device)
  }

  return out
}

export async function listDevices(timeoutMs = 8000): Promise<AdbDevice[]> {
  const { adb } = locateBinaries()
  try {
    const { stdout } = await execFileAsync(adb, ['devices', '-l'], {
      timeout: timeoutMs,
      windowsHide: true
    })
    const devices = parseDevicesOutput(stdout)
    log.info(`adb 枚举到 ${devices.length} 台设备`)
    return devices
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`adb devices 失败: ${msg}`)
    return []
  }
}

/** 读取单个设备属性（原型阶段用于补充型号信息） */
export async function getDeviceProp(serial: string, prop: string): Promise<string | null> {
  const { adb } = locateBinaries()
  try {
    const { stdout } = await execFileAsync(adb, ['-s', serial, 'shell', 'getprop', prop], {
      timeout: 5000,
      windowsHide: true
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** 供 UI 展示的连接方式描述 */
export function describeTransport(device: AdbDevice): string {
  if (device.wireless) return '无线'
  return 'USB'
}

export function deviceLabel(device: AdbDevice): string {
  const model = device.model ?? device.product ?? '未知设备'
  return `${model}（${shortSerial(device.serial)}）`
}
