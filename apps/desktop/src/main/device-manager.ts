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
import { AdbDevice, listDevices } from './adb'
import { ScrcpyAdapter, ScrcpySession } from './scrcpy-adapter'
import type { ScrcpyIdentity } from './device-binding'

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
}

const UNKNOWN_IDENTITY: ScrcpyIdentity = {
  deviceId: null,
  paired: false,
  bound: false,
  allowed: false
}

export class DeviceManager extends EventEmitter {
  private devices: AdbDevice[] = []
  private resolveIdentity: ((serial: string) => ScrcpyIdentity) | null

  constructor(
    private readonly adapter: ScrcpyAdapter,
    opts: DeviceManagerOptions = {}
  ) {
    super()
    this.resolveIdentity = opts.resolveIdentity ?? null
    adapter.on('changed', () => this.emit('changed'))
  }

  /** 运行时注入身份解析（index.ts 在 Host 建好后调用；与构造注入等价） */
  setIdentityResolver(fn: (serial: string) => ScrcpyIdentity): void {
    this.resolveIdentity = fn
  }

  /** 刷新设备列表并广播变更 */
  async refresh(): Promise<DeviceView[]> {
    this.devices = await listDevices()
    this.emit('changed')
    return this.view()
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
