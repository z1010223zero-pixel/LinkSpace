// 本机显示名持久化。
//
// 设备显示名（5.4）由本机拥有：改名后要经 device.rename 广播给对端、
// 并更新 mDNS 服务名，重启后仍生效，因此必须落盘。
// 与 TrustStore（存对端）/ LayoutStore（存卡片顺序）一样是独立小文件，
// 单独一个 profile.json 避免把「本机配置」混进「对端信任」语义里。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ProfileStoreOptions {
  /** 配置文件所在目录；测试可注入临时目录 */
  dir?: string
}

interface ProfileFile {
  version: 1
  displayName: string
  /** 剪贴板同步开关（审查 P2-1）。缺省视为关：静默双向同步需要用户明示授权 */
  clipboardEnabled?: boolean
  /** 上次成功监听的服务端口。重启后优先复用——对端的 mDNS 缓存对
   * 「同名服务换端口」的再通告可能迟迟不重解析（NsdManager 只对
   * 新发现的服务触发 resolve），端口一变对端就要瘫 5 分钟 */
  lastPort?: number
}

export class ProfileStore {
  private readonly filePath: string
  private displayName = ''
  private clipboardOn = false
  private lastPort = 0

  constructor(opts: ProfileStoreOptions = {}) {
    // 默认目录只会在测试直构（不传 dir）时用到：落 tmpdir 而非 cwd，
    // 避免在生产工作目录留下测试残留（审查 P3）
    const dir = opts.dir ?? join(tmpdir(), 'linkspace-profile')
    this.filePath = join(dir, 'profile.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<ProfileFile>
      if (parsed.version !== 1 || typeof parsed.displayName !== 'string') return
      this.displayName = parsed.displayName
      if (typeof parsed.clipboardEnabled === 'boolean') this.clipboardOn = parsed.clipboardEnabled
      if (typeof parsed.lastPort === 'number' && parsed.lastPort > 0) this.lastPort = parsed.lastPort
    } catch {
      // 配置损坏只是名字退回默认值，不能因此起不来
      this.displayName = ''
    }
  }

  private persist(): void {
    const dir = join(this.filePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data: ProfileFile = {
      version: 1,
      displayName: this.displayName,
      clipboardEnabled: this.clipboardOn,
      lastPort: this.lastPort || undefined
    }
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

  /** 剪贴板同步开关的持久化值（审查 P2-1）。未设置过 = false（默认关） */
  getClipboardEnabled(): boolean {
    return this.clipboardOn
  }

  setClipboardEnabled(enabled: boolean): void {
    this.clipboardOn = enabled
    this.persist()
  }

  /** 上次成功监听的端口；0 = 从未记录。仅供启动时优先尝试绑定 */
  getLastPort(): number {
    return this.lastPort
  }

  setLastPort(port: number): void {
    if (port === this.lastPort) return
    this.lastPort = port
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
  // C1 控制符（U+0080–U+009F）与双向/隔离覆盖符一并清除（审查 P3）：
  // U+202E 等可让后续文字逆序渲染，进 UI 与日志即成显示层欺骗
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 60)
}
