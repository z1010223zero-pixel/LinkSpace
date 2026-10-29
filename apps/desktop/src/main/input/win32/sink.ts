// SendInput 注入层（被控端）。
//
// 把 input/protocol 的 InputEvent 翻译成 Win32 INPUT 结构。这是
// 「对端可以操纵本机」的最后一站，因此：
//   - 只接受 decodeInputEvents 收敛后的事件（上游已做白名单与钳制），
//     本层对越界坐标再做一次归一化钳制，纵深防御；
//   - 结构体偏移手工计算而不是用 koffi struct：INPUT 是含 union 的
//     变长对齐结构，手工 Buffer 打包完全可控且可无头测试。
//
// INPUT 布局（C 对齐规则）：
//   x64/arm64：type@0(4) pad(4) union@8，MOUSEINPUT=28B，INPUT=40B
//   ia32     ：type@0(4) union@4， MOUSEINPUT=24B，INPUT=28B
// MOUSEINPUT：dx@+0 dy@+4 mouseData@+8 dwFlags@+12 time@+16 extra@+20
// KEYBDINPUT：wVk@+0 wScan@+2 dwFlags@+4 time@+8 extra@+12

import type { InputEvent, MouseButton } from '../protocol'
import type { Win32Native } from './native'

/** 指针宽度决定 INPUT 尺寸。arm64 与 x64 同为 8 */
const PTR_SIZE = process.arch === 'ia32' ? 4 : 8
/** 单个 INPUT 的字节数，SendInput 的 cbSize 参数 */
export const INPUT_SIZE = PTR_SIZE === 8 ? 40 : 28
/** union 字段在 INPUT 内的起始偏移（测试断言用） */
export const UNION_OFF = PTR_SIZE === 8 ? 8 : 4

const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_MIDDLEDOWN = 0x0020
const MOUSEEVENTF_MIDDLEUP = 0x0040
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_HWHEEL = 0x1000
const MOUSEEVENTF_VIRTUALDESK = 0x4000
const MOUSEEVENTF_ABSOLUTE = 0x8000

const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002

/** WHEEL_DELTA：一档滚轮的标准增量 */
export const WHEEL_DELTA = 120

/** 需要带 KEYEVENTF_EXTENDEDKEY 注入的键。漏标会导致方向键/Ins/Del
 * 等被系统当作小键盘键注入，行为完全不同 */
const EXTENDED_VKS: ReadonlySet<number> = new Set([
  0x21, 0x22, 0x23, 0x24, // PgUp PgDn End Home
  0x25, 0x26, 0x27, 0x28, // 方向键
  0x2c, 0x2d, 0x2e, // PrtSc Ins Del
  0x5b, 0x5c, // Win 键
  0x6f, // 小键盘除号
  0xa3, 0xa5 // 右 Ctrl / 右 Alt
])

export function isExtendedVk(vk: number): boolean {
  return EXTENDED_VKS.has(vk)
}

/**
 * 屏幕坐标 → SendInput 绝对坐标（0..65535，跨虚拟屏幕归一化）。
 * 结果钳制进范围：上游坐标来自对端（自报屏幕尺寸），不信任。
 */
export function normalizeAbsolute(
  x: number,
  y: number,
  vs: { x: number; y: number; w: number; h: number }
): { nx: number; ny: number } {
  const nx = Math.max(0, Math.min(65535, Math.round(((x - vs.x) * 65535) / Math.max(1, vs.w - 1))))
  const ny = Math.max(0, Math.min(65535, Math.round(((y - vs.y) * 65535) / Math.max(1, vs.h - 1))))
  return { nx, ny }
}

const BUTTON_FLAGS: Record<MouseButton, { down: number; up: number }> = {
  left: { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP },
  right: { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP },
  middle: { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP }
}

function writeMouse(buf: Buffer, off: number, dx: number, dy: number, flags: number, mouseData: number): void {
  buf.writeInt32LE(dx, off + UNION_OFF)
  buf.writeInt32LE(dy, off + UNION_OFF + 4)
  buf.writeInt32LE(mouseData, off + UNION_OFF + 8)
  buf.writeUInt32LE(flags, off + UNION_OFF + 12)
  buf.writeUInt32LE(0, off + UNION_OFF + 16) // time
  // dwExtraInfo：指针宽度字段，写 0
  buf.writeUInt32LE(0, off + UNION_OFF + 20)
  if (PTR_SIZE === 8) buf.writeUInt32LE(0, off + UNION_OFF + 24)
}

function writeKey(buf: Buffer, off: number, vk: number, up: boolean, extended: boolean): void {
  buf.writeUInt16LE(vk, off + UNION_OFF)
  buf.writeUInt16LE(0, off + UNION_OFF + 2) // wScan：只按 VK 注入
  const flags = (up ? KEYEVENTF_KEYUP : 0) | (extended && !up ? KEYEVENTF_EXTENDEDKEY : 0)
  buf.writeUInt32LE(flags, off + UNION_OFF + 4)
  buf.writeUInt32LE(0, off + UNION_OFF + 8) // time
  buf.writeUInt32LE(0, off + UNION_OFF + 12)
  if (PTR_SIZE === 8) buf.writeUInt32LE(0, off + UNION_OFF + 16)
}

/**
 * 把一批事件打包成连续的 INPUT 数组。
 * 按下的键/键位同时记入 pressedKeys/pressedButtons（releaseAll 用）。
 * 返回 null 表示屏幕无效或无可注入内容——调用方静默跳过。
 */
export function buildInputBatch(
  events: InputEvent[],
  vs: { x: number; y: number; w: number; h: number },
  pressedKeys: Set<number>,
  pressedButtons: Set<MouseButton>
): Buffer | null {
  if (!Number.isFinite(vs.w) || !Number.isFinite(vs.h) || vs.w < 1 || vs.h < 1) return null
  // 滚轮双轴会拆成两条 INPUT，上限 2 倍
  const buf = Buffer.alloc(INPUT_SIZE * events.length * 2)
  let off = 0
  let count = 0

  const push = (write: (off: number) => void): void => {
    write(off)
    off += INPUT_SIZE
    count++
  }

  for (const ev of events) {
    switch (ev.t) {
      case 'move': {
        const { nx, ny } = normalizeAbsolute(ev.x, ev.y, vs)
        push((o) =>
          writeMouse(buf, o, nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, 0)
        )
        break
      }
      case 'down': {
        pressedButtons.add(ev.b)
        push((o) => writeMouse(buf, o, 0, 0, BUTTON_FLAGS[ev.b].down, 0))
        break
      }
      case 'up': {
        pressedButtons.delete(ev.b)
        push((o) => writeMouse(buf, o, 0, 0, BUTTON_FLAGS[ev.b].up, 0))
        break
      }
      case 'wheel': {
        // dx/dy 各自独立成条（协议允许双轴同帧）
        if (ev.dx !== 0) {
          push((o) => writeMouse(buf, o, 0, 0, MOUSEEVENTF_HWHEEL, ev.dx * WHEEL_DELTA))
        }
        if (ev.dy !== 0) {
          push((o) => writeMouse(buf, o, 0, 0, MOUSEEVENTF_WHEEL, ev.dy * WHEEL_DELTA))
        }
        break
      }
      case 'key': {
        if (ev.down) pressedKeys.add(ev.vk)
        else pressedKeys.delete(ev.vk)
        const vk = ev.vk
        const up = !ev.down
        push((o) => writeKey(buf, o, vk, up, isExtendedVk(vk)))
        break
      }
    }
  }
  if (count === 0) return null
  return buf.subarray(0, count * INPUT_SIZE)
}

/**
 * 终止会话时抬起所有仍处于按下状态的东西（防卡键）。
 * 对端断连/撤销时来不及收到 'up' 事件，唯一可靠的补救是本机主动抬起。
 */
export function buildReleaseBatch(pressedKeys: Set<number>, pressedButtons: Set<MouseButton>): Buffer | null {
  const n = pressedKeys.size + pressedButtons.size
  if (n === 0) return null
  const buf = Buffer.alloc(INPUT_SIZE * n)
  let off = 0
  let count = 0
  for (const vk of pressedKeys) {
    writeKey(buf, off, vk, true, isExtendedVk(vk))
    off += INPUT_SIZE
    count++
  }
  for (const b of pressedButtons) {
    writeMouse(buf, off, 0, 0, BUTTON_FLAGS[b].up, 0)
    off += INPUT_SIZE
    count++
  }
  pressedKeys.clear()
  pressedButtons.clear()
  return buf.subarray(0, count * INPUT_SIZE)
}

/** 真实注入器：buildInputBatch 的产物交给 Win32Native.sendInput */
export class SendInputSink {
  private readonly pressedKeys = new Set<number>()
  private readonly pressedButtons = new Set<MouseButton>()

  constructor(
    private readonly native: Win32Native,
    private readonly log?: (msg: string) => void
  ) {}

  inject(events: InputEvent[]): void {
    const buf = buildInputBatch(events, this.native.virtualScreen(), this.pressedKeys, this.pressedButtons)
    if (!buf) return
    const count = buf.length / INPUT_SIZE
    if (!this.native.sendInput(buf, count)) {
      this.log?.(`SendInput 注入失败（${count} 条）`)
    }
  }

  /** 会话终止时抬起所有按住状态。幂等 */
  releaseAll(): void {
    const buf = buildReleaseBatch(this.pressedKeys, this.pressedButtons)
    if (!buf) return
    this.native.sendInput(buf, buf.length / INPUT_SIZE)
  }
}
