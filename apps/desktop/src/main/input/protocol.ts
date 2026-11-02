// 键鼠共享的线上事件编解码（阶段 3，第 7 组）。
//
// 与剪贴板同理：最容易写错的部分是**不可信输入的收敛**。input.event
// 的 payload 完全来自对端，而注入层直接对接 Win32 SendInput——字段
// 白名单、数值钳制、坐标映射任何一处失守，都等于给已配对设备开了
// 一个「随意伪造本机输入」的通道。因此编解码集中在这个纯模块里，
// 无头测试可以逐字段钉死边界。
//
// 事件用 JSON 承载（局域网带宽充裕，键鼠事件体积极小），
// 坐标用**控制端屏幕绝对坐标**传输，被控端按两端屏幕尺寸比例映射。
// 选绝对坐标而不是相对增量：轮询采集天然只有绝对位置，且丢一帧
// 不会造成永久偏移——增量法一次丢包就再也回不到正确位置。

export type MouseButton = 'left' | 'right' | 'middle'

/** 单条输入事件。字段名取短：批量事件里每字节都要过网络 */
export type InputEvent =
  | { t: 'move'; x: number; y: number }
  | { t: 'down'; b: MouseButton }
  | { t: 'up'; b: MouseButton }
  | { t: 'wheel'; dx: number; dy: number }
  | { t: 'key'; vk: number; down: boolean }

export interface ScreenSize {
  w: number
  h: number
}

/** 单条 input.event 消息的事件数上限。超限整批丢弃并留痕 */
export const MAX_EVENTS_PER_MESSAGE = 64

/** Windows 虚拟屏幕坐标上限（SM_CXVIRTUALSCREEN 理论最大 32768） */
const MAX_COORD = 32768

const MOUSE_BUTTONS: readonly string[] = ['left', 'right', 'middle']

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 整数化坐标并钳制进合法范围，越界值直接拒绝该事件 */
function clampCoord(v: number): number | null {
  const n = Math.round(v)
  if (n < 0 || n > MAX_COORD) return null
  return n
}

/**
 * 校验并收敛一批输入事件。返回收敛后的事件数组；
 * 含任何非法事件时整批拒绝（返回 null）——逐条放行会让「洗掉非法
 * 字段」变成一种可依赖的容错，攻击者可以借机探测字段语义。
 */
export function decodeInputEvents(raw: unknown): InputEvent[] | null {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { events?: unknown }).events)) {
    return null
  }
  const list = (raw as { events: unknown[] }).events
  if (list.length === 0 || list.length > MAX_EVENTS_PER_MESSAGE) return null

  const out: InputEvent[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) return null
    const ev = item as Record<string, unknown>
    switch (ev.t) {
      case 'move': {
        if (!isFiniteNum(ev.x) || !isFiniteNum(ev.y)) return null
        const x = clampCoord(ev.x)
        const y = clampCoord(ev.y)
        if (x === null || y === null) return null
        out.push({ t: 'move', x, y })
        break
      }
      case 'down':
      case 'up': {
        if (typeof ev.b !== 'string' || !MOUSE_BUTTONS.includes(ev.b)) return null
        out.push(ev.t === 'down' ? { t: 'down', b: ev.b as MouseButton } : { t: 'up', b: ev.b as MouseButton })
        break
      }
      case 'wheel': {
        if (!isFiniteNum(ev.dx) || !isFiniteNum(ev.dy)) return null
        // 滚轮刻度钳制：正常一帧不会超过 ±10 刻度，钳住极端值
        const dx = Math.max(-1000, Math.min(1000, Math.round(ev.dx)))
        const dy = Math.max(-1000, Math.min(1000, Math.round(ev.dy)))
        out.push({ t: 'wheel', dx, dy })
        break
      }
      case 'key': {
        if (!isFiniteNum(ev.vk)) return null
        const vk = Math.round(ev.vk)
        // VK 码 0..255。Win32 虚拟键空间远大于此，但键鼠共享只需要
        // 常规键盘（0x01..0xFE 已覆盖），越界一律拒绝
        if (vk < 0 || vk > 255) return null
        if (typeof ev.down !== 'boolean') return null
        out.push({ t: 'key', vk, down: ev.down })
        break
      }
      default:
        return null // 未知事件类型：整批拒绝而非跳过，理由同上
    }
  }
  return out
}

/** 校验对端自报的屏幕尺寸（session.start / session.accept 的 params.screen） */
export function decodeScreenSize(raw: unknown): ScreenSize | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Record<string, unknown>
  if (!isFiniteNum(s.w) || !isFiniteNum(s.h)) return null
  const w = Math.round(s.w)
  const h = Math.round(s.h)
  // 至少 1×1：0 会让比例映射除零
  if (w < 1 || h < 1 || w > MAX_COORD || h > MAX_COORD) return null
  return { w, h }
}

/** sessionId 字符集约束，与 transferId 同规则（进 URL 与组合键） */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 控制端坐标 → 被控端坐标的比例映射。
 * round 后钳进目标屏幕边界：控制端屏幕尺寸与映射结果是自报的，
 * 不能让越界坐标进注入层。
 */
export function mapPoint(
  x: number,
  y: number,
  from: ScreenSize,
  to: ScreenSize
): { x: number; y: number } {
  const mx = Math.min(to.w - 1, Math.max(0, Math.round((x * to.w) / from.w)))
  const my = Math.min(to.h - 1, Math.max(0, Math.round((y * to.h) / from.h)))
  return { x: mx, y: my }
}

/** 单条 input.text 消息的文本上限（UTF-8 字节，协议 4.9）。超长由控制端分段 */
export const MAX_INPUT_TEXT_BYTES = 8 * 1024

/** UTF-8 字节长（按码位计，代理对按一个码位算 4 字节） */
export function utf8ByteLength(text: string): number {
  let n = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

/**
 * 把文本按 UTF-8 字节切成 ≤ MAX_INPUT_TEXT_BYTES 的段。
 * 按码位切分，绝不拆开代理对/多字节字符；空文本返回空数组。
 */
export function segmentInputText(text: string): string[] {
  if (!text) return []
  const segments: string[] = []
  let cur = ''
  let curBytes = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const b = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (curBytes + b > MAX_INPUT_TEXT_BYTES && cur) {
      segments.push(cur)
      cur = ''
      curBytes = 0
    }
    cur += ch
    curBytes += b
  }
  if (cur) segments.push(cur)
  return segments
}
