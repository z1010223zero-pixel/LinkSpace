// Win32 原生绑定（koffi FFI）。
//
// 所有 FFI 细节（DLL 加载、签名声明、struct 定义）集中在这一个模块，
// 上层（sink/capture）只依赖 Win32Native 接口——它们因此可以在无头
// 测试里用假实现驱动，而真实的 SendInput/GetCursorPos 绝不出现在测试里。
//
// 失败降级：非 Windows 平台、koffi 加载失败、DLL 符号缺失一律返回
// null，由调用方决定降级行为（键鼠共享入口隐藏/提示），绝不抛异常
// 打断主进程启动。
//
// 为什么用轮询（GetCursorPos/GetAsyncKeyState）而不是低级钩子采集：
// LL 钩子需要原生回调 + 消息泵，koffi 回调在 Electron 主线程上的
// 重入风险高；轮询是纯函数调用，无回调机制。代价是滚轮无法捕获
// （滚轮是事件不是状态）与极端快速敲击可能丢帧，MVP 可接受。

/** 注入与采集共用的原生能力面。字段刻意最小化，便于测试桩实现 */
export interface Win32Native {
  /** 当前光标位置（虚拟屏幕坐标，多显示器可为负）。失败返回 null */
  getCursorPos(): { x: number; y: number } | null
  /** 指定虚拟键当前是否按下 */
  isKeyDown(vk: number): boolean
  /** 虚拟屏幕（多显示器并集）bounds，SendInput 绝对坐标的归一化基准 */
  virtualScreen(): { x: number; y: number; w: number; h: number }
  /**
   * 批量注入 INPUT 结构。buf 为连续排布的 INPUT 数组（紧凑打包，
   * 步长见 INPUT_SIZE），count 为条数。返回是否全部成功。
   */
  sendInput(buf: Buffer, count: number): boolean
}

// sink.ts 对本模块只有类型依赖（编译期擦除），无运行时环
import { INPUT_SIZE } from './sink'

let cached: Win32Native | null | undefined

/** 进程级单例加载。失败结果同样缓存，避免每次调用都重试 DLL 加载 */
export function loadWin32(): Win32Native | null {
  if (cached === undefined) cached = tryLoad()
  return cached
}

/** 测试用：清空单例缓存（native.ts 只在注入假 koffi 时才会被引用） */
export function resetWin32Cache(): void {
  cached = undefined
}

function tryLoad(): Win32Native | null {
  if (process.platform !== 'win32') return null
  try {
    // 延迟 require：koffi 是原生模块，保持与其他平台隔离
    const koffi = require('koffi') as {
      load(dll: string): {
        func(sig: string): (...args: unknown[]) => unknown
      }
      struct(name: string, fields: Record<string, string>): unknown
    }
    const user32 = koffi.load('user32.dll')
    // struct 注册表是全局的，重复定义会抛错；cached 保证本函数只跑一次
    koffi.struct('POINT', { x: 'long', y: 'long' })

    const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)') as (
      pt: { x: number; y: number }
    ) => boolean
    const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)') as (
      vk: number
    ) => number
    const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)') as (
      idx: number
    ) => number
    // INPUT 结构未在 koffi 注册，用 void * 承载 Buffer：
    // 若写成「INPUT *」koffi 会在定义时抛 Unknown type name，
    // 整个注入层将静默降级为 null
    const SendInput = user32.func(
      'uint32_t __stdcall SendInput(uint32_t cInputs, void *pInputs, int cbSize)'
    ) as (count: number, buf: Buffer, cbSize: number) => number

    return {
      getCursorPos() {
        try {
          const pt = { x: 0, y: 0 }
          if (!GetCursorPos(pt)) return null
          return { x: pt.x, y: pt.y }
        } catch {
          return null
        }
      },
      isKeyDown(vk: number): boolean {
        try {
          // 高位为 1 表示当前按下（koffi 把 short 还原成有符号数，
          // JS 按位与按 32 位补码处理，结果一致）
          return (GetAsyncKeyState(vk) & 0x8000) !== 0
        } catch {
          return false
        }
      },
      virtualScreen() {
        // 76/77/78/79 = SM_XVIRTUALSCREEN / SM_YVIRTUALSCREEN /
        // SM_CXVIRTUALSCREEN / SM_CYVIRTUALSCREEN
        const x = GetSystemMetrics(76)
        const y = GetSystemMetrics(77)
        const w = GetSystemMetrics(78)
        const h = GetSystemMetrics(79)
        return { x, y, w: w > 0 ? w : 1, h: h > 0 ? h : 1 }
      },
      sendInput(buf: Buffer, count: number): boolean {
        try {
          // cbSize 必须是单个 INPUT 的字节数（见 sink.ts 的 INPUT_SIZE）
          return SendInput(count, buf, INPUT_SIZE) === count
        } catch {
          return false
        }
      }
    }
  } catch {
    return null
  }
}
