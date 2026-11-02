// adb serial ↔ LinkSpace deviceId 绑定（W2 安全修复）。
//
// 背景：桌面端有两个互不相认的设备模型——adb 模型只有 serial/model/state/
// wireless，LinkSpace 模型只有 deviceId（peers 表 + TrustStore），两者
// 之间没有任何 join key。scrcpy:startFor 原先只校验 serial 是非空字符串
// 就放行，任意 adb 可见设备都能直接投屏。
//
// join 方案（见 docs/line2-line3-direction.md §4 W2）：
//   - 无线 adb：serial 本身就是 host:port，用 LAN IP 做 join——adb 主机 IP
//     == 该设备 LinkSpace 控制连接的 remoteAddress，且该连接对端已配对。
//   - USB 有线 adb：没有 IP 可 join，fail closed——未绑定过的 USB 设备
//     拒绝启动 scrcpy。绑定由用户在桌面端显式建立一次、持久化到本地
//     （与信任条目同处一个 dataDir，不进协议），不做型号/显示名模糊匹配。
//
// 本文件是纯逻辑，不依赖 Electron：映射解析 + 持久化存储都可无头测试。
// 授权判定（TrustStore / peers 表）由调用方以回调注入，保持可测试。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface DeviceBinding {
  /** adb serial（无线为 host:port，USB 为设备序列号） */
  serial: string
  /** LinkSpace deviceId（证书派生） */
  deviceId: string
  boundAt: number
}

/**
 * scrcpy 设备身份（2.5-1 统一设备模型）：adb 侧的 serial 解析到 LinkSpace
 * 侧的 deviceId 后的快照。DeviceManager.view() 经它把两套模型并成一套，
 * UI 据此决定「启动投屏」是否可点、是否要先绑定。
 */
export interface ScrcpyIdentity {
  /** 解析到的 LinkSpace deviceId，未解析到为 null */
  deviceId: string | null
  /** 是否已配对（信任清单内） */
  paired: boolean
  /** 是否存在用户显式建立的 serial↔deviceId 绑定 */
  bound: boolean
  /** 门禁是否会放行（配对 + 绑定/IP-join 已满足） */
  allowed: boolean
}

export interface DeviceBindingStoreOptions {
  /** 绑定文件所在目录；与 TrustStore 同处一个 dataDir。测试可注入临时目录 */
  dir?: string
}

interface BindingFile {
  version: 1
  bindings: DeviceBinding[]
}

/**
 * serial↔deviceId 绑定存储。持久化方式参照 TrustStore：先写临时文件
 * 再改名，避免写入中途崩溃留下半个 JSON；损坏时丢弃并重新开始。
 */
export class DeviceBindingStore {
  private readonly filePath: string
  private bindings: DeviceBinding[] = []

  constructor(opts: DeviceBindingStoreOptions = {}) {
    const dir = opts.dir ?? join(tmpdir(), "linkspace-trust")
    this.filePath = join(dir, "device-bindings.json")
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const raw = readFileSync(this.filePath, "utf8")
      const parsed = JSON.parse(raw) as BindingFile
      if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) return
      this.bindings = parsed.bindings.filter(isDeviceBinding)
    } catch {
      // 绑定损坏不应导致应用无法启动：丢弃并重新开始，但要在日志留痕
      this.bindings = []
    }
  }

  private persist(): void {
    const dir = join(this.filePath, "..")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data: BindingFile = { version: 1, bindings: this.bindings }
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8")
    renameSync(tmp, this.filePath)
  }

  /** 建立或更新一条绑定（同一 serial 改绑到另一设备会覆盖旧条目） */
  bind(serial: string, deviceId: string): DeviceBinding {
    const entry: DeviceBinding = { serial, deviceId, boundAt: Date.now() }
    const idx = this.bindings.findIndex((b) => b.serial === serial)
    if (idx >= 0) this.bindings[idx] = entry
    else this.bindings.push(entry)
    this.persist()
    return { ...entry }
  }

  /** 删除一条绑定。返回是否实际删掉了条目 */
  unbind(serial: string): boolean {
    const before = this.bindings.length
    this.bindings = this.bindings.filter((b) => b.serial !== serial)
    const changed = this.bindings.length !== before
    if (changed) this.persist()
    return changed
  }

  deviceIdOf(serial: string): string | null {
    return this.bindings.find((b) => b.serial === serial)?.deviceId ?? null
  }

  serialsFor(deviceId: string): string[] {
    return this.bindings.filter((b) => b.deviceId === deviceId).map((b) => b.serial)
  }

  /** 删除某设备全部绑定（撤销信任时级联）。返回删掉的条数 */
  removeForDevice(deviceId: string): number {
    const before = this.bindings.length
    this.bindings = this.bindings.filter((b) => b.deviceId !== deviceId)
    const removed = before - this.bindings.length
    if (removed > 0) this.persist()
    return removed
  }

  list(): DeviceBinding[] {
    return this.bindings.map((b) => ({ ...b }))
  }
}

function isDeviceBinding(v: unknown): v is DeviceBinding {
  if (typeof v !== "object" || v === null) return false
  const b = v as Partial<DeviceBinding>
  return (
    typeof b.serial === "string" &&
    b.serial.length > 0 &&
    typeof b.deviceId === "string" &&
    b.deviceId.length > 0 &&
    typeof b.boundAt === "number"
  )
}

// ---------- adb serial 解析 ----------

export type ParsedAdbSerial =
  | { kind: "wireless"; ip: string }
  | { kind: "wireless-tls"; ip: null }
  | { kind: "usb" }

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/

/**
 * 解析 adb serial 的连接形态。
 *   - `192.168.1.5:5555` → wireless，可用 IP 做 join
 *   - `xxx._adb-tls-connect._tcp` → wireless-tls，无线但 serial 里没有 IP，
 *     无法做 IP-join，只能走显式绑定
 *   - 其余（USB 序列号、`emulator-5554` 等）→ usb，无 IP 可 join
 */
export function parseAdbSerial(serial: string): ParsedAdbSerial {
  if (serial.includes("._adb-tls-connect._tcp")) return { kind: "wireless-tls", ip: null }
  const idx = serial.lastIndexOf(":")
  if (idx > 0) {
    const host = serial.slice(0, idx)
    const port = serial.slice(idx + 1)
    if (IPV4_RE.test(host) && /^\d+$/.test(port)) return { kind: "wireless", ip: host }
  }
  return { kind: "usb" }
}

// ---------- scrcpy 启动门禁判定（纯函数） ----------

export interface ScrcpyResolveContext {
  bindings: Pick<DeviceBindingStore, "deviceIdOf">
  /** 该 deviceId 是否在信任清单内 */
  isTrusted: (deviceId: string) => boolean
  /** 按 LAN IP 反查已连接且已配对的对端 deviceId，无匹配返回 null */
  deviceIdByIp: (ip: string) => string | null
}

export type ScrcpyResolveResult =
  | { ok: true; deviceId: string; via: "binding" | "ip-join" }
  | { ok: false; error: string }

/**
 * scrcpy 启动门禁：serial → deviceId 的授权判定。
 *
 * 顺序固定：显式绑定优先（USB 与无线都可用）；无线无绑定时走 IP-join；
 * 其余一律拒绝（fail closed），绝不静默放行。
 */
export function resolveScrcpyDeviceId(
  serial: string,
  ctx: ScrcpyResolveContext
): ScrcpyResolveResult {
  const bound = ctx.bindings.deviceIdOf(serial)
  if (bound !== null) {
    if (!ctx.isTrusted(bound)) {
      return { ok: false, error: "该设备已取消配对，绑定随之失效，请重新配对后再绑定" }
    }
    return { ok: true, deviceId: bound, via: "binding" }
  }

  const parsed = parseAdbSerial(serial)
  if (parsed.kind === "wireless") {
    const peerId = ctx.deviceIdByIp(parsed.ip)
    if (peerId !== null && ctx.isTrusted(peerId)) {
      return { ok: true, deviceId: peerId, via: "ip-join" }
    }
    return { ok: false, error: "该设备未配对：请先在 LinkSpace 里与它配对，再启动投屏" }
  }
  if (parsed.kind === "wireless-tls") {
    return { ok: false, error: "无法确认该无线设备的身份：请先在设备列表里将它绑定到一台已配对设备" }
  }
  return { ok: false, error: "该 USB 设备未绑定：请先在设备列表里将它绑定到一台已配对设备" }
}

/**
 * 撤销级联用的归属判定：某 adb serial 是否属于被撤销的设备。
 * boundSerials 是撤销前从绑定存储里取出的该设备 serial 快照（撤销处理
 * 会删绑定，判定必须用快照、不能读 live 存储，否则删完就匹配不上了）；
 * remoteIp 是撤销前从该设备的 LinkSpace 连接上取到的 remoteAddress，
 * peers 表删掉后就拿不到了，所以调用方必须在撤销处理的最前面捕获。
 */
export function serialBelongsToDevice(
  serial: string,
  ctx: { boundSerials: string[]; remoteIp: string | null }
): boolean {
  if (ctx.boundSerials.includes(serial)) return true
  const parsed = parseAdbSerial(serial)
  return parsed.kind === "wireless" && ctx.remoteIp !== null && parsed.ip === ctx.remoteIp
}
