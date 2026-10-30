// 控制端输入采集层。
//
// 控制期间本机的鼠标/键盘要「跟随」到对端（7.2）。采集用轮询而不是
// 低级钩子（理由见 native.ts 头注）：每个 tick 读一次光标位置与全部
// 虚拟键状态，与上一轮对比产出事件。tick 由外部定时器驱动（index.ts），
// 本类保持同步纯逻辑，无头测试可以精确驱动。
//
// 模式：
//   idle      —— 只喂边缘检测（7.1）：位置变化时回调 onEdgeMove
//   control   —— 采集输入并回调 onEvents；边缘检测停止，否则切过去的
//                第一次移动就会在源屏幕边缘再次触发切换
//   suspended —— 受控挂起（审查 P2-3）：本机输入正被对端注入驱动，
//                此时的光标移动不是本机用户意图，喂边缘检测或转发都
//                等于让对端借本机无授权驱动第三方设备。只保基线
//
// 已知限制（MVP 接受）：
//   - 滚轮是事件不是状态，轮询无法捕获 → 不转发滚轮
//   - 单个 tick 内完成「按下并抬起」的极速敲击会丢失（<12ms 极罕见）
//   - 本机输入不被屏蔽：控制期间按键同时作用于两端（无钩子吃不掉）

import type { InputEvent, MouseButton, ScreenSize } from '../protocol'
import { MAX_EVENTS_PER_MESSAGE } from '../protocol'

/** 采集只需要读取能力（isKeyDown/getCursorPos），比 Win32Native 更窄 */
export interface CaptureNative {
  getCursorPos(): { x: number; y: number } | null
  isKeyDown(vk: number): boolean
}

export interface Win32CaptureDeps {
  native: CaptureNative
  /** 本机主屏尺寸。控制端坐标 = 本机屏幕绝对坐标，超出部分钳入 */
  screen: ScreenSize
  /** 采集到的一批输入事件（≤64 条/批，与协议单消息上限对齐） */
  onEvents(events: InputEvent[]): void
  /** 非控制态的光标移动（喂 EdgeSwitcher） */
  onEdgeMove?(x: number, y: number): void
}

/** 鼠标键的虚拟键码。X1/X2（0x05/0x06）协议不承载，跳过 */
const BUTTON_VKS: ReadonlyArray<readonly [number, MouseButton]> = [
  [0x01, 'left'],
  [0x02, 'right'],
  [0x04, 'middle']
]

/** 键盘轮询范围：0x08 起跳过鼠标键与未定义区，0xFE 收尾 */
export const KEY_POLL_MIN = 0x08
export const KEY_POLL_MAX = 0xfe

export type CaptureMode = 'idle' | 'control' | 'suspended'

export class Win32InputCapture {
  private mode: CaptureMode = 'idle'
  private readonly keys = new Set<number>()
  private readonly buttons = new Set<MouseButton>()
  private lastPos: { x: number; y: number } | null = null

  constructor(private readonly deps: Win32CaptureDeps) {}

  /**
   * 切换模式时清空全部「上一轮」状态：新会话的第一 tick 只建立基线
   * 不产事件——否则进入控制态的瞬间会把光标从旧位置传过去（瞬移），
   * 退出时会把「退出那一刻的按键」传成一个多余的 down
   */
  setMode(mode: CaptureMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.keys.clear()
    this.buttons.clear()
    this.lastPos = null
  }

  get currentMode(): CaptureMode {
    return this.mode
  }

  /** 单次轮询。由 index.ts 的定时器驱动，也可在测试里手工驱动 */
  tick(): void {
    const raw = this.deps.native.getCursorPos()
    if (!raw) {
      // 读取失败（如窗口站切换）：丢基线，下轮重建，避免位置跳变
      this.lastPos = null
      return
    }
    const { w, h } = this.deps.screen
    // GetCursorPos 给的是虚拟屏幕坐标（多显示器可为负），而协议坐标
    // 空间是主屏——多显示器场景钳到主屏边缘（MVP 降级），保证不产出
    // 被对端解码器拒收的负坐标
    const x = Math.max(0, Math.min(w - 1, raw.x))
    const y = Math.max(0, Math.min(h - 1, raw.y))

    if (this.mode === 'suspended') {
      // 受控挂起（审查 P2-3）：不喂边缘、不产事件，只维护基线，
      // 退出挂起时第一 tick 不会把挂起期间的光标跳变当事件
      this.lastPos = { x, y }
      return
    }

    if (this.mode === 'idle') {
      // 光标在主屏之外（副屏）不喂边缘检测（审查 P3）：坐标钳到主屏边界
      // 后 nearRight 恒真，移向副屏即误触发边缘穿越。主屏在虚拟屏坐标系
      // 的原点恰为 (0,0)，越界判定不需要副屏信息
      const onPrimary = raw.x >= 0 && raw.x < w && raw.y >= 0 && raw.y < h
      if (onPrimary && this.lastPos && (this.lastPos.x !== x || this.lastPos.y !== y)) {
        this.deps.onEdgeMove?.(x, y)
      }
      this.lastPos = { x, y }
      return
    }

    // ---------- 控制态采集 ----------
    const events: InputEvent[] = []

    if (this.lastPos && (this.lastPos.x !== x || this.lastPos.y !== y)) {
      events.push({ t: 'move', x, y })
    }

    for (const [vk, b] of BUTTON_VKS) {
      const down = this.deps.native.isKeyDown(vk)
      if (down && !this.buttons.has(b)) {
        this.buttons.add(b)
        events.push({ t: 'down', b })
      } else if (!down && this.buttons.has(b)) {
        this.buttons.delete(b)
        events.push({ t: 'up', b })
      }
    }

    for (let vk = KEY_POLL_MIN; vk <= KEY_POLL_MAX; vk++) {
      const down = this.deps.native.isKeyDown(vk)
      if (down && !this.keys.has(vk)) {
        this.keys.add(vk)
        events.push({ t: 'key', vk, down: true })
      } else if (!down && this.keys.has(vk)) {
        this.keys.delete(vk)
        events.push({ t: 'key', vk, down: false })
      }
    }

    this.lastPos = { x, y }

    if (events.length > 0) {
      // 单消息事件数有硬上限（decodeInputEvents 整批拒绝超长批次），
      // 极端情况（全键回弹）也要按协议分批
      for (let i = 0; i < events.length; i += MAX_EVENTS_PER_MESSAGE) {
        this.deps.onEvents(events.slice(i, i + MAX_EVENTS_PER_MESSAGE))
      }
    }
  }
}
