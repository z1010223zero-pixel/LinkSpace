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
}
