// 边缘穿越状态机（验收 7.1 / 7.3 / 7.4）。
//
// 鼠标移到屏幕边缘 → 切换控制对应侧的设备。这个「一句话」的行为
// 真做起来有三个经典坑，全部收在这个纯逻辑模块里：
//
//   1. **贴边抖动**：用户把鼠标顶在边缘不动，每次采样都触发切换。
//      → 触发后进入锁定态，鼠标离开边缘带（LEAVE_BAND_PX）才重新武装。
//   2. **切过去立刻弹回**：切换到远端后本机鼠标仍顶在边缘，任何
//      一次误触发都会把控制权弹回本机。→ 同上，锁定态兜底。
//   3. **退出后立刻又触发**（7.4 的反面）：快捷键退回本机时鼠标
//      大概率还停在边缘。→ 退出路径显式调 lock()，重新武装只能靠
//      鼠标离开边缘带，而不是靠时间——用户思考的功夫可长可短。
//
// 冷却时间只防「同一贴边动作内的重复触发」，语义与锁定不同：冷却
// 是短暂的（毫秒级，给物理抖动留余量），锁定必须靠人为移动解除。

import type { ScreenSize } from './protocol'

export type EdgeSide = 'left' | 'right' | 'top' | 'bottom'

export const ALL_EDGES: readonly EdgeSide[] = ['left', 'right', 'top', 'bottom']

/** 触发带：鼠标距边缘 ≤ 该值视为「压边」 */
export const EDGE_BAND_PX = 1

/** 解锁带：距所有边缘均 > 该值才重新武装 */
export const LEAVE_BAND_PX = 24

/** 同一次贴边的触发冷却 */
export const DEFAULT_COOLDOWN_MS = 800

/** deviceId → 该设备位于本机哪一侧。空缺的边不触发 */
export type EdgeLayout = Partial<Record<EdgeSide, string>>

export interface EdgeSwitcherOptions {
  onSwitch: (edge: EdgeSide, deviceId: string) => void
  screen: ScreenSize
  cooldownMs?: number
  now?: () => number
}

export class EdgeSwitcher {
  private layout: EdgeLayout = {}
  private screen: ScreenSize
  private armed = true
  private locked = false
  private lastTriggerAt = 0
  private readonly cooldownMs: number
  private readonly onSwitch: (edge: EdgeSide, deviceId: string) => void
  private readonly now: () => number

  constructor(opts: EdgeSwitcherOptions) {
    this.onSwitch = opts.onSwitch
    this.screen = opts.screen
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.now = opts.now ?? Date.now
  }

  setLayout(layout: EdgeLayout): void {
    this.layout = layout
  }

  setScreen(screen: ScreenSize): void {
    this.screen = screen
  }

  /** 是否处于武装态（压边可触发）。测试与 UI 提示用 */
  get isArmed(): boolean {
    return this.armed
  }

  /** 是否被显式锁定（退出控制后的防抖状态）。UI 提示用 */
  get isLocked(): boolean {
    return this.locked
  }

  /** 显式锁定（7.4 退出控制时调用）。离开边缘带才解除 */
  lock(): void {
    this.armed = false
    this.locked = true
  }

  /**
   * 喂入一次鼠标采样（本机屏幕绝对坐标）。
   * 锁定/未武装状态下只判断是否解除，绝不触发。
   */
  feed(x: number, y: number): void {
    const { w, h } = this.screen
    const nearLeft = x <= EDGE_BAND_PX
    const nearRight = x >= w - 1 - EDGE_BAND_PX
    const nearTop = y <= EDGE_BAND_PX
    const nearBottom = y >= h - 1 - EDGE_BAND_PX

    if (!this.armed) {
      // 离开所有边缘带 → 解除锁定重新武装。锁定态与普通未武装
      // 共用解除条件：都要求一次「主动远离边缘」的动作
      if (!nearLeft && !nearRight && !nearTop && !nearBottom && this.farFromAllEdges(x, y)) {
        this.armed = true
        this.locked = false
      }
      return
    }
    if (this.now() - this.lastTriggerAt < this.cooldownMs) return

    // 触发优先级固定：水平优先于垂直（角落时行为可预期）
    if (nearLeft && this.layout.left) this.fire('left', this.layout.left)
    else if (nearRight && this.layout.right) this.fire('right', this.layout.right)
    else if (nearTop && this.layout.top) this.fire('top', this.layout.top)
    else if (nearBottom && this.layout.bottom) this.fire('bottom', this.layout.bottom)
  }

  private farFromAllEdges(x: number, y: number): boolean {
    const { w, h } = this.screen
    return (
      x > LEAVE_BAND_PX &&
      x < w - 1 - LEAVE_BAND_PX &&
      y > LEAVE_BAND_PX &&
      y < h - 1 - LEAVE_BAND_PX
    )
  }

  private fire(edge: EdgeSide, deviceId: string): void {
    this.armed = false
    this.locked = true
    this.lastTriggerAt = this.now()
    this.onSwitch(edge, deviceId)
  }
}
