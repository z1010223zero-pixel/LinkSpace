// scrcpy 配对门禁与撤销级联无头测试（W2 安全修复）。
//
// 三层：
//   1. 纯逻辑单测——serial 解析、绑定存储持久化、门禁判定、归属判定。
//   2. 双 Host 环路——真实的 WebSocket 控制通道上配对后，门禁按 IP-join
//      与显式绑定放行、未配对拒绝。
//   3. 撤销级联——revokeTrust 后 hook 被调用，假会话按归属停掉，绑定删除。
//
// 无真机、无 scrcpy 二进制：会话停止用假会话 + 注入的 hook 验证逻辑，
// 不声称真机验证过。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generate } from "selfsigned"
import { Host } from "./host"
import { DeviceManager } from "./device-manager"
import type { ScrcpyAdapter } from "./scrcpy-adapter"
import { EventEmitter } from "node:events"
import { fingerprintOfCert, type DeviceCert } from "./transfer/identity"
import type { DiscoveredService } from "./discovery"
import type { PendingPairing } from "./pairing"
import {
  DeviceBindingStore,
  parseAdbSerial,
  resolveScrcpyDeviceId,
  serialBelongsToDevice
} from "./device-binding"

let failures = 0

function check(label: string, pass: boolean, detail = ""): void {
  if (!pass) failures++
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error("等待超时")
    await sleep(50)
  }
}

async function makeCert(): Promise<DeviceCert> {
  const notAfter = new Date()
  notAfter.setFullYear(notAfter.getFullYear() + 10)
  const pems = await generate([{ name: "commonName", value: "LinkSpace Device" }], {
    notAfterDate: notAfter,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true, clientAuth: true }
    ]
  })
  return { key: pems.private, cert: pems.cert, fingerprint: fingerprintOfCert(pems.cert) }
}

// ---------- 纯逻辑：serial 解析 ----------

function testParse(): void {
  console.log("\n=== 纯逻辑：adb serial 解析 ===\n")

  const w = parseAdbSerial("192.168.1.5:5555")
  check("无线 host:port 解析出 IP", w.kind === "wireless" && w.ip === "192.168.1.5", JSON.stringify(w))
  const w2 = parseAdbSerial("10.0.0.2:37099")
  check("非常用端口同样认无线", w2.kind === "wireless" && w2.ip === "10.0.0.2", JSON.stringify(w2))
  const tls = parseAdbSerial("adb-R5CT123._adb-tls-connect._tcp")
  check("TLS 形态无线但无 IP", tls.kind === "wireless-tls", JSON.stringify(tls))
  check("USB 序列号认 USB", parseAdbSerial("R5CT123ABCD").kind === "usb")
  check("模拟器序列号认 USB", parseAdbSerial("emulator-5554").kind === "usb")
  check("非法端口不认无线", parseAdbSerial("192.168.1.5:abc").kind === "usb")
  check("非 IP 主机不认无线", parseAdbSerial("myhost:5555").kind === "usb")
}

// ---------- 纯逻辑：绑定存储 ----------

async function testBindingStore(workDir: string): Promise<void> {
  console.log("\n=== 纯逻辑：绑定存储持久化 ===\n")

  const dir = join(workDir, "store")
  await mkdir(dir, { recursive: true })
  const store = new DeviceBindingStore({ dir })
  check("空存储无绑定", store.list().length === 0)

  store.bind("USBDEV001", "dev-a")
  store.bind("192.168.1.5:5555", "dev-a")
  check("绑定后可查", store.deviceIdOf("USBDEV001") === "dev-a")
  check("同设备多 serial", store.serialsFor("dev-a").length === 2)

  // 重新加载：持久化 round-trip
  const reloaded = new DeviceBindingStore({ dir })
  check("重启后绑定仍在", reloaded.deviceIdOf("USBDEV001") === "dev-a")
  check("重启后 serial 列表仍在", reloaded.serialsFor("dev-a").length === 2)

  // 改绑覆盖
  reloaded.bind("USBDEV001", "dev-b")
  check("改绑覆盖旧条目", reloaded.deviceIdOf("USBDEV001") === "dev-b")
  check("改绑后旧设备只剩一条", reloaded.serialsFor("dev-a").length === 1)

  check("解绑返回 true", reloaded.unbind("192.168.1.5:5555"))
  check("解绑不存在的返回 false", !reloaded.unbind("192.168.1.5:5555"))
  check("解绑后查不到", reloaded.deviceIdOf("192.168.1.5:5555") === null)

  const removed = reloaded.removeForDevice("dev-b")
  check("按设备删除返回条数", removed === 1, `removed=${removed}`)
  check("按设备删除后为空", reloaded.list().length === 0)

  // 损坏文件不抛错、不阻塞启动
  await writeFile(join(dir, "device-bindings.json"), "{ not json", "utf8")
  const broken = new DeviceBindingStore({ dir })
  check("损坏文件丢弃并重新开始", broken.list().length === 0)
}

// ---------- 纯逻辑：门禁判定与归属判定 ----------

function testResolvePure(workDir: string): void {
  console.log("\n=== 纯逻辑：门禁判定（假上下文） ===\n")

  const dir = join(workDir, "pure")
  const store = new DeviceBindingStore({ dir })
  store.bind("USBDEV001", "dev-trusted")
  const trusted = new Set(["dev-trusted", "dev-peer"])
  const byIp = new Map([["192.168.1.5", "dev-peer"]])
  const ctx = {
    bindings: store,
    isTrusted: (id: string) => trusted.has(id),
    deviceIdByIp: (ip: string) => byIp.get(ip) ?? null
  }

  const bound = resolveScrcpyDeviceId("USBDEV001", ctx)
  check("已绑定 USB 放行", bound.ok && bound.deviceId === "dev-trusted" && bound.via === "binding", JSON.stringify(bound))
  const ipJoin = resolveScrcpyDeviceId("192.168.1.5:5555", ctx)
  check("无线 IP-join 放行", ipJoin.ok && ipJoin.deviceId === "dev-peer" && ipJoin.via === "ip-join", JSON.stringify(ipJoin))
  check("无线未知 IP 拒绝", !resolveScrcpyDeviceId("192.168.1.6:5555", ctx).ok)
  check("未绑定 USB 拒绝", !resolveScrcpyDeviceId("R5CT99", ctx).ok)
  check("TLS 形态无绑定拒绝", !resolveScrcpyDeviceId("adb-ABC._adb-tls-connect._tcp", ctx).ok)

  // 绑定指向已撤销设备：拒绝
  store.bind("USBDEV001", "dev-gone")
  check("绑定到未信任设备拒绝", !resolveScrcpyDeviceId("USBDEV001", ctx).ok)
  store.bind("USBDEV001", "dev-trusted")

  // IP-join 到未信任设备：拒绝
  trusted.delete("dev-peer")
  check("IP-join 到未信任设备拒绝", !resolveScrcpyDeviceId("192.168.1.5:5555", ctx).ok)
  trusted.add("dev-peer")

  console.log("\n=== 纯逻辑：撤销归属判定 ===\n")
  check(
    "绑定 serial 属于该设备",
    serialBelongsToDevice("USBDEV001", { boundSerials: ["USBDEV001"], remoteIp: null })
  )
  check(
    "无线 IP 匹配属于该设备",
    serialBelongsToDevice("192.168.1.5:5555", { boundSerials: [], remoteIp: "192.168.1.5" })
  )
  check(
    "无线 IP 不匹配不属于",
    !serialBelongsToDevice("192.168.1.6:5555", { boundSerials: [], remoteIp: "192.168.1.5" })
  )
  check(
    "USB 无绑定、无 IP 不属于",
    !serialBelongsToDevice("R5CT99", { boundSerials: [], remoteIp: "192.168.1.5" })
  )
  check(
    "无连接时无线 serial 不属于",
    !serialBelongsToDevice("192.168.1.5:5555", { boundSerials: [], remoteIp: null })
  )
}

// ---------- 双 Host 环路：门禁 + 撤销级联 ----------

async function testE2e(workDir: string): Promise<void> {
  console.log("\n=== 双 Host 环路：配对门禁 → 撤销级联 ===\n")

  const dirA = join(workDir, "A")
  const dirB = join(workDir, "B")
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })
  const pairRequestsB: PendingPairing[] = []

  const A = new Host({
    displayName: "Bind-Alpha",
    deviceType: "win",
    dataDir: dirA,
    cert: await makeCert(),
    bind: "127.0.0.1"
  })
  const B = new Host({
    displayName: "Bind-Beta",
    deviceType: "win",
    dataDir: dirB,
    cert: await makeCert(),
    bind: "127.0.0.1"
  })
  B.on("pairRequested", (p) => pairRequestsB.push(p))

  await A.start()
  await B.start()

  try {
    // 直连配对（不经 mDNS：本测试只关心门禁与撤销语义）
    const svcB: DiscoveredService = {
      serviceName: "Bind-Beta",
      idPrefix: B.id.slice(0, 12),
      displayName: "Bind-Beta",
      deviceType: "win",
      caps: ["file"],
      host: "127.0.0.1",
      port: B.port,
      paired: true,
      lastSeen: Date.now()
    }
    const conn = await A.connect(svcB)
    await waitFor(() => (conn.peerId === B.id ? conn : undefined))
    const pairingPromise = A.requestPairing(conn)
    const pending = await waitFor(() => pairRequestsB[0])
    const submit = A.submitCode(conn, pending.code)
    check("配对建立", submit.ok && (await pairingPromise).deviceId === B.id)

    // ---------- 1. 门禁 ----------
    console.log("\n1. 未配对拒绝 / 已配对放行")
    const g1 = A.resolveScrcpyDevice("127.0.0.1:5555")
    check("无线 IP-join：已配对放行", g1.ok && g1.deviceId === B.id && g1.via === "ip-join", JSON.stringify(g1))
    check("无线未知 IP 拒绝", !A.resolveScrcpyDevice("192.168.99.99:5555").ok)
    check("未绑定 USB 拒绝", !A.resolveScrcpyDevice("USBDEV001").ok)
    check("TLS 形态无绑定拒绝", !A.resolveScrcpyDevice("adb-XYZ._adb-tls-connect._tcp").ok)

    const bindR = A.bindScrcpyDevice("USBDEV001", B.id)
    check("显式绑定已配对设备成功", bindR.ok)
    const g2 = A.resolveScrcpyDevice("USBDEV001")
    check("绑定后 USB 放行", g2.ok && g2.deviceId === B.id && g2.via === "binding", JSON.stringify(g2))
    check("绑定未配对设备拒绝", !A.bindScrcpyDevice("USBDEV002", "no-such-device").ok)

    // 对称：B 看 A 也是 127.0.0.1
    const g3 = B.resolveScrcpyDevice("127.0.0.1:5555")
    check("反向 IP-join 同样放行", g3.ok && g3.deviceId === A.id, JSON.stringify(g3))

    // ---------- 1b. 身份快照（2.5-1）与归属判定（2.5 反向流衔接） ----------
    console.log("\n1b. 身份快照与归属判定")
    const idWireless = A.scrcpyIdentityOf("127.0.0.1:5555")
    check(
      "无线已配对身份快照",
      idWireless.deviceId === B.id && idWireless.paired && !idWireless.bound && idWireless.allowed,
      JSON.stringify(idWireless)
    )
    const idUsb = A.scrcpyIdentityOf("USBDEV001")
    check(
      "绑定 USB 身份快照",
      idUsb.deviceId === B.id && idUsb.paired && idUsb.bound && idUsb.allowed,
      JSON.stringify(idUsb)
    )
    const idUnknown = A.scrcpyIdentityOf("192.168.99.99:5555")
    check(
      "未知设备身份全空",
      idUnknown.deviceId === null && !idUnknown.paired && !idUnknown.bound && !idUnknown.allowed,
      JSON.stringify(idUnknown)
    )
    check("归属：无线 IP-join serial 属于该设备", A.scrcpySerialBelongsTo(B.id, "127.0.0.1:5555"))
    check("归属：绑定 USB serial 属于该设备", A.scrcpySerialBelongsTo(B.id, "USBDEV001"))
    check("归属：无关 serial 不属于", !A.scrcpySerialBelongsTo(B.id, "10.0.0.9:5555"))
    check("归属：未知设备一律不属于", !A.scrcpySerialBelongsTo("no-such-device", "127.0.0.1:5555"))

    // ---------- 2. 撤销级联 ----------
    console.log("\n2. 撤销信任级联断开 scrcpy")
    interface FakeSession {
      serial: string
      stopped: boolean
    }
    const fakeSessions: FakeSession[] = [
      { serial: "127.0.0.1:5555", stopped: false },
      { serial: "USBDEV001", stopped: false },
      { serial: "10.0.0.9:5555", stopped: false }
    ]
    const hookCalls: string[] = []
    A.setScrcpyRevokedHandler((deviceId, matches) => {
      hookCalls.push(deviceId)
      for (const s of fakeSessions) {
        if (matches(s.serial)) s.stopped = true
      }
    })
    check("撤销前 hook 未调用", hookCalls.length === 0)

    const revoked = A.revokeTrust(B.id)
    check("撤销信任成功", revoked)
    check("撤销后 hook 被调用一次", hookCalls.length === 1 && hookCalls[0] === B.id, JSON.stringify(hookCalls))
    check("IP-join 会话被停", fakeSessions[0].stopped)
    check("绑定 USB 会话被停", fakeSessions[1].stopped)
    check("无关设备会话未动", !fakeSessions[2].stopped)
    check("撤销后绑定已删除", A.scrcpyBindings().length === 0)
    check("撤销后无线门禁拒绝", !A.resolveScrcpyDevice("127.0.0.1:5555").ok)
    check("撤销后 USB 门禁拒绝", !A.resolveScrcpyDevice("USBDEV001").ok)

    // 等对端收到 pair.revoke 再收尾，避免关停时序干扰断言
    await sleep(300)
  } finally {
    await A.stop()
    await B.stop()
  }
}

// ---------- DeviceManager：统一视图 + 断开恢复（2.5） ----------

async function testDeviceManager(): Promise<void> {
  console.log("\n=== DeviceManager：统一视图 + 断开恢复 ===\n")

  const devA = { serial: "192.168.1.5:5555", state: "device" as const, wireless: true }
  const fakeSessions = [
    {
      id: "scr-1",
      serial: "192.168.1.5:5555",
      pid: 123,
      state: "running" as const,
      startedAt: Date.now()
    }
  ]
  const stoppedIds: string[] = []
  const fakeAdapter = Object.assign(new EventEmitter(), {
    list: () => fakeSessions,
    findBySerial: (serial: string) => fakeSessions.filter((s) => s.serial === serial),
    stop: async (id: string) => {
      stoppedIds.push(id)
      return { ok: true as const, value: undefined }
    }
  }) as unknown as ScrcpyAdapter

  // 枚举剧本：1. 有设备 → 2. 失败 → 3. 空（首次缺失）→ 4. 空（二次缺失）
  let calls = 0
  const enumerate = async () => {
    calls++
    if (calls === 1) return { ok: true as const, devices: [devA] }
    if (calls === 2) return { ok: false as const, error: "adb server 未响应" }
    return { ok: true as const, devices: [] }
  }

  const dm = new DeviceManager(fakeAdapter, {
    resolveIdentity: (serial) =>
      serial === devA.serial
        ? { deviceId: "dev-x", paired: true, bound: false, allowed: true }
        : { deviceId: null, paired: false, bound: false, allowed: false },
    enumerate
  })

  await dm.refresh()
  check("首刷列出设备", dm.view().length === 1)
  const v = dm.view()[0]
  check(
    "视图带解析身份",
    v?.deviceId === "dev-x" && v?.paired === true && v?.scrcpyAllowed === true,
    JSON.stringify(v)
  )
  await dm.refresh()
  check("枚举失败保留上次列表", dm.view().length === 1)
  check("枚举失败不误删会话", stoppedIds.length === 0)
  await dm.refresh()
  check("首次缺失不断会话（等一次确认）", stoppedIds.length === 0)
  await dm.refresh()
  check("连续两次缺失停掉陈旧会话", stoppedIds.includes("scr-1"), JSON.stringify(stoppedIds))
}

async function main(): Promise<void> {
  console.log("\n=== LinkSpace scrcpy 配对门禁测试（W2） ===\n")

  testParse()

  const workDir = await mkdtemp(join(tmpdir(), "linkspace-binding-"))
  try {
    await testBindingStore(workDir)
    testResolvePure(workDir)
    await testDeviceManager()
    await testE2e(workDir)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  console.log(`\n=== 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("\n测试脚本异常：", err)
  process.exit(1)
})
