<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  DeviceEdge,
  DeviceView,
  DiscoveredDevice,
  EnvInfo,
  InputStateView,
  SessionView,
  TransferInfo,
  TransferTaskView,
  TrustedDevice
} from '../shared/types'
import DeviceCard from './components/DeviceCard.vue'

const devices = ref<DeviceView[]>([])
const sessions = ref<SessionView[]>([])
const transfers = ref<TransferTaskView[]>([])
const transferInfo = ref<TransferInfo | null>(null)
const discovered = ref<DiscoveredDevice[]>([])
const pairings = ref<Array<{ id: string; peerId: string; displayName: string; deviceType: string; code: string; expiresAt: number }>>([])
const trusted = ref<TrustedDevice[]>([])
const codeInput = ref('')
const env = ref<EnvInfo | null>(null)
const notice = ref('')
let refreshing = false

// ---------- 本机显示名（5.4） ----------
const selfName = ref('')
const editingName = ref(false)
const nameDraft = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

// ---------- 剪贴板同步开关（6.6） ----------
const clipboardOn = ref(true)

async function toggleClipboard(): Promise<void> {
  const next = !clipboardOn.value
  const res = await window.linkspace.setClipboardEnabled(next)
  if (!res.ok) {
    notice.value = res.error.message
    return
  }
  clipboardOn.value = res.value
}

// ---------- 键鼠共享（阶段 3，第 7 组） ----------
const inputState = ref<InputStateView | null>(null)

/** 方位下拉的展示顺序与文案。'' 表示不参与共享 */
const EDGE_OPTIONS: Array<{ value: DeviceEdge | ''; label: string }> = [
  { value: '', label: '不参与' },
  { value: 'left', label: '在左侧' },
  { value: 'right', label: '在右侧' },
  { value: 'top', label: '在上方' },
  { value: 'bottom', label: '在下方' }
]

function edgeOf(deviceId: string): DeviceEdge | '' {
  return inputState.value?.layout[deviceId] ?? ''
}

async function setEdge(deviceId: string, edge: DeviceEdge | ''): Promise<void> {
  const res = await window.linkspace.setDeviceEdge(deviceId, edge === '' ? null : edge)
  if (!res.ok) notice.value = res.error.message
  await loadInputState()
}

/** 手动发起键鼠控制（7.2）。边缘穿越触发的也是同一条链路 */
async function requestControl(deviceId: string): Promise<void> {
  notice.value = ''
  const res = await window.linkspace.requestInputControl(deviceId)
  if (!res.ok) notice.value = res.error.message
}

async function approveControl(sessionId: string): Promise<void> {
  const res = await window.linkspace.approveInputControl(sessionId)
  if (!res.ok) notice.value = res.error.message
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

/** 方位下拉 change 事件：模板里写不了 TS 断言，在此收口取值 */
function onEdgeChange(deviceId: string, ev: Event): void {
  const value = (ev.target as HTMLSelectElement).value as DeviceEdge | ''
  void setEdge(deviceId, value)
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
  const res = await window.linkspace.renameSelf(name)
  if (!res.ok) {
    notice.value = res.error.message
    return
  }
  selfName.value = res.value
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
let pollTimer: number | null = null
let speedTimer: number | null = null

const onlineCount = computed(() => devices.value.filter((d) => d.state === 'device').length)
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
  if (!res.ok) notice.value = res.error.message
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

function speedOf(t: TransferTaskView): string {
  const r = rates.value[t.id]
  return r === undefined ? '' : `${bytes(r)}/s`
}

function percentOf(t: TransferTaskView): number {
  if (!t.totalSize) return 0
  return Math.min(100, Math.round((t.transferred / t.totalSize) * 100))
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const STATE_LABEL: Record<string, string> = {
  waiting: '等待设备上线',
  offered: '等待对端确认',
  accepted: '传输中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

async function loadDiscovered(): Promise<void> {
  const list = await window.linkspace.listDiscovered()
  discovered.value = Array.isArray(list) ? list : []
}

async function loadPairings(): Promise<void> {
  const list = await window.linkspace.listPendingPairings()
  pairings.value = Array.isArray(list) ? list : []
}

async function loadTrusted(): Promise<void> {
  const list = await window.linkspace.listTrusted()
  trusted.value = Array.isArray(list) ? list : []
}

async function connectAndPair(svc: DiscoveredDevice): Promise<void> {
  notice.value = ''
  const res = await window.linkspace.connectAndPair(svc.serviceName)
  if (!res.ok) {
    notice.value = res.error.message
    return
  }
  await loadPairings()
}

async function rejectPairing(id: string): Promise<void> {
  await window.linkspace.rejectPairing(id)
  await loadPairings()
}

async function revokeTrust(deviceId: string): Promise<void> {
  await window.linkspace.revokeTrust(deviceId)
  await loadTrusted()
}

/** 发起方：把用户输入的配对码提交给对端校验 */
async function submitCode(d: DiscoveredDevice): Promise<void> {
  notice.value = ''
  const res = await window.linkspace.submitPairingCode(d.serviceName, codeInput.value.trim())
  if (!res.ok) {
    notice.value = res.error.message
    return
  }
  codeInput.value = ''
  await loadTrusted()
  await loadDiscovered()
}

async function sendFile(peerId: string): Promise<void> {
  notice.value = ''
  const res = await window.linkspace.pickAndOffer(peerId)
  if (!res.ok) notice.value = res.error.message
  else await loadTransfers()
}

function typeLabel(t: string): string {
  if (t === 'win') return '电脑'
  if (t === 'android-phone') return '手机'
  if (t === 'android-tablet') return '平板'
  return t
}

async function cancelTransfer(id: string): Promise<void> {
  const res = await window.linkspace.cancelTransfer(id)
  if (!res.ok) notice.value = res.error.message
  else await loadTransfers()
}

/** 接收方：选保存目录并接受传输 */
async function acceptTransfer(id: string): Promise<void> {
  notice.value = ''
  const res = await window.linkspace.acceptTransfer(id)
  if (!res.ok) {
    notice.value = res.error.message
    return
  }
  await loadTransfers()
}

async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    const res = await window.linkspace.refreshDevices()
    if (res.ok) devices.value = res.value
    else notice.value = res.error.message
    await loadSessions()
  } finally {
    refreshing = false
  }
}

async function startMirror(serial: string, index: number): Promise<void> {
  notice.value = ''
  // 多设备时错开摆放，避免窗口完全重叠
  const res = await window.linkspace.startMirror(serial, {
    windowTitle: `LinkSpace-${serial}`,
    windowX: 140 + index * 36,
    windowY: 90 + index * 28,
    maxSize: 1080,
    stayAwake: true
  })
  if (!res.ok) {
    notice.value = res.error.message
  } else {
    await loadSessions()
    await loadDevices()
  }
}

async function stopMirror(id: string): Promise<void> {
  notice.value = ''
  const res = await window.linkspace.stopMirror(id)
  if (!res.ok) {
    notice.value = res.error.message
    return
  }
  await loadSessions()
  await loadDevices()
}

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
  if (pollTimer !== null) window.clearInterval(pollTimer)
  if (speedTimer !== null) window.clearInterval(speedTimer)
})
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="topbar__logo">
        <span class="topbar__logo-dot" />
        LinkSpace
      </div>
      <span class="topbar__subtitle">局域网多设备协作工作空间</span>
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
      <div class="topbar__spacer" />
      <div class="topbar__actions">
        <span v-if="env" class="badge" :class="env.ready ? 'badge--ok' : 'badge--warn'">
          <span class="badge__dot" />
          {{ env.ready ? 'scrcpy 就绪' : 'scrcpy 未就绪' }}
        </span>
        <span class="badge badge--neutral">在线 {{ onlineCount }}/{{ devices.length }}</span>
        <button
          class="badge badge-btn"
          :class="clipboardOn ? 'badge--ok' : 'badge--off'"
          :title="clipboardOn ? '剪贴板同步已开启，点击关闭' : '剪贴板同步已关闭，点击开启'"
          @click="toggleClipboard"
        >
          <span class="badge__dot" />
          剪贴板 {{ clipboardOn ? '开' : '关' }}
        </button>
        <button class="btn btn--sm" :disabled="refreshing" @click="refresh">
          {{ refreshing ? '扫描中…' : '刷新' }}
        </button>
      </div>
    </header>

    <main class="content">
      <div v-if="env && !env.ready" class="banner banner--warn">
        <div>
          <strong>未检测到 scrcpy。</strong>
          投屏功能不可用。请安装 scrcpy 后重启应用，或设置
          <code>LINKSPACE_SCRCPY</code> 环境变量指定路径。
          <div class="device-card__serial" style="margin-top: 6px">
            当前查找：{{ env.scrcpyPath }}（来源 {{ env.scrcpySource }}）
          </div>
        </div>
      </div>

      <div v-if="notice" class="banner banner--warn">{{ notice }}</div>

      <!-- 键鼠共享（第 7 组）：被控端确认条。9.1 要求每次控制请求都有明确提示 -->
      <div v-if="inputState?.pending" class="banner banner--warn">
        <div>
          <strong>{{ inputState.pending.displayName }}</strong> 请求控制本机的鼠标和键盘。
          <div class="pairing-hint" style="margin-top: 6px">
            同意后对方可操作本机键鼠，随时可点「拔掉」终止；授权仅本次会话有效，配对本身不授予该权限。
          </div>
        </div>
        <span class="topbar__spacer" />
        <button
          class="btn btn--sm btn--primary"
          @click="approveControl(inputState.pending.sessionId)"
        >
          同意
        </button>
        <button class="btn btn--sm btn--danger" @click="denyControl(inputState.pending.sessionId)">
          拒绝
        </button>
      </div>

      <!-- 被控中状态条：用户随时可以拔掉（安全兜底） -->
      <div v-if="inputState?.controlledBy" class="banner banner--warn">
        <div>
          <strong>{{ inputState.controlledBy }}</strong> 正在控制本机的键鼠。
          <div class="pairing-hint" style="margin-top: 6px">
            会话结束、对端断开或撤销信任后，控制自动失效。
          </div>
        </div>
        <span class="topbar__spacer" />
        <button class="btn btn--sm btn--danger" @click="terminateControl">拔掉</button>
      </div>

      <!-- 控制中状态条：Ctrl+Alt+Space 是主进程注册的全局快捷键（7.4） -->
      <div v-if="inputState?.controlling" class="banner banner--ok">
        <div>
          正在用本机键鼠控制 <strong>{{ inputState.controlling }}</strong>。
          <div class="pairing-hint" style="margin-top: 6px">
            按 Ctrl+Alt+Space 或点击右侧按钮退出控制。
          </div>
        </div>
        <span class="topbar__spacer" />
        <button class="btn btn--sm" @click="exitControl">退出控制</button>
      </div>

      <section v-if="pairings.length" class="sessions">
        <h2 class="section-title">待确认的配对请求</h2>
        <div v-for="p in pairings" :key="p.id" class="session-row">
          <span class="badge badge--warn">配对</span>
          <span class="session-row__id">
            {{ p.displayName }}（{{ typeLabel(p.deviceType) }}）请求配对
          </span>
          <span class="topbar__spacer" />
          <span class="pairing-code">{{ p.code }}</span>
          <button class="btn btn--sm btn--danger" @click="rejectPairing(p.id)">拒绝</button>
        </div>
        <div class="pairing-hint">
          请让对方输入上面这 6 位配对码。配对码只在<span strong>本方屏幕</span>显示，不会通过网络传递。
        </div>
      </section>

      <h2 class="section-title">
        设备
        <span v-if="devices.length > 1" class="section-title__hint">拖拽卡片可调整顺序</span>
      </h2>

      <div v-if="devices.length" class="device-grid">
        <DeviceCard
          v-for="(device, index) in orderedDevices"
          :key="device.serial"
          :device="device"
          :sessions="sessionsFor(device.serial)"
          :index="index"
          :dragging="dragSerial === device.serial"
          :drop-hint="dropTarget === device.serial"
          @start="startMirror"
          @stop="stopMirror"
          @drag-start="onDragStart"
          @drag-enter="onDragEnter"
          @drag-end="onDragEnd"
          @drop-on="onDrop"
        />
      </div>

      <div v-else class="empty">
        <div class="empty__title">没有发现设备</div>
        <div class="empty__hint">
          请用 USB 连接 Android 设备并开启 USB 调试，或使用无线调试配对后点击「刷新」。
        </div>
      </div>

      <section v-if="transfers.length" class="sessions">
        <h2 class="section-title">文件传输</h2>
        <div v-for="t in transfers" :key="t.id" class="session-row">
          <span class="badge" :class="t.direction === 'send' ? 'badge--neutral' : 'badge--ok'">
            {{ t.direction === 'send' ? '发送' : '接收' }}
          </span>
          <span class="session-row__id">
            {{ t.files.map((f) => f.name).join('、') }}
            <span class="device-card__serial">（{{ bytes(t.totalSize) }}）</span>
          </span>
          <span class="session-row__spacer" />
          <span v-if="t.state === 'accepted'" class="progress">
            <span class="progress__bar" :style="{ width: percentOf(t) + '%' }" />
          </span>
          <span v-if="t.state === 'accepted'" class="session-row__speed">
            {{ speedOf(t) }}
          </span>
          <span class="badge badge--neutral">{{ STATE_LABEL[t.state] ?? t.state }}</span>
          <button
            v-if="t.direction === 'receive' && t.state === 'offered'"
            class="btn btn--sm"
            @click="acceptTransfer(t.id)"
          >
            选择位置接收
          </button>
          <button
            v-if="t.state === 'offered' || t.state === 'accepted' || t.state === 'waiting'"
            class="btn btn--sm btn--danger"
            @click="cancelTransfer(t.id)"
          >
            取消
          </button>
        </div>
      </section>

      <section v-if="discovered.length" class="sessions">
        <h2 class="section-title">局域网内的其他设备</h2>
        <div v-for="d in discovered" :key="d.serviceName" class="session-row">
          <span class="badge" :class="d.paired ? 'badge--ok' : 'badge--neutral'">
            {{ d.paired ? '已配对' : '未配对' }}
          </span>
          <span class="session-row__id">
            {{ d.displayName }}（{{ typeLabel(d.deviceType) }}）
            <span class="device-card__serial">{{ d.host }}:{{ d.port }} · {{ d.caps.join(',') }}</span>
          </span>
          <span class="session-row__spacer" />
          <input
            v-model="codeInput"
            class="code-field"
            maxlength="6"
            placeholder="6 位码"
            inputmode="numeric"
          />
          <button class="btn btn--sm" :disabled="codeInput.length !== 6" @click="submitCode(d)">
            提交配对码
          </button>
          <button class="btn btn--sm" @click="connectAndPair(d)">发起配对</button>
        </div>
        <div class="pairing-hint">
          先点「发起配对」，再把<b>对方屏幕</b>上显示的 6 位配对码输入后提交。
          配对码不会通过网络传递，只能人眼抄录。
        </div>
      </section>

      <section v-if="trusted.length" class="sessions">
        <h2 class="section-title">已信任的设备</h2>
        <div v-for="t in trusted" :key="t.deviceId" class="session-row">
          <span class="badge badge--ok">信任</span>
          <span class="session-row__id">
            {{ t.displayName }}（{{ typeLabel(t.deviceType) }}）
            <span class="device-card__serial">授权范围：{{ t.scope.join(',') }}</span>
          </span>
          <span class="session-row__spacer" />
          <!-- 键鼠共享仅 Windows↔Windows（阶段 3 范围），其他设备类型不显示入口 -->
          <template v-if="t.deviceType === 'win'">
            <select
              class="edge-select"
              :value="edgeOf(t.deviceId)"
              title="设置对方屏幕相对本机的方位；鼠标移到对应屏幕边缘即可发起跨屏控制"
              @change="onEdgeChange(t.deviceId, $event)"
            >
              <option v-for="o in EDGE_OPTIONS" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select>
            <button
              class="btn btn--sm"
              :disabled="!inputState?.nativeReady"
              :title="
                inputState?.nativeReady
                  ? '请求控制对方键鼠（对方确认后生效）'
                  : '本机注入层不可用，无法发起键鼠控制'
              "
              @click="requestControl(t.deviceId)"
            >
              键鼠控制
            </button>
          </template>
          <button class="btn btn--sm" @click="sendFile(t.deviceId)">发送文件</button>
          <button class="btn btn--sm btn--danger" @click="revokeTrust(t.deviceId)">撤销信任</button>
        </div>
      </section>

      <section v-if="activeSessions.length" class="sessions">
        <h2 class="section-title">进行中的会话</h2>
        <div v-for="s in activeSessions" :key="s.id" class="session-row">
          <span class="badge" :class="s.state === 'running' ? 'badge--ok' : 'badge--warn'">
            {{ s.state === 'running' ? '运行中' : '启动中' }}
          </span>
          <span class="session-row__id">{{ s.id }}</span>
          <span class="session-row__spacer" />
          <button class="btn btn--sm btn--danger" @click="stopMirror(s.id)">停止</button>
        </div>
      </section>
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
</template>
