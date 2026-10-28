// 信任清单（TrustStore）。
//
// 「发现不等于可信」。mDNS 只能证明某台设备在局域网里，能不能给它发文件、
// 让它控制本机，完全由这份清单决定。它是方案 6.4 配对流程的持久化结果。
//
// 关键规则：
//   - 只有 pair.approve 之后才写入条目，且必须记录**对方证书指纹**
//   - 撤销是幂等的，撤销后该设备的所有能力立即失效
//   - scope 显式列出授权的能力，控制类能力不默认授予
//   - 清单不含任何密钥，只含公开信息（ID、指纹、能力范围）

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 授权范围。控制类（投屏/键鼠）不默认授予，需二次授权 */
export type TrustScope = 'file' | 'clipboard' | 'control'

export const ALL_SCOPES: TrustScope[] = ['file', 'clipboard', 'control']

export interface TrustEntry {
  deviceId: string
  displayName: string
  deviceType: string
  /** 对方设备证书的 SHA-256 指纹，TOFU 建立信任的依据 */
  fingerprint: string
  scope: TrustScope[]
  trustedAt: number
}

export interface TrustStoreOptions {
  /** 清单文件所在目录；测试可注入临时目录 */
  dir?: string
  /** 默认授权范围。配对时用户可增减，这里只提供默认值 */
  defaultScope?: TrustScope[]
}

interface TrustFile {
  version: 1
  devices: TrustEntry[]
}

/**
 * 信任清单。
 * 目录可注入，使其能在无 Electron 环境下被测试复用。
 */
export class TrustStore {
  private readonly filePath: string
  private readonly defaultScope: TrustScope[]
  private entries: TrustEntry[] = []

  constructor(opts: TrustStoreOptions = {}) {
    const dir = opts.dir ?? join(process.cwd(), '.trust-test')
    this.filePath = join(dir, 'trust.json')
    this.defaultScope = opts.defaultScope ?? ['file']
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as TrustFile
      if (parsed.version !== 1 || !Array.isArray(parsed.devices)) return
      this.entries = parsed.devices.filter(isTrustEntry)
    } catch {
      // 清单损坏不应导致应用无法启动：丢弃并重新开始，但要在日志留痕
      this.entries = []
    }
  }

  private persist(): void {
    const dir = join(this.filePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data: TrustFile = { version: 1, devices: this.entries }
    // 先写临时文件再改名，避免写入中途崩溃留下半个 JSON
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.filePath)
  }

  isKnown(deviceId: string): boolean {
    return this.entries.some((e) => e.deviceId === deviceId)
  }

  hasScope(deviceId: string, scope: TrustScope): boolean {
    return this.entries.some((e) => e.deviceId === deviceId && e.scope.includes(scope))
  }

  scopeOf(deviceId: string): TrustScope[] {
    return this.entries.find((e) => e.deviceId === deviceId)?.scope ?? []
  }

  fingerprintOf(deviceId: string): string | null {
    return this.entries.find((e) => e.deviceId === deviceId)?.fingerprint ?? null
  }

  list(): TrustEntry[] {
    return this.entries.map((e) => ({ ...e, scope: [...e.scope] }))
  }

  /** 新增或更新信任。重复 approve 同一设备时刷新指纹与范围 */
  grant(entry: Omit<TrustEntry, 'trustedAt'> & { trustedAt?: number }): void {
    const next: TrustEntry = {
      deviceId: entry.deviceId,
      displayName: entry.displayName,
      deviceType: entry.deviceType,
      fingerprint: entry.fingerprint,
      scope: entry.scope.length ? entry.scope : this.defaultScope,
      trustedAt: entry.trustedAt ?? Date.now()
    }
    const idx = this.entries.findIndex((e) => e.deviceId === entry.deviceId)
    if (idx >= 0) this.entries[idx] = next
    else this.entries.push(next)
    this.persist()
  }

  /** 撤销信任。幂等，撤销后该设备所有能力立即失效 */
  revoke(deviceId: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.deviceId !== deviceId)
    const changed = this.entries.length !== before
    if (changed) this.persist()
    return changed
  }

  /** 与对端通告的指纹比对，不一致说明设备身份被替换或中间人 */
  matchesFingerprint(deviceId: string, fingerprint: string): boolean {
    return this.fingerprintOf(deviceId) === fingerprint
  }
}

function isTrustEntry(v: unknown): v is TrustEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Partial<TrustEntry>
  return (
    typeof e.deviceId === 'string' &&
    typeof e.displayName === 'string' &&
    typeof e.deviceType === 'string' &&
    typeof e.fingerprint === 'string' &&
    Array.isArray(e.scope) &&
    typeof e.trustedAt === 'number'
  )
}
