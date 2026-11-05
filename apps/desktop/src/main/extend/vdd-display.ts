// VDD 后端的虚拟显示器管理器（线 3，④）。
//
// 与 VirtualDisplayManager（extend/virtual-display.ts，swd-host 后端）
// 相同的接口形状：create(preferred) / destroy() / active / currentScreen /
// available。后端换成开源 VDD 设备节点 + VddDriverManager（⑤）：
//   - create：查驱动状态 → ensureSettings(count≥1) → 记录会话前设备
//     是否已启用 → setDeviceEnabled(true) → 在 listDisplays() 里等新
//     显示器出现（创建前后差分、按最接近 preferred 挑一块，复用 phase 3
//     的逻辑）→ 超时约 30s 失败。
//   - destroy：只有本次会话是我们启用了节点时才禁用它；会话前已启用的
//     保持启用；清掉 screen。无活动显示器时是安全空操作。
//   - available：驱动已装（最近一次 status() 的 installed）即 true。
//
// 安全红线（与 ⑤ 同口径）：
//   - 会话创建时绝不自动安装驱动。未安装时 create 直接返回可操作的
//     reason 失败，安装是设置页里的用户显式动作（IPC vdd-driver:install）。
//   - 创建失败不留残留：若本次会话启用了设备节点但新显示器未出现，
//     create 会把节点恢复回禁用（会话前的状态）。
//   - 本文件不直接碰 Enable/Disable-PnpDevice：启用/禁用全部经
//     VddDriverManager.setDeviceEnabled()，命令执行层由它注入。
//
// 设备节点创建已于 ⑥ 实现（自研 SetupDi 助手，随安装流程创建节点；
// 见 docs/line3-vdd.md「⑥ 实现」）。create 里 installed=true 但
// devicePresent=false（例如节点被手动删除，或由旧版本装的驱动）
// 仍返回可操作的 reason，提示用户回设置页重装一次创建节点，
// 不当成安装失败误报。
//
// 依赖可注入（driver、listDisplays、超时时间），供 fake 测试。

import { log } from '../log'
import type { VddSettingsResult, VddSimpleResult } from './vdd-driver'
import type { VddDriverStatus } from '../../shared/types'
import type { VirtualDisplayCreateResult, VirtualDisplayRect } from './virtual-display'

/** VddVirtualDisplayManager 只依赖驱动管理器的这三个方法；VddDriverManager 结构上满足。 */
export interface VddDriverLike {
  status(): Promise<VddDriverStatus>
  ensureSettings(
    count: number,
    preferred?: { width: number; height: number; refreshRate?: number }
  ): Promise<VddSettingsResult>
  setDeviceEnabled(enabled: boolean): Promise<VddSimpleResult>
}

export interface VddVirtualDisplayManagerOptions {
  /** 驱动管理器（生产传 VddDriverManager；测试传 fake） */
  driver: VddDriverLike
  /** 当前显示器列表（物理像素，与 DD rect / Win32 虚拟屏同基准） */
  listDisplays: () => VirtualDisplayRect[]
  /** 等新显示器出现的上限，默认 30s */
  appearTimeoutMs?: number
}

const DEFAULT_APPEAR_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 250

/** 两矩形是否同一块显示器（创建前后差分用，与 virtual-display.ts 同口径） */
function sameRect(a: VirtualDisplayRect, b: VirtualDisplayRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/** 与请求尺寸的距离：宽高差之和，越小越接近（与 virtual-display.ts 同口径） */
function sizeDistance(r: VirtualDisplayRect, preferred: { width: number; height: number } | null): number {
  if (!preferred) return 0
  return Math.abs(r.w - preferred.width) + Math.abs(r.h - preferred.height)
}

export class VddVirtualDisplayManager {
  private screen: VirtualDisplayRect | null = null
  /** 本次会话是否由我们启用了设备节点（destroy 时据此决定是否禁用） */
  private enabledByUs = false
  /** 正在创建中（Coordinator 保证不会重入，此处是防御） */
  private creating = false
  /** 最近一次 status() 的 installed 快照（available 的依据；未查过时 null） */
  private lastInstalled: boolean | null = null
  private readonly driver: VddDriverLike
  private readonly listDisplays: () => VirtualDisplayRect[]
  private readonly appearTimeoutMs: number

  constructor(opts: VddVirtualDisplayManagerOptions) {
    this.driver = opts.driver
    this.listDisplays = opts.listDisplays
    this.appearTimeoutMs = opts.appearTimeoutMs ?? DEFAULT_APPEAR_TIMEOUT_MS
  }

  /** 驱动已装（最近一次 status() 快照）即 true；未查过状态时保守为 false */
  get available(): boolean {
    return this.lastInstalled === true
  }

  /** 当前是否有本管理器创建的虚拟显示器 */
  get active(): boolean {
    return this.screen !== null
  }

  /** 当前虚拟显示器的矩形；未创建时 null */
  get currentScreen(): VirtualDisplayRect | null {
    return this.screen ? { ...this.screen } : null
  }

  /**
   * 创建虚拟显示器。成功返回其矩形；失败返回可操作的原因（调用方据此回
   * session.reject）。同一时刻只允许一个：已创建时直接返回当前矩形。
   *
   * 绝不自动安装驱动：未安装时直接失败，安装是设置页的用户显式动作。
   */
  async create(preferred: { width: number; height: number } | null): Promise<VirtualDisplayCreateResult> {
    if (this.screen) return { ok: true, screen: { ...this.screen } }
    if (this.creating) {
      return { ok: false, reason: 'virtual display creation in progress' }
    }
    this.creating = true
    try {
      let st: VddDriverStatus
      try {
        st = await this.driver.status()
      } catch (err) {
        return { ok: false, reason: `VDD 驱动状态查询失败：${String(err)}` }
      }
      this.lastInstalled = st.installed
      if (!st.installed) {
        return {
          ok: false,
          reason: 'VDD 驱动未安装：请先在设置页安装虚拟显示驱动（VDD 25.7.23），再发起扩展屏请求'
        }
      }
      if (!st.devicePresent) {
        // 设备节点缺失：驱动已装，但节点不存在（例如被手动删除，或由旧版本
        // 装的驱动）；节点创建是安装流程的一部分，回设置页重装一次即可。
        return {
          ok: false,
          reason:
            'VDD 驱动已安装，但设备节点未创建（硬件 ID Root\\MttVDD）：请回设置页点一次「安装虚拟显示器驱动」，安装流程会创建节点'
        }
      }

      // 设置：保证至少一块虚拟屏。节点会话前已启用时，改完设置要下次
      // 启用才生效——count 平时已是 1，本步多为无操作，不阻塞创建。
      const settings = await this.driver.ensureSettings(
        1,
        preferred ? { width: preferred.width, height: preferred.height } : undefined
      )
      if (!settings.ok) {
        return {
          ok: false,
          reason: `VDD 设置写入失败：${settings.detail ?? settings.reason ?? '未知错误'}`
        }
      }

      const wasEnabled = st.deviceEnabled
      this.enabledByUs = !wasEnabled
      const before = this.listDisplays()
      if (!wasEnabled) {
        const enabled = await this.driver.setDeviceEnabled(true)
        if (!enabled.ok) {
          this.enabledByUs = false
          return { ok: false, reason: `启用 VDD 设备失败：${enabled.detail}` }
        }
        log.info('[vdd-display] VDD 设备节点已启用，等待新显示器出现')
      } else {
        log.info('[vdd-display] VDD 设备节点会话前已启用，直接等新显示器出现')
      }

      // 等新显示器出现：创建前后差分，按最接近请求尺寸挑一块。
      const start = Date.now()
      let retriedToggle = false
      for (;;) {
        const after = this.listDisplays()
        const fresh = after.filter((r) => !before.some((b) => sameRect(b, r)))
        if (fresh.length > 0) {
          fresh.sort((a, b) => sizeDistance(a, preferred) - sizeDistance(b, preferred))
          const chosen = fresh[0]!
          this.screen = { ...chosen }
          log.info(
            `[vdd-display] 虚拟显示器已创建：${chosen.w}x${chosen.h} @ ${chosen.x},${chosen.y}` +
              (fresh.length > 1 ? `（同批新出现 ${fresh.length} 块，按最接近请求尺寸挑）` : '')
          )
          return { ok: true, screen: { ...chosen } }
        }
        if (wasEnabled && !retriedToggle && Date.now() - start >= 500) {
          retriedToggle = true
          log.info('[vdd-display] 节点预先已启用但首轮无差分，500ms 后自动重启节点刷新基线')
          await this.driver.setDeviceEnabled(false)
          await new Promise((r) => setTimeout(r, 200))
          await this.driver.setDeviceEnabled(true)
          this.enabledByUs = true
        }
        if (Date.now() - start >= this.appearTimeoutMs) {
          // 失败不留残留：本次会话启用了节点则恢复回禁用；会话前已启用的不动。
          await this.restoreEnabledState()
          return {
            ok: false,
            reason: `虚拟显示器未出现（启用 VDD 设备后 ${Math.round(this.appearTimeoutMs / 1000)} 秒内未枚举到新显示器）：请检查驱动状态或重新发起扩展屏请求`
          }
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      }
    } finally {
      this.creating = false
    }
  }

  /**
   * 销毁虚拟显示器：只有本次会话是我们启用了节点时才禁用它；会话前已
   * 启用的保持启用；清掉 screen。无活动显示器时是安全空操作。
   * 返回 Promise<void>，确保退出或结束清理时能等待禁用落定。
   */
  async destroy(): Promise<void> {
    if (!this.screen && !this.enabledByUs) return
    const shouldDisable = this.enabledByUs
    this.screen = null
    this.enabledByUs = false
    if (!shouldDisable) {
      log.info('[vdd-display] 虚拟显示器已释放（设备节点会话前已启用，保持启用）')
      return
    }
    try {
      const r = await this.driver.setDeviceEnabled(false)
      if (r.ok) log.info('[vdd-display] VDD 设备节点已禁用（本次会话启用过，现恢复）')
      else log.warn(`[vdd-display] VDD 设备节点恢复禁用失败：${r.detail}`)
    } catch (err) {
      log.warn(`[vdd-display] VDD 设备节点恢复禁用异常：${String(err)}`)
    }
    log.info('[vdd-display] 虚拟显示器已销毁')
  }

  /** 创建失败路径：把本次会话启用过的节点恢复回禁用（尽力而为，不抛错） */
  private async restoreEnabledState(): Promise<void> {
    if (!this.enabledByUs) return
    this.enabledByUs = false
    try {
      const r = await this.driver.setDeviceEnabled(false)
      if (r.ok) log.info('[vdd-display] 创建失败，VDD 设备节点已恢复禁用')
      else log.warn(`[vdd-display] 创建失败，VDD 设备节点恢复禁用失败：${r.detail}`)
    } catch (err) {
      log.warn(`[vdd-display] 创建失败，VDD 设备节点恢复禁用异常：${String(err)}`)
    }
  }
}
