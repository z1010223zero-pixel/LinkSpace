// check-protocol.mjs — P0 共享协议一致性检查（无依赖，纯 node 可直接运行）。
//
// 比对 docs/protocol.md 的机器可读版 modules/protocol/protocol.json 与两端
// 代码里的协议常量是否一致：
//   - Kotlin: apps/android/.../service/Protocol.kt（消息类型、数值常量）
//             + LinkSpaceService.kt（配对/心跳/剪贴板散落常量抽查）
//             + TransferServer.kt（入站 from 绑定与 id 去重守卫抽查）
//   - TS: apps/desktop/src/main/input/protocol.ts、control/node.ts、
//         screen-stream.ts、pairing.ts、clipboard.ts、transfer/server.ts、
//         transfer/chunker.ts、host.ts
//
// 用法：node scripts/check-protocol.mjs（在 apps/desktop 下运行，
// 或 npm run verify:protocol）。任一不一致即打印差异并以非零码退出。
// protocol.json 里只允许出现 protocol.md 定义且未删除的消息类型；
// transfer.progress 已按 docs/line2-line3-direction.md §5 删除，
// 出现在 JSON 或 Kotlin TYPE_* 里即判失败。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DESKTOP = resolve(ROOT, 'apps/desktop/src/main')
const ANDROID = resolve(ROOT, 'apps/android/app/src/main/java/cn/linkspace/client/service')

const read = (p) => readFileSync(p, 'utf8')
const protocol = JSON.parse(read(resolve(ROOT, 'modules/protocol/protocol.json')))
const C = protocol.constraints

const failures = []
const warnings = []
let passed = 0

function canon(v) {
  if (Array.isArray(v)) return v.map(canon)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  }
  return v
}

function check(name, expected, actual, source) {
  const ok = JSON.stringify(canon(expected)) === JSON.stringify(canon(actual))
  if (ok) {
    passed++
    console.log(`PASS  ${name} = ${JSON.stringify(actual)}  (${source})`)
  } else {
    failures.push(name)
    console.log(
      `FAIL  ${name}: protocol.json 期望 ${JSON.stringify(expected)}，` +
      `代码实际 ${JSON.stringify(actual)}  (${source})`
    )
  }
}

function warn(msg) {
  warnings.push(msg)
  console.log(`WARN  ${msg}`)
}

// 只含数字、空格、* 的表达式求值，如 "32 * 1024 * 1024"、"15_000"
function evalNum(expr) {
  const clean = expr.replace(/_/g, '').trim()
  if (!/^[0-9\s*]+$/.test(clean)) throw new Error(`无法求值的数值表达式: ${expr}`)
  return clean.split('*').map((s) => Number(s.trim())).reduce((a, b) => a * b, 1)
}

// 正则里的模式归一化：去掉 /.../ 定界符与 ^ $ 锚点
function normPattern(p) {
  return p.replace(/^\//, '').replace(/\/[a-z]*$/, '').replace(/^\^/, '').replace(/\$$/, '')
}

// 取 "const NAME = <expr>;"（TS，export 可有可无）
function tsConst(src, name) {
  const m = src.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*([^;\\n]+)`))
  if (!m) throw new Error(`TS 常量未找到: ${name}`)
  return m[1].trim()
}

// 取 "const val NAME = <expr>"（Kotlin）
function ktConst(src, name) {
  const m = src.match(new RegExp(`const val ${name}\\s*=\\s*([^\\n]+)`))
  if (!m) throw new Error(`Kotlin 常量未找到: ${name}`)
  return m[1].trim().replace(/,$/, '')
}

// ---------- 读入各方源文件 ----------
const kt = read(resolve(ANDROID, 'Protocol.kt'))
const ktService = read(resolve(ANDROID, 'LinkSpaceService.kt'))
const ktInjector = read(resolve(ANDROID, 'ControlledInputInjector.kt'))
const ktA11y = read(resolve(ANDROID, 'LinkSpaceAccessibilityService.kt'))
const tsSink = read(resolve(DESKTOP, 'input/win32/sink.ts'))
const md = read(resolve(ROOT, 'docs/protocol.md'))
const ktServer = read(resolve(ANDROID, 'TransferServer.kt'))
const tsInput = read(resolve(DESKTOP, 'input/protocol.ts'))
const tsSession = read(resolve(DESKTOP, 'input/session.ts'))
const tsNode = read(resolve(DESKTOP, 'control/node.ts'))
const tsStream = read(resolve(DESKTOP, 'screen-stream.ts'))
const tsPairing = read(resolve(DESKTOP, 'pairing.ts'))
const tsClipboard = read(resolve(DESKTOP, 'clipboard.ts'))
const tsTransferServer = read(resolve(DESKTOP, 'transfer/server.ts'))
const tsChunker = read(resolve(DESKTOP, 'transfer/chunker.ts'))
const tsHost = read(resolve(DESKTOP, 'host.ts'))
const tsExtend = read(resolve(DESKTOP, 'extend/session.ts'))
const ktExtend = read(resolve(ANDROID, 'DisplayExtendController.kt'))

const jsonTypes = protocol.messageTypes.map((m) => m.type)
const jsonTypeSet = new Set(jsonTypes)

// ---------- 0. JSON 自身完整性 ----------
check('messageTypes 无重复', jsonTypes.length, jsonTypeSet.size, 'protocol.json')
if (jsonTypeSet.has('transfer.progress')) {
  failures.push('transfer.progress 不应出现在 protocol.json')
  console.log('FAIL  transfer.progress 已删除，不应出现在 protocol.json')
} else {
  passed++
  console.log('PASS  transfer.progress 不在 protocol.json（已删除，符合方向文档 §5）')
}

// ---------- 1. Kotlin Protocol.kt ----------
check('protocolVersion', C.protocolVersion, evalNum(ktConst(kt, 'VERSION')), 'Protocol.kt VERSION')
check('chunkSizeBytes', C.chunkSizeBytes, evalNum(ktConst(kt, 'CHUNK_SIZE')), 'Protocol.kt CHUNK_SIZE')
check('maxEventsPerMessage', C.maxEventsPerMessage, evalNum(ktConst(kt, 'MAX_EVENTS_PER_MESSAGE')), 'Protocol.kt MAX_EVENTS_PER_MESSAGE')
check('maxCoord', C.maxCoord, evalNum(ktConst(kt, 'MAX_COORD')), 'Protocol.kt MAX_COORD')
check('maxChunkBodyBytes', C.maxChunkBodyBytes, evalNum(ktConst(kt, 'MAX_CHUNK_BODY')), 'Protocol.kt MAX_CHUNK_BODY')

const sessionIdKt = ktConst(kt, 'SESSION_ID_RE').replace(/^"|"$/g, '')
check('sessionIdPattern', C.sessionIdPattern, normPattern(sessionIdKt), 'Protocol.kt SESSION_ID_RE')

const scopeM = kt.match(/DEFAULT_GRANT_SCOPE[^=]*=\s*listOf\(([^)]+)\)/)
if (!scopeM) throw new Error('Kotlin DEFAULT_GRANT_SCOPE 未找到')
const scopeKt = scopeM[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
check('defaultGrantScope', C.defaultGrantScope, scopeKt, 'Protocol.kt DEFAULT_GRANT_SCOPE')

// Kotlin 消息类型常量：每一个都必须在 protocol.json 里；反之 JSON 里多出
// 的类型（device.capabilities / device.disconnect / session.state）只警告，
// 它们由 protocol.md 定义、代码里尚无同名常量，不算不一致。
const ktTypes = [...kt.matchAll(/const val (TYPE_\w+)\s*=\s*"([^"]+)"/g)]
for (const [, constName, value] of ktTypes) {
  if (value === 'transfer.progress') {
    failures.push(`Kotlin 仍有已删除类型 ${value}`)
    console.log(`FAIL  ${constName} = ${value}：transfer.progress 已删除`)
  } else if (!jsonTypeSet.has(value)) {
    failures.push(`Kotlin 类型 ${value} 不在 protocol.json`)
    console.log(`FAIL  ${constName} = ${value} 不在 protocol.json 的 messageTypes 里`)
  } else {
    passed++
    console.log(`PASS  ${constName} = ${value}  (Protocol.kt)`)
  }
}
for (const t of jsonTypes) {
  if (!ktTypes.some(([, , v]) => v === t)) {
    warn(`protocol.json 有 ${t}，Protocol.kt 里无同名 TYPE_* 常量（协议定义先行，代码未引用）`)
  }
}

// Kotlin 信封字段（Envelope 数据类）与 protocol.json envelope 对照
const envBlock = kt.match(/data class Envelope\(([\s\S]*?)\)/)
if (!envBlock) throw new Error('Kotlin Envelope 数据类未找到')
const envFields = protocol.envelope.fields.map((f) => f.name)
for (const f of envFields) {
  if (new RegExp(`\\bval ${f}\\s*:`).test(envBlock[1])) {
    passed++
    console.log(`PASS  envelope 字段 ${f}  (Protocol.kt Envelope)`)
  } else {
    failures.push(`Kotlin Envelope 缺字段 ${f}`)
    console.log(`FAIL  Kotlin Envelope 缺字段 ${f}`)
  }
}

// ---------- 2. TS control/node.ts ----------
check('protocolVersion', C.protocolVersion, evalNum(tsConst(tsNode, 'PROTOCOL_VERSION')), 'control/node.ts PROTOCOL_VERSION')
check('heartbeat.intervalMs', C.heartbeat.intervalMs, evalNum(tsConst(tsNode, 'HEARTBEAT_INTERVAL_MS')), 'control/node.ts HEARTBEAT_INTERVAL_MS')
check('heartbeat.timeoutMs', C.heartbeat.timeoutMs, evalNum(tsConst(tsNode, 'HEARTBEAT_TIMEOUT_MS')), 'control/node.ts HEARTBEAT_TIMEOUT_MS')
check('maxClockSkewMs', C.maxClockSkewMs, evalNum(tsConst(tsNode, 'MAX_CLOCK_SKEW_MS')), 'control/node.ts MAX_CLOCK_SKEW_MS')
check('controlMaxPayloadBytes', C.controlMaxPayloadBytes, evalNum(tsConst(tsNode, 'CONTROL_MAX_PAYLOAD')), 'control/node.ts CONTROL_MAX_PAYLOAD')

const rateBlock = tsNode.match(/RATE_LIMITS[^=]*=\s*\{([\s\S]*?)\n\}/)
if (!rateBlock) throw new Error('control/node.ts RATE_LIMITS 未找到')
const rateTs = Object.fromEntries(
  [...rateBlock[1].matchAll(/'([^']+)':\s*(\d+)/g)].map(([, k, v]) => [k, Number(v)])
)
check('rateLimitsPerSecond', C.rateLimitsPerSecond, rateTs, 'control/node.ts RATE_LIMITS')

// 配对码 6 位：generatePairingCode 函数体里的 % 1_000_000 + padStart(6, '0')
const genCodeFn = tsNode.match(/function generatePairingCode\(\)[\s\S]*?\n\}/)
if (!genCodeFn) throw new Error('control/node.ts generatePairingCode 未找到')
const modM = genCodeFn[0].match(/%\s*([\d_]+)/)
const padM = genCodeFn[0].match(/padStart\((\d+),\s*'0'\)/)
check('pairingCode.digits', C.pairingCode.digits, padM ? Number(padM[1]) : null, 'control/node.ts generatePairingCode padStart')
check('pairingCode 模数 10^digits', 10 ** C.pairingCode.digits, modM ? evalNum(modM[1]) : null, 'control/node.ts generatePairingCode % 1_000_000')

// ---------- 3. TS input/protocol.ts ----------
check('maxEventsPerMessage', C.maxEventsPerMessage, evalNum(tsConst(tsInput, 'MAX_EVENTS_PER_MESSAGE')), 'input/protocol.ts MAX_EVENTS_PER_MESSAGE')
check('maxCoord', C.maxCoord, evalNum(tsConst(tsInput, 'MAX_COORD')), 'input/protocol.ts MAX_COORD')

const sessionIdTs = tsInput.match(/SESSION_ID_RE\s*=\s*(\/[^/]+\/)/)
if (!sessionIdTs) throw new Error('input/protocol.ts SESSION_ID_RE 未找到')
check('sessionIdPattern', C.sessionIdPattern, normPattern(sessionIdTs[1]), 'input/protocol.ts SESSION_ID_RE')

const wheelM = tsInput.match(/Math\.max\((-?\d+),\s*Math\.min\((\d+),/)
if (!wheelM) throw new Error('input/protocol.ts 滚轮钳制未找到')
check('inputEvent.wheelClamp', C.inputEvent.wheelClamp, Number(wheelM[2]), 'input/protocol.ts wheel 钳 ±1000')
const vkM = tsInput.match(/vk < 0 \|\| vk > (\d+)/)
if (!vkM) throw new Error('input/protocol.ts vk 上限未找到')
check('inputEvent.vkMax', C.inputEvent.vkMax, Number(vkM[1]), 'input/protocol.ts vk 0..255')

// ---------- 4. TS screen-stream.ts ----------
const tiersBlock = tsStream.match(/TIERS[^=]*=\s*\[([\s\S]*?)\n\]/)
if (!tiersBlock) throw new Error('screen-stream.ts TIERS 未找到')
const tiersTs = [...tiersBlock[1].matchAll(/\{\s*label:\s*'([^']+)',\s*bps:\s*(null|[\d_]+)\s*\}/g)]
  .map(([, label, bps]) => ({ label, bps: bps === 'null' ? null : evalNum(bps) }))
check('streamTiers', C.streamTiers, tiersTs, 'screen-stream.ts TIERS')

const presetsBlock = tsStream.match(/STREAM_QUALITY_PRESETS[^=]*=\s*\[([\s\S]*?)\n\]/)
if (!presetsBlock) throw new Error('screen-stream.ts STREAM_QUALITY_PRESETS 未找到')
const presetsTs = [...presetsBlock[1].matchAll(/\{\s*label:\s*'([^']+)',\s*width:\s*([\d_]+),\s*fps:\s*([\d_]+),\s*bps:\s*([\d_]+)\s*\}/g)]
  .map(([, label, width, fps, bps]) => ({ label, width: evalNum(width), fps: evalNum(fps), bps: evalNum(bps) }))
check('streamQualityPresets', C.streamQualityPresets, presetsTs, 'screen-stream.ts STREAM_QUALITY_PRESETS')

// screen.stream.stop 方向位（协议 4.7）：TS screen-stream.ts 与
// Kotlin Protocol.kt 的 STREAM_DIRECTION_* 必须与 protocol.json
// constraints.streamDirections 一字不差；stop 的 payload 必须是 [direction?]
const dirTs = ['STREAM_DIRECTION_FORWARD', 'STREAM_DIRECTION_REVERSE']
  .map((n) => tsConst(tsStream, n).replace(/^['"]|['"]$/g, ''))
check('streamDirections', C.streamDirections, dirTs, 'screen-stream.ts STREAM_DIRECTION_*')
const dirKt = ['STREAM_DIRECTION_FORWARD', 'STREAM_DIRECTION_REVERSE']
  .map((n) => ktConst(kt, n).replace(/^"|"$/g, ''))
check('streamDirections', C.streamDirections, dirKt, 'Protocol.kt STREAM_DIRECTION_*')
const stopEntry = protocol.messageTypes.find((m) => m.type === 'screen.stream.stop')
check('screen.stream.stop payload', ['direction?'], stopEntry?.payload ?? null, 'protocol.json messageTypes')

// ---------- 5. TS pairing.ts / clipboard.ts / transfer / host.ts ----------
check('pairingCode.ttlMs', C.pairingCode.ttlMs, evalNum(tsConst(tsPairing, 'CODE_TTL_MS')), 'pairing.ts CODE_TTL_MS')
check('pairingCode.maxAttempts', C.pairingCode.maxAttempts, evalNum(tsConst(tsPairing, 'MAX_ATTEMPTS')), 'pairing.ts MAX_ATTEMPTS')
check('pairingCode.maxPending', C.pairingCode.maxPending, evalNum(tsConst(tsPairing, 'MAX_PENDING')), 'pairing.ts MAX_PENDING')
check('clipboardMaxBytes', C.clipboardMaxBytes, evalNum(tsConst(tsClipboard, 'DEFAULT_MAX_BYTES')), 'clipboard.ts DEFAULT_MAX_BYTES')
check('clipboardSuppressMs', C.clipboardSuppressMs, evalNum(tsConst(tsClipboard, 'SUPPRESS_MS')), 'clipboard.ts SUPPRESS_MS')
check('maxChunkBodyBytes', C.maxChunkBodyBytes, evalNum(tsConst(tsTransferServer, 'MAX_CHUNK_BODY')), 'transfer/server.ts MAX_CHUNK_BODY')
check('chunkSizeBytes', C.chunkSizeBytes, evalNum(tsConst(tsChunker, 'DEFAULT_CHUNK_SIZE')), 'transfer/chunker.ts DEFAULT_CHUNK_SIZE')

const transferIdTs = tsHost.match(/TRANSFER_ID_RE\s*=\s*(\/[^/]+\/)/)
if (!transferIdTs) throw new Error('host.ts TRANSFER_ID_RE 未找到')
check('transferIdPattern', C.transferIdPattern, normPattern(transferIdTs[1]), 'host.ts TRANSFER_ID_RE')

// ---------- 6. Kotlin LinkSpaceService.kt 抽查 ----------
check('pairingCode.maxPending', C.pairingCode.maxPending, evalNum(ktConst(ktService, 'MAX_PENDING_PAIRINGS')), 'LinkSpaceService.kt MAX_PENDING_PAIRINGS')
check('pairingCode.maxAttempts', C.pairingCode.maxAttempts, evalNum(ktConst(ktService, 'MAX_PAIR_ATTEMPTS')), 'LinkSpaceService.kt MAX_PAIR_ATTEMPTS')

const ktCodeM = ktService.match(/String\.format\("%0(\d+)d",\s*secureRandom\.nextInt\(([\d_]+)\)\)/)
if (!ktCodeM) throw new Error('LinkSpaceService.kt 配对码生成未找到')
check('pairingCode.digits', C.pairingCode.digits, Number(ktCodeM[1]), 'LinkSpaceService.kt 配对码 %06d')
check('pairingCode 模数 10^digits', 10 ** C.pairingCode.digits, evalNum(ktCodeM[2]), 'LinkSpaceService.kt 配对码 nextInt(1_000_000)')

const ktTtlM = ktService.match(/expiresAt\s*=\s*System\.currentTimeMillis\(\)\s*\+\s*([\d_]+)/)
if (!ktTtlM) throw new Error('LinkSpaceService.kt 配对码过期时间未找到')
check('pairingCode.ttlMs', C.pairingCode.ttlMs, evalNum(ktTtlM[1]), 'LinkSpaceService.kt expiresAt +60_000')

const ktSkewM = ktService.match(/abs\(System\.currentTimeMillis\(\)\s*-\s*msg\.optLong\("ts",\s*0L\)\)\s*>\s*([\d_]+)/)
if (!ktSkewM) throw new Error('LinkSpaceService.kt ts 偏差校验未找到')
check('maxClockSkewMs', C.maxClockSkewMs, evalNum(ktSkewM[1]), 'LinkSpaceService.kt ts ±60_000')

const ktClipM = ktService.match(/toByteArray\(Charsets\.UTF_8\)\.size\s*>\s*([\d_* ]+)/)
if (!ktClipM) throw new Error('LinkSpaceService.kt 剪贴板上限未找到')
check('clipboardMaxBytes', C.clipboardMaxBytes, evalNum(ktClipM[1]), 'LinkSpaceService.kt 剪贴板 512 * 1024')

// ---------- 7. 左右键映射（线 2，协议 4.6 [PROTOCOL] 2026-11-03） ----------
// wire 不变：b 字段三值在三处一致；落点语义分平台，文档与实现互相钉死。
const mouseButtonsM = tsInput.match(/MOUSE_BUTTONS[^=]*=\s*\[([^\]]+)\]/)
if (!mouseButtonsM) throw new Error('input/protocol.ts MOUSE_BUTTONS 未找到')
const mouseButtonsTs = [...mouseButtonsM[1].matchAll(/'([^']+)'/g)].map(([, v]) => v)
check('inputEvent.mouseButtons', C.inputEvent.mouseButtons, mouseButtonsTs, 'input/protocol.ts MOUSE_BUTTONS')

const parseButtonM = ktInjector.match(/private fun parseButton[\s\S]*?\n    \}/)
if (!parseButtonM) throw new Error('ControlledInputInjector.kt parseButton 未找到')
const ktButtons = [...parseButtonM[0].matchAll(/"([^"]+)"\s*->\s*Button\./g)].map(([, v]) => v)
check('inputEvent.mouseButtons', C.inputEvent.mouseButtons, ktButtons, 'ControlledInputInjector.kt parseButton')

const sem = C.inputEvent.buttonSemantics
if (!sem) {
  failures.push('protocol.json 缺 buttonSemantics（协议 4.6 左右键映射）')
  console.log('FAIL  protocol.json constraints.inputEvent 缺 buttonSemantics')
} else {
  check('buttonSemantics.android.left', 'tap-drag', sem.androidControlled?.left, 'protocol.json')
  check('buttonSemantics.android.right', 'back', sem.androidControlled?.right, 'protocol.json')
  check('buttonSemantics.android.middle', 'home', sem.androidControlled?.middle, 'protocol.json')
  check('buttonSemantics.windows.left', 'left-button', sem.windowsControlled?.left, 'protocol.json')
  check('buttonSemantics.windows.right', 'right-button', sem.windowsControlled?.right, 'protocol.json')
  check('buttonSemantics.windows.middle', 'middle-button', sem.windowsControlled?.middle, 'protocol.json')
}
check('Android 右键落点 GLOBAL_ACTION_BACK', true, ktA11y.includes('GLOBAL_ACTION_BACK'), 'LinkSpaceAccessibilityService.kt')
check('Android 中键落点 GLOBAL_ACTION_HOME', true, ktA11y.includes('GLOBAL_ACTION_HOME'), 'LinkSpaceAccessibilityService.kt')
check('Windows 右键落点 MOUSEEVENTF_RIGHTDOWN', true, tsSink.includes('MOUSEEVENTF_RIGHTDOWN'), 'input/win32/sink.ts')
check('Windows 中键落点 MOUSEEVENTF_MIDDLEDOWN', true, tsSink.includes('MOUSEEVENTF_MIDDLEDOWN'), 'input/win32/sink.ts')
check('protocol.md 登记左右键映射', true, md.includes('右键返回') && md.includes('GLOBAL_ACTION_BACK'), 'docs/protocol.md §4.6')
// ---------- 8. 信封绑定与去重（协议 §3） ----------
check('dedupMaxIdsPerConnection', C.dedupMaxIdsPerConnection, evalNum(tsConst(tsNode, 'MAX_SEEN_MESSAGE_IDS')), 'control/node.ts MAX_SEEN_MESSAGE_IDS')
check('dedupMaxIdsPerConnection', C.dedupMaxIdsPerConnection, evalNum(ktConst(kt, 'MAX_SEEN_MESSAGE_IDS')), 'Protocol.kt MAX_SEEN_MESSAGE_IDS')

// from 绑定与去重的守卫必须真实存在于四处入口，不只常量对齐：
// 桌面 control/node.ts、Android 入站 TransferServer、Android 出站
// 主读循环与传输等待循环（后两者都在 LinkSpaceService.kt 内）。
function mustContain(name, src, needle, source) {
  if (src.includes(needle)) {
    passed++
    console.log(`PASS  ${name}  (${source})`)
  } else {
    failures.push(name)
    console.log(`FAIL  ${name}：缺少 ${needle}  (${source})`)
  }
}
mustContain('from 绑定（桌面）', tsNode, 'msg.from !== conn.peerId', 'control/node.ts')
mustContain('from 绑定（Android 入站）', ktServer, 'registered != from', 'TransferServer.kt')
mustContain('from 绑定（Android 出站主读循环）', ktService, 'from != fullId', 'LinkSpaceService.kt')
mustContain('from 绑定（Android 出站传输等待循环）', ktService, 'from != peerFullId', 'LinkSpaceService.kt')
mustContain('id 去重（桌面）', tsNode, 'seenIds.isDuplicate(msg.id)', 'control/node.ts')
mustContain('id 去重（Android 入站）', ktServer, 'seen.isDuplicate(id)', 'TransferServer.kt')
mustContain('id 去重（Android 出站主读循环）', ktService, 'seenIds.isDuplicate(id)', 'LinkSpaceService.kt')

// ---------- 9. 文本直通 input.text / input.error（协议 4.9，线 2 中文输入） ----------
const inputTextEntry = protocol.messageTypes.find((m) => m.type === 'input.text')
check('input.text payload', ['sessionId', 'text'], inputTextEntry?.payload ?? null, 'protocol.json messageTypes')
const inputErrorEntry = protocol.messageTypes.find((m) => m.type === 'input.error')
check('input.error payload', ['sessionId', 'code', 'reason'], inputErrorEntry?.payload ?? null, 'protocol.json messageTypes')
check('inputTextMaxBytes', C.inputTextMaxBytes, evalNum(ktConst(kt, 'MAX_INPUT_TEXT_BYTES')), 'Protocol.kt MAX_INPUT_TEXT_BYTES')
check('inputTextMaxBytes', C.inputTextMaxBytes, evalNum(tsConst(tsInput, 'MAX_INPUT_TEXT_BYTES')), 'input/protocol.ts MAX_INPUT_TEXT_BYTES')
check('protocol.md 登记 input.text', true, md.includes('input.text') && md.includes('commitText'), 'docs/protocol.md §4.9')
check('protocol.md 登记 input.error', true, md.includes('input.error') && md.includes('no-focus'), 'docs/protocol.md §4.9')
check('Android commitText 入口', true, ktA11y.includes('commitText'), 'LinkSpaceAccessibilityService.kt')
mustContain('桌面 input.text 发送', tsSession, "'input.text'", 'input/session.ts')
mustContain('桌面 input.error 接收', tsHost, "'input.error'", 'host.ts')
mustContain('桌面 screen.paste 发送', tsHost, "'screen.paste'", 'host.ts')

// ---------- 10. 扩展屏 display-extend（协议 4.3 / 4.7，线 3，3.2-2） ----------
// 会话类型三值与帧源二值在三处一致；session.start 按类型路由，
// 扩展会话的创建/销毁出口真实存在，不只常量对齐。
check('sessionTypes', ['scrcpy', 'input', 'display-extend'], C.sessionTypes, 'protocol.json constraints')
check('streamSources', ['screen', 'virtual-display'], C.streamSources, 'protocol.json constraints')
check(
  'sessionType display-extend（桌面）',
  true,
  tsExtend.includes("'display-extend'"),
  'extend/session.ts'
)
check(
  'sessionType display-extend（Android）',
  true,
  ktConst(kt, 'SESSION_TYPE_DISPLAY_EXTEND').replace(/^"|"$/g, '') === 'display-extend',
  'Protocol.kt SESSION_TYPE_DISPLAY_EXTEND'
)
check(
  'sessionType input（Android）',
  true,
  ktConst(kt, 'SESSION_TYPE_INPUT').replace(/^"|"$/g, '') === 'input',
  'Protocol.kt SESSION_TYPE_INPUT'
)
check(
  'sessionType scrcpy（Android）',
  true,
  ktConst(kt, 'SESSION_TYPE_SCRCPY').replace(/^"|"$/g, '') === 'scrcpy',
  'Protocol.kt SESSION_TYPE_SCRCPY'
)
check('streamSources（桌面）', C.streamSources, ['STREAM_SOURCE_SCREEN', 'STREAM_SOURCE_VIRTUAL_DISPLAY']
  .map((n) => tsConst(tsStream, n).replace(/^['"]|['"]$/g, '')), 'screen-stream.ts STREAM_SOURCE_*')
check('streamSources（Android）', C.streamSources, ['STREAM_SOURCE_SCREEN', 'STREAM_SOURCE_VIRTUAL_DISPLAY']
  .map((n) => ktConst(kt, n).replace(/^"|"$/g, '')), 'Protocol.kt STREAM_SOURCE_*')
const startEntry = protocol.messageTypes.find((m) => m.type === 'session.start')
check('session.start payload', ['sessionType', 'params'], startEntry?.payload ?? null, 'protocol.json messageTypes')
check('protocol.md 登记 display-extend', true, md.includes('display-extend') && md.includes('virtualScreen') && md.includes('DisplayExtendSessionCoordinator'), 'docs/protocol.md §4.3')
check('protocol.md 登记扩展屏帧源', true, md.includes("source?: 'screen' | 'virtual-display'") && md.includes('virtual-display'), 'docs/protocol.md §4.7')
mustContain('桌面 session.start 按类型路由', tsHost, "sessionType === 'display-extend'", 'host.ts')
mustContain('桌面 extend approve 入口', tsHost, 'approveExtendControl', 'host.ts')
mustContain('桌面 extend 创建出口', tsHost, 'extendCreateVirtualDisplay', 'host.ts')
mustContain('Android 扩展控制器发 display-extend', ktExtend, 'SESSION_TYPE_DISPLAY_EXTEND', 'DisplayExtendController.kt')
mustContain('Android 扩展控制器收 virtualScreen', ktExtend, 'virtualScreen', 'DisplayExtendController.kt')

// ---------- 汇总 ----------
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项，警告 ${warnings.length} 项。`)
if (failures.length > 0) {
  console.log(`不一致：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('protocol.json 与两端代码常量一致。')
