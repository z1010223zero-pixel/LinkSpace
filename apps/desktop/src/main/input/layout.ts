// 键鼠共享的布局存储（验收 7.3）。
//
// 记录「每台已配对设备位于本机哪一侧」。它与设备卡片顺序
// （LayoutStore）是两回事：卡片顺序是 UI 排列，这里是**控制拓扑**——
// 鼠标移向本机的哪条边，就切换控制放在那条边上的设备。
//
// 结构刻意与 TrustStore 一致（原子写 + 版本号 + 损坏降级）：
// 布局写坏不该让应用起不来，丢掉的只是几张卡片摆哪边的偏好。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_EDGES, type EdgeLayout, type EdgeSide } from './edge'

interface InputLayoutFile {
  version: 1
  /** deviceId → 边 */
  edges: EdgeLayout
}

export class InputLayoutStore {
  private readonly filePath: string
  /** deviceId → 边。键是设备 ID，用 Record 承载；对外仍是 EdgeLayout 形状 */
  private edges: Record<string, EdgeSide> = {}

  constructor(opts: { dir?: string } = {}) {
    // 默认目录只会在测试直构（不传 dir）时用到：落 tmpdir 而非 cwd（审查 P3）
    const dir = opts.dir ?? join(tmpdir(), 'linkspace-input-layout')
    this.filePath = join(dir, 'input-layout.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as InputLayoutFile
      if (parsed.version !== 1 || typeof parsed.edges !== 'object' || parsed.edges === null) return
      const clean: Record<string, EdgeSide> = {}
      for (const [deviceId, side] of Object.entries(parsed.edges as Record<string, unknown>)) {
        if (deviceId && typeof side === 'string' && ALL_EDGES.includes(side as EdgeSide)) {
          clean[deviceId] = side as EdgeSide
        }
      }
      this.edges = clean
    } catch {
      // 布局损坏按丢失处理：偏好文件不该阻断应用启动
      this.edges = {}
    }
  }

  private persist(): void {
    const dir = join(this.filePath, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data: InputLayoutFile = { version: 1, edges: this.edges }
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.filePath)
  }

  /** 某设备被摆在哪条边。未设置返回 null */
  edgeOf(deviceId: string): EdgeSide | null {
    return this.edges[deviceId] ?? null
  }

  /** 设置设备所在边；side 为 null 表示清除。同一设备只能占一边 */
  setEdge(deviceId: string, side: EdgeSide | null): void {
    if (!deviceId) return
    if (side === null) {
      if (this.edges[deviceId] === undefined) return
      delete this.edges[deviceId]
    } else {
      if (!ALL_EDGES.includes(side)) return
      // 清掉其他设备占用同一边的记录：一条边只放一台设备，
      // 否则边缘触发时无法唯一确定要控制谁
      for (const [id, s] of Object.entries(this.edges)) {
        if (s === side && id !== deviceId) delete this.edges[id]
      }
      this.edges[deviceId] = side
    }
    this.persist()
  }

  /** 全量快照。UI 与 EdgeSwitcher 的 setLayout 都吃这个形状 */
  all(): EdgeLayout {
    return { ...this.edges } as EdgeLayout
  }
}
