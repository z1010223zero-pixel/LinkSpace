// 设备与会话聚合层（架构 L2 的原型实现）。
//
// 职责：合并 adb 枚举结果与投屏会话状态，向 UI 提供统一的设备视图。
// 布局持久化、信任关系在本阶段不实现，见 docs/architecture.md 第 7 节。
//
// 2.5-1 统一设备模型：view() 不再只吐 adb 字段——经注入的身份解析回调
// （Host.scrcpyIdentityOf）把每条 serial 并上 LinkSpace 身份
// （deviceId / 配对 / 绑定 / 门禁放行），UI 据此决定「启动投屏」是否可点、
// 是否要先绑定。未注入解析器时退化为旧行为（四字段全空/假），DeviceManager
// 本身不直接依赖 Host，保持可测试。

import { EventEmitter } from 'node:events'
import { AdbDevice, tryListDevices, type ListDevicesResult } from './adb'
import { ScrcpyAdapter, ScrcpySession } from './scrcpy-adapter'
import type { ScrcpyIdentity } from './device-binding'
import { log } from './log'

export interface DeviceView {
  serial: string
  model?: string
  state: AdbDevice['state']
  wireless: boolean
  /** 该设备上处于活跃状态的会话 */
  activeSessions: ScrcpySession[]
  /** 解析到的 LinkSpace deviceId，未解析到为 null */
  deviceId: string | null
  /** 是否已配对（信任清单内） */
  paired: boolean
  /** 是否存在用户显式建立的 serial↔deviceId 绑定 */
  bound: boolean
  /** 门禁是否会放行（配对 + 绑定/IP-join 已满足），与 scrcpy:startFor 同口径 */
  scrcpyAllowed: boolean
}

export interface DeviceManagerOptions {
  /** serial → LinkSpace 身份解析（Host 注入；不注入则视图退化为 adb-only） */
  resolveIdentity?: (serial: string) => ScrcpyIdentity
  /** adb 枚举（默认 tryListDevices；测试注入桩） */
  enumerate?: () => Promise<ListDevicesResult>
}

// 陈旧会话确认次数：设备连续两次成功枚举都不见（UI 5 秒一轮询，约 10 秒），
// 才判定 scrcpy 进程已僵死——正常断开时 scrcpy 进程自己会在 1-2 秒内退出，
// 根本等不到第二次确认；一次就停会误杀 adb 枚举抖动时的健康会话。
const STALE_MISSING_REFRESHES = 2

const UNKNOWN_IDENTITY: ScrcpyIdentity = {
  deviceId: null,
  paired: false,
  bound: false,
  allowed: false
}

export class DeviceManager extends EventEmitter {
  private devices: AdbDevice[] = []
  private resolveIdentity: ((serial: string) => ScrcpyIdentity) | null
  private readonly enumerate: () => Promise<ListDevicesResult>
  /** serial → 连续成功枚举中缺失的次数（只在枚举成功时累计） */
  private missingRefreshes = new Map<string, number>()

  constructor(
    private readonly adapter: ScrcpyAdapter,
    opts: DeviceManagerOptions = {}
  ) {
    super()
    this.resolveIdentity = opts.resolveIdentity ?? null
    this.enumerate = opts.enumerate ?? tryListDevices
    adapter.on('changed', () => this.emit('changed'))
  }

  /** 运行时注入身份解析（index.ts 在 Host 建好后调用；与构造注入等价） */
  setIdentityResolver(fn: (serial: string) => ScrcpyIdentity): void {
    this.resolveIdentity = fn
  }

  /**
   * 刷新设备列表并广播变更（2.5 断开恢复）。
   * 枚举失败不是「没有设备」：保留上次列表，不闪空、不累计缺失、不误删会话。
   * 枚举成功时做陈旧会话清理，见 reconcileStaleSessions()。
   */
  async refresh(): Promise<DeviceView[]> {
    const r = await this.enumerate()
    if (!r.ok) {
      log.warn(`adb 枚举失败，保留上次设备列表: ${r.error}`)
      return this.view()
    }
    this.devices = r.devices
    this.reconcileStaleSessions()
    this.emit('changed')
    return this.view()
  }

  /**
   * 陈旧会话清理：设备已从 adb 列表消失，但 scrcpy 会话还挂着。
   * 正常断开（USB 拔出/断网）时 scrcpy 进程自己退出，adapter 的 close
   * 处理会把会话归位，根本走不到这里；走到这里的基本是进程僵死
   * （如 adb server 挂掉后 scrcpy 进程僵住），须主动停掉，否则 UI 上
   * 「投屏中」的卡片永远下不来。确认两次才停，防枚举抖动误杀。
   */
  private reconcileStaleSessions(): void {
    const present = new Set(this.devices.map((d) => d.serial))
    const active = this.adapter
      .list()
      .filter((s) => s.state === 'starting' || s.state === 'running' || s.state === 'stopping')
    for (const s of active) {
      if (present.has(s.serial)) {
        this.missingRefreshes.delete(s.serial)
        continue
      }
      const missed = (this.missingRefreshes.get(s.serial) ?? 0) + 1
      if (missed < STALE_MISSING_REFRESHES) {
        this.missingRefreshes.set(s.serial, missed)
        continue
      }
      this.missingRefreshes.delete(s.serial)
      log.warn(`设备 ${s.serial} 已连续 ${STALE_MISSING_REFRESHES} 次不在 adb 列表中，停止其陈旧 scrcpy 会话 ${s.id}`)
      void this.adapter.stop(s.id).catch((err) => {
        log.warn(`停止陈旧 scrcpy 会话 ${s.id} 失败: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  view(): DeviceView[] {
    return this.devices.map((d) => {
      const id = this.resolveIdentity?.(d.serial) ?? UNKNOWN_IDENTITY
      return {
        serial: d.serial,
        model: d.model,
        state: d.state,
        wireless: d.wireless,
        activeSessions: this.adapter
          .findBySerial(d.serial)
          .filter((s) => s.state === 'starting' || s.state === 'running' || s.state === 'stopping'),
        deviceId: id.deviceId,
        paired: id.paired,
        bound: id.bound,
        scrcpyAllowed: id.allowed
      }
    })
  }

  get count(): number {
    return this.devices.length
  }
}
