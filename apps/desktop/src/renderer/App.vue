<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  DeviceEdge,
  DeviceView,
  DiscoveredDevice,
  EnvInfo,
  InputStateView,
  QualityPreset,
  ReverseStreamStatusView,
  SessionView,
  TransferInfo,
  TransferTaskView,
  TrustedDevice
} from '../shared/types'
import DeviceCard from './components/DeviceCard.vue'
import SidebarNav, { type NavPage } from './components/SidebarNav.vue'
import DeviceRow from './components/DeviceRow.vue'
import DirectionCard, { type DirectionCapability } from './components/DirectionCard.vue'
import DetailCard from './components/DetailCard.vue'
import SessionBanner, { type BannerItem } from './components/SessionBanner.vue'
import TransferList from './components/TransferList.vue'

const devices = ref<DeviceView[]>([])
const sessions = ref<SessionView[]>([])
const transfers = ref<TransferTaskView[]>([])
const transferInfo = ref<TransferInfo | null>(null)
const discovered = ref<DiscoveredDevice[]>([])
const pairings = ref<Array<{ id: string; peerId: string; displayName: string; deviceType: string; code: string; expiresAt: number }>>([])
const trusted = ref<TrustedDevice[]>([])
/** 配对码输入框按设备拆成独立 ref（审计 bug：原来全列表共用一个 codeInput） */
const codeInputs = ref<Record<string, string>>({})
const env = ref<EnvInfo | null>(null)
/** 单条通知：danger 常驻到被关闭，info 6 秒后自动消失（SessionBanner 负责计时） */
const notice = ref<{ text: string; level: 'info' | 'danger' } | null>(null)
const refreshing = ref(false)

/** 当前导航页 */
const currentPage = ref<NavPage>('overview')

/** 异步操作进行中态：key → 是否进行中。按钮禁用 + 文案变「配对中…/连接中…/发送中…」 */
const busy = ref<Record<string, boolean>>({})

async function withBusy(key: string, fn: () => Promise<void>): Promise<void> {
  if (busy.value[key]) return
  busy.value[key] = true
  try {
    await fn()
  } finally {
    busy.value[key] = false
  }
}

function pushNotice(text: string, level: 'info' | 'danger' = 'danger'): void {
  notice.value = { text, level }
}

function clearNotice(): void {
  notice.value = null
}

// ---------- 本机显示名（5.4） ----------
const selfName = ref('')
const editingName = ref(false)
const nameDraft = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

// ---------- 剪贴板同步开关（6.6） ----------
const clipboardOn = ref(true)

async function toggleClipboard(): Promise<void> {
  await withBusy('clipboard', async () => {
    const next = !clipboardOn.value
    const res = await window.linkspace.setClipboardEnabled(next)
    if (!res.ok) {
      pushNotice(res.error.message)
      return
    }
    clipboardOn.value = res.value
  })
}

// ---------- 投屏画质（档位参数见 scrcpy-adapter QUALITY_PRESETS） ----------
const QUALITY_OPTIONS: Array<{ value: QualityPreset; label: string }> = [
  { value: 'sharp', label: '高清（原始分辨率 · 20M 码率）' },
  { value: 'balanced', label: '均衡（1600p · 12M 码率）' },
  { value: 'smooth', label: '流畅（1080p · 8M 码率）' }
]
const QUALITY_KEY = 'ls.quality'

const quality = ref<QualityPreset>(
  QUALITY_OPTIONS.some((q) => q.value === localStorage.getItem(QUALITY_KEY))
    ? (localStorage.getItem(QUALITY_KEY) as QualityPreset)
    : 'sharp'
)
watch(quality, (v) => localStorage.setItem(QUALITY_KEY, v))

// ---------- 反向流分辨率（四档，与投屏画质三档是两套设置，文案不混用） ----------
const REVERSE_QUALITY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1280, label: '流畅 · 720p' },
  { value: 1920, label: '高清 · 1080p' },
  { value: 2560, label: '超清 · 1440p' },
  { value: 3840, label: '极清 · 2160p' }
]
const REVERSE_QUALITY_KEY = 'ls.reverseQuality'

const reverseQuality = ref<number>(
  REVERSE_QUALITY_OPTIONS.some((q) => q.value === Number(localStorage.getItem(REVERSE_QUALITY_KEY)))
    ? Number(localStorage.getItem(REVERSE_QUALITY_KEY))
    : 1920
)
watch(reverseQuality, (v) => localStorage.setItem(REVERSE_QUALITY_KEY, String(v)))

// ---------- 反向流状态（主窗口指示 + 断开入口用） ----------
const reverseStatus = ref<ReverseStreamStatusView | null>(null)
const reverseActive = computed(
  () => !!reverseStatus.value?.peerId && reverseStatus.value.receiver.running
)
const reversePeerId = computed(() => reverseStatus.value?.peerId ?? null)
const reverseName = computed(() => reverseStatus.value?.displayName ?? '')

async function loadReverseStatus(): Promise<void> {
  reverseStatus.value = await window.linkspace.reverseStreamStatus().catch(() => null)
}

async function stopReverse(peerId?: string): Promise<void> {
  await withBusy('stop-reverse:' + (peerId ?? 'all'), async () => {
    const res = await window.linkspace.stopReverseControl(peerId)
    if (!res.ok) pushNotice(res.error.message)
    await loadReverseStatus()
  })
}

async function onReverseQualityChange(ev: Event): Promise<void> {
  const width = Number((ev.target as HTMLSelectElement).value)
  reverseQuality.value = width
  if (reverseActive.value && reversePeerId.value) {
    await withBusy('reverse-quality', async () => {
      const res = await window.linkspace.setReverseStreamQuality(reversePeerId.value!, width)
      if (!res.ok) pushNotice(res.error.message)
    })
  }
}

// ---------- 键鼠共享（阶段 3，第 7 组） ----------
const inputState = ref<InputStateView | null>(null)

function edgeOf(deviceId: string): DeviceEdge | '' {
  return inputState.value?.layout[deviceId] ?? ''
}

async function setEdge(deviceId: string, edge: DeviceEdge | ''): Promise<void> {
  const res = await window.linkspace.setDeviceEdge(deviceId, edge === '' ? null : edge)
  if (!res.ok) pushNotice(res.error.message)
  await loadInputState()
}

/** 手动发起键鼠控制（7.2）。边缘穿越触发的也是同一条链路 */
async function requestControl(deviceId: string): Promise<void> {
  await withBusy('control:' + deviceId, async () => {
    clearNotice()
    const res = await window.linkspace.requestInputControl(deviceId)
    if (!res.ok) pushNotice(res.error.message)
  })
}

/** 线 2（2.3-1）：请求看 Android 平板画面并打开画面窗口（2.3-2）。入口只在
 * 已配对设备上出现（本节只列信任清单）；未配对/不在线时主进程回明确的
 * 授权引导，不静默无反应。控制授权是会话级：平板每次都要确认 */
async function requestReverseControl(deviceId: string): Promise<void> {
  await withBusy('reverse:' + deviceId, async () => {
    clearNotice()
    const res = await window.linkspace.requestReverseControl(deviceId, reverseQuality.value)
    if (!res.ok) pushNotice(res.error.message)
    await loadReverseStatus()
  })
}

async function approveControl(sessionId: string): Promise<void> {
  const res = await window.linkspace.approveInputControl(sessionId)
  if (!res.ok) pushNotice(res.error.message)
  await loadInputState()
}

async function denyControl(sessionId: string): Promise<void> {
  await window.linkspace.denyInputControl(sessionId)
  await loadInputState()
}

/** 被控端随时拔掉控制（9.1 的安全兜底） */
async function terminateControl(): Promise<void> {
  await window.linkspace.terminateInputControl()
  await loadInputState()
}

/** 控制端退出（7.4 也可用 Ctrl+Alt+Space） */
async function exitControl(): Promise<void> {
  await window.linkspace.exitInputControl()
  await loadInputState()
}

async function loadInputState(): Promise<void> {
  inputState.value = await window.linkspace.inputState().catch(() => null)
}

watch(editingName, async (v) => {
  if (!v) return
  await nextTick()
  nameInput.value?.focus()
  nameInput.value?.select()
})

function startRename(): void {
  nameDraft.value = selfName.value
  editingName.value = true
}

/** Enter/blur 都会触发，靠 editingName 复位防双跑 */
async function saveRename(): Promise<void> {
  if (!editingName.value) return
  editingName.value = false
  const name = nameDraft.value
  if (name === selfName.value) return
  await withBusy('rename', async () => {
    const res = await window.linkspace.renameSelf(name)
    if (!res.ok) {
      pushNotice(res.error.message)
      return
    }
    selfName.value = res.value
    pushNotice('本机名已更新', 'info')
  })
}

async function copyFingerprint(): Promise<void> {
  const fp = transferInfo.value?.fingerprint
  if (!fp) return
  try {
    await navigator.clipboard.writeText(fp)
    pushNotice('指纹已复制', 'info')
  } catch {
    pushNotice('复制失败，请手动选择复制')
  }
}

/** 持久化的设备顺序。主进程返回时已排好，这里只在拖拽后本地更新 */
const layoutOrder = ref<string[]>([])
const dragSerial = ref('')
const dropTarget = ref('')

/**
 * 展示顺序。主进程已按保存顺序返回，但拖拽后 devices 会被 5 秒轮询
 * 刷新回 adb 的顺序，所以渲染侧必须自己再排一次，否则拖完立刻弹回。
 */
const orderedDevices = computed<DeviceView[]>(() => {
  const rank = new Map<string, number>()
  layoutOrder.value.forEach((s, i) => rank.set(s, i))
  const FALLBACK = Number.MAX_SAFE_INTEGER
  return devices.value
    .map((d, i) => ({ d, i, rank: rank.get(d.serial) ?? FALLBACK }))
    .sort((a, b) => (a.rank === b.rank ? a.i - b.i : a.rank - b.rank))
    .map((x) => x.d)
})

let unsubDevices: (() => void) | null = null
let unsubSessions: (() => void) | null = null
let unsubTransfers: (() => void) | null = null
let unsubDiscovered: (() => void) | null = null
let unsubPairings: (() => void) | null = null
let unsubTrust: (() => void) | null = null
let unsubSelfName: (() => void) | null = null
let unsubInput: (() => void) | null = null
let unsubReverseNotice: (() => void) | null = null
let unsubReverseChanged: (() => void) | null = null
let pollTimer: number | null = null
let speedTimer: number | null = null

const onlineCount = computed(() => devices.value.filter((d) => d.state === 'device').length)
const onlineText = computed(() => `在线 ${onlineCount.value}/${devices.value.length}`)
const activeSessions = computed(() =>
  sessions.value.filter((s) => s.state === 'starting' || s.state === 'running')
)

function sessionsFor(serial: string): SessionView[] {
  return sessions.value.filter((s) => s.serial === serial)
}

async function loadDevices(): Promise<void> {
  const list = await window.linkspace.listDevices()
  devices.value = Array.isArray(list) ? list : []
}

async function loadLayout(): Promise<void> {
  const order = await window.linkspace.getDeviceLayout().catch(() => [])
  layoutOrder.value = Array.isArray(order) ? order : []
}

// ---------- 卡片拖拽排序 ----------

function onDragStart(serial: string): void {
  dragSerial.value = serial
}

function onDragEnter(serial: string): void {
  if (dragSerial.value && dragSerial.value !== serial) dropTarget.value = serial
}

function onDragEnd(): void {
  dragSerial.value = ''
  dropTarget.value = ''
}

/**
 * 落位：把拖拽的卡片插到目标卡片的位置，然后把完整顺序回写主进程。
 * 传完整列表而不是「把 A 移到 B 前面」这类增量指令——增量指令在
 * 设备上下线并发时会算错，完整列表是幂等的。
 */
async function onDrop(target: string): Promise<void> {
  const from = dragSerial.value
  onDragEnd()
  if (!from || from === target) return

  const serials = orderedDevices.value.map((d) => d.serial)
  const fromIdx = serials.indexOf(from)
  const toIdx = serials.indexOf(target)
  if (fromIdx < 0 || toIdx < 0) return

  serials.splice(fromIdx, 1)
  serials.splice(toIdx, 0, from)

  layoutOrder.value = serials
  const res = await window.linkspace.saveDeviceLayout(serials)
  if (!res.ok) pushNotice(res.error.message)
}

async function loadSessions(): Promise<void> {
  const list = await window.linkspace.listSessions()
  sessions.value = Array.isArray(list) ? list : []
}

async function loadTransfers(): Promise<void> {
  const list = await window.linkspace.listTransfers()
  transfers.value = Array.isArray(list) ? list : []
  sampleRates()
}

// ---------- 传输速率（4.3） ----------
//
// 差分采样：对 accepted 任务用「上次采样字节 / 距上次采样时间」算瞬时速率。
// 快照本身是事件驱动的（每块完成推送一次），块间隔随对端速度波动很大
// （本地环路几十毫秒、真实 Wi-Fi 可能数秒），直接差分会剧烈跳动，
// 因此这里做 500ms 节流，采样口径由 1s 兜底轮询保证连续。
const rateSamples = new Map<string, { bytes: number; ts: number }>()
const rateLastTs = { value: 0 }
const rates = ref<Record<string, number>>({})

function sampleRates(): void {
  const now = Date.now()
  const elapsed = now - rateLastTs.value
  const next: Record<string, number> = {}
  for (const t of transfers.value) {
    if (t.state !== 'accepted' || !t.totalSize) continue
    const prev = rateSamples.get(t.id)
    if (prev && elapsed >= 500 && now > prev.ts) {
      // 负差分（续传回退重算）按 0 处理，不显示负速率
      next[t.id] = Math.max(0, ((t.transferred - prev.bytes) / (now - prev.ts)) * 1000)
    } else if (prev && elapsed < 500 && rates.value[t.id] !== undefined) {
      // 节流窗口内沿用上次速率，避免抖动
      next[t.id] = rates.value[t.id]
    }
    rateSamples.set(t.id, { bytes: t.transferred, ts: now })
  }
  // 任务结束后清掉采样点，防止 Map 随历史任务增长
  for (const id of rateSamples.keys()) {
    if (!next[id]) rateSamples.delete(id)
  }
  rateLastTs.value = now
  rates.value = next
}

async function loadDiscovered(): Promise<void> {
  const list = await window.linkspace.listDiscovered()
  discovered.value = Array.isArray(list) ? list : []
  ensureSelection()
}

async function loadPairings(): Promise<void> {
  const list = await window.linkspace.listPendingPairings()
  pairings.value = Array.isArray(list) ? list : []
}

async function loadTrusted(): Promise<void> {
  const list = await window.linkspace.listTrusted()
  trusted.value = Array.isArray(list) ? list : []
  ensureSelection()
}

async function connectAndPair(svc: DiscoveredDevice): Promise<void> {
  await withBusy('pair:' + svc.serviceName, async () => {
    clearNotice()
    const res = await window.linkspace.connectAndPair(svc.serviceName)
    if (!res.ok) {
      pushNotice(res.error.message)
      return
    }
    pushNotice(`已向 ${svc.displayName} 发起配对，请让对方输入本机屏幕上显示的配对码`, 'info')
    await loadPairings()
  })
}

async function rejectPairing(id: string): Promise<void> {
  await withBusy('reject:' + id, async () => {
    await window.linkspace.rejectPairing(id)
    await loadPairings()
  })
}

async function revokeTrust(deviceId: string): Promise<void> {
  await withBusy('revoke:' + deviceId, async () => {
    await window.linkspace.revokeTrust(deviceId)
    pushNotice('已撤销信任，与该设备的所有会话已断开', 'info')
    await loadTrusted()
  })
}

/** 发起方：把用户输入的配对码提交给对端校验（每设备独立输入框，不串） */
async function submitCode(d: DiscoveredDevice): Promise<void> {
  await withBusy('submit:' + d.serviceName, async () => {
    clearNotice()
    const code = (codeInputs.value[d.serviceName] ?? '').trim()
    const res = await window.linkspace.submitPairingCode(d.serviceName, code)
    if (!res.ok) {
      pushNotice(res.error.message)
      return
    }
    codeInputs.value[d.serviceName] = ''
    pushNotice(`已与 ${d.displayName} 配对成功`, 'info')
    await loadTrusted()
    await loadDiscovered()
  })
}

function codeOf(d: DiscoveredDevice): string {
  return codeInputs.value[d.serviceName] ?? ''
}

async function sendFile(peerId: string): Promise<void> {
  await withBusy('send:' + peerId, async () => {
    clearNotice()
    const res = await window.linkspace.pickAndOffer(peerId)
    if (!res.ok) pushNotice(res.error.message)
    else await loadTransfers()
  })
}

function typeLabel(t: string): string {
  if (t === 'win') return '电脑'
  if (t === 'android-phone') return '手机'
  if (t === 'android-tablet') return '平板'
  return t
}

async function cancelTransfer(id: string): Promise<void> {
  await withBusy('cancel:' + id, async () => {
    const res = await window.linkspace.cancelTransfer(id)
    if (!res.ok) pushNotice(res.error.message)
    else await loadTransfers()
  })
}

/** 接收方：选保存目录并接受传输 */
async function acceptTransfer(id: string): Promise<void> {
  await withBusy('accept:' + id, async () => {
    clearNotice()
    const res = await window.linkspace.acceptTransfer(id)
    if (!res.ok) {
      pushNotice(res.error.message)
      return
    }
    await loadTransfers()
  })
}

async function refresh(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    const res = await window.linkspace.refreshDevices()
    if (res.ok) devices.value = res.value
    else pushNotice(res.error.message)
    await loadSessions()
  } finally {
    refreshing.value = false
  }
}

async function startMirror(serial: string, index: number): Promise<void> {
  await withBusy('mirror:' + serial, async () => {
    clearNotice()
    // 多设备时错开摆放，避免窗口完全重叠
    const res = await window.linkspace.startMirror(serial, {
      windowTitle: `LinkSpace-${serial}`,
      windowX: 140 + index * 36,
      windowY: 90 + index * 28,
      // 分辨率/码率由画质档位决定（用户反馈 1080 写死太糊），不再传显式 maxSize
      quality: quality.value,
      stayAwake: true
    })
    if (!res.ok) {
      pushNotice(res.error.message)
    } else {
      await loadSessions()
      await loadDevices()
    }
  })
}

async function stopMirror(id: string): Promise<void> {
  await withBusy('stop-mirror:' + id, async () => {
    clearNotice()
    const res = await window.linkspace.stopMirror(id)
    if (!res.ok) {
      pushNotice(res.error.message)
      return
    }
    await loadSessions()
    await loadDevices()
  })
}

function stopAllMirrors(): void {
  for (const s of activeSessions.value) void stopMirror(s.id)
}

// ---------- 设备页分组 ----------

/** idPrefix 是对端设备 id 的前 12 位（discovery.ts），据此把信任清单与发现清单对上 */
function isTrustedOnline(t: TrustedDevice): boolean {
  return discovered.value.some((d) => t.deviceId.startsWith(d.idPrefix))
}

/** 最近连接：当前在局域网内可见的已信任设备，按信任时间倒序，取前 5 */
const recentTrusted = computed(() =>
  trusted.value
    .filter((t) => isTrustedOnline(t))
    .sort((a, b) => b.trustedAt - a.trustedAt)
    .slice(0, 5)
)

/** 局域网内其他设备：发现到的未配对设备（已配对的已在信任清单里，不重复出现） */
const unpairedDiscovered = computed(() => discovered.value.filter((d) => !d.paired))

// ---------- 设备页选中态 ----------
const selectedId = ref('')

function ensureSelection(): void {
  const stillValid =
    trusted.value.some((t) => t.deviceId === selectedId.value) ||
    unpairedDiscovered.value.some((d) => d.serviceName === selectedId.value)
  if (stillValid) return
  selectedId.value =
    trusted.value[0]?.deviceId ?? unpairedDiscovered.value[0]?.serviceName ?? ''
}

const selectedTrusted = computed(
  () => trusted.value.find((t) => t.deviceId === selectedId.value) ?? null
)
const selectedDiscovered = computed(
  () => unpairedDiscovered.value.find((d) => d.serviceName === selectedId.value) ?? null
)

function selectDevice(id: string, page: NavPage = 'devices'): void {
  selectedId.value = id
  currentPage.value = page
}

/** 详情卡的操作入口：模板里 v-if 的收窄进不了箭头函数作用域，统一走带空 guard 的方法 */
function detailControl(): void {
  const t = selectedTrusted.value
  if (!t) return
  if (t.deviceType === 'win') void requestControl(t.deviceId)
  else void requestReverseControl(t.deviceId)
}

function detailSendFile(): void {
  const t = selectedTrusted.value
  if (!t) return
  void sendFile(t.deviceId)
}

function detailSetEdge(edge: DeviceEdge | ''): void {
  const t = selectedTrusted.value
  if (!t) return
  void setEdge(t.deviceId, edge)
}

function detailRevoke(): void {
  const t = selectedTrusted.value
  if (!t) return
  void revokeTrust(t.deviceId)
}

function detailStopReverse(): void {
  const t = selectedTrusted.value
  if (!t) return
  void stopReverse(t.deviceId)
}

/** 设备行标记：控制中 / 正在看画面，与横条同步 */
function rowMarkForTrusted(t: TrustedDevice): string | null {
  if (reversePeerId.value === t.deviceId && reverseActive.value) return '正在看画面'
  if (inputState.value?.controlling === t.displayName) return '控制中'
  return null
}

function rowSubForTrusted(t: TrustedDevice): string {
  const scope = t.scope.length ? ` · ${t.scope.join(',')}` : ''
  return `${typeLabel(t.deviceType)} · 局域网${scope}`
}

function rowSubForDiscovered(d: DiscoveredDevice): string {
  const caps = d.caps.length ? ` · ${d.caps.join(',')}` : ''
  return `${typeLabel(d.deviceType)} · ${d.host}:${d.port}${caps}`
}

// ---------- 方向卡 ----------

/**
 * 方向卡开关的接线口径：
 * - 剪贴板：真实全局开关（两张卡同源）。
 * - 画面（平板→电脑）：真实投屏会话状态；开 = 对首台在线 adb 设备启动投屏，关 = 停掉全部投屏。
 * - 画面 / 键鼠（电脑→平板）：真实反向流会话；开 = 请求反向控制，关 = 断开；键鼠开且流已建但输入未建立时走重试。
 * - 键鼠（平板→电脑）：对方发起、本机确认的请求驱动，没有可前置的开关，只展示真实状态（被控中 = 开）。
 * - 文件：暂无方向级能力开关（主进程未提供），toggle 为本地偏好（默认关），不 gating 现有入口。
 */
const DIR_CAPS_KEY = 'ls.dirCaps'
function loadDirCaps(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(DIR_CAPS_KEY) ?? '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}
const dirCaps = ref<Record<string, boolean>>(loadDirCaps())
watch(dirCaps, (v) => localStorage.setItem(DIR_CAPS_KEY, JSON.stringify(v)), { deep: true })

const firstAndroidTrusted = computed(
  () =>
    trusted.value.find(
      (t) => t.deviceType === 'android-phone' || t.deviceType === 'android-tablet'
    ) ?? null
)

const dirCapsA = computed<DirectionCapability[]>(() => [
  {
    key: 'screen',
    label: '画面',
    hint: '把平板 / 手机画面投到电脑上看（scrcpy 投屏）',
    on: activeSessions.value.length > 0,
    toggleable: true
  },
  {
    key: 'input',
    label: '键鼠',
    hint: '平板发起控制请求时，在这里确认；授权仅本次会话有效',
    on: !!inputState.value?.controlledBy,
    toggleable: false
  },
  {
    key: 'clipboard',
    label: '剪贴板',
    hint: '与对方同步剪贴板，复制粘贴跨设备',
    on: clipboardOn.value,
    toggleable: true,
    busy: busy.value['clipboard']
  },
  {
    key: 'file',
    label: '文件',
    hint: '选中已信任的设备发送文件；对方发来的文件在文件页确认接收',
    on: dirCaps.value['a-file'] ?? false,
    toggleable: true
  }
])

const dirCapsB = computed<DirectionCapability[]>(() => [
  {
    key: 'screen',
    label: '画面',
    hint: '在电脑窗口里看平板画面（反向流），平板每次都要确认',
    on: reverseActive.value,
    toggleable: true,
    busy:
      (firstAndroidTrusted.value
        ? busy.value['reverse:' + firstAndroidTrusted.value.deviceId]
        : false) || busy.value['stop-reverse:' + (reversePeerId.value ?? 'all')]
  },
  {
    key: 'input',
    label: '键鼠',
    hint: '用本机键鼠控制平板（走反向流会话），平板每次都要确认',
    on: reverseStatus.value?.input.state === 'active',
    toggleable: true,
    busy:
      (firstAndroidTrusted.value
        ? busy.value['reverse:' + firstAndroidTrusted.value.deviceId]
        : false) || busy.value['stop-reverse:' + (reversePeerId.value ?? 'all')]
  },
  {
    key: 'clipboard',
    label: '剪贴板',
    hint: '与对方同步剪贴板，复制粘贴跨设备',
    on: clipboardOn.value,
    toggleable: true,
    busy: busy.value['clipboard']
  },
  {
    key: 'file',
    label: '文件',
    hint: '选中已信任的设备发送文件；对方发来的文件在文件页确认接收',
    on: dirCaps.value['b-file'] ?? false,
    toggleable: true
  }
])

async function onDirToggle(card: 'a' | 'b', key: string, next: boolean): Promise<void> {
  if (key === 'clipboard') {
    await toggleClipboard()
    return
  }
  if (card === 'a' && key === 'screen') {
    if (next) {
      const target = orderedDevices.value.find((d) => d.state === 'device')
      if (!target) {
        pushNotice('没有在线的投屏设备，先用 USB 或无线调试连接一台设备')
        return
      }
      await startMirror(target.serial, orderedDevices.value.indexOf(target))
    } else {
      stopAllMirrors()
    }
    return
  }
  if (card === 'b' && (key === 'screen' || key === 'input')) {
    if (next) {
      if (reverseActive.value && key === 'input' && reversePeerId.value) {
        const res = await window.linkspace.retryReverseInput(reversePeerId.value)
        if (!res.ok) pushNotice(res.error.message)
        await loadReverseStatus()
        return
      }
      const target = firstAndroidTrusted.value
      if (!target) {
        pushNotice('没有已信任的平板 / 手机，先在设备页完成配对')
        return
      }
      await requestReverseControl(target.deviceId)
    } else {
      await stopReverse(reversePeerId.value ?? undefined)
    }
    return
  }
  if (key === 'file') {
    dirCaps.value[`${card}-file`] = next
  }
}

function onDirOpen(card: 'a' | 'b', key: string): void {
  if (key === 'file') currentPage.value = 'files'
  else if (key === 'clipboard') currentPage.value = 'settings'
  else if (key === 'screen') currentPage.value = 'screen'
  else if (key === 'input') currentPage.value = card === 'a' ? 'devices' : 'screen'
}

// ---------- 通知横条（分级，可多条并存） ----------

const banners = computed<BannerItem[]>(() => {
  const list: BannerItem[] = []
  if (env.value && !env.value.ready) {
    list.push({
      id: 'env',
      level: 'warn',
      text: '未检测到 scrcpy，投屏功能不可用。请安装 scrcpy 后重启应用，或设置 LINKSPACE_SCRCPY 环境变量指定路径。',
      hint: `当前查找：${env.value.scrcpyPath}（来源 ${env.value.scrcpySource}）`
    })
  }
  if (notice.value) {
    list.push({
      id: 'notice',
      level: notice.value.level,
      text: notice.value.text,
      closable: true,
      autoDismiss: notice.value.level === 'info'
    })
  }
  const pending = inputState.value?.pending
  if (pending) {
    list.push({
      id: 'pending',
      level: 'warn',
      text: `${pending.displayName} 请求控制本机的鼠标和键盘。`,
      hint: '同意后对方可操作本机键鼠，随时可点「拔掉」终止；授权仅本次会话有效，配对本身不授予该权限。',
      actions: [
        { id: 'approve', label: '同意', kind: 'primary', busy: busy.value['approve'] },
        { id: 'deny', label: '拒绝', kind: 'danger', busy: busy.value['deny'] }
      ]
    })
  }
  const controlledBy = inputState.value?.controlledBy
  if (controlledBy) {
    // 被控中用 danger 级（ui-redesign §3.1）
    list.push({
      id: 'controlled',
      level: 'danger',
      text: `${controlledBy} 正在控制本机的键鼠。`,
      hint: '会话结束、对端断开或撤销信任后，控制自动失效。',
      actions: [{ id: 'terminate', label: '拔掉', kind: 'danger', busy: busy.value['terminate'] }]
    })
  }
  const controlling = inputState.value?.controlling
  if (controlling) {
    // 控制中用 ok 级（ui-redesign §3.1）
    list.push({
      id: 'controlling',
      level: 'ok',
      text: `正在用本机键鼠控制 ${controlling}。`,
      hint: '按 Ctrl+Alt+Space 或点击右侧按钮退出控制。',
      actions: [{ id: 'exit', label: '退出控制', busy: busy.value['exit'] }]
    })
  }
  if (reverseActive.value) {
    list.push({
      id: 'reverse',
      level: 'ok',
      text: `正在看 ${reverseName.value} 的画面（反向流进行中）。`,
      actions: [
        {
          id: 'stop-reverse',
          label: '断开',
          kind: 'danger',
          busy: busy.value['stop-reverse:' + (reversePeerId.value ?? 'all')]
        }
      ]
    })
  }
  return list
})

async function onBannerAction(bannerId: string, actionId: string): Promise<void> {
  const pending = inputState.value?.pending
  switch (actionId) {
    case 'approve':
      if (pending) {
        await withBusy('approve', async () => {
          await approveControl(pending.sessionId)
        })
      }
      break
    case 'deny':
      if (pending) {
        await withBusy('deny', async () => {
          await denyControl(pending.sessionId)
        })
      }
      break
    case 'terminate':
      await withBusy('terminate', async () => {
        await terminateControl()
      })
      break
    case 'exit':
      await withBusy('exit', async () => {
        await exitControl()
      })
      break
    case 'stop-reverse':
      await stopReverse(reversePeerId.value ?? undefined)
      break
  }
  void bannerId
}

function onBannerClose(id: string): void {
  if (id === 'notice') notice.value = null
}

// ---------- 概览页 ----------

/** 连接可视化对端：首台已信任设备；没有时显示占位。
 * 延迟：主进程未提供延迟数据，不编造「7 ms」，只显示「局域网直连」。 */
const vizPeer = computed(() => trusted.value[0] ?? null)

onMounted(async () => {
  env.value = await window.linkspace.envInfo()
  transferInfo.value = await window.linkspace.transferInfo().catch(() => null)
  selfName.value = await window.linkspace.selfDisplayName().catch(() => '')
  clipboardOn.value = await window.linkspace.clipboardEnabled().catch(() => true)
  await loadDevices()
  await loadSessions()
  await loadTransfers()
  await loadDiscovered()
  await loadPairings()
  await loadTrusted()
  await loadLayout()
  await loadInputState()
  await loadReverseStatus()

  unsubDevices = window.linkspace.onDevicesChanged(() => {
    void loadDevices()
    void loadSessions()
  })
  unsubSessions = window.linkspace.onSessionsChanged(() => {
    void loadSessions()
  })
  unsubTransfers = window.linkspace.onTransfersChanged(() => {
    void loadTransfers()
  })
  unsubDiscovered = window.linkspace.onDiscoveredChanged(() => {
    void loadDiscovered()
  })
  unsubPairings = window.linkspace.onPairingsChanged(() => {
    void loadPairings()
    void loadTrusted()
  })
  unsubTrust = window.linkspace.onTrustChanged(() => {
    void loadTrusted()
  })
  unsubSelfName = window.linkspace.onSelfNameChanged(async () => {
    selfName.value = await window.linkspace.selfDisplayName().catch(() => selfName.value)
  })
  // 键鼠状态（请求到达/授权/退出/断线）全部经主进程广播回来，这里只管重拉快照
  unsubInput = window.linkspace.onInputChanged(() => {
    void loadInputState()
  })
  // 反向投屏在别处结束且有明确原因（平板拒绝/超时/断连）：主窗口提示，
  // 而不是画面窗口悄悄消失
  unsubReverseNotice = window.linkspace.onReverseStreamNotice((msg) => {
    pushNotice(msg)
  })
  unsubReverseChanged = window.linkspace.onReverseStreamChanged((status) => {
    reverseStatus.value = status
  })

  // 事件之外的兜底轮询：设备插拔时 adb 不会主动通知
  pollTimer = window.setInterval(() => {
    void loadDevices()
    void loadSessions()
  }, 5000)

  // 速率需要连续采样（4.3）：事件密度随对端速度波动，1s 兜底轮询保证
  // 活动任务的进度与速率持续刷新；无活动任务时跳过，空转成本可忽略
  speedTimer = window.setInterval(() => {
    if (transfers.value.some((t) => t.state === 'accepted')) void loadTransfers()
  }, 1000)
})

onBeforeUnmount(() => {
  unsubDevices?.()
  unsubSessions?.()
  unsubTransfers?.()
  unsubDiscovered?.()
  unsubPairings?.()
  unsubTrust?.()
  unsubSelfName?.()
  unsubInput?.()
  unsubReverseNotice?.()
  unsubReverseChanged?.()
  if (pollTimer !== null) window.clearInterval(pollTimer)
  if (speedTimer !== null) window.clearInterval(speedTimer)
})
</script>

<template>
  <div class="app">
    <SidebarNav
      :self-name="selfName"
      :online-text="onlineText"
      :current-page="currentPage"
      version="v0.1.0 · 原型"
      @navigate="(p) => (currentPage = p)"
    />

    <div class="main">
      <header class="topbar">
        <span class="topbar__self">
          <input
            v-if="editingName"
            ref="nameInput"
            v-model="nameDraft"
            class="code-field topbar__self-input"
            maxlength="60"
            placeholder="本机显示名"
            @keydown.enter="saveRename"
            @keydown.esc="editingName = false"
            @blur="saveRename"
          />
          <template v-else>
            <span class="topbar__self-name" :title="'本机显示名（对端可见）'">{{ selfName }}</span>
            <button class="btn-icon" title="修改本机显示名" @click="startRename">✎</button>
          </template>
        </span>
        <span class="topbar__spacer" />
        <span v-if="reverseActive" class="topbar__watching">
          正在看 {{ reverseName }} 的画面
          <button
            class="btn btn--sm btn--danger"
            :disabled="busy['stop-reverse:' + (reversePeerId ?? 'all')]"
            @click="stopReverse(reversePeerId ?? undefined)"
          >
            {{ busy['stop-reverse:' + (reversePeerId ?? 'all')] ? '断开中…' : '断开' }}
          </button>
        </span>
        <div class="topbar__actions">
          <span class="badge badge--neutral">{{ onlineText }}</span>
          <button
            class="badge badge-btn"
            :class="clipboardOn ? 'badge--ok' : 'badge--off'"
            :disabled="busy['clipboard']"
            :title="clipboardOn ? '剪贴板同步已开启，点击关闭' : '剪贴板同步已关闭，点击开启'"
            @click="toggleClipboard"
          >
            <span class="badge__dot" />
            剪贴板 {{ busy['clipboard'] ? '切换中…' : clipboardOn ? '开' : '关' }}
          </button>
          <button class="btn btn--sm" :disabled="refreshing" @click="refresh">
            {{ refreshing ? '扫描中…' : '刷新' }}
          </button>
        </div>
      </header>

      <main class="content">
        <div class="page">
          <SessionBanner :items="banners" @close="onBannerClose" @action="onBannerAction" />

          <!-- ============ 概览页 ============ -->
          <template v-if="currentPage === 'overview'">
            <section class="card">
              <div class="self-card__row">
                <span class="self-card__name">{{ selfName || '本机' }}</span>
                <span class="badge badge--ok">本设备</span>
                <span class="topbar__spacer" />
                <span v-if="transferInfo && transferInfo.port" class="self-card__meta">
                  传输端口 {{ transferInfo.port }}
                </span>
                <span v-if="transferInfo" class="self-card__meta">
                  指纹 {{ transferInfo.fingerprint.slice(0, 17) }}…
                </span>
                <button v-if="transferInfo" class="btn btn--sm" @click="copyFingerprint">
                  复制指纹
                </button>
              </div>
              <div
                class="self-card__ready"
                :class="{ 'self-card__ready--idle': !trusted.length }"
              >
                <span v-if="trusted.length">✓ 就绪：已信任 {{ trusted.length }} 台设备，可以开始协作</span>
                <span v-else>尚未配对设备，先在设备页发起配对</span>
              </div>
            </section>

            <section class="card conn-viz">
              <div class="conn-viz__node">
                <span class="conn-viz__icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="3" y="4" width="18" height="12" rx="1.5" />
                    <path d="M9 20h6M12 16v4" />
                  </svg>
                </span>
                {{ selfName || '本机' }}
              </div>
              <div class="conn-viz__line" :class="{ 'conn-viz__line--idle': !vizPeer }">
                <span class="conn-viz__latency">{{ vizPeer ? '局域网直连' : '尚未连接设备' }}</span>
              </div>
              <div class="conn-viz__node">
                <span class="conn-viz__icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="4" y="3" width="16" height="18" rx="2" />
                    <path d="M11 18h2" />
                  </svg>
                </span>
                {{ vizPeer ? vizPeer.displayName : '附近设备' }}
              </div>
            </section>

            <div class="dir-cards">
              <DirectionCard
                title="平板 → 电脑"
                sub="对方控制本机"
                :capabilities="dirCapsA"
                @toggle="(key, next) => onDirToggle('a', key, next)"
                @open="(key) => onDirOpen('a', key)"
              />
              <DirectionCard
                title="电脑 → 平板"
                sub="本机控制对方"
                :capabilities="dirCapsB"
                @toggle="(key, next) => onDirToggle('b', key, next)"
                @open="(key) => onDirOpen('b', key)"
              />
            </div>

            <section>
              <h2 class="section-title">设备</h2>
              <div class="device-list">
                <DeviceRow
                  name="本机"
                  :sub="`${selfName || '本机'} · 局域网`"
                  status="online"
                  device-type="win"
                  is-self
                  @select="currentPage = 'settings'"
                />
                <DeviceRow
                  v-for="t in trusted"
                  :key="t.deviceId"
                  :name="t.displayName"
                  :sub="rowSubForTrusted(t)"
                  :status="isTrustedOnline(t) ? 'online' : 'offline'"
                  :device-type="t.deviceType"
                  :mark="rowMarkForTrusted(t)"
                  @select="selectDevice(t.deviceId)"
                />
                <DeviceRow
                  v-for="d in unpairedDiscovered"
                  :key="d.serviceName"
                  :name="d.displayName"
                  :sub="rowSubForDiscovered(d)"
                  status="online"
                  :device-type="d.deviceType"
                  @select="selectDevice(d.serviceName)"
                />
                <div v-if="!trusted.length && !unpairedDiscovered.length" class="empty empty--sm">
                  <div class="empty__title">局域网内没有发现设备</div>
                  <div class="empty__hint">请确保对方设备已打开 LinkSpace 并连入同一局域网，然后点击右上角「刷新」。</div>
                </div>
              </div>
            </section>
          </template>

          <!-- ============ 设备页 ============ -->
          <template v-else-if="currentPage === 'devices'">
            <section>
              <h2 class="section-title">待确认的配对请求</h2>
              <div v-if="pairings.length">
                <div v-for="p in pairings" :key="p.id" class="session-row">
                  <span class="badge badge--warn">配对</span>
                  <span class="session-row__id">
                    {{ p.displayName }}（{{ typeLabel(p.deviceType) }}）请求配对
                  </span>
                  <span class="topbar__spacer" />
                  <span class="pairing-code">{{ p.code }}</span>
                  <button
                    class="btn btn--sm btn--danger"
                    :disabled="busy['reject:' + p.id]"
                    @click="rejectPairing(p.id)"
                  >
                    {{ busy['reject:' + p.id] ? '处理中…' : '拒绝' }}
                  </button>
                </div>
                <div class="pairing-hint">
                  请让对方输入上面这 6 位配对码。配对码只在<b>本方屏幕</b>显示，不会通过网络传递。
                </div>
              </div>
              <div v-else class="empty empty--sm">
                <div class="empty__title">暂无待确认的配对请求</div>
                <div class="empty__hint">对方发起配对时，6 位配对码会显示在这里。</div>
              </div>
            </section>

            <div class="devices-layout">
              <div class="devices-layout__list">
                <section class="device-group">
                  <h3 class="device-group__title">最近连接</h3>
                  <div class="device-list">
                    <DeviceRow
                      v-for="t in recentTrusted"
                      :key="t.deviceId"
                      :name="t.displayName"
                      :sub="rowSubForTrusted(t)"
                      status="online"
                      :device-type="t.deviceType"
                      :selected="selectedId === t.deviceId"
                      :mark="rowMarkForTrusted(t)"
                      @select="selectDevice(t.deviceId)"
                    />
                    <div v-if="!recentTrusted.length" class="empty empty--sm">
                      <div class="empty__title">局域网内暂无已信任的设备在线</div>
                    </div>
                  </div>
                </section>

                <section class="device-group">
                  <h3 class="device-group__title">已信任的设备</h3>
                  <div class="device-list">
                    <DeviceRow
                      v-for="t in trusted"
                      :key="t.deviceId"
                      :name="t.displayName"
                      :sub="rowSubForTrusted(t)"
                      :status="isTrustedOnline(t) ? 'online' : 'offline'"
                      :device-type="t.deviceType"
                      :selected="selectedId === t.deviceId"
                      :mark="rowMarkForTrusted(t)"
                      @select="selectDevice(t.deviceId)"
                    />
                    <div v-if="!trusted.length" class="empty empty--sm">
                      <div class="empty__title">还没有信任的设备</div>
                      <div class="empty__hint">在下方「局域网内其他设备」里发起配对。</div>
                    </div>
                  </div>
                </section>

                <section class="device-group">
                  <h3 class="device-group__title">局域网内其他设备</h3>
                  <div class="device-list">
                    <template v-for="d in unpairedDiscovered" :key="d.serviceName">
                      <DeviceRow
                        :name="d.displayName"
                        :sub="rowSubForDiscovered(d)"
                        status="online"
                        :device-type="d.deviceType"
                        :selected="selectedId === d.serviceName"
                        @select="selectDevice(d.serviceName)"
                      />
                      <div v-if="selectedId === d.serviceName" class="session-row">
                        <input
                          v-model="codeInputs[d.serviceName]"
                          class="code-field"
                          maxlength="6"
                          placeholder="6 位码"
                          inputmode="numeric"
                        />
                        <button
                          class="btn btn--sm"
                          :disabled="codeOf(d).length !== 6 || busy['submit:' + d.serviceName]"
                          @click="submitCode(d)"
                        >
                          {{ busy['submit:' + d.serviceName] ? '提交中…' : '提交配对码' }}
                        </button>
                        <button
                          class="btn btn--sm"
                          :disabled="busy['pair:' + d.serviceName]"
                          @click="connectAndPair(d)"
                        >
                          {{ busy['pair:' + d.serviceName] ? '配对中…' : '发起配对' }}
                        </button>
                      </div>
                    </template>
                    <div v-if="!unpairedDiscovered.length" class="empty empty--sm">
                      <div class="empty__title">局域网内没有其他设备</div>
                      <div class="empty__hint">对方设备打开 LinkSpace 并连入同一局域网后会出现在这里。</div>
                    </div>
                  </div>
                  <div v-if="unpairedDiscovered.length" class="pairing-hint">
                    先点「发起配对」，再把<b>对方屏幕</b>上显示的 6 位配对码输入后提交。
                    配对码不会通过网络传递，只能人眼抄录。
                  </div>
                </section>
              </div>

              <div class="devices-layout__detail">
                <DetailCard
                  v-if="selectedTrusted"
                  :device="selectedTrusted"
                  :clipboard-on="clipboardOn"
                  :edge="edgeOf(selectedTrusted.deviceId)"
                  :native-ready="inputState?.nativeReady ?? false"
                  :controlling="inputState?.controlling === selectedTrusted.displayName"
                  :reverse-watching="reversePeerId === selectedTrusted.deviceId && reverseActive"
                  :busy="busy"
                  @control="detailControl"
                  @send-file="detailSendFile"
                  @toggle-clipboard="toggleClipboard"
                  @set-edge="detailSetEdge"
                  @revoke="detailRevoke"
                  @stop-reverse="detailStopReverse"
                />
                <section v-else-if="selectedDiscovered" class="card">
                  <div class="detail-card__head">
                    <div>
                      <h3 class="detail-card__name">{{ selectedDiscovered.displayName }}</h3>
                      <div class="detail-card__sub">{{ typeLabel(selectedDiscovered.deviceType) }} · 未配对</div>
                    </div>
                  </div>
                  <div class="pairing-hint pairing-hint--flush">
                    该设备尚未配对。发起配对后，把对方屏幕上显示的 6 位配对码输入后提交。
                  </div>
                  <div class="session-row u-mt-md">
                    <input
                      v-model="codeInputs[selectedDiscovered.serviceName]"
                      class="code-field"
                      maxlength="6"
                      placeholder="6 位码"
                      inputmode="numeric"
                    />
                    <button
                      class="btn btn--sm"
                      :disabled="
                        codeOf(selectedDiscovered).length !== 6 ||
                        busy['submit:' + selectedDiscovered.serviceName]
                      "
                      @click="submitCode(selectedDiscovered)"
                    >
                      {{ busy['submit:' + selectedDiscovered.serviceName] ? '提交中…' : '提交配对码' }}
                    </button>
                    <button
                      class="btn btn--sm"
                      :disabled="busy['pair:' + selectedDiscovered.serviceName]"
                      @click="connectAndPair(selectedDiscovered)"
                    >
                      {{ busy['pair:' + selectedDiscovered.serviceName] ? '配对中…' : '发起配对' }}
                    </button>
                  </div>
                </section>
                <div v-else class="empty empty--sm">
                  <div class="empty__title">未选择设备</div>
                  <div class="empty__hint">在左侧列表里点一台设备查看详情。</div>
                </div>
              </div>
            </div>
          </template>

          <!-- ============ 屏幕页 ============ -->
          <template v-else-if="currentPage === 'screen'">
            <section class="card">
              <h3 class="card__title">投屏设置</h3>
              <p class="card__sub">把 Android 设备的画面投到电脑上（scrcpy）。画质档位决定分辨率与码率。</p>
              <div class="settings-row">
                <div class="settings-row__text">
                  <div class="settings-row__label">投屏画质</div>
                  <div class="settings-row__hint">高清不压分辨率，代价是 Wi-Fi 下更吃带宽</div>
                </div>
                <label class="quality-pick">
                  画质
                  <select v-model="quality" class="edge-select">
                    <option v-for="q in QUALITY_OPTIONS" :key="q.value" :value="q.value">{{ q.label }}</option>
                  </select>
                </label>
              </div>
              <div v-if="devices.length" class="device-grid u-mt-lg">
                <DeviceCard
                  v-for="(device, index) in orderedDevices"
                  :key="device.serial"
                  :device="device"
                  :sessions="sessionsFor(device.serial)"
                  :index="index"
                  :dragging="dragSerial === device.serial"
                  :drop-hint="dropTarget === device.serial"
                  :start-busy="busy['mirror:' + device.serial]"
                  :stop-busy="
                    busy['stop-mirror:' + (sessionsFor(device.serial).find((s) => s.state === 'starting' || s.state === 'running' || s.state === 'stopping')?.id ?? '')]
                  "
                  @start="startMirror"
                  @stop="stopMirror"
                  @drag-start="onDragStart"
                  @drag-enter="onDragEnter"
                  @drag-end="onDragEnd"
                  @drop-on="onDrop"
                />
              </div>
              <div v-else class="empty empty--sm u-mt-lg">
                <div class="empty__title">没有发现设备</div>
                <div class="empty__hint">
                  请用 USB 连接 Android 设备并开启 USB 调试，或使用无线调试配对后点击「刷新」。
                </div>
              </div>
              <section v-if="activeSessions.length" class="sessions">
                <h2 class="section-title">进行中的会话</h2>
                <div v-for="s in activeSessions" :key="s.id" class="session-row">
                  <span class="badge" :class="s.state === 'running' ? 'badge--ok' : 'badge--warn'">
                    {{ s.state === 'running' ? '运行中' : '启动中' }}
                  </span>
                  <span class="session-row__id">{{ s.id }}</span>
                  <span class="session-row__spacer" />
                  <button
                    class="btn btn--sm btn--danger"
                    :disabled="busy['stop-mirror:' + s.id]"
                    @click="stopMirror(s.id)"
                  >
                    {{ busy['stop-mirror:' + s.id] ? '停止中…' : '停止' }}
                  </button>
                </div>
              </section>
            </section>

            <section class="card">
              <h3 class="card__title">反向流设置</h3>
              <p class="card__sub">在电脑窗口里看平板画面并用键鼠控制（线 2）。画面分辨率与投屏画质是两套设置。</p>
              <div class="settings-row">
                <div class="settings-row__text">
                  <div class="settings-row__label">画面分辨率</div>
                  <div class="settings-row__hint">反向流的目标宽度；平板每次控制都要确认</div>
                </div>
                <label class="quality-pick">
                  分辨率
                  <select :value="reverseQuality" class="edge-select" @change="onReverseQualityChange">
                    <option v-for="q in REVERSE_QUALITY_OPTIONS" :key="q.value" :value="q.value">{{ q.label }}</option>
                  </select>
                </label>
              </div>
              <div class="settings-row">
                <div class="settings-row__text">
                  <div class="settings-row__label">当前状态</div>
                  <div class="settings-row__hint">
                    {{ reverseActive ? `正在看 ${reverseName} 的画面` : '未在看任何平板画面' }}
                  </div>
                </div>
                <button
                  v-if="reverseActive"
                  class="btn btn--sm btn--danger"
                  :disabled="busy['stop-reverse:' + (reversePeerId ?? 'all')]"
                  @click="stopReverse(reversePeerId ?? undefined)"
                >
                  {{ busy['stop-reverse:' + (reversePeerId ?? 'all')] ? '断开中…' : '断开' }}
                </button>
              </div>
            </section>

            <section class="card">
              <h3 class="card__title">扩展屏设置</h3>
              <p class="card__sub">把平板当作电脑的第二块屏幕（线 3）。</p>
              <div class="empty empty--sm">
                <div class="empty__title">研制中</div>
                <div class="empty__hint">扩展屏功能尚未完成，这里先占位，不提供假入口。</div>
              </div>
              <div class="settings-row">
                <div class="settings-row__text">
                  <div class="settings-row__label">模式</div>
                  <div class="settings-row__hint">扩展 / 镜像</div>
                </div>
                <span class="segmented">
                  <button class="segmented__btn segmented__btn--active" disabled>扩展</button>
                  <button class="segmented__btn" disabled>镜像</button>
                </span>
              </div>
              <div class="settings-row">
                <div class="settings-row__text">
                  <div class="settings-row__label">尺寸</div>
                  <div class="settings-row__hint">研制中，暂不可选</div>
                </div>
                <button class="btn btn--sm" disabled>应用</button>
              </div>
            </section>
          </template>

          <!-- ============ 文件页 ============ -->
          <template v-else-if="currentPage === 'files'">
            <section class="card">
              <h3 class="card__title">文件传输</h3>
              <p class="card__sub">对方发来的文件会在这里等你确认接收；发送请到设备页选一台已信任的设备。</p>
              <TransferList
                :transfers="transfers"
                :rates="rates"
                :busy="busy"
                @accept="acceptTransfer"
                @cancel="cancelTransfer"
              />
            </section>
          </template>

          <!-- ============ 设置页 ============ -->
          <template v-else-if="currentPage === 'settings'">
            <section class="card">
              <h3 class="card__title">本机</h3>
              <div class="settings-row">
                <div class="settings-row__text">
                  <div class="settings-row__label">本机名</div>
                  <div class="settings-row__hint">对端设备看到的名字</div>
                </div>
                <span class="topbar__self">
                  <input
                    v-if="editingName"
                    ref="nameInput"
                    v-model="nameDraft"
                    class="code-field topbar__self-input"
                    maxlength="60"
                    placeholder="本机显示名"
                    @keydown.enter="saveRename"
                    @keydown.esc="editingName = false"
                    @blur="saveRename"
                  />
                  <template v-else>
                    <span class="topbar__self-name">{{ selfName }}</span>
                    <button class="btn-icon" title="修改本机显示名" @click="startRename">✎</button>
                  </template>
                </span>
              </div>
              <div class="settings-row">
                <div class="settings-row__text">
                  <div class="settings-row__label">剪贴板同步</div>
                  <div class="settings-row__hint">关闭后收发双向静默，不产生任何流量</div>
                </div>
                <button
                  class="toggle"
                  role="switch"
                  :aria-checked="clipboardOn"
                  aria-label="剪贴板同步"
                  :disabled="busy['clipboard']"
                  @click="toggleClipboard"
                />
              </div>
              <div class="settings-row">
                <div class="settings-row__text">
                  <div class="settings-row__label">传输端口 / 指纹</div>
                  <div class="settings-row__hint">
                    <span v-if="transferInfo && transferInfo.port">
                      端口 {{ transferInfo.port }} · 指纹 {{ transferInfo.fingerprint.slice(0, 17) }}…
                    </span>
                    <span v-else>传输服务未启动</span>
                  </div>
                </div>
                <button v-if="transferInfo" class="btn btn--sm" @click="copyFingerprint">
                  复制指纹
                </button>
              </div>
            </section>

            <section class="card">
              <h3 class="card__title">关于</h3>
              <dl class="kv-list">
                <div class="kv-list__row">
                  <dt class="kv-list__key">版本</dt>
                  <dd class="kv-list__value">v0.1.0 · 原型</dd>
                </div>
                <div class="kv-list__row">
                  <dt class="kv-list__key">scrcpy</dt>
                  <dd class="kv-list__value">
                    {{ env ? (env.ready ? '就绪' : '未就绪') : '检测中…' }}
                    <span v-if="env && !env.ready" class="device-card__serial">
                      （{{ env.scrcpyPath }}，来源 {{ env.scrcpySource }}）
                    </span>
                  </dd>
                </div>
              </dl>
            </section>
          </template>
        </div>
      </main>

      <footer class="footer">
        <span>v0.1.0 · 原型</span>
        <span>·</span>
        <span>投屏会话 {{ sessions.length }} 个</span>
        <span>·</span>
        <span>传输任务 {{ transfers.length }} 个</span>
        <span v-if="transferInfo && transferInfo.port" class="device-card__serial">
          传输端口 {{ transferInfo.port }} · 指纹 {{ transferInfo.fingerprint.slice(0, 17) }}…
        </span>
        <span class="topbar__spacer" />
        <span v-if="discovered.length">局域网内 {{ discovered.length }} 台可配对设备</span>
      </footer>
    </div>
  </div>
</template>
