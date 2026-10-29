// 本机显示名持久化。
//
// 设备显示名（5.4）由本机拥有：改名后要经 device.rename 广播给对端、
// 并更新 mDNS 服务名，重启后仍生效，因此必须落盘。
// 与 TrustStore（存对端）/ LayoutStore（存卡片顺序）一样是独立小文件，
// 单独一个 profile.json 避免把「本机配置」混进「对端信任」语义里。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ProfileStoreOptions {
  /** 配置文件所在目录；测试可注入临时目录 */
  dir?: string
}

interface ProfileFile {
  version: 1
  displayName: string
}

export class ProfileStore {
  private readonly filePath: string
  private displayName = ''

  constructor(opts: ProfileStoreOptions = {}) {
    const dir = opts.dir ?? join(process.cwd(), '.profile-test')
    this.filePath = join(dir, 'profile.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<ProfileFile>
      if (parsed.version !== 1 || typeof parsed.displayName !== 'string') return
      this.displayName = parsed.displayName
    } catch {
      // 配置损坏只是名字退回默认值，不能因此起不来
      this.displayName = ''
    }
  }

  private persist(): void {
    const dir = join(this.filePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data: ProfileFile = { version: 1, displayName: this.displayName }
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.filePath)
  }

  /** 已保存的显示名，从未改过时为空（调用方退回默认名） */
  get(): string {
    return this.displayName
  }

  set(name: string): void {
    this.displayName = name
    this.persist()
  }
}

/**
 * 显示名清洗：去控制字符、去首尾空白、限长 60。
 * 对端发来的 device.rename 与本机改名共用这一条规则，两端约定一致
 * （Android 侧在 LinkSpaceService.sanitizeDisplayName 有等价实现）。
 * 返回空串表示无效名，调用方应拒绝而非退回默认——静默回退会让
 * 「改名为空」看起来成功，对端却没更新。
 */
export function sanitizeDisplayName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60)
}
