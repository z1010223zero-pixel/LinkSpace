// 平板当扩展屏无头测试（线 3，协议 4.3，sessionType: 'display-extend'）。
//
// 三层：
//   1. 纯逻辑单测——扩展参数解码、虚拟显示器矩形解码、被控/控制状态机。
//      覆盖门禁（未配对拒绝）、创建失败不建会话、终止路径全销毁虚拟
//      显示器、与 input 会话解耦（状态机层面各占独立槽位），以及创建
//      进行中的取消（deny/断连/撤销时已建成的显示器立即销毁）。
//   2. 双 Host 环路——真实的 WebSocket 控制通道上跑完整的
//      「请求 → 确认 → 会话建立 → input 会话并行 → input 结束不影响
//      扩展 → 扩展退出销毁虚拟显示器」，外加未信任设备拒绝。
//   3. VirtualDisplayManager 与 startDd——以 node 写的 fake swd-host
//      （打 SWD-READY/APPEARED 行）验证管理器协议解析、模式选定与
//      超时失败；startDd 以不存在的 dd-capture 路径验证失败走 onEnded。
//   4. VddVirtualDisplayManager（线 3，④）——fake driver manager +
//      fake listDisplays：VDD 后端的创建/销毁/超时路径，不碰真实设备。
//
// 真实的虚拟显示器创建（SWD + 驱动）在后台会话里不可用（须测试签名 +
// 关 Secure Boot），创建/销毁层以注入的 fake 替代：验证的是「对的
// 会话在对的时机创建/销毁虚拟显示器」，驱动本身的正确性留真机走查
// （2026-10-30 PoC 已验证创建 + DD 取帧；swd-host 的 READY→TIMEOUT
// 路径 2026-11-03 已在真机上实测，见 native/swd-host/README.md）。

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate } from 'selfsigned'
import { Host } from './host'
import { fingerprintOfCert, type DeviceCert } from './transfer/identity'
import type { DiscoveredService } from './discovery'
import type { PendingPairing } from './pairing'
import {
  DisplayExtendSessionCoordinator,
  DisplayExtendController,
  decodeExtendParams,
  decodeVirtualScreen,
  type ExtendPreferredSize
} from './extend/session'
import { VirtualDisplayManager } from './extend/virtual-display'
import { VddVirtualDisplayManager, type VddDriverLike } from './extend/vdd-display'
import { ScreenStreamService } from './screen-stream'

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await sleep(50)
  }
}

async function makeCert(): Promise<DeviceCert> {
  const notAfter = new Date()
  notAfter.setFullYear(notAfter.getFullYear() + 10)
  const pems = await generate([{ name: 'commonName', value: 'LinkSpace Device' }], {
    notAfterDate: notAfter,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true }
    ]
  })
  return { key: pems.private, cert: pems.cert, fingerprint: fingerprintOfCert(pems.cert) }
}

interface SentMsg {
  peerId: string
  type: string
  payload: Record<string, unknown>
}

// ---------- 纯逻辑：参数解码 ----------

function testDecode(): void {
  console.log('\n=== 纯逻辑：扩展参数与虚拟显示器矩形解码 ===\n')

  check('无参数时 preferred 为 null、scaleWidth 默认 1920', (() => {
    const d = decodeExtendParams({})
    return d !== null && d.preferred === null && d.scaleWidth === 1920
  })())
  check('成对宽高通过', (() => {
    const d = decodeExtendParams({ width: 2560, height: 1440, scaleWidth: 2560 })
    return d?.preferred?.width === 2560 && d.preferred.height === 1440 && d.scaleWidth === 2560
  })())
  check('只给宽不给高整包拒绝', decodeExtendParams({ width: 2560 }) === null)
  check('宽高为 0 拒绝', decodeExtendParams({ width: 0, height: 1080 }) === null)
  check('宽高超限拒绝', decodeExtendParams({ width: 40000, height: 1080 }) === null)
  check('非对象拒绝', decodeExtendParams(null) === null)
  check('虚拟屏矩形 x/y 可为负', (() => {
    const s = decodeVirtualScreen({ x: -1920, y: 0, w: 1920, h: 1080 })
    return s?.x === -1920 && s.w === 1920
  })())
  check('虚拟屏矩形 w/h 为 0 拒绝', decodeVirtualScreen({ x: 0, y: 0, w: 0, h: 1080 }) === null)
  check('虚拟屏矩形缺字段拒绝', decodeVirtualScreen({ x: 0, y: 0, w: 1920 }) === null)
}

// ---------- 纯逻辑：被控端状态机 ----------

function makeCoordinator(opts: {
  now?: () => number
  ttlMs?: number
  create?: (preferred: ExtendPreferredSize | null) => Promise<{ ok: true; screen: { x: number; y: number; w: number; h: number } } | { ok: false; reason: string }>
} = {}): {
  coord: DisplayExtendSessionCoordinator
  sent: SentMsg[]
  state: { created: number; destroyed: number }
  requests: string[]
} {
  const sent: SentMsg[] = []
  const state = { created: 0, destroyed: 0 }
  const requests: string[] = []
  const create =
    opts.create ??
    (async (preferred: ExtendPreferredSize | null) => {
      state.created++
      const w = preferred?.width ?? 2560
      const h = preferred?.height ?? 1440
      return { ok: true as const, screen: { x: 1920, y: 0, w, h } }
    })
  const coord = new DisplayExtendSessionCoordinator({
    callbacks: {
      isPeerAuthorized: (id) => id === 'dev_B',
      createVirtualDisplay: create,
      destroyVirtualDisplay: () => {
        state.destroyed++
      },
      send: (peerId, type, payload) => sent.push({ peerId, type, payload }),
      onRequest: (req) => requests.push(req.sessionId)
    },
    requestTtlMs: opts.ttlMs,
    now: opts.now
  })
  return { coord, sent, state, requests }
}

function startPayload(
  sessionId: string,
  params: Record<string, unknown> = {}
): Record<string, unknown> {
  return { sessionId, sessionType: 'display-extend', params: { displayName: 'Alpha', ...params } }
}

async function testCoordinator(): Promise<void> {
  console.log('\n=== 纯逻辑：被控端状态机 ===\n')

  // 1. 未信任设备：直接拒绝，不进 pending
  {
    const { coord, sent } = makeCoordinator()
    coord.onStart('dev_rogue', startPayload('e1'))
    check('未信任设备的请求被拒绝', sent[0]?.type === 'session.reject' && sent[0].payload.reason === 'not trusted')
    check('未信任设备的请求不弹 UI', coord.pendingRequest === null)
  }

  // 2. 非 display-extend 类型拒绝
  {
    const { coord, sent } = makeCoordinator()
    coord.onStart('dev_B', { sessionId: 'e2', sessionType: 'input', params: {} })
    check('input 类型走不到扩展状态机', sent[0]?.type === 'session.reject' && sent[0].payload.reason === 'bad request')
    check('非法类型不进 pending', coord.pendingRequest === null)
  }

  // 3. 正常流：pending → approve（创建虚拟显示器）→ active
  {
    const { coord, sent, state } = makeCoordinator()
    coord.onStart('dev_B', startPayload('e3', { width: 2560, height: 1440 }))
    check('合法请求进入待确认', coord.pendingRequest?.sessionId === 'e3')
    check('批准前不创建虚拟显示器', state.created === 0)
    const r = await coord.approve('e3')
    check('批准成功', r.ok)
    check('批准时创建虚拟显示器', state.created === 1)
    check(
      'accept 回给对端并携带虚拟显示器矩形',
      sent.some(
        (m) =>
          m.type === 'session.accept' &&
          JSON.stringify(m.payload.virtualScreen) === '{"x":1920,"y":0,"w":2560,"h":1440}'
      )
    )
    check('活动会话记录对端', coord.extendedFor === 'dev_B')
  }

  // 4. 创建失败：会话不建立，回 reject
  {
    const { coord, sent, state } = makeCoordinator({
      create: async () => ({ ok: false as const, reason: 'virtual display unavailable' })
    })
    coord.onStart('dev_B', startPayload('e4'))
    const r = await coord.approve('e4')
    check('创建失败时批准返回失败', !r.ok && r.error === 'virtual display unavailable')
    check('创建失败时无活动会话', coord.activeSession === null)
    check('创建失败回 reject（不 accept）', sent.some((m) => m.type === 'session.reject' && m.payload.reason === 'virtual display unavailable'))
    check('创建失败不留待销毁的显示器', state.destroyed === 0)
  }

  // 5. 拒绝与过期
  {
    let t = 1_000_000
    const { coord, sent } = makeCoordinator({ now: () => t })
    coord.onStart('dev_B', startPayload('e5'))
    coord.deny('e5')
    check('拒绝后回 reject', sent.some((m) => m.type === 'session.reject' && m.payload.reason === 'denied by user'))
    check('拒绝后无挂起', coord.pendingRequest === null)

    const { coord: c2, sent: s2 } = makeCoordinator({ now: () => t, ttlMs: 1000 })
    c2.onStart('dev_B', startPayload('e6'))
    t += 1500
    const r = await c2.approve('e6')
    check('过期请求批准失败', !r.ok && r.error === '请求已过期')
    check('过期请求自动回 reject', s2.some((m) => m.type === 'session.reject' && m.payload.reason === 'expired'))
  }

  // 6. 终止路径：对端 stop / 断连 / 撤销 / 本机终止，全部销毁虚拟显示器
  {
    const { coord, sent, state } = makeCoordinator()
    coord.onStart('dev_B', startPayload('e7'))
    await coord.approve('e7')
    coord.onStop('dev_B', { sessionId: 'e7' })
    check('对端 stop 后会话结束', coord.activeSession === null)
    check('对端 stop 后虚拟显示器销毁', state.destroyed === 1)
    check('stop 回执已发', sent.filter((m) => m.type === 'session.stop').length === 1)

    const { coord: c2, state: st2 } = makeCoordinator()
    c2.onStart('dev_B', startPayload('e8'))
    await c2.approve('e8')
    c2.onPeerDisconnected('dev_B')
    check('对端断连终止会话并销毁显示器', c2.activeSession === null && st2.destroyed === 1)

    const { coord: c3, state: st3 } = makeCoordinator()
    c3.onStart('dev_B', startPayload('e9'))
    await c3.approve('e9')
    c3.onTrustRevoked('dev_B')
    check('信任撤销立即掐断并销毁显示器', c3.activeSession === null && st3.destroyed === 1)

    const { coord: c4, sent: s4, state: st4 } = makeCoordinator()
    c4.onStart('dev_B', startPayload('e10'))
    await c4.approve('e10')
    c4.terminate()
    check('本机终止后无活动会话', c4.activeSession === null)
    check('本机终止销毁显示器并通知对端', st4.destroyed === 1 && s4.some((m) => m.type === 'session.stop'))
  }

  // 7. 资源占用：同一时刻至多一个扩展会话；同一会话重发 start 幂等
  {
    const { coord, sent } = makeCoordinator()
    coord.onStart('dev_B', startPayload('e11'))
    await coord.approve('e11')
    coord.onStart('dev_B', startPayload('e12'))
    check('活动期间新请求被拒', sent.some((m) => m.type === 'session.reject' && m.payload.reason === 'resource busy'))
    check('活动会话不受影响', coord.activeSession?.sessionId === 'e11')
    const acceptsBefore = sent.filter((m) => m.type === 'session.accept').length
    coord.onStart('dev_B', startPayload('e11'))
    check(
      '同一会话 start 重发幂等重回 accept',
      sent.filter((m) => m.type === 'session.accept').length === acceptsBefore + 1
    )
  }

  // 8. 创建进行中取消：approve 未落定就 deny，落定后已建成的显示器
  // 立即销毁，不 accept、不留活动会话
  {
    let resolveCreate!: (v: { ok: true; screen: { x: number; y: number; w: number; h: number } }) => void
    const deferred = new Promise<{ ok: true; screen: { x: number; y: number; w: number; h: number } }>(
      (r) => {
        resolveCreate = r
      }
    )
    const { coord, sent, state } = makeCoordinator({ create: () => deferred })
    coord.onStart('dev_B', startPayload('e13'))
    const approveP = coord.approve('e13')
    coord.deny('e13')
    resolveCreate({ ok: true as const, screen: { x: 1920, y: 0, w: 2560, h: 1440 } })
    const r = await approveP
    check('创建中拒绝后批准返回取消', !r.ok && r.error === '请求已取消')
    check('创建中拒绝后已建成的显示器被销毁', state.destroyed === 1)
    check('创建中拒绝后无 accept', !sent.some((m) => m.type === 'session.accept'))
    check('创建中拒绝后无活动会话', coord.activeSession === null)
    check('创建中拒绝后已回 reject', sent.some((m) => m.type === 'session.reject' && m.payload.reason === 'denied by user'))
  }
}

// ---------- 纯逻辑：控制端状态机 ----------

async function testController(): Promise<void> {
  console.log('\n=== 纯逻辑：控制端状态机 ===\n')

  {
    const sent: SentMsg[] = []
    const ctl = new DisplayExtendController({
      callbacks: { send: (peerId, type, payload) => sent.push({ peerId, type, payload }) }
    })
    const p = ctl.request('dev_B', { width: 2560, height: 1440 }, 1920, 'Alpha')
    const first = sent[0]
    check('request 发出 session.start', first?.type === 'session.start' && first.peerId === 'dev_B')
    check('start 携带会话类型 display-extend', (first?.payload as { sessionType?: string }).sessionType === 'display-extend')
    check('start 携带希望尺寸与档位', (() => {
      const params = (first?.payload as { params?: Record<string, unknown> }).params
      return params?.width === 2560 && params?.height === 1440 && params?.scaleWidth === 1920
    })())
    check('控制端在 accept 前未扩展', ctl.extendingTo === null)
    const sid = (first.payload as { sessionId: string }).sessionId
    // 来源不符的 accept 必须被忽略
    ctl.onAccepted('dev_C', sid, { x: 1920, y: 0, w: 2560, h: 1440 })
    check('他端伪造的 accept 被忽略', ctl.extendingTo === null)
    // 缺 virtualScreen 的 accept 必须被拒绝
    ctl.onAccepted('dev_B', sid, undefined)
    const res = await p
    check('缺 virtualScreen 的 accept 按失败回落', !res.ok)
    check('失败后可再次发起', ctl.extendingTo === null)

    const p2 = ctl.request('dev_B', null, 1920, 'Alpha')
    const sid2 = (sent[1].payload as { sessionId: string }).sessionId
    ctl.onAccepted('dev_B', sid2, { x: 1920, y: 0, w: 2560, h: 1440 })
    const res2 = await p2
    check('accept 后 promise 落定', res2.ok)
    check('accept 后进入扩展态', ctl.extendingTo === 'dev_B')
    check('虚拟显示器矩形已记录', ctl.activeSession?.virtualScreen?.w === 2560 && ctl.activeSession?.virtualScreen?.x === 1920)
    ctl.stop('exit')
    check('stop 后收起扩展屏', ctl.extendingTo === null)
    check('stop 已通知对端', sent.some((m) => m.type === 'session.stop' && m.payload.reason === 'exit'))
  }

  // 断连清理
  {
    const sent: SentMsg[] = []
    let ended = ''
    const ctl = new DisplayExtendController({
      callbacks: {
        send: (peerId, type, payload) => sent.push({ peerId, type, payload }),
        onEnded: (peerId) => {
          ended = peerId
        }
      }
    })
    void ctl.request('dev_B', null, 1920, 'A').then(() => undefined)
    const sid = (sent[0].payload as { sessionId: string }).sessionId
    ctl.onAccepted('dev_B', sid, { x: 0, y: 0, w: 1920, h: 1080 })
    ctl.onPeerDisconnected('dev_B')
    check('被控端断连立即收起扩展屏', ctl.extendingTo === null && ended === 'dev_B')
  }

  // 超时回落
  {
    const ctl = new DisplayExtendController({
      callbacks: { send: () => undefined },
      requestTimeoutMs: 80
    })
    const res = await ctl.request('dev_B', null, 1920, 'A')
    check('对端无响应按失败回落', !res.ok && res.error === '对端未响应扩展屏请求')
  }
}

// ---------- 双 Host 环路 ----------

async function testE2e(): Promise<void> {
  console.log('\n=== 双 Host 环路：扩展请求 → 确认 → 会话建立 → 与 input 解耦 ===\n')

  const workDir = await mkdtemp(join(tmpdir(), 'linkspace-extend-'))
  let createdB = 0
  let destroyedB = 0
  const requestsB: { sessionId: string; displayName: string }[] = []
  const pairRequestsB: PendingPairing[] = []

  const A = new Host({
    displayName: 'Extend-Alpha',
    deviceType: 'win',
    dataDir: join(workDir, 'A'),
    cert: await makeCert(),
    bind: '127.0.0.1',
    inputLocalScreen: () => ({ w: 2000, h: 1000 })
  })
  const B = new Host({
    displayName: 'Extend-Beta',
    deviceType: 'win',
    dataDir: join(workDir, 'B'),
    cert: await makeCert(),
    bind: '127.0.0.1',
    inputLocalScreen: () => ({ w: 1000, h: 500 }),
    // 虚拟显示器 fake：创建记数并回固定矩形，销毁记数
    extendCreateVirtualDisplay: async (preferred) => {
      createdB++
      return { ok: true as const, screen: { x: 1000, y: 0, w: preferred?.width ?? 2560, h: preferred?.height ?? 1440 } }
    },
    extendDestroyVirtualDisplay: () => {
      destroyedB++
    }
  })
  const C = new Host({
    displayName: 'Extend-Gamma',
    deviceType: 'win',
    dataDir: join(workDir, 'C'),
    cert: await makeCert(),
    bind: '127.0.0.1'
  })

  B.on('extendRequested', (req) => requestsB.push({ sessionId: req.sessionId, displayName: req.displayName }))
  B.on('pairRequested', (p) => pairRequestsB.push(p))

  await A.start()
  await B.start()
  await C.start()

  try {
    // 直连配对（不经 mDNS：本测试只关心控制通道语义）
    const svcB: DiscoveredService = {
      serviceName: 'Extend-Beta',
      idPrefix: B.id.slice(0, 12),
      displayName: 'Extend-Beta',
      deviceType: 'win',
      caps: ['file'],
      host: '127.0.0.1',
      port: B.port,
      paired: true,
      lastSeen: Date.now()
    }
    const conn = await A.connect(svcB)
    await waitFor(() => (conn.peerId === B.id ? conn : undefined))
    const pairingPromise = A.requestPairing(conn)
    const pending = await waitFor(() => pairRequestsB[0])
    const submit = A.submitCode(conn, pending.code)
    check('配对建立', submit.ok && (await pairingPromise).deviceId === B.id)

    // ---------- 1. 扩展请求与确认 ----------
    console.log('\n1. 扩展请求 → 用户确认 → 会话建立')
    const reqPromise = A.requestExtendControl(B.id, { width: 2560, height: 1440 }, 1920)
    const req = await waitFor(() => requestsB[0])
    check('被控端收到请求并弹 UI', req.sessionId.length > 0)
    check('请求带对端显示名（仅提示用）', req.displayName === 'Extend-Alpha')
    check('确认前无活动扩展会话', B.extendedForPeer() === null && A.extendingToPeer() === null)
    check('确认前未创建虚拟显示器', createdB === 0)

    const approved = await B.approveExtendControl(req.sessionId)
    check('被控端批准', approved.ok)
    check('批准时创建虚拟显示器', createdB === 1)
    const ext = await reqPromise
    check('控制端 promise 落定', ext.ok)
    check('两端扩展会话状态一致', A.extendingToPeer() === B.id && B.extendedForPeer() === A.id)
    check('控制端拿到虚拟显示器矩形', B.extendStatus().virtualScreen?.w === 2560)

    // ---------- 2. 与 input 会话解耦 ----------
    console.log('\n2. input 会话并行、结束不影响扩展屏')
    const inputPromise = A.requestInputControl(B.id)
    const inputReq = await waitFor(() => B.pendingInputRequest() ?? undefined)
    check('扩展进行中仍可开 input 会话', inputReq !== undefined)
    B.approveInputControl(inputReq.sessionId)
    const inputRes = await inputPromise
    check('input 会话建立', inputRes.ok)
    check('两类会话同时活动', A.controllingPeer() === B.id && A.extendingToPeer() === B.id)
    A.stopInputControl()
    await sleep(300)
    check('input 会话结束', A.controllingPeer() === null)
    check('input 结束不终止扩展屏', A.extendingToPeer() === B.id && B.extendedForPeer() === A.id)
    check('input 结束不销毁虚拟显示器', destroyedB === 0)

    // ---------- 3. 未信任设备拒绝 ----------
    console.log('\n3. 未信任设备被门禁挡下')
    const connC = await C.connect({ ...svcB })
    await waitFor(() => (connC.peerId === B.id ? connC : undefined))
    const reqC = C.requestExtendControl(B.id)
    await sleep(400)
    check('未信任设备的扩展请求失败', !(await reqC).ok)
    check('未信任设备的请求不弹 UI', requestsB.length === 1)

    // ---------- 4. 扩展退出销毁虚拟显示器 ----------
    console.log('\n4. 扩展退出 → 虚拟显示器销毁')
    A.stopExtendControl()
    await sleep(300)
    check('扩展退出后两端无会话', A.extendingToPeer() === null && B.extendedForPeer() === null)
    check('扩展退出销毁虚拟显示器', destroyedB === 1)
  } finally {
    await A.stop()
    await B.stop()
    await C.stop()
    await rm(workDir, { recursive: true, force: true })
  }
}

// ---------- VirtualDisplayManager：fake swd-host ----------

// fake swd-host（node 脚本）：按 argv[2] 的模式打协议行。
//   ok     → READY → APPEARED 2，stdin EOF 后打 CLOSED 退出 0
//   slow   → READY/APPEARED 各延迟几百毫秒（取消路径用）
//   silent → 只打 READY，永不 APPEARED（超时路径用）
//   fail   → stderr 打 SwDeviceCreate 失败，退出 1
const FAKE_SWD_HOST_SRC = `const mode = process.argv[2] ?? 'ok'
const out = (s) => process.stdout.write(s + '\\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
if (mode === 'fail') {
  process.stderr.write('[swd-host] SwDeviceCreate failed 0x80070005\\n')
  process.exit(1)
}
await sleep(mode === 'slow' ? 500 : 50)
out('SWD-READY')
if (mode === 'silent') {
  await new Promise(() => undefined)
}
await sleep(mode === 'slow' ? 300 : 50)
out('SWD-DISPLAY-APPEARED 2')
process.stdin.on('end', () => {
  out('SWD-CLOSED 1 2')
  process.exit(0)
})
process.stdin.resume()
`

async function testVirtualDisplayManager(): Promise<void> {
  console.log('\n=== VirtualDisplayManager：fake swd-host ===\n')

  const dir = await mkdtemp(join(tmpdir(), 'linkspace-vdm-'))
  try {
    const fakePath = join(dir, 'fake-swd-host.mjs')
    await writeFile(fakePath, FAKE_SWD_HOST_SRC)

    // 1. 二进制缺失直接失败，不 spawn
    {
      const m = new VirtualDisplayManager({ swdHostPath: null, listDisplays: () => [] })
      const r = await m.create(null)
      check('swd-host 缺失时创建失败', !r.ok && r.reason === 'virtual display unavailable')
    }

    // 2. 正常创建：差分定位新显示器，按最接近请求尺寸挑
    {
      let calls = 0
      const before = [{ x: 0, y: 0, w: 1920, h: 1080 }]
      const after = [
        { x: 0, y: 0, w: 1920, h: 1080 },
        { x: 1920, y: 0, w: 2560, h: 1440 },
        { x: 1920, y: 0, w: 1024, h: 768 }
      ]
      const m = new VirtualDisplayManager({
        swdHostPath: process.execPath,
        swdHostArgs: [fakePath, 'ok'],
        listDisplays: () => (++calls === 1 ? before : after)
      })
      const r = await m.create({ width: 2560, height: 1440 })
      check('fake swd-host 创建成功', r.ok)
      check('按最接近请求尺寸挑到 2560x1440', r.ok && r.screen.w === 2560 && r.screen.x === 1920)
      check('创建后 active', m.active)
      m.destroy()
      await sleep(500)
      check('销毁后 inactive', !m.active)
    }

    // 3. swd-host 失败退出（0x80070005）：原因带 stderr 尾巴
    {
      const m = new VirtualDisplayManager({
        swdHostPath: process.execPath,
        swdHostArgs: [fakePath, 'fail'],
        listDisplays: () => []
      })
      const r = await m.create(null)
      check('swd-host 退出 1 时创建失败', !r.ok)
      check('失败原因带 SwDeviceCreate 报错', !r.ok && r.reason.includes('0x80070005'))
    }

    // 4. APPEARED 不来：短超时内失败，不挂死
    {
      const m = new VirtualDisplayManager({
        swdHostPath: process.execPath,
        swdHostArgs: [fakePath, 'silent'],
        listDisplays: () => [],
        readyTimeoutMs: 2000,
        appearTimeoutMs: 500
      })
      const t0 = Date.now()
      const r = await m.create(null)
      check('APPEARED 超时创建失败', !r.ok)
      check('超时失败不挂死（<5s）', Date.now() - t0 < 5000)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------- VddVirtualDisplayManager：fake driver manager + fake listDisplays ----------

// fake 驱动管理器：记录 status/ensureSettings/setDeviceEnabled 的调用，
// 不碰真实设备。enabled 状态由 fake 自己维护（setDeviceEnabled 改写它，
// status 读它），与真实 VddDriverManager 的行为一致。
interface FakeVddDriverCalls {
  status: number
  ensureSettings: Array<{ count: number; preferred?: { width: number; height: number; refreshRate?: number } }>
  setEnabled: boolean[]
}

function makeFakeVddDriver(opts: {
  installed?: boolean
  devicePresent?: boolean
  deviceEnabled?: boolean
  settingsOk?: boolean
  enableOk?: boolean
}): { driver: VddDriverLike; calls: FakeVddDriverCalls } {
  const calls: FakeVddDriverCalls = { status: 0, ensureSettings: [], setEnabled: [] }
  let enabled = opts.deviceEnabled ?? false
  const driver: VddDriverLike = {
    status: async () => {
      calls.status++
      return {
        installed: opts.installed ?? true,
        installedVersion: '11.30.4.434',
        oemInf: 'oem116.inf',
        deviceEnabled: enabled,
        devicePresent: opts.devicePresent ?? true,
        deviceInstanceId: (opts.devicePresent ?? true) ? 'ROOT\\DISPLAY\\0001' : null,
        packageBundled: true,
        isAdmin: true
      }
    },
    ensureSettings: async (count, preferred) => {
      calls.ensureSettings.push({ count, preferred })
      if (opts.settingsOk === false) {
        return { ok: false, reason: 'settings-write-failed', detail: 'fake 写入失败', count, created: false, changed: false }
      }
      return { ok: true, count, created: false, changed: false }
    },
    setDeviceEnabled: async (e) => {
      calls.setEnabled.push(e)
      if (opts.enableOk === false) {
        return { ok: false, reason: e ? 'enable-failed' : 'disable-failed', detail: 'fake 启用/禁用失败' }
      }
      enabled = e
      return { ok: true }
    }
  }
  return { driver, calls }
}

async function testVddVirtualDisplayManager(): Promise<void> {
  console.log('\n=== VddVirtualDisplayManager：fake driver manager ===\n')

  const before = [{ x: 0, y: 0, w: 1920, h: 1080 }]
  const after = [
    { x: 0, y: 0, w: 1920, h: 1080 },
    { x: 1920, y: 0, w: 2560, h: 1440 },
    { x: 1920, y: 0, w: 1024, h: 768 }
  ]

  // 1. happy path：调了 enable，差分挑中新显示器
  {
    const { driver, calls } = makeFakeVddDriver({})
    let n = 0
    const m = new VddVirtualDisplayManager({
      driver,
      listDisplays: () => (++n === 1 ? before : after)
    })
    const r = await m.create({ width: 2560, height: 1440 })
    check('VDD 创建成功', r.ok)
    check('VDD 按最接近请求尺寸挑到 2560x1440', r.ok && r.screen.w === 2560 && r.screen.x === 1920)
    check('VDD 创建后 active', m.active)
    check('VDD 创建后 available', m.available)
    check('VDD 创建时调了 ensureSettings(count=1)', calls.ensureSettings.length === 1 && calls.ensureSettings[0]?.count === 1)
    check('VDD 创建时调了 enable', calls.setEnabled.length === 1 && calls.setEnabled[0] === true)
    check('VDD currentScreen 与创建结果一致', m.currentScreen?.w === 2560)
    // destroy：本次会话是我们启用过 → 禁用
    m.destroy()
    await sleep(100)
    check('VDD destroy 后 inactive', !m.active)
    check('VDD destroy 时调了 disable（本次会话启用过）', calls.setEnabled.length === 2 && calls.setEnabled[1] === false)
  }

  // 2. 驱动未装：create 失败，且未尝试 enable、未写设置
  {
    const { driver, calls } = makeFakeVddDriver({ installed: false })
    const m = new VddVirtualDisplayManager({ driver, listDisplays: () => before })
    const r = await m.create(null)
    check('VDD 驱动未装时创建失败', !r.ok)
    check('VDD 驱动未装时原因可操作（指去设置页安装）', !r.ok && r.reason.includes('设置页安装'))
    check('VDD 驱动未装时未尝试 enable', calls.setEnabled.length === 0)
    check('VDD 驱动未装时未写设置', calls.ensureSettings.length === 0)
    check('VDD 驱动未装时 available 为 false', !m.available)
    check('VDD 驱动未装时 inactive', !m.active)
  }

  // 3. 驱动已装但设备节点未建（⑤ 已知缺口）：失败文案点出缺口，不误报安装失败
  {
    const { driver, calls } = makeFakeVddDriver({ devicePresent: false })
    const m = new VddVirtualDisplayManager({ driver, listDisplays: () => before })
    const r = await m.create(null)
    check('VDD 设备节点未建时创建失败', !r.ok)
    check('VDD 设备节点未建时原因点出节点创建缺口', !r.ok && r.reason.includes('设备节点未创建'))
    check('VDD 设备节点未建时未尝试 enable', calls.setEnabled.length === 0)
  }

  // 4. 会话前设备已启用：create 不重复 enable；destroy 不禁用（保持启用）
  {
    const { driver, calls } = makeFakeVddDriver({ deviceEnabled: true })
    let n = 0
    const m = new VddVirtualDisplayManager({
      driver,
      listDisplays: () => (++n === 1 ? before : after)
    })
    const r = await m.create({ width: 1920, height: 1080 })
    check('VDD 会话前已启用时创建成功', r.ok)
    check('VDD 会话前已启用时未重复 enable', calls.setEnabled.length === 0)
    m.destroy()
    await sleep(100)
    check('VDD 会话前已启用时 destroy 不禁用', calls.setEnabled.length === 0)
    check('VDD 会话前已启用时 destroy 后 inactive', !m.active)
  }

  // 4b. 节点预先已启用但首轮无差分，500ms 后自动重启节点刷新基线
  {
    const { driver, calls } = makeFakeVddDriver({ deviceEnabled: true })
    const m = new VddVirtualDisplayManager({
      driver,
      appearTimeoutMs: 2500,
      listDisplays: () => {
        // 在驱动被自动重启（setEnabled 包含 true）后返回新显示器
        return calls.setEnabled.includes(true) ? after : before
      }
    })
    const r = await m.create({ width: 1920, height: 1080 })
    check('VDD 节点预先已启用首轮无差分时 500ms 自动重启节点并成功创建', r.ok)
    check('VDD 自动重启节点触发了 disable 与 enable', calls.setEnabled.includes(false) && calls.setEnabled.includes(true))
    await m.destroy()
    check('VDD destroy 返回 Promise<void> 且正常完成', !m.active)
  }

  // 5. destroy 无活动时是安全空操作
  {
    const { driver, calls } = makeFakeVddDriver({})
    const m = new VddVirtualDisplayManager({ driver, listDisplays: () => before })
    m.destroy()
    await sleep(100)
    check('VDD 无活动时 destroy 不调任何驱动命令', calls.status === 0 && calls.setEnabled.length === 0)
    check('VDD 无活动时 destroy 后仍 inactive', !m.active)
  }

  // 6. 超时路径：启用成功但新显示器一直不出现 → 失败，且把节点恢复回禁用
  {
    const { driver, calls } = makeFakeVddDriver({})
    const m = new VddVirtualDisplayManager({
      driver,
      listDisplays: () => before,
      appearTimeoutMs: 600
    })
    const t0 = Date.now()
    const r = await m.create(null)
    const elapsed = Date.now() - t0
    check('VDD 新显示器超时创建失败', !r.ok)
    check('VDD 超时原因点出未枚举到新显示器', !r.ok && r.reason.includes('未枚举到新显示器'))
    check('VDD 超时失败不挂死（<5s）', elapsed < 5000)
    check('VDD 超时后 inactive', !m.active)
    check('VDD 超时后把节点恢复回禁用（enable 后补 disable）', calls.setEnabled.length === 2 && calls.setEnabled[0] === true && calls.setEnabled[1] === false)
  }
}

// ---------- startDd：帧源失败路径 ----------

async function testStartDdFailure(): Promise<void> {
  console.log('\n=== startDd：帧源失败路径 ===\n')

  const svc = new ScreenStreamService()
  let ended = false
  svc.onEnded = () => {
    ended = true
  }
  // 不存在的 dd-capture 路径：spawn 报 error，走 onEnded，不挂死
  svc.startDd({
    ffmpegPath: 'ffmpeg',
    ddCapturePath: join(tmpdir(), 'linkspace-no-such-dd-capture.exe'),
    onChunk: () => undefined,
    rect: { x: 0, y: 0, w: 1920, h: 1080 }
  })
  try {
    await waitFor(() => (ended ? true : undefined), 5000)
  } catch {
    /* 超时即失败，check 会报 */
  }
  check('dd-capture 不存在时 onEnded 触发', ended)
  check('dd-capture 不存在时 running 为 false', !svc.running)
  svc.stop()
}

async function main(): Promise<void> {
  console.log('\n=== LinkSpace 扩展屏（display-extend）测试 ===\n')

  testDecode()
  await testCoordinator()
  await testController()
  await testE2e()
  await testVirtualDisplayManager()
  await testVddVirtualDisplayManager()
  await testStartDdFailure()

  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试脚本异常：', err)
  process.exit(1)
})
