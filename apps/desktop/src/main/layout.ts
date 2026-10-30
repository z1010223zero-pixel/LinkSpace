// 设备卡片布局持久化。
//
// 设备列表的顺序由 adb 返回顺序决定，本质上是不稳定的：拔插一次线、
// 换一个 USB 口、无线设备重连，顺序就会变。用户刚记住「第二张卡是我的手机」，
// 下一次启动就换了位置——这种抖动比功能缺失更烦人。
//
// 所以布局要显式持久化，而不是每次启动重新推断。
//
// 只存**顺序**（serial 数组），不存绝对坐标：坐标会和窗口尺寸、DPI、
// 设备数量耦合，任何一项变了布局就崩。顺序 + CSS Grid 自适应流动，
// 既稳定又不用处理重排。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface LayoutStoreOptions {
  /** 布局文件所在目录；测试可注入临时目录 */
  dir?: string
}

interface LayoutFile {
  version: 1
  /** 设备序列号的有序列表。未知设备追加在末尾 */
  order: string[]
}

export class LayoutStore {
  private readonly filePath: string
  private order: string[] = []

  constructor(opts: LayoutStoreOptions = {}) {
    // 默认目录只会在测试直构（不传 dir）时用到：落 tmpdir 而非 cwd（审查 P3）
    const dir = opts.dir ?? join(tmpdir(), 'linkspace-layout')
    this.filePath = join(dir, 'layout.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as LayoutFile
      if (parsed.version !== 1 || !Array.isArray(parsed.order)) return
      this.order = parsed.order.filter((s): s is string => typeof s === 'string')
    } catch {
      // 布局坏了只是摆放不对，不能因此起不来：丢弃重排
      this.order = []
    }
  }

  private persist(): void {
    const dir = join(this.filePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data: LayoutFile = { version: 1, order: this.order }
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.filePath)
  }

  /** 当前保存的顺序（快照） */
  get(): string[] {
    return [...this.order]
  }

  set(order: string[]): void {
    // 去重：拖拽事件偶发重复，留下第一次出现的位置
    const seen = new Set<string>()
    this.order = order.filter((s) => typeof s === 'string' && s.length > 0 && !seen.has(s) && seen.add(s))
    this.persist()
  }

  /**
   * 按保存顺序排序。未在布局里出现过的设备（新设备、换过序列号）
   * 追加到末尾，保持它们在原数组里的相对次序——不做任何隐式猜测。
   */
  sort<T>(items: T[], keyOf: (item: T) => string): T[] {
    const rank = new Map<string, number>()
    this.order.forEach((s, i) => rank.set(s, i))
    const FALLBACK = Number.MAX_SAFE_INTEGER
    return items
      .map((item, i) => ({ item, i, rank: rank.get(keyOf(item)) ?? FALLBACK }))
      .sort((a, b) => (a.rank === b.rank ? a.i - b.i : a.rank - b.rank))
      .map((x) => x.item)
  }
}
