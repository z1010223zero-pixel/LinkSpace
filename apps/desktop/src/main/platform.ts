// 定位 scrcpy 与 adb 可执行文件。
//
// 查找顺序：
//   1. 环境变量 LINKSPACE_SCRCPY / LINKSPACE_ADB（测试与调试用）
//   2. 打包资源目录 <resourcesPath>/scrcpy/
//   3. PATH 中的 scrcpy.exe（adb 取同目录）
//   4. PATH 中的 adb.exe
//
// 注意：本机当前是开发环境，scrcpy 通过 winget 安装，未进 PATH，
// 因此保留了「已知 winget 安装路径」作为开发期兜底。正式分发时
// 应改为把 scrcpy 随安装包提供，并删除该兜底逻辑。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { VDD_ZIP_NAME } from './extend/vdd-driver'

export interface Binaries {
  scrcpy: string
  adb: string
  source: 'env' | 'resources' | 'path' | 'winget'
  /**
   * scrcpy 可执行文件是否真实存在。
   * scrcpy 字段在「只找到 adb」等场景下是占位值，调用方（IPC 的
   * ready 判定）必须以本字段为准，不能拿 scrcpy 路径做 existsSync
   * 之外的健康推断——占位值指向 adb 时 existsSync 反而是通过的。
   */
  scrcpyFound: boolean
}

let cached: Binaries | null = null

const EXE = process.platform === 'win32' ? '.exe' : ''

function pathEntries(): string[] {
  return (process.env.PATH ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 已知的 winget 安装路径（仅开发期兜底，正式发布应移除） */
function knownWingetDirs(): string[] {
  const local = process.env.LOCALAPPDATA
  if (!local) return []
  const base = join(local, 'Microsoft', 'WinGet', 'Packages')
  // 版本号会变，这里只匹配目录前缀
  return [
    join(base, 'Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe', 'scrcpy-win64-v5.0.1')
  ]
}

function findInDir(dir: string, name: string): string | null {
  const full = join(dir, name + EXE)
  return existsSync(full) ? full : null
}

export function locateBinaries(): Binaries {
  if (cached) return cached

  // 1. 环境变量
  const envScrcpy = process.env.LINKSPACE_SCRCPY
  const envAdb = process.env.LINKSPACE_ADB
  if (envScrcpy && existsSync(envScrcpy)) {
    cached = {
      scrcpy: envScrcpy,
      adb: envAdb && existsSync(envAdb) ? envAdb : guessAdbBeside(envScrcpy) ?? envScrcpy,
      source: 'env',
      scrcpyFound: true
    }
    return cached
  }

  // 2. 打包资源目录
  if (process.resourcesPath) {
    const dir = join(process.resourcesPath, 'scrcpy')
    const scrcpy = findInDir(dir, 'scrcpy')
    if (scrcpy) {
      cached = {
        scrcpy,
        adb: findInDir(dir, 'adb') ?? guessAdbBeside(scrcpy) ?? scrcpy,
        source: 'resources',
        scrcpyFound: true
      }
      return cached
    }
  }

  // 3. PATH 中的 scrcpy，adb 取同目录
  for (const dir of pathEntries()) {
    const scrcpy = findInDir(dir, 'scrcpy')
    if (scrcpy) {
      cached = {
        scrcpy,
        adb: findInDir(dir, 'adb') ?? guessAdbBeside(scrcpy) ?? scrcpy,
        source: 'path',
        scrcpyFound: true
      }
      return cached
    }
  }

  // 4. PATH 中的 adb：scrcpy 未找到，占位值必须是一个不存在的路径，
  // 让 existsSync 检查与 scrcpyFound 都能正确报告缺失
  for (const dir of pathEntries()) {
    const adb = findInDir(dir, 'adb')
    if (adb) {
      cached = { scrcpy: 'scrcpy', adb, source: 'path', scrcpyFound: false }
      return cached
    }
  }

  // 5. 已知 winget 安装路径（开发期）
  for (const dir of knownWingetDirs()) {
    const scrcpy = findInDir(dir, 'scrcpy')
    if (scrcpy) {
      cached = {
        scrcpy,
        adb: findInDir(dir, 'adb') ?? scrcpy,
        source: 'winget',
        scrcpyFound: true
      }
      return cached
    }
  }

  // 全部失败：返回占位，调用方需处理缺失
  cached = { scrcpy: 'scrcpy', adb: 'adb', source: 'winget', scrcpyFound: false }
  return cached
}

function guessAdbBeside(scrcpyPath: string): string | null {
  const dir = scrcpyPath.slice(0, Math.max(scrcpyPath.lastIndexOf('/'), scrcpyPath.lastIndexOf('\\')) + 1)
  return findInDir(dir, 'adb')
}

/** 清除缓存，便于测试 */
export function resetBinaryCache(): void {
  cached = null
  cachedNative = null
  cachedVddZip = undefined
}

// ---------- 虚拟显示器原生二进制（线 3，3.2-1） ----------
//
// 查找顺序：
//   1. 环境变量 LINKSPACE_SWD_HOST / LINKSPACE_DD_CAPTURE（测试与调试用）
//   2. 打包资源目录 <resourcesPath>/native/<swd-host|dd-capture>/
//      （electron-builder extraResources 须把两处 x64/Release 产物打进去，
//      否则打包后此路查不到——分发前补，见交接文档）
//   3. 开发期仓内构建产物 <repo>/native/<...>/x64/Release/*.exe
//      （electron-vite dev 时 cwd 在 apps/desktop，往上两级即仓根）
//
// 找不到时返回 null，不抛错：调用方（VirtualDisplayManager / 推流）
// 按“虚拟显示器不可用”降级，扩展请求回 session.reject、投屏回 error。
export interface NativeDisplayBinaries {
  swdHost: string | null
  ddCapture: string | null
}

let cachedNative: NativeDisplayBinaries | null = null

function findNative(name: 'swd-host' | 'dd-capture'): string | null {
  const exe = name + EXE
  const envVar = name === 'swd-host' ? 'LINKSPACE_SWD_HOST' : 'LINKSPACE_DD_CAPTURE'
  const envPath = process.env[envVar]
  if (envPath && existsSync(envPath)) return envPath
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const p = join(resourcesPath, 'native', name, exe)
    if (existsSync(p)) return p
  }
  // 开发期：cwd 在 apps/desktop（electron-vite dev）或仓根
  for (const base of [process.cwd(), join(process.cwd(), '..', '..')]) {
    const p = join(base, 'native', name, 'x64', 'Release', exe)
    if (existsSync(p)) return p
  }
  return null
}

export function locateVirtualDisplayBinaries(): NativeDisplayBinaries {
  if (cachedNative) return cachedNative
  cachedNative = { swdHost: findNative('swd-host'), ddCapture: findNative('dd-capture') }
  return cachedNative
}

/** 清除原生二进制缓存（与 resetBinaryCache 同口径，便于测试） */
export function resetNativeBinaryCache(): void {
  cachedNative = null
}

// ---------- VDD 驱动包（线 3，⑤） ----------
//
// 查找顺序：
//   1. 环境变量 LINKSPACE_VDD_ZIP（测试与调试用）
//   2. 打包资源目录 <resourcesPath>/vdd/<zip>
//      （electron-builder extraResources 须把 resources/vdd 打进去，
//      否则打包后此路查不到）
//   3. 开发期仓内 resources/vdd/<zip>（cwd 在 apps/desktop 或仓根）
//
// 找不到时返回 null，不抛错：VddDriverManager 的 status() 报
// packageBundled=false，ensureInstalled() 以 package-missing 拒绝，
// 其余功能不受影响。
let cachedVddZip: string | null | undefined = undefined

export function locateVddPackageZip(): string | null {
  if (cachedVddZip !== undefined) return cachedVddZip
  const envPath = process.env.LINKSPACE_VDD_ZIP
  if (envPath && existsSync(envPath)) {
    cachedVddZip = envPath
    return cachedVddZip
  }
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const p = join(resourcesPath, 'vdd', VDD_ZIP_NAME)
    if (existsSync(p)) {
      cachedVddZip = p
      return cachedVddZip
    }
  }
  for (const dir of [join(process.cwd(), 'resources', 'vdd'), join(process.cwd(), 'apps', 'desktop', 'resources', 'vdd')]) {
    const p = join(dir, VDD_ZIP_NAME)
    if (existsSync(p)) {
      cachedVddZip = p
      return cachedVddZip
    }
  }
  cachedVddZip = null
  return cachedVddZip
}

/** 清除 VDD 驱动包缓存（与 resetBinaryCache 同口径，便于测试） */
export function resetVddPackageCache(): void {
  cachedVddZip = undefined
}
