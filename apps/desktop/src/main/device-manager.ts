// 设备与会话聚合层（架构 L2 的原型实现）。
//
// 职责：合并 adb 枚举结果与投屏会话状态，向 UI 提供统一的设备视图。
// 布局持久化、信任关系在本阶段不实现，见 docs/architecture.md 第 7 节。

import { EventEmitter } from 'node:events'
import { AdbDevice, listDevices } from './adb'
import { ScrcpyAdapter, ScrcpySession } from './scrcpy-adapter'

export interface DeviceView {
  serial: string
  model?: string
  state: AdbDevice['state']
  wireless: boolean
  /** 该设备上处于活跃状态的会话 */
  activeSessions: ScrcpySession[]
}

export class DeviceManager extends EventEmitter {
  private devices: AdbDevice[] = []

  constructor(private readonly adapter: ScrcpyAdapter) {
    super()
    adapter.on('changed', () => this.emit('changed'))
  }

  /** 刷新设备列表并广播变更 */
  async refresh(): Promise<DeviceView[]> {
    this.devices = await listDevices()
    this.emit('changed')
    return this.view()
  }

  view(): DeviceView[] {
    return this.devices.map((d) => ({
      serial: d.serial,
      model: d.model,
      state: d.state,
      wireless: d.wireless,
      activeSessions: this.adapter
        .findBySerial(d.serial)
        .filter((s) => s.state === 'starting' || s.state === 'running' || s.state === 'stopping')
    }))
  }

  get count(): number {
    return this.devices.length
  }
}
