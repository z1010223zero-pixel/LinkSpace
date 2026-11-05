// 键鼠共享无头测试（阶段 3，验收第 7 组）。
//
// 两层：
//   1. 纯逻辑单测——事件解码、坐标映射、被控/控制状态机、边缘穿越、
//      布局存储。这些是安全边界与体验核心，必须确定性覆盖。
//   2. 双 Host 环路——真实的 WebSocket 控制通道上跑完整的
//      「请求 → 确认 → 事件注入 → 退出/终止/撤销」，外加剪贴板
//      开关的双向验证（6.6）。
//
// 真实的键鼠注入（Win32 SendInput）在后台会话里不可用，注入层
// 以捕获数组替代：验证的是「对的事件在对的时机被交给注入层」，
// SendInput 本身的正确性留真机走查。

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate } from 'selfsigned'
import { WebSocket } from 'ws'
import { ControlNode, MAX_CLOCK_SKEW_MS, MAX_SEEN_MESSAGE_IDS, PROTOCOL_VERSION, SeenMessageIds, type Envelope } from './control/node'
import { Host } from './host'
import { fingerprintOfCert, type DeviceCert } from './transfer/identity'
import type { DiscoveredService } from './discovery'
import type { PendingPairing } from './pairing'
import { decodeInputEvents, decodeScreenSize, mapPoint, MAX_INPUT_TEXT_BYTES, segmentInputText, utf8ByteLength, type InputEvent, type MouseButton } from './input/protocol'
import { resolveStreamStopDirection, ScreenStreamReceiver } from './screen-stream'
import { InputSessionCoordinator, InputController } from './input/session'
import { EdgeSwitcher, type EdgeLayout } from './input/edge'
import { InputLayoutStore } from './input/layout'
import { normalizeAbsolute, buildInputBatch, buildReleaseBatch, INPUT_SIZE, UNION_OFF } from './input/win32/sink'
import { Win32InputCapture, decideCaptureMode } from './input/win32/capture'

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

// ---------- 纯逻辑：事件解码与映射 ----------

function testProtocol(): void {
  console.log('\n=== 纯逻辑：input 事件编解码 ===\n')

  const ok: InputEvent[] = [
    { t: 'move', x: 100, y: 200.7 },
    { t: 'down', b: 'left' },
    { t: 'up', b: 'right' },
    { t: 'wheel', dx: 0, dy: -3 },
    { t: 'key', vk: 65, down: true }
  ]
  const decoded = decodeInputEvents({ events: ok })
  check('合法批次整体通过', decoded !== null && decoded.length === 5)
  check(
    '坐标取整',
    decoded?.[0].t === 'move' && decoded[0].x === 100 && decoded[0].y === 201,
    JSON.stringify(decoded?.[0])
  )

  check('events 缺失拒绝', decodeInputEvents({}) === null)
  check('events 非数组拒绝', decodeInputEvents({ events: 'nope' }) === null)
  check('空批次拒绝', decodeInputEvents({ events: [] }) === null)
  check(
    '超长批次拒绝',
    decodeInputEvents({ events: Array.from({ length: 65 }, () => ({ t: 'key', vk: 1, down: false })) }) === null
  )
  check('未知事件类型整批拒绝', decodeInputEvents({ events: [{ t: 'halt' }] }) === null)
  check('负坐标拒绝', decodeInputEvents({ events: [{ t: 'move', x: -1, y: 0 }] }) === null)
  check('超大坐标拒绝', decodeInputEvents({ events: [{ t: 'move', x: 99999, y: 0 }] }) === null)
  check('NaN 拒绝', decodeInputEvents({ events: [{ t: 'move', x: Number.NaN, y: 0 }] }) === null)
  check('非法鼠标键拒绝', decodeInputEvents({ events: [{ t: 'down', b: 'middle2' }] }) === null)
  const buttons = decodeInputEvents({
    events: [
      { t: 'down', b: 'right' },
      { t: 'up', b: 'right' },
      { t: 'down', b: 'middle' },
      { t: 'up', b: 'middle' }
    ]
  })
  check(
    '右/中键 down/up 原样通过解码',
    buttons !== null &&
      buttons.length === 4 &&
      (buttons[0] as { b: string }).b === 'right' &&
      (buttons[1] as { b: string }).b === 'right' &&
      (buttons[2] as { b: string }).b === 'middle' &&
      (buttons[3] as { b: string }).b === 'middle',
    JSON.stringify(buttons)
  )
  check('越界 VK 拒绝', decodeInputEvents({ events: [{ t: 'key', vk: 300, down: true }] }) === null)
  check('down 非布尔拒绝', decodeInputEvents({ events: [{ t: 'key', vk: 65, down: 1 }] }) === null)
  const wheel = decodeInputEvents({ events: [{ t: 'wheel', dx: 99999, dy: -99999 }] })
  check('滚轮钳制不拒绝', wheel !== null && (wheel[0] as { dx: number }).dx === 1000, JSON.stringify(wheel))

  check('屏幕尺寸 0 拒绝', decodeScreenSize({ w: 0, h: 1080 }) === null)
  check('屏幕尺寸非数拒绝', decodeScreenSize({ w: '1920', h: 1080 }) === null)
  check('屏幕尺寸合法通过', decodeScreenSize({ w: 2560, h: 1440 }) !== null)

  // 映射：控制端 2000x1000 → 被控端 1000x500
  const from = { w: 2000, h: 1000 }
  const to = { w: 1000, h: 500 }
  const p1 = mapPoint(1000, 500, from, to)
  check('坐标比例映射', p1.x === 500 && p1.y === 250, JSON.stringify(p1))
  const p2 = mapPoint(0, 0, from, to)
  check('原点映射为原点', p2.x === 0 && p2.y === 0)
  const p3 = mapPoint(1999, 999, from, to)
  check('边界钳制不越界', p3.x === 999 && p3.y === 499, JSON.stringify(p3))
  const p4 = mapPoint(5000, 5000, from, to)
  check('越界输入被钳制', p4.x === 999 && p4.y === 499, JSON.stringify(p4))
}

// ---------- 纯逻辑：screen.stream.stop 方向解析（协议 4.7） ----------
// 显式 direction 直接采用；缺失时按属于发消息对端的活动流解析——
// 单路在跑停那路、双向在跑只停 forward、两路都没跑忽略；非法值忽略。
function testStreamStopDirection(): void {
  console.log('\n=== 纯逻辑：screen.stream.stop 方向解析 ===\n')

  // 显式方向：与在跑状态无关，直接采用
  check('显式 forward 直接采用', resolveStreamStopDirection({ direction: 'forward' }, false, false) === 'forward')
  check('显式 reverse 直接采用', resolveStreamStopDirection({ direction: 'reverse' }, false, false) === 'reverse')
  check(
    '显式 forward 不受反向流在跑影响',
    resolveStreamStopDirection({ direction: 'forward' }, false, true) === 'forward'
  )
  check(
    '显式 reverse 不受正向流在跑影响',
    resolveStreamStopDirection({ direction: 'reverse' }, true, false) === 'reverse'
  )

  // 缺失 direction（旧版本对端）：单路在跑停那一路
  check('缺失时只跑 forward 停 forward', resolveStreamStopDirection({}, true, false) === 'forward')
  check('缺失时只跑 reverse 停 reverse', resolveStreamStopDirection({}, false, true) === 'reverse')
  // 缺失 direction：双向都在跑只停 forward，绝不顺手停掉另一路
  check('缺失时双向在跑只停 forward', resolveStreamStopDirection({}, true, true) === 'forward')
  // 缺失 direction：两路都没跑则忽略（不回声）
  check('缺失且无流在跑时忽略', resolveStreamStopDirection({}, false, false) === null)

  // 缺失的等价形态：payload 为 null / 非对象时同样按缺失处理
  check('payload 为 null 时按缺失处理', resolveStreamStopDirection(null, false, true) === 'reverse')
  check('payload 非对象时按缺失处理', resolveStreamStopDirection('nope', true, true) === 'forward')
  // direction 显式为 null 时按缺失处理（JSON null 与缺失同义）
  check('direction 为 null 时按缺失处理', resolveStreamStopDirection({ direction: null }, false, true) === 'reverse')

  // 非法 direction：一律忽略，不猜
  check('非法 direction 忽略', resolveStreamStopDirection({ direction: 'sideways' }, true, true) === null)
  check('空字符串 direction 忽略', resolveStreamStopDirection({ direction: '' }, true, false) === null)
  check('数字 direction 忽略', resolveStreamStopDirection({ direction: 123 }, false, true) === null)
}

// ---------- 纯逻辑：被控端状态机 ----------

interface SentMsg {
  peerId: string
  type: string
  payload: Record<string, unknown>
}

function makeCoordinator(opts: {
  now?: () => number
  ttlMs?: number
} = {}): {
  coord: InputSessionCoordinator
  sent: SentMsg[]
  injected: InputEvent[][]
  /** 用对象而非裸数字：数字在 return 时被快照，后续自增测试看不到 */
  state: { released: number }
  requests: string[]
} {
  const sent: SentMsg[] = []
  const injected: InputEvent[][] = []
  const state = { released: 0 }
  const requests: string[] = []
  const coord = new InputSessionCoordinator({
    callbacks: {
      isPeerAuthorized: (id) => id === 'dev_B',
      localScreen: () => ({ w: 1000, h: 500 }),
      inject: (events) => injected.push(events),
      releaseAll: () => {
        state.released++
      },
      send: (peerId, type, payload) => sent.push({ peerId, type, payload }),
      onRequest: (req) => requests.push(req.sessionId)
    },
    requestTtlMs: opts.ttlMs,
    now: opts.now
  })
  return { coord, sent, injected, state, requests }
}

function startPayload(
  sessionId: string,
  screen = { w: 2000, h: 1000 },
  displayName = 'Alpha'
): Record<string, unknown> {
  return { sessionId, sessionType: 'input', params: { screen, displayName } }
}

function testCoordinator(): void {
  console.log('\n=== 纯逻辑：被控端状态机 ===\n')

  // 1. 未信任设备：直接拒绝，不进 pending
  {
    const { coord, sent } = makeCoordinator()
    coord.onStart('dev_rogue', startPayload('s1'))
    check('未信任设备的请求被拒绝', sent[0]?.type === 'session.reject' && sent[0].payload.reason === 'not trusted')
    check('未信任设备的请求不弹 UI', coord.pendingRequest === null)
  }

  // 2. 正常流：pending → approve → active → 事件注入
  {
    const { coord, sent, injected } = makeCoordinator()
    coord.onStart('dev_B', startPayload('s2'))
    check('合法请求进入待确认', coord.pendingRequest?.sessionId === 's2')
    coord.onEvent('dev_B', { sessionId: 's2', events: [{ t: 'move', x: 1000, y: 500 }] })
    check('批准前的事件不注入', injected.length === 0)
    const r = coord.approve('s2')
    check('批准成功', r.ok)
    check(
      'accept 回给对端并携带本机屏幕',
      sent.some((m) => m.type === 'session.accept' && JSON.stringify(m.payload.screen) === '{"w":1000,"h":500}')
    )
    coord.onEvent('dev_B', {
      sessionId: 's2',
      events: [
        { t: 'move', x: 1000, y: 500 },
        { t: 'key', vk: 65, down: true }
      ]
    })
    check('活动会话事件注入', injected.length === 1 && injected[0].length === 2)
    check(
      '事件已按两端屏幕映射',
      injected[0][0].t === 'move' && (injected[0][0] as { x: number }).x === 500,
      JSON.stringify(injected[0][0])
    )
    // 旁观连接（其他已配对设备）不能注入
    coord.onEvent('dev_C', { sessionId: 's2', events: [{ t: 'key', vk: 66, down: true }] })
    check('旁观连接的事件被忽略', injected.length === 1)
  }

  // 3. 拒绝与过期
  {
    let t = 1_000_000
    const { coord, sent } = makeCoordinator({ now: () => t })
    coord.onStart('dev_B', startPayload('s3'))
    coord.deny('s3')
    check('拒绝后回 reject', sent.some((m) => m.type === 'session.reject' && m.payload.reason === 'denied by user'))
    check('拒绝后无挂起', coord.pendingRequest === null)

    const { coord: c2, sent: s2 } = makeCoordinator({ now: () => t, ttlMs: 1000 })
    c2.onStart('dev_B', startPayload('s4'))
    t += 1500
    const r = c2.approve('s4')
    check('过期请求批准失败', !r.ok && r.error === '请求已过期')
    check('过期请求自动回 reject', s2.some((m) => m.type === 'session.reject' && m.payload.reason === 'expired'))
  }

  // 4. 终止路径：对端 stop / 断连 / 撤销 / 本机终止，全部触发 releaseAll 防卡键
  {
    const { coord, sent, state } = makeCoordinator()
    coord.onStart('dev_B', startPayload('s5'))
    coord.approve('s5')
    coord.onStop('dev_B', { sessionId: 's5' })
    check('对端 stop 后会话结束', coord.activeSession === null)
    check('终止时抬起所有按键', state.released === 1)
    check('stop 回执已发', sent.filter((m) => m.type === 'session.stop').length === 1)

    const { coord: c2, state: st2 } = makeCoordinator()
    c2.onStart('dev_B', startPayload('s6'))
    c2.approve('s6')
    c2.onPeerDisconnected('dev_B')
    check('对端断连终止会话', c2.activeSession === null && st2.released === 1)

    const { coord: c3, state: st3 } = makeCoordinator()
    c3.onStart('dev_B', startPayload('s7'))
    c3.approve('s7')
    c3.onTrustRevoked('dev_B')
    check('信任撤销立即掐断会话', c3.activeSession === null && st3.released === 1)

    const { coord: c4, sent: s4 } = makeCoordinator()
    c4.onStart('dev_B', startPayload('s8'))
    c4.approve('s8')
    c4.terminate()
    check('本机终止后无活动会话', c4.activeSession === null)
    check('本机终止也通知对端', s4.some((m) => m.type === 'session.stop'))
  }

  // 5. 资源占用：同一时刻至多一个会话
  {
    const { coord, sent } = makeCoordinator()
    coord.onStart('dev_B', startPayload('s9'))
    coord.approve('s9')
    coord.onStart('dev_B', startPayload('s10'))
    check('活动期间新请求被拒', sent.some((m) => m.type === 'session.reject' && m.payload.reason === 'resource busy'))
    check('活动会话不受影响', coord.activeSession?.sessionId === 's9')
  }
}

// ---------- 纯逻辑：控制端状态机 ----------

async function testController(): Promise<void> {
  console.log('\n=== 纯逻辑：控制端状态机 ===\n')

  {
    const sent: SentMsg[] = []
    const ctl = new InputController({
      callbacks: { send: (peerId, type, payload) => sent.push({ peerId, type, payload }) }
    })
    const p = ctl.request('dev_B', { w: 2000, h: 1000 }, 'Alpha')
    const first = sent[0]
    check('request 发出 session.start', first?.type === 'session.start' && first.peerId === 'dev_B')
    check('start 携带会话类型与屏幕', (first?.payload as { sessionType?: string }).sessionType === 'input')
    check('控制端在 accept 前不控制任何人', ctl.controlling === null)
    const sid = (first.payload as { sessionId: string }).sessionId
    // 来源不符的 accept 必须被忽略
    ctl.onAccepted('dev_C', sid, { w: 1000, h: 500 })
    check('他端伪造的 accept 被忽略', ctl.controlling === null)
    ctl.onAccepted('dev_B', sid, { w: 1000, h: 500 })
    const res = await p
    check('accept 后 promise 落定', res.ok)
    check('accept 后进入控制态', ctl.controlling === 'dev_B')
    ctl.sendEvents([{ t: 'key', vk: 65, down: true }])
    check('事件外发给被控端', sent.some((m) => m.type === 'input.event'))
    ctl.stop('exit hotkey')
    check('stop 后回本机', ctl.controlling === null)
    check('stop 已通知对端', sent.some((m) => m.type === 'session.stop' && m.payload.reason === 'exit hotkey'))
    ctl.sendEvents([{ t: 'key', vk: 66, down: true }])
    check('退出后事件不再外发', sent.filter((m) => m.type === 'input.event').length === 1)
  }

  // 断连清理
  {
    const sent: SentMsg[] = []
    let ended = ''
    const ctl = new InputController({
      callbacks: {
        send: (peerId, type, payload) => sent.push({ peerId, type, payload }),
        onEnded: (peerId) => {
          ended = peerId
        }
      }
    })
    void ctl.request('dev_B', { w: 1, h: 1 }, 'A').then(() => undefined)
    const sid = (sent[0].payload as { sessionId: string }).sessionId
    ctl.onAccepted('dev_B', sid, { w: 1000, h: 500 })
    ctl.onPeerDisconnected('dev_B')
    check('被控端断连立即回本机', ctl.controlling === null && ended === 'dev_B')
  }

  // 超时回落
  {
    const ctl = new InputController({
      callbacks: { send: () => undefined },
      requestTimeoutMs: 80
    })
    const res = await ctl.request('dev_B', { w: 1, h: 1 }, 'A')
    check('对端无响应按失败回落', !res.ok && res.error === '对端未响应控制请求')
    check('超时后可再次发起', (await ctl.request('dev_B', { w: 1, h: 1 }, 'A')) !== undefined)
  }
}

// ---------- 纯逻辑：文本直通 input.text（协议 4.9，中文输入 B2） ----------

function testInputText(): void {
  console.log('\n=== 纯逻辑：input.text 分段 ===\n')

  check('空文本不分段', segmentInputText('').length === 0)
  check('短文本一段', segmentInputText('你好世界').length === 1)
  check('ASCII 恰好 8 KiB 一段', segmentInputText('a'.repeat(8 * 1024)).length === 1)
  const over = segmentInputText('a'.repeat(8 * 1024 + 1))
  check(
    'ASCII 超 1 字节切两段',
    over.length === 2 && over[0].length === 8 * 1024 && over[1] === 'a'
  )
  check('汉字按 3 字节计长', utf8ByteLength('汉') === 3 && utf8ByteLength('a汉😀') === 1 + 3 + 4)
  const han = segmentInputText('汉'.repeat(3000))
  check(
    '汉字长文按字节切段且每段不超限',
    han.length === 2 &&
      han.every((s) => utf8ByteLength(s) <= MAX_INPUT_TEXT_BYTES) &&
      han.join('') === '汉'.repeat(3000),
    han.map((s) => utf8ByteLength(s)).join('+')
  )
  // emoji 是代理对（4 字节）：切分点落在段边界时不得拆开
  const emoSegs = segmentInputText('😀'.repeat(3000)) // 12000 字节 → 两段
  check(
    'emoji 不拆代理对',
    emoSegs.length === 2 &&
      emoSegs.every((s) => utf8ByteLength(s) <= MAX_INPUT_TEXT_BYTES) &&
      emoSegs.join('') === '😀'.repeat(3000) &&
      [...emoSegs[0]].length === 2048,
    emoSegs.map((s) => utf8ByteLength(s)).join('+')
  )
  check('单段上限常量 8 KiB', MAX_INPUT_TEXT_BYTES === 8 * 1024)
}

async function testInputTextSend(): Promise<void> {
  console.log('\n=== 纯逻辑：控制端 input.text / screen.paste 发送 ===\n')

  const sent: SentMsg[] = []
  const ctl = new InputController({
    callbacks: { send: (peerId, type, payload) => sent.push({ peerId, type, payload }) }
  })
  // 未建立会话时发送是安全空操作
  ctl.sendText('你好')
  ctl.sendPaste('粘贴')
  check('无会话时文本/粘贴不外发', sent.length === 0)

  const req = ctl.request('dev_B', { w: 2000, h: 1000 }, 'Alpha')
  const sid = (sent[0].payload as { sessionId: string }).sessionId
  ctl.onAccepted('dev_B', sid, { w: 1000, h: 500 })
  await req
  sent.length = 0

  ctl.sendText('你好世界')
  const texts = sent.filter((m) => m.type === 'input.text')
  check(
    '短文本一段 input.text',
    texts.length === 1 &&
      (texts[0].payload as { text?: string }).text === '你好世界' &&
      (texts[0].payload as { sessionId?: string }).sessionId === sid
  )
  sent.length = 0
  ctl.sendText('a'.repeat(9000))
  const long = sent.filter((m) => m.type === 'input.text')
  check(
    '长文本按 8 KiB 分段发送',
    long.length === 2 &&
      long.every((m) => (m.payload as { sessionId?: string }).sessionId === sid) &&
      long.map((m) => (m.payload as { text?: string }).text ?? '').join('') === 'a'.repeat(9000),
    long.map((m) => ((m.payload as { text?: string }).text ?? '').length).join('+')
  )
  sent.length = 0
  ctl.sendPaste('粘贴文本')
  check(
    '粘贴一次 screen.paste',
    sent.length === 1 &&
      sent[0].type === 'screen.paste' &&
      (sent[0].payload as { text?: string }).text === '粘贴文本'
  )
  sent.length = 0
  ctl.sendPaste('a'.repeat(512 * 1024 + 1))
  check('超 512 KiB 的粘贴不发送', sent.length === 0)
  ctl.stop('done')
  sent.length = 0
  ctl.sendText('你好')
  check('退出后文本不再外发', sent.length === 0)
}

// ---------- 纯逻辑：边缘穿越与布局存储 ----------

function testEdge(): void {
  console.log('\n=== 纯逻辑：边缘穿越 ===\n')

  let t = 1_000_000
  const fired: string[] = []
  const sw = new EdgeSwitcher({
    onSwitch: (edge, deviceId) => fired.push(`${edge}:${deviceId}`),
    screen: { w: 1920, h: 1080 },
    cooldownMs: 800,
    now: () => t
  })
  sw.setLayout({ right: 'dev_R', left: 'dev_L', top: 'dev_T', bottom: 'dev_B' } as EdgeLayout)

  sw.feed(1919, 540)
  check('右缘触发右设备', fired[0] === 'right:dev_R', fired.join(','))
  check('触发后锁定', !sw.isArmed && sw.isLocked)

  // 贴边抖动与时间流逝都不该再触发：解除必须靠离开边缘带
  t += 100
  sw.feed(1919, 540)
  sw.feed(1920, 540)
  t += 5000
  sw.feed(1920, 540)
  check('贴边不动不重复触发', fired.length === 1, fired.join(','))

  sw.feed(1500, 540)
  check('离开边缘带解除锁定', sw.isArmed && !sw.isLocked)
  sw.feed(0, 540)
  check('左缘触发左设备', fired[1] === 'left:dev_L', fired.join(','))

  // 布局空缺的边不触发
  const sw2 = new EdgeSwitcher({
    onSwitch: (edge, deviceId) => fired.push(`${edge}:${deviceId}`),
    screen: { w: 1920, h: 1080 },
    cooldownMs: 1,
    now: () => t
  })
  sw2.setLayout({ right: 'dev_R' } as EdgeLayout)
  sw2.feed(0, 540)
  sw2.feed(960, 0)
  sw2.feed(960, 1079)
  check('未分配设备的边不触发', fired.length === 2, fired.join(','))

  // 屏幕尺寸变更后按新边界判定
  sw2.setScreen({ w: 1000, h: 800 })
  sw2.feed(999, 400)
  check('屏幕尺寸变更后仍正确判定', fired.length === 3 && fired[2] === 'right:dev_R', fired.join(','))
}

async function testLayoutStore(workDir: string): Promise<void> {
  console.log('\n=== 纯逻辑：键鼠布局存储 ===\n')
  const dir = join(workDir, 'layout-store')
  await mkdir(dir, { recursive: true })
  const store = new InputLayoutStore({ dir })
  store.setEdge('dev_1', 'right')
  store.setEdge('dev_2', 'left')
  check('设置可读回', store.edgeOf('dev_1') === 'right' && store.edgeOf('dev_2') === 'left')
  check('快照形状正确', JSON.stringify(store.all()) === '{"dev_1":"right","dev_2":"left"}', JSON.stringify(store.all()))

  // 一条边只允许一台设备：后设的顶掉先设的
  store.setEdge('dev_3', 'right')
  check('同边互斥', store.edgeOf('dev_1') === null && store.edgeOf('dev_3') === 'right')

  store.setEdge('dev_3', null)
  check('null 清除', store.edgeOf('dev_3') === null)

  store.setEdge('dev_2', 'diagonal' as never)
  check('非法边被忽略', store.edgeOf('dev_2') === 'left')

  // 重启恢复
  const store2 = new InputLayoutStore({ dir })
  check('重启后恢复', store2.edgeOf('dev_2') === 'left' && store2.edgeOf('dev_1') === null)

  // 损坏降级
  const badDir = join(workDir, 'layout-bad')
  await mkdir(badDir, { recursive: true })
  await writeFile(join(badDir, 'input-layout.json'), '{broken', 'utf8')
  const store3 = new InputLayoutStore({ dir: badDir })
  check('损坏文件降级为空且不崩溃', Object.keys(store3.all()).length === 0)
}

// ---------- 纯逻辑：Win32 注入与采集 ----------

function makeFakeNative() {
  let pos: { x: number; y: number } | null = { x: 0, y: 0 }
  const down = new Set<number>()
  return {
    setPos(p: { x: number; y: number } | null): void {
      pos = p
    },
    press(vk: number): void {
      down.add(vk)
    },
    release(vk: number): void {
      down.delete(vk)
    },
    native: {
      getCursorPos: () => (pos ? { ...pos } : null),
      isKeyDown: (vk: number) => down.has(vk)
    }
  }
}

function testWin32(): void {
  console.log('\n=== 纯逻辑：Win32 注入与采集 ===\n')

  // 绝对坐标归一化
  const vs = { x: 0, y: 0, w: 1920, h: 1080 }
  check('绝对坐标原点归零', normalizeAbsolute(0, 0, vs).nx === 0 && normalizeAbsolute(0, 0, vs).ny === 0)
  const br = normalizeAbsolute(1919, 1079, vs)
  check('右下角归一化到 65535', br.nx === 65535 && br.ny === 65535, JSON.stringify(br))
  check('负坐标钳到 0', normalizeAbsolute(-500, -1, vs).nx === 0 && normalizeAbsolute(-500, -1, vs).ny === 0)
  check('越界钳到 65535', normalizeAbsolute(99999, 99999, vs).nx === 65535)
  const vs2 = { x: -1920, y: 0, w: 3840, h: 1080 }
  const off = normalizeAbsolute(-1920, 0, vs2)
  check('带偏移虚拟屏归一化', off.nx === 0 && normalizeAbsolute(1919, 0, vs2).nx === 65535)

  // INPUT 打包
  {
    const keys = new Set<number>()
    const buttons = new Set<MouseButton>()
    const buf = buildInputBatch([{ t: 'move', x: 960, y: 540 }], vs, keys, buttons)
    check('move 打包为 ABSOLUTE|VIRTUALDESK|MOVE', buf !== null && buf.readUInt32LE(UNION_OFF + 12) === 0xc001)
    // 期望值按归一化公式独立重算（公式边界行为已由上面四项钉死）
    const expectNx = Math.round((960 * 65535) / 1919)
    const expectNy = Math.round((540 * 65535) / 1079)
    check(
      'move 写入归一化坐标',
      buf !== null && buf.readInt32LE(UNION_OFF) === expectNx && buf.readInt32LE(UNION_OFF + 4) === expectNy,
      buf ? `${buf.readInt32LE(UNION_OFF)},${buf.readInt32LE(UNION_OFF + 4)} vs ${expectNx},${expectNy}` : ''
    )

    const b2 = buildInputBatch([{ t: 'key', vk: 0x25, down: true }], vs, keys, buttons)
    check('方向键带扩展位', b2 !== null && b2.readUInt32LE(UNION_OFF + 4) === 0x0001 && b2.readUInt16LE(UNION_OFF) === 0x25)
    const b3 = buildInputBatch([{ t: 'key', vk: 0x41, down: false }], vs, keys, buttons)
    check('普通键抬起仅 KEYUP 位', b3 !== null && b3.readUInt32LE(UNION_OFF + 4) === 0x0002)
    const b3x = buildInputBatch([{ t: 'key', vk: 0x25, down: false }], vs, keys, buttons)
    check('扩展键抬起带 EXTENDEDKEY（审查 P3）', b3x !== null && b3x.readUInt32LE(UNION_OFF + 4) === 0x0003)

    const b4 = buildInputBatch([{ t: 'wheel', dx: 0, dy: -2 }], vs, keys, buttons)
    check('滚轮换算 WHEEL_DELTA', b4 !== null && b4.readUInt32LE(UNION_OFF + 12) === 0x0800 && b4.readInt32LE(UNION_OFF + 8) === -240)
    const b5 = buildInputBatch([{ t: 'wheel', dx: 3, dy: -2 }], vs, keys, buttons)
    check('双轴滚轮拆两条 INPUT', b5 !== null && b5.length === INPUT_SIZE * 2)
    check('非法屏幕拒绝打包', buildInputBatch([{ t: 'move', x: 1, y: 1 }], { x: 0, y: 0, w: 0, h: 0 }, keys, buttons) === null)

    // 按下状态记录与 releaseAll
    const k2 = new Set<number>()
    const bt2 = new Set<MouseButton>()
    buildInputBatch([{ t: 'down', b: 'left' }, { t: 'key', vk: 65, down: true }], vs, k2, bt2)
    check('按下状态被记录', k2.has(65) && bt2.has('left'))
    const rel = buildReleaseBatch(k2, bt2)
    check('releaseAll 抬起全部并清空', rel !== null && rel.length === INPUT_SIZE * 2 && k2.size === 0 && bt2.size === 0)
    check(
      'releaseAll 内容正确（先键后钮）',
      rel !== null &&
        rel.readUInt16LE(UNION_OFF) === 65 &&
        rel.readUInt32LE(UNION_OFF + 4) === 2 &&
        rel.readUInt32LE(INPUT_SIZE + UNION_OFF + 12) === 0x0004
    )
    check('无按住状态 releaseAll 为空', buildReleaseBatch(new Set(), new Set()) === null)
  }

  // 采集状态机
  {
    const f = makeFakeNative()
    const edge: Array<{ x: number; y: number }> = []
    const evts: InputEvent[][] = []
    const cap = new Win32InputCapture({
      native: f.native,
      screen: { w: 1920, h: 1080 },
      onEvents: (e) => evts.push(e),
      onEdgeMove: (x, y) => edge.push({ x, y })
    })

    // idle：只喂边缘
    cap.tick()
    f.setPos({ x: 500, y: 300 })
    cap.tick()
    check('idle 位移喂边缘检测', edge.length === 1 && edge[0].x === 500 && edge[0].y === 300)
    f.setPos({ x: -5, y: 1200 })
    cap.tick()
    // 审查 P3：主屏之外（副屏/负坐标）不再喂边缘——钳到主屏边界后
    // nearRight/nearBottom 恒真，移向副屏会误触发边缘穿越
    check('多屏负坐标不喂边缘', edge.length === 1)
    f.setPos({ x: 1920, y: 400 }) // 主屏右边界之外（右侧副屏）
    cap.tick()
    f.setPos({ x: 2000, y: 500 })
    cap.tick()
    check('右侧副屏坐标不喂边缘', edge.length === 1)
    check('idle 不产输入事件', evts.length === 0)
    f.setPos(null)
    cap.tick()
    f.setPos({ x: 10, y: 10 })
    cap.tick()
    check('读取失败重建基线不触发边缘', edge.length === 1)

    // control：采集
    cap.setMode('control')
    cap.tick()
    const base = evts.length
    check('进入控制态首 tick 无事件', evts.length === base)
    f.press(65)
    cap.tick()
    check(
      '按键按下被采集',
      evts.length === base + 1 && evts[base][0].t === 'key' && (evts[base][0] as { down: boolean }).down === true
    )
    cap.tick()
    check('按住不重复上报', evts.length === base + 1)
    f.release(65)
    cap.tick()
    check(
      '按键抬起被采集',
      evts.length === base + 2 && (evts[base + 1][0] as { down: boolean }).down === false
    )
    f.press(0x01)
    f.setPos({ x: 1000, y: 500 })
    cap.tick()
    check(
      '移动与鼠标键同帧采集',
      evts.length === base + 3 && evts[base + 2].length === 2 && evts[base + 2][0].t === 'move' && evts[base + 2][1].t === 'down'
    )
    f.release(0x01)
    cap.tick()

    // 模式切换清基线：切走再切回，首 tick 不得重放旧位置/旧按键
    const before = evts.length
    cap.setMode('idle')
    cap.setMode('control')
    cap.tick()
    check('模式切换后重建基线', evts.length === before)

    // 受控挂起（审查 P2-3）：被控期间本机采集必须停摆——此时光标移动
    // 是对端注入的，喂边缘或转发都等于让对端借本机无授权驱动第三方
    const suspEvts = evts.length
    const suspEdge = edge.length
    cap.setMode('suspended')
    cap.tick() // 建挂起基线
    f.setPos({ x: 1500, y: 700 })
    f.press(0x45)
    cap.tick()
    f.release(0x45)
    cap.tick()
    check('挂起期间不产输入事件', evts.length === suspEvts)
    check('挂起期间不喂边缘检测', edge.length === suspEdge)
    cap.setMode('control')
    cap.tick()
    check('退出挂起首 tick 无事件（基线重建）', evts.length === suspEvts)

    // 单 tick 大量按键 → 按协议上限分批
    for (let vk = 0x08; vk < 0x08 + 70; vk++) f.press(vk)
    cap.tick()
    const c1 = evts[evts.length - 2]
    const c2 = evts[evts.length - 1]
    check('超长采集按 64 条分批', c1.length === 64 && c2.length === 6, `${c1.length}+${c2.length}`)

    // 左右区分修饰键（0xA0..0xA5）跳过，避免与通用修饰键（0x10..0x12）双发
    for (let vk = 0x08; vk < 0x08 + 70; vk++) f.release(vk)
    cap.tick()
    const modBase = evts.length
    f.press(0x11)
    f.press(0xa2)
    f.press(0x56)
    cap.tick()
    const modBatch = evts[modBase] ?? []
    check(
      'Ctrl+V 采集跳过 0xA2 左右修饰重复码',
      evts.length === modBase + 1 &&
        modBatch.length === 2 &&
        (modBatch[0] as { vk?: number }).vk === 0x11 &&
        (modBatch[1] as { vk?: number }).vk === 0x56,
      JSON.stringify(modBatch)
    )
  }
}

// Bug 1：反向窗口失焦/最小化时，全局采集必须挂起，否则用户在别的
// 窗口打字、挪鼠标都会同步到平板。决策矩阵（窗口焦点事件本身是
// Electron 行为，无头测不到；这里钉死“给定焦点态 → 什么采集模式”）：
//   - 被控挂起优先于一切（含正在控制对端时被反向控制）
//   - 反向会话 + 窗口获得焦点 → control（与修复前一致）
//   - 反向会话 + 窗口失焦/最小化 → suspended（只保基线，不转发、不喂边缘）
//   - 线 1 会话（无反向窗口）不受焦点门限制 → control
//   - 无会话 → idle
function testDecideCaptureMode(): void {
  console.log('\n=== 纯逻辑：采集模式决策（Bug 1 焦点门） ===\n')

  const base = { controlledByPeer: false, controllingPeer: false, reverseSession: false, reverseInputPaused: false }
  check('无会话 → idle', decideCaptureMode(base) === 'idle')
  check(
    '线 1 控制中 → control',
    decideCaptureMode({ ...base, controllingPeer: true }) === 'control'
  )
  check(
    '反向会话 + 窗口获得焦点 → control',
    decideCaptureMode({ ...base, controllingPeer: true, reverseSession: true, reverseInputPaused: false }) === 'control'
  )
  check(
    '反向会话 + 窗口失焦/最小化 → suspended',
    decideCaptureMode({ ...base, controllingPeer: true, reverseSession: true, reverseInputPaused: true }) === 'suspended'
  )
  check(
    '线 1 控制中不受反向暂停态影响 → control',
    decideCaptureMode({ ...base, controllingPeer: true, reverseSession: false, reverseInputPaused: true }) === 'control'
  )
  check(
    '被控挂起优先于控制态 → suspended',
    decideCaptureMode({ ...base, controlledByPeer: true, controllingPeer: true }) === 'suspended'
  )
  check(
    '被控挂起优先于反向焦点态 → suspended',
    decideCaptureMode({ ...base, controlledByPeer: true, controllingPeer: true, reverseSession: true, reverseInputPaused: false }) ===
      'suspended'
  )
  check(
    '仅被控（无控制会话）→ suspended',
    decideCaptureMode({ ...base, controlledByPeer: true }) === 'suspended'
  )
}

// ---------- 双 Host 环路 ----------

async function testE2e(): Promise<void> {
  console.log('\n=== 双 Host 环路：请求 → 确认 → 注入 → 退出 ===\n')

  const workDir = await mkdtemp(join(tmpdir(), 'linkspace-input-'))
  const injectedB: InputEvent[][] = []
  let releasedB = 0
  const ioA = { value: '' }
  const ioB = { value: '' }
  const requestsB: { sessionId: string; displayName: string }[] = []
  // 配对 pending 只存在于接收方（B），发起方 A 的列表恒空——
  // 曾误轮询 A 侧导致 20s 超时，进而触发未处理的 pairing reject 崩溃
  const pairRequestsB: PendingPairing[] = []

  const A = new Host({
    displayName: 'Input-Alpha',
    deviceType: 'win',
    dataDir: join(workDir, 'A'),
    cert: await makeCert(),
    bind: '127.0.0.1',
    inputLocalScreen: () => ({ w: 2000, h: 1000 })
  })
  const B = new Host({
    displayName: 'Input-Beta',
    deviceType: 'win',
    dataDir: join(workDir, 'B'),
    cert: await makeCert(),
    bind: '127.0.0.1',
    inputLocalScreen: () => ({ w: 1000, h: 500 }),
    inputInject: (events) => injectedB.push(events),
    inputReleaseAll: () => {
      releasedB++
    }
  })
  const C = new Host({
    displayName: 'Input-Gamma',
    deviceType: 'win',
    dataDir: join(workDir, 'C'),
    cert: await makeCert(),
    bind: '127.0.0.1'
  })
  await mkdir(join(workDir, 'C'), { recursive: true })

  B.on('inputRequested', (req) => requestsB.push({ sessionId: req.sessionId, displayName: req.displayName }))
  B.on('pairRequested', (p) => pairRequestsB.push(p))

  await A.start()
  await B.start()
  await C.start()

  try {
    // 直连配对（不经 mDNS：本测试只关心控制通道语义）
    const svcB: DiscoveredService = {
      serviceName: 'Input-Beta',
      idPrefix: B.id.slice(0, 12),
      displayName: 'Input-Beta',
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
    check('配对默认无 control 授权', !B.trustStore.scopeOf(A.id).includes('control'))

    // ---------- 1. 控制请求与确认（9.1 授权可见） ----------
    console.log('\n1. 控制请求 → 用户确认 → 会话建立')
    const reqPromise = A.requestInputControl(B.id)
    const req = await waitFor(() => requestsB[0])
    check('被控端收到请求并弹 UI', req.sessionId.length > 0)
    check('请求带对端显示名（仅提示用）', req.displayName === 'Input-Alpha')
    check('确认前无活动会话', B.controlledByPeer() === null && A.controllingPeer() === null)

    const approved = B.approveInputControl(req.sessionId)
    check('被控端批准', approved.ok)
    const ctrl = await reqPromise
    check('控制端 promise 落定', ctrl.ok)
    check('两端会话状态一致', A.controllingPeer() === B.id && B.controlledByPeer() === A.id)

    // ---------- 2. 事件注入与坐标映射 ----------
    console.log('\n2. 事件注入与坐标映射')
    A.sendInputEvents([
      { t: 'move', x: 1000, y: 500 },
      { t: 'key', vk: 65, down: true },
      { t: 'down', b: 'left' },
      { t: 'wheel', dx: 0, dy: -2 }
    ])
    await waitFor(() => injectedB[0])
    check('事件批次到达注入层', injectedB.length === 1 && injectedB[0].length === 4)
    const firstMove = injectedB[0][0] as { t: string; x: number; y: number }
    check('坐标按两端屏幕比例映射', firstMove.x === 500 && firstMove.y === 250, JSON.stringify(firstMove))
    check('键鼠事件原样通过', (injectedB[0][1] as { vk: number }).vk === 65)

    // ---------- 3. 未信任设备拒绝 ----------
    console.log('\n3. 未信任设备被门禁挡下')
    const connC = await C.connect({ ...svcB })
    await waitFor(() => (connC.peerId === B.id ? connC : undefined))
    const reqC = C.requestInputControl(B.id)
    await sleep(400)
    check('未信任设备的控制请求失败', !(await reqC).ok)
    check('未信任设备的请求不弹 UI', requestsB.length === 1)
    const before = injectedB.length
    C.sendInputEvents([{ t: 'key', vk: 66, down: true }])
    await sleep(200)
    check('未信任设备的事件不注入', injectedB.length === before)

    // ---------- 4. 剪贴板开关（6.6） ----------
    console.log('\n4. 剪贴板开关 e2e')
    A.enableClipboardSync({
      readText: () => ioA.value,
      writeText: (t) => {
        ioA.value = t
      }
    })
    B.enableClipboardSync({
      readText: () => ioB.value,
      writeText: (t) => {
        ioB.value = t
      }
    })
    ioA.value = '打开后的第一段'
    A.pollClipboard()
    await waitFor(() => (ioB.value === '打开后的第一段' ? true : undefined))
    check('正向对照：开关全开时同步到达', ioB.value === '打开后的第一段')

    A.setClipboardEnabled(false)
    ioA.value = 'A 关闭后复制的内容'
    A.pollClipboard()
    await sleep(300)
    check('发送侧关闭后不再发送', ioB.value === '打开后的第一段')

    A.setClipboardEnabled(true) // 基线重读为「A 关闭后复制的内容」，不广播
    await sleep(200)
    check('重开开关不广播存量内容', ioB.value === '打开后的第一段')

    B.setClipboardEnabled(false)
    ioA.value = 'B 关闭期间 A 复制的内容'
    A.pollClipboard()
    await sleep(300)
    check('接收侧关闭后不再写入', ioB.value === '打开后的第一段')

    B.setClipboardEnabled(true)
    ioA.value = '双侧重开后的内容'
    A.pollClipboard()
    await waitFor(() => (ioB.value === '双侧重开后的内容' ? true : undefined))
    check('双侧重开后恢复正常同步', ioB.value === '双侧重开后的内容')

    // ---------- 5. 控制端退出（7.4 快捷键路径） ----------
    console.log('\n5. 控制端退出（快捷键路径）')
    A.stopInputControl('exit hotkey')
    await waitFor(() => (A.controllingPeer() === null ? true : undefined))
    check('控制端回本机', A.controllingPeer() === null)
    // session.stop 是跨端消息：被控端状态更新走网络，不能随控制端本地状态同步断言
    await waitFor(() => (B.controlledByPeer() === null ? true : undefined))
    check('被控端会话同步结束', B.controlledByPeer() === null)
    check('被控端抬起按住状态（防卡键）', releasedB === 1)
    const beforeStop = injectedB.length
    A.sendInputEvents([{ t: 'key', vk: 67, down: true }])
    await sleep(200)
    check('退出后事件不再注入', injectedB.length === beforeStop)

    // ---------- 6. 被控端随时拔掉控制 ----------
    console.log('\n6. 被控端随时拔掉控制')
    const req2Promise = A.requestInputControl(B.id)
    const req2 = await waitFor(() => requestsB[1])
    B.approveInputControl(req2.sessionId)
    check('第二次会话建立', (await req2Promise).ok && B.controlledByPeer() === A.id)
    B.terminateInputControl()
    await waitFor(() => (A.controllingPeer() === null ? true : undefined))
    check('被控端终止后控制端回本机', A.controllingPeer() === null)
    check('每次终止都抬起按键', releasedB === 2)

    // ---------- 6.5 反向窗口的键鼠控制（线 2 W7，2.3-2） ----------
    // 流尺寸声明的 input 会话：控制面就是流画面，session.start 里声明的
    // 屏幕尺寸是流尺寸（1080x2400），不是本机虚拟屏（2000x1000）。
    // 平板按声明尺寸把窗口坐标映射回本屏；断言用注入侧的落点验证。
    console.log('\n6.5 反向窗口的键鼠控制（流尺寸声明）')
    // 门禁：无 ffmpeg 的本机请求反向流直接失败，不发请求、不改状态
    const noFfmpeg = A.requestReverseScreenStream(B.id)
    check('无 ffmpeg 时反向流请求失败', !noFfmpeg.ok)
    check('无 ffmpeg 时不进入反向流状态', A.reverseStreamStatus().peerId === null)
    const offlineReverse = A.requestReverseScreenStream('no-such-peer')
    check('离线设备反向流请求失败', !offlineReverse.ok)
    const untrustedReverse = C.requestInputControlWithScreen(B.id, { w: 1080, h: 2400 })
    check('未配对设备不能发起反向控制', !untrustedReverse.ok)

    const streamScreen = { w: 1080, h: 2400 }
    const revReq = A.requestInputControlWithScreen(B.id, streamScreen)
    check('反向控制请求发出', revReq.ok)
    check('请求待确认时状态为 pending', A.reverseInputStatus().state === 'pending')
    check(
      '声明尺寸就是流尺寸',
      JSON.stringify(A.reverseInputScreen()) === JSON.stringify(streamScreen)
    )
    const reqRev = await waitFor(() => requestsB[2])
    B.approveInputControl(reqRev.sessionId)
    await waitFor(() => (A.controllingPeer() === B.id ? true : undefined))
    check('反向控制会话建立', A.controllingPeer() === B.id && B.controlledByPeer() === A.id)
    check('会话建立后状态为 active', A.reverseInputStatus().state === 'active')
    // 同对端重复请求不重发、不报错
    check('已控制时重复请求直接成功', A.requestInputControlWithScreen(B.id, streamScreen).ok)
    // 流坐标 (540,1200) → 声明 1080x2400 → B 本机 1000x500：落点 (500,250)
    const beforeRev = injectedB.length
    A.sendInputEvents([{ t: 'move', x: 540, y: 1200 }])
    await waitFor(() => (injectedB.length > beforeRev ? true : undefined))
    const revMove = injectedB[injectedB.length - 1][0] as { t: string; x: number; y: number }
    check('流坐标按声明尺寸映射到本屏', revMove.x === 500 && revMove.y === 250, JSON.stringify(revMove))
    // 左右键映射（线 2）：右/中键 down/up 随 input.event 原样到达被控端
    // 注入层，b 不塌成左键；落点语义（右键返回/中键 Home）由 Android
    // 被控端按协议 4.6 落地，本处只钉桌面控制端不丢键。
    const beforeBtn = injectedB.length
    A.sendInputEvents([
      { t: 'down', b: 'right' },
      { t: 'up', b: 'right' }
    ])
    await waitFor(() => (injectedB.length > beforeBtn ? true : undefined))
    const btnBatch = injectedB[injectedB.length - 1]
    check(
      '右键 down/up 原样到达被控端注入层',
      btnBatch.length === 2 &&
        btnBatch[0].t === 'down' &&
        (btnBatch[0] as { b: string }).b === 'right' &&
        btnBatch[1].t === 'up' &&
        (btnBatch[1] as { b: string }).b === 'right',
      JSON.stringify(btnBatch)
    )
    const beforeMid = injectedB.length
    A.sendInputEvents([
      { t: 'down', b: 'middle' },
      { t: 'up', b: 'middle' }
    ])
    await waitFor(() => (injectedB.length > beforeMid ? true : undefined))
    const midBatch = injectedB[injectedB.length - 1]
    check(
      '中键 down/up 原样到达被控端注入层',
      midBatch.length === 2 &&
        midBatch[0].t === 'down' &&
        (midBatch[0] as { b: string }).b === 'middle' &&
        midBatch[1].t === 'up' &&
        (midBatch[1] as { b: string }).b === 'middle',
      JSON.stringify(midBatch)
    )
    // 会话结束清声明（第 7 节的 releasedB 计数随之 +1，见下）
    A.stopInputControl('reverse window closed')
    await waitFor(() => (A.controllingPeer() === null ? true : undefined))
    check('反向会话结束清声明', A.reverseInputScreen() === null)
    check('反向会话结束后状态为 none', A.reverseInputStatus().state === 'none')

    // 拒绝路径：平板拒绝后状态为 failed，带原因，可重试
    const revReq2 = A.requestInputControlWithScreen(B.id, streamScreen)
    check('第二次反向控制请求发出', revReq2.ok)
    const reqRev2 = await waitFor(() => requestsB[3])
    B.denyInputControl(reqRev2.sessionId)
    await waitFor(() => (A.reverseInputStatus().state === 'failed' ? true : undefined))
    check('平板拒绝后状态为 failed', A.reverseInputStatus().state === 'failed')
    check('拒绝原因带回窗口', (A.reverseInputStatus().error ?? '').includes('拒绝'))

    // 反向流接收端切帧：块边界与帧边界完全不对齐时，输出帧数与内容仍须正确
    // （splitFrames 改为块列表累积后，防止回归成丢帧/错位）
    {
      const rx = new ScreenStreamReceiver()
      const W = 6
      const H = 4
      const frameSize = W * H * 4
      const frames: Array<{ w: number; h: number; first: number; last: number }> = []
      const r = rx as unknown as {
        expectedWidth: number
        expectedHeight: number
        onFrameRef: ((f: { width: number; height: number; data: Buffer }) => void) | null
        frameChunks: Buffer[]
        frameBytes: number
        splitFrames: () => void
      }
      r.expectedWidth = W
      r.expectedHeight = H
      r.onFrameRef = (f) =>
        frames.push({ w: f.width, h: f.height, first: f.data[0], last: f.data[f.data.length - 1] })
      // 5 帧，帧 i 全部填充字节 i+1；以 7/1/50/33 字节的不规则块喂入
      const all = Buffer.concat([1, 2, 3, 4, 5].map((i) => Buffer.alloc(frameSize, i)))
      const sizes = [7, 1, 50, 33]
      let off = 0
      let k = 0
      while (off < all.length) {
        const n = Math.min(sizes[k++ % sizes.length], all.length - off)
        r.frameChunks.push(all.subarray(off, off + n))
        r.frameBytes += n
        off += n
        r.splitFrames()
      }
      check('不规则分块仍切出 5 帧', frames.length === 5, String(frames.length))
      check(
        '每帧内容按序且不串帧',
        frames.every((f, i) => f.first === i + 1 && f.last === i + 1 && f.w === W && f.h === H)
      )
      check('切帧后无残留字节', r.frameBytes === 0 && r.frameChunks.length === 0)
    }

    // ---------- 7. 撤销信任掐断会话 ----------
    console.log('\n7. 撤销信任立即掐断')
    const req3Promise = A.requestInputControl(B.id)
    const req3 = await waitFor(() => requestsB[4])
    B.approveInputControl(req3.sessionId)
    check('第三次会话建立', (await req3Promise).ok)
    B.revokeTrust(A.id)
    await waitFor(() => (B.controlledByPeer() === null ? true : undefined))
    check('撤销后被控端会话结束', B.controlledByPeer() === null)
    check('撤销后抬起按键', releasedB === 4)
    // 撤销通知（pair.revoke）同样走网络：控制端收到后才回本机并删除信任
    await waitFor(() => (A.controllingPeer() === null ? true : undefined))
    check('撤销后控制端也回本机', A.controllingPeer() === null, `A.controlling=${A.controllingPeer()}`)
    check('撤销是双向的', !A.trustStore.isKnown(B.id))

    // ---------- 8. 剪贴板开关持久化（P2-1） ----------
    console.log('\n8. 剪贴板开关持久化')
    // 用户上次关掉的，重启后不能悄悄打开：开关必须落在 profile.json。
    // 同一 dataDir 重建 Host 等价于进程重启（profile 是构造时读盘的）
    const dirP = join(workDir, 'P')
    await mkdir(dirP, { recursive: true })
    const mkPersistHost = async (gen: number) =>
      new Host({
        displayName: 'Input-Persist-' + gen,
        deviceType: 'win',
        dataDir: dirP,
        cert: await makeCert(),
        bind: '127.0.0.1'
      })
    // 三代实例串行起停（而非并存）：贴近「重启」语义，也避免同进程
    // 多实例并发通告同名 mDNS 服务刷冲突告警
    const P1 = await mkPersistHost(1)
    await P1.start()
    P1.enableClipboardSync({ readText: () => '', writeText: () => {} })
    check('未设置过时默认关', P1.restoreClipboardSwitch() === false)
    P1.setClipboardEnabled(true)
    await P1.stop()
    const P2 = await mkPersistHost(2)
    await P2.start()
    P2.enableClipboardSync({ readText: () => '', writeText: () => {} })
    check('重启后恢复为开', P2.restoreClipboardSwitch() === true)
    P2.setClipboardEnabled(false)
    await P2.stop()
    const P3 = await mkPersistHost(3)
    await P3.start()
    P3.enableClipboardSync({ readText: () => '', writeText: () => {} })
    check('重启后恢复为关', P3.restoreClipboardSwitch() === false)
    await P3.stop()
  } finally {
    await A.stop()
    await B.stop()
    await C.stop()
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * 心跳超时的会话清理（审查 P2-4）。
 *
 * 被控期间对端断网的典型表现是静默丢包：TCP 没有断开信号，ws.close
 * 的优雅握手完不成，真正的 close 事件要等 closeTimeout（30s）。修复前
 * onTimeout 只删连接表条目，Host 级清理（终止会话 + 抬键）要等
 * 15s 心跳 + 30s close ≈ 45s；修复后超时回调与 onClosed 共用
 * handleConnClosed，超时即刻恢复本机输入。
 */
async function testHeartbeatTimeout(): Promise<void> {
  console.log('\n=== 心跳超时终止会话（静默丢包路径）===\n')

  const workDir = await mkdtemp(join(tmpdir(), 'linkspace-hbinput-'))
  const injected: InputEvent[][] = []
  let released = 0
  const requests: string[] = []
  const pairRequests: PendingPairing[] = []

  // D（控制端）注入超长心跳周期：测试期间一条心跳都不发，模拟静默丢包；
  // E（被控端）短周期判定：1s 无消息即视为对端离线
  const D = new Host({
    displayName: 'HB-Alpha',
    deviceType: 'win',
    dataDir: join(workDir, 'D'),
    cert: await makeCert(),
    bind: '127.0.0.1',
    heartbeat: { intervalMs: 60_000, timeoutMs: 60_000 },
    inputLocalScreen: () => ({ w: 2000, h: 1000 })
  })
  const E = new Host({
    displayName: 'HB-Beta',
    deviceType: 'win',
    dataDir: join(workDir, 'E'),
    cert: await makeCert(),
    bind: '127.0.0.1',
    heartbeat: { intervalMs: 200, timeoutMs: 1000 },
    inputLocalScreen: () => ({ w: 1000, h: 500 }),
    inputInject: (events) => injected.push(events),
    inputReleaseAll: () => {
      released++
    }
  })
  await mkdir(join(workDir, 'D'), { recursive: true })
  await mkdir(join(workDir, 'E'), { recursive: true })
  E.on('inputRequested', (r) => requests.push(r.sessionId))
  E.on('pairRequested', (p) => pairRequests.push(p))

  try {
    await D.start()
    await E.start()

    const svcE: DiscoveredService = {
      serviceName: 'HB-Beta',
      idPrefix: E.id.slice(0, 12),
      displayName: 'HB-Beta',
      deviceType: 'win',
      caps: ['file'],
      host: '127.0.0.1',
      port: E.port,
      paired: true,
      lastSeen: Date.now()
    }
    const conn = await D.connect(svcE)
    await waitFor(() => (conn.peerId === E.id ? conn : undefined))
    const pairingPromise = D.requestPairing(conn)
    const pending = await waitFor(() => pairRequests[0])
    D.submitCode(conn, pending.code)
    check('配对建立', (await pairingPromise).deviceId === E.id)

    const reqPromise = D.requestInputControl(E.id)
    const req = await waitFor(() => requests[0])
    E.approveInputControl(req)
    check('会话已建立', (await reqPromise).ok && E.controlledByPeer() === D.id)

    // 此后 D 完全静默（含心跳）：E 的超时判定触发，会话必须立即终止
    await waitFor(() => (E.controlledByPeer() === null ? true : undefined))
    check('超时后被控会话立即终止', E.controlledByPeer() === null)
    check('超时清理抬起按住状态（防卡键）', released === 1)
    check('超时期间无事件注入', injected.length === 0)
    // close 帧经 TCP 仍可达：控制端走 onClosed 既有路径回本机
    await waitFor(() => (D.controllingPeer() === null ? true : undefined))
    check('控制端随之回本机', D.controllingPeer() === null)
  } finally {
    await D.stop()
    await E.stop()
    await rm(workDir, { recursive: true, force: true })
  }
}

// ---------- 信封校验：坏 v 断连、坏 to 丢弃、超偏 ts 丢弃 ----------
//
// 直接驱动 ControlNode + 原生 ws 客户端（不经 Host/配对）：
// 坏信封在 announce 之前就能发，测的就是入口本身。
// 断言：坏 v 断连（4007）且不到 handler；坏 to 静默丢弃且不断连；
// 超偏 ts 丢弃且不断连；to 为空放行（announce 前必需）。
// __closed__ 的 emptyEnvelope（v 已是 PROTOCOL_VERSION）不走消息
// 解析，坏 v 测试同时验证该路径不断链（服务端 onClosed 正常触发）。

function testSeenMessageIds(): void {
  console.log('\n=== 纯逻辑：消息 id 去重（协议 §3） ===\n')

  const seen = new SeenMessageIds(3)
  check('首次 id 不算重复', !seen.isDuplicate('a') && !seen.isDuplicate('b'))
  check('同一 id 第二次算重复', seen.isDuplicate('a'))
  check('重复计数累计', seen.duplicateCount === 1)
  check('窗口内其他 id 仍算重复', seen.isDuplicate('b'))
  seen.isDuplicate('c')
  seen.isDuplicate('d') // 窗口 {b, c, d}，a 被淘汰
  check('窗口内 id 被新 id 挤掉前仍算重复', seen.isDuplicate('b'))
  check('淘汰出窗口的 id 再次出现视为新消息', !seen.isDuplicate('a'))

  const full = new SeenMessageIds()
  let fresh = true
  for (let i = 0; i < MAX_SEEN_MESSAGE_IDS; i++) fresh &&= !full.isDuplicate(`id-${i}`)
  check('默认窗口 1024 条内不误判', fresh)
  check('窗口满后最旧 id 仍算重复', full.isDuplicate('id-0'))
  check('新 id 挤掉最旧 id', !full.isDuplicate('id-1024') && !full.isDuplicate('id-0'))
}

async function testEnvelopeValidation(): Promise<void> {
  console.log('\n=== 信封校验：v / to / ts / from / id 分级失败处理 ===\n')

  const server = new ControlNode({
    deviceId: 'dev_server',
    tls: await makeCert()
  })
  const port = await server.listen(0)
  const received: string[] = []
  const closedPeers: string[] = []
  server.on('device.heartbeat', (_conn, msg) => {
    received.push(msg.id)
  })
  // 模拟 pairing.ts 的 announce 登记：peerId 由首条 announce 的 from 填上
  server.on('device.announce', (conn, msg) => {
    conn.peerId = msg.from
  })
  server.onClosed((conn) => {
    closedPeers.push(conn.peerId)
  })

  const envelope = (over: Partial<Envelope> = {}): Record<string, unknown> => ({
    v: PROTOCOL_VERSION,
    type: 'device.heartbeat',
    id: `env-${received.length}-${Date.now()}`,
    from: 'dev_client',
    to: 'dev_server',
    ts: Date.now(),
    payload: {},
    ...over
  })

  async function rawClient(): Promise<WebSocket> {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/linkspace/v1/control`, {
      rejectUnauthorized: false
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return ws
  }

  try {
    // 1. 合法信封通过；to 为空也放行（announce 之前对端身份未知）
    const ws1 = await rawClient()
    try {
      ws1.send(JSON.stringify(envelope()))
      await waitFor(() => (received.length >= 1 ? received[0] : undefined))
      check('合法信封到达 handler', received.length === 1)
      ws1.send(JSON.stringify(envelope({ to: '', id: 'empty-to' })))
      await waitFor(() => (received.length >= 2 ? received[1] : undefined))
      check('to 为空放行（announce 前）', received.length === 2)
    } finally {
      ws1.close()
    }
    await sleep(200)

    // 2. 坏 v：断开连接（4007），不到 handler
    const closedBefore = closedPeers.length
    const ws2 = await rawClient()
    const closeCode = await new Promise<number>((resolve) => {
      ws2.once('close', (code) => resolve(code))
      ws2.send(JSON.stringify(envelope({ v: PROTOCOL_VERSION + 1, id: 'bad-v' })))
      setTimeout(() => resolve(-1), 5000)
    })
    check('坏 v 断开连接（4007）', closeCode === 4007, `code=${closeCode}`)
    check('坏 v 不到达 handler', received.length === 2)
    await waitFor(() => (closedPeers.length > closedBefore ? closedPeers.length : undefined))
    check('坏 v 触发服务端 __closed__（emptyEnvelope 路径正常）', closedPeers.length > closedBefore)

    // 3. 坏 to：静默丢弃，不断连
    const ws3 = await rawClient()
    try {
      ws3.send(JSON.stringify(envelope({ to: 'dev_someone_else', id: 'bad-to' })))
      await sleep(300)
      check('坏 to 静默丢弃', received.length === 2)
      ws3.send(JSON.stringify(envelope({ id: 'after-bad-to' })))
      await waitFor(() => (received.length >= 3 ? received[2] : undefined))
      check('坏 to 不断连（随后合法消息仍到达）', received.length === 3 && ws3.readyState === WebSocket.OPEN)
    } finally {
      ws3.close()
    }

    // 4. 超偏 ts：丢弃，不断连
    const ws4 = await rawClient()
    try {
      ws4.send(
        JSON.stringify(envelope({ ts: Date.now() - MAX_CLOCK_SKEW_MS - 60_000, id: 'stale-ts' }))
      )
      await sleep(300)
      check('超偏 ts 丢弃', received.length === 3)
      ws4.send(JSON.stringify(envelope({ id: 'after-stale-ts' })))
      await waitFor(() => (received.length >= 4 ? received[3] : undefined))
      check('超偏 ts 不断连（随后合法消息仍到达）', received.length === 4 && ws4.readyState === WebSocket.OPEN)
    } finally {
      ws4.close()
    }

    // 5. from 绑定：announce 登记后，from 不符/为空的消息丢弃，不断连。
    // 登记前（ws1-ws4）from='dev_client' 能通过，正是“登记前只要求非空”。
    const ws5 = await rawClient()
    try {
      ws5.send(JSON.stringify(envelope({ type: 'device.announce', id: 'bind-announce' })))
      await sleep(300)
      const base = received.length
      ws5.send(JSON.stringify(envelope({ id: 'bind-ok-1' })))
      await waitFor(() => (received.length >= base + 1 ? received[base] : undefined))
      check('登记身份的 from 到达 handler', received.length === base + 1)
      ws5.send(JSON.stringify(envelope({ from: 'dev_other', id: 'bind-spoof-1' })))
      await sleep(300)
      check('冒名 from 丢弃', received.length === base + 1)
      ws5.send(JSON.stringify(envelope({ from: '', id: 'bind-empty-1' })))
      await sleep(300)
      check('空 from 丢弃', received.length === base + 1)
      ws5.send(JSON.stringify(envelope({ id: 'bind-ok-2' })))
      await waitFor(() => (received.length >= base + 2 ? received[base + 1] : undefined))
      check('from 不合不断连（随后合法消息仍到达）', received.length === base + 2 && ws5.readyState === WebSocket.OPEN)
      // 同一连接上重发 announce 改绑身份：from 不符直接在信封层拦住
      ws5.send(
        JSON.stringify(envelope({ type: 'device.announce', from: 'dev_other', id: 'bind-reannounce' }))
      )
      await sleep(300)
      ws5.send(JSON.stringify(envelope({ id: 'bind-ok-3' })))
      await waitFor(() => (received.length >= base + 3 ? received[base + 2] : undefined))
      check('重发 announce 改绑失败（原身份消息仍到达）', received.length === base + 3)
    } finally {
      ws5.close()
    }

    // 6. id 去重：同一连接上同一 id 只处理一次；空 id 丢弃
    const ws6 = await rawClient()
    try {
      ws6.send(JSON.stringify(envelope({ type: 'device.announce', id: 'dedup-announce' })))
      await sleep(300)
      const base = received.length
      ws6.send(JSON.stringify(envelope({ id: 'dup-1' })))
      await waitFor(() => (received.length >= base + 1 ? received[base] : undefined))
      check('首个 id 到达 handler', received.length === base + 1)
      ws6.send(JSON.stringify(envelope({ id: 'dup-1' })))
      await sleep(300)
      check('重复 id 只处理一次', received.length === base + 1)
      ws6.send(JSON.stringify(envelope({ id: 'dup-1' })))
      await sleep(300)
      check('第三次重放同样丢弃', received.length === base + 1)
      ws6.send(JSON.stringify(envelope({ id: 'dup-2' })))
      await waitFor(() => (received.length >= base + 2 ? received[base + 1] : undefined))
      check('新 id 正常到达', received.length === base + 2)
      ws6.send(JSON.stringify(envelope({ id: '' })))
      await sleep(300)
      check('空 id 丢弃', received.length === base + 2)
      check('去重不断连', ws6.readyState === WebSocket.OPEN)
    } finally {
      ws6.close()
    }
  } finally {
    server.stop()
  }
}

async function main(): Promise<void> {
  console.log('\n=== LinkSpace 键鼠共享测试 ===\n')

  testProtocol()
  testStreamStopDirection()
  testSeenMessageIds()
  testCoordinator()
  await testController()
  testInputText()
  await testInputTextSend()
  testEdge()
  testWin32()
  testDecideCaptureMode()

  const workDir = await mkdtemp(join(tmpdir(), 'linkspace-input-unit-'))
  try {
    await testLayoutStore(workDir)
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  await testE2e()
  await testHeartbeatTimeout()
  await testEnvelopeValidation()

  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试脚本异常：', err)
  process.exit(1)
})
