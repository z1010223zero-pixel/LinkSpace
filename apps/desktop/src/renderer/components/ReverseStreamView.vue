<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  ReverseStreamFrameView,
  ReverseStreamStatusView,
  ReverseWindowInput
} from '../../shared/types'

// 平板画面窗口（线 2 W7，任务 2.3-2）：展示反向流解出的 RGBA 帧，
// 输入经 IPC 走 input.event 落到平板。
//
// B 线 UI 重设计（docs/ui-redesign.md §3.2）：标题栏常驻 + 工具栏默认折叠，
// 深色走 §5 token（A 线未在 style.css 落 .theme-dark 前，先在 scoped 里定义同名变量），
// 状态行只留分辨率与控制状态，调试信息（帧数/MB/关键帧重同步）进“详情”展开项。
// 只改表现层：画布指针/滚轮/键盘转发逻辑、IPC 调用一律不动。
//
// 坐标链（两段比例映射，与线 1 被控端同口径）：
//   画布像素 →（本组件，扣掉 object-fit 黑边）→ 流画面像素
//   流画面像素 →（主进程 decodeReverseWindowInput，mapPoint）→ 会话声明的流尺寸
//   会话声明尺寸 →（平板 ControlledInputSession，mapPoint）→ 平板本屏像素
// 中间尺寸（窗口大小、换档前后的流尺寸）只影响比例，不影响落点。

const QUALITY_OPTIONS = [
  { width: 1280, label: '720p' },
  { width: 1920, label: '1080p' },
  { width: 2560, label: '1440p' },
  { width: 3840, label: '2160p' }
]

function peerFromHash(): { peerId: string; name: string } {
  const q = window.location.hash.split('?')[1] ?? ''
  const params = new URLSearchParams(q)
  return {
    peerId: params.get('peer') ?? '',
    name: params.get('name') ?? ''
  }
}

const { peerId } = peerFromHash()
const status = ref<ReverseStreamStatusView | null>(null)
const notice = ref('')
const canvasRef = ref<HTMLCanvasElement | null>(null)
const qualityWidth = ref(1920)
let ctx: CanvasRenderingContext2D | null = null
let unsubFrame: (() => void) | null = null
let unsubChanged: (() => void) | null = null
let pollTimer: number | null = null

// 工具栏默认折叠（ToDesk 式），点标题栏 chevron 展开；全屏时自动隐藏。
const toolbarExpanded = ref(false)
const detailsExpanded = ref(false)
const isFullscreen = ref(false)
const toolbarVisible = computed(() => toolbarExpanded.value && !isFullscreen.value)

// 控制请求倒计时：状态里没有请求发起时间戳，自首次观测到 pending 起本地计时。
// 服务端 TTL 30 秒（main/input/session.ts DEFAULT_REQUEST_TTL_MS），显示为约数。
const CONTROL_REQUEST_TTL_S = 30
const pendingSince = ref<number | null>(null)
const now = ref(Date.now())
const pendingRemaining = computed(() => {
  if (pendingSince.value === null) return null
  return Math.max(0, CONTROL_REQUEST_TTL_S - Math.floor((now.value - pendingSince.value) / 1000))
})
watch(
  () => status.value?.input.state,
  (state, prev) => {
    if (state === 'pending' && prev !== 'pending') pendingSince.value = Date.now()
    else if (state !== 'pending') pendingSince.value = null
  }
)

const peerName = computed(() => status.value?.displayName || peerId)
const streamRunning = computed(() => status.value?.receiver.running ?? false)
const streamSize = computed(() => {
  const r = status.value?.receiver
  return r && r.width > 0 ? `${r.width}×${r.height}` : '—'
})
const qualityLabel = computed(
  () => QUALITY_OPTIONS.find((q) => q.width === qualityWidth.value)?.label ?? ''
)
const inputLabel = computed(() => {
  const s = status.value?.input
  if (!s) return ''
  switch (s.state) {
    case 'active':
      return '键鼠控制中'
    case 'pending': {
      const remain = pendingRemaining.value
      return remain !== null && remain > 0
        ? `等待平板确认控制…（约 ${remain} 秒后自动取消）`
        : '等待平板确认控制…（即将自动取消）'
    }
    case 'failed':
      return `控制未建立：${s.error ?? '未知原因'}`
    default:
      // none：与 pending/failed 的文案区分开——控制会话不存在。
      // 流已在跑时说明控制始终没建立起来（可点“重试控制”）；
      // 流没跑时状态行另有录屏等待文案，这里不展示。
      return streamRunning.value ? '控制未建立，仅查看画面' : '仅查看画面'
  }
})
const showRetry = computed(() => {
  const s = status.value?.input
  return streamRunning.value && (s?.state === 'failed' || s?.state === 'none')
})
const stats = computed(() => {
  const r = status.value?.receiver
  if (!r) return ''
  const mb = (r.bytesReceived / 1024 / 1024).toFixed(1)
  return `${r.framesDecoded} 帧 · ${mb} MB${r.keyframeResyncs > 0 ? ` · 关键帧重同步 ${r.keyframeResyncs} 次` : ''}`
})

async function loadStatus(): Promise<void> {
  const s = await window.linkspace.reverseStreamStatus().catch(() => null)
  if (!s) return
  status.value = s
  if (s.scaleWidth) qualityWidth.value = s.scaleWidth
}

function drawFrame(frame: ReverseStreamFrameView): void {
  const canvas = canvasRef.value
  if (!canvas) return
  if (!ctx) ctx = canvas.getContext('2d')
  if (!ctx) return
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width
    canvas.height = frame.height
  }
  const expected = frame.width * frame.height * 4
  if (frame.data.length !== expected) return
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0)
}

async function changeQuality(): Promise<void> {
  notice.value = ''
  const res = await window.linkspace.setReverseStreamQuality(peerId, qualityWidth.value)
  if (!res.ok) {
    notice.value = res.error.message
    await loadStatus()
  }
}

async function disconnect(): Promise<void> {
  await window.linkspace.stopReverseControl(peerId)
  // 主进程随流结束关窗口；此处不主动 window.close()，避免竞态
}

async function toggleClipboard(): Promise<void> {
  const next = !(status.value?.clipboardEnabled ?? false)
  const res = await window.linkspace.setClipboardEnabled(next)
  if (!res.ok) notice.value = res.error.message
  await loadStatus()
}

async function retryInput(): Promise<void> {
  notice.value = ''
  const res = await window.linkspace.retryReverseInput(peerId)
  if (!res.ok) notice.value = res.error.message
  await loadStatus()
}

function onFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement !== null
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    notice.value = '无法切换全屏：当前环境不支持全屏'
  }
}

async function sendInput(input: ReverseWindowInput): Promise<void> {
  const res = await window.linkspace.sendReverseInput(input).catch(() => null)
  if (res && !res.ok && res.error.message !== '键鼠控制尚未建立：请等平板确认控制后再操作') {
    notice.value = res.error.message
  }
}

// ---------- 指针：画布像素 → 流画面像素（扣 object-fit 黑边） ----------
function toStreamPoint(e: PointerEvent): { x: number; y: number } | null {
  const canvas = canvasRef.value
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null
  const rect = canvas.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  // canvas 用 object-fit: contain：画面等比居中，左右/上下可能有黑边
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
  const imgW = canvas.width * scale
  const imgH = canvas.height * scale
  const offsetX = (rect.width - imgW) / 2
  const offsetY = (rect.height - imgH) / 2
  const x = (e.clientX - rect.left - offsetX) / scale
  const y = (e.clientY - rect.top - offsetY) / scale
  if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) return null
  return { x, y }
}

function buttonOf(e: PointerEvent): 'left' | 'right' | 'middle' {
  return e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'
}

// 移动节流：rAF 合并为一帧一个 move，滑动不断点、IPC 不刷屏
let pendingMove: { x: number; y: number } | null = null
let moveRaf = 0

function flushMove(): void {
  moveRaf = 0
  const pt = pendingMove
  pendingMove = null
  if (!pt) return
  const canvas = canvasRef.value
  if (!canvas) return
  void sendInput({ kind: 'move', x: pt.x, y: pt.y, canvasW: canvas.width, canvasH: canvas.height })
}

function onPointerMove(e: PointerEvent): void {
  const pt = toStreamPoint(e)
  if (!pt) return
  pendingMove = pt
  if (!moveRaf) moveRaf = requestAnimationFrame(flushMove)
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault()
  canvasRef.value?.focus()
  ;(e.target as Element).setPointerCapture?.(e.pointerId)
  const pt = toStreamPoint(e)
  if (!pt) return
  const canvas = canvasRef.value
  if (!canvas) return
  // 主进程的 down 收敛里自带一个同位置 move 前缀（落点与按键同一批），
  // 这里不再另发 move，避免同一位置发两遍
  void sendInput({
    kind: 'down',
    b: buttonOf(e),
    x: pt.x,
    y: pt.y,
    canvasW: canvas.width,
    canvasH: canvas.height
  })
}

function onPointerUp(e: PointerEvent): void {
  const pt = toStreamPoint(e)
  if (!pt) return
  const canvas = canvasRef.value
  if (!canvas) return
  void sendInput({
    kind: 'up',
    b: buttonOf(e),
    x: pt.x,
    y: pt.y,
    canvasW: canvas.width,
    canvasH: canvas.height
  })
}

function onWheel(e: WheelEvent): void {
  // 滚轮刻度：协议里 dy 以刻度计（Win32 侧 ×120），正 = 向上滚
  void sendInput({ kind: 'wheel', dx: -Math.sign(e.deltaX), dy: -Math.sign(e.deltaY) })
}

// ---------- 键盘：Chromium keyCode 在 Windows 上就是 Win32 VK 码 ----------
// 中文输入不在本批（2.3-3 另排）：IME 组合输入走不了 vk 通道
function onKey(e: KeyboardEvent, down: boolean): void {
  const tag = (e.target as HTMLElement | null)?.tagName
  if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return
  if (down && e.repeat) return
  const vk = e.keyCode
  if (vk < 0 || vk > 255) return
  e.preventDefault()
  void sendInput({ kind: 'key', vk, down })
}

function onKeyDown(e: KeyboardEvent): void {
  onKey(e, true)
}

function onKeyUp(e: KeyboardEvent): void {
  onKey(e, false)
}

onMounted(() => {
  void loadStatus()
  unsubFrame = window.linkspace.onReverseStreamFrame(drawFrame)
  unsubChanged = window.linkspace.onReverseStreamChanged((s) => {
    status.value = s
    if (s.scaleWidth) qualityWidth.value = s.scaleWidth
  })
  pollTimer = window.setInterval(() => {
    now.value = Date.now()
    void loadStatus()
  }, 1000)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
})

onBeforeUnmount(() => {
  unsubFrame?.()
  unsubChanged?.()
  if (pollTimer !== null) window.clearInterval(pollTimer)
  if (moveRaf) cancelAnimationFrame(moveRaf)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
})
</script>

<template>
  <div class="rs-view">
    <header class="rs-titlebar">
      <span class="rs-title">{{ peerName }} 的屏幕</span>
      <span v-if="qualityLabel" class="rs-quality-badge">{{ qualityLabel }}</span>
      <span class="topbar__spacer" />
      <button
        v-if="!isFullscreen"
        class="rs-chevron"
        :aria-expanded="toolbarExpanded"
        :title="toolbarExpanded ? '收起工具栏' : '展开工具栏'"
        @click="toolbarExpanded = !toolbarExpanded"
      >
        {{ toolbarExpanded ? '⌃' : '⌄' }}
      </button>
      <button class="rs-close" title="关闭窗口并结束控制会话" @click="disconnect">×</button>
    </header>

    <div v-if="toolbarVisible" class="rs-toolbar">
      <div class="rs-toolbar__group">
        <span class="rs-toolbar__group-label">显示</span>
        <label class="rs-quality">
          画面分辨率
          <select v-model.number="qualityWidth" class="edge-select" @change="changeQuality">
            <option v-for="q in QUALITY_OPTIONS" :key="q.width" :value="q.width">
              {{ q.label }}
            </option>
          </select>
        </label>
        <button class="btn btn--sm" @click="toggleFullscreen">全屏</button>
      </div>
      <div class="rs-toolbar__group">
        <span class="rs-toolbar__group-label">控制</span>
        <button
          class="badge badge-btn"
          :class="status?.clipboardEnabled ? 'badge--ok' : 'badge--off'"
          :title="'与平板双向同步剪贴板文本（与主界面开关同一处）'"
          @click="toggleClipboard"
        >
          <span class="badge__dot" />剪贴板：{{ status?.clipboardEnabled ? '开' : '关' }}
        </button>
        <button v-if="showRetry" class="btn btn--sm" @click="retryInput">重试控制</button>
      </div>
      <div class="rs-toolbar__group rs-toolbar__group--danger">
        <span class="rs-toolbar__group-label">断开</span>
        <button class="btn btn--sm btn--danger" @click="disconnect">断开</button>
      </div>
    </div>

    <div v-if="notice" class="banner banner--warn">{{ notice }}</div>

    <div class="rs-status">
      <span v-if="!streamRunning">等待平板确认录屏…（平板点同意后画面出现）</span>
      <span v-else>{{ streamSize }} · {{ inputLabel }}</span>
      <button
        v-if="stats"
        class="rs-details-toggle"
        :aria-expanded="detailsExpanded"
        @click="detailsExpanded = !detailsExpanded"
      >
        详情 {{ detailsExpanded ? '▴' : '▾' }}
      </button>
    </div>
    <div v-if="detailsExpanded && stats" class="rs-details">{{ stats }}</div>

    <div class="rs-stage">
      <canvas
        ref="canvasRef"
        class="rs-canvas"
        tabindex="0"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel.prevent="onWheel"
        @contextmenu.prevent
      />
      <div v-if="!streamRunning" class="rs-empty">
        <div class="empty__title">暂无画面</div>
        <div class="empty__hint">
          已向平板发起录屏请求。请在平板上点「同意」并在系统录屏授权框里点「允许」。
          30 秒内无人确认会自动取消。
        </div>
      </div>
    </div>

    <footer class="rs-footer">
      <span>点按 / 滑动 / 滚轮 / 键盘直接落到平板对应位置；中文输入暂不支持（2.3-3 另排）。</span>
      <span>关闭窗口即结束控制会话；全屏时按 Esc 退出全屏。</span>
    </footer>
  </div>
</template>

<style scoped>
.rs-view {
  /* 深色 token（docs/ui-redesign.md §5）：A 线尚未在 style.css 落 .theme-dark，
     先在组件内用同名变量定义；A 线到位、窗口挂上 .theme-dark 后删掉这里，改由全局接管。
     强调色不重定义，沿用全局 --accent #2f6bff。 */
  --bg: #161617;
  --surface: #1e1e1f;
  --surface-2: #232325;
  --text: #e8eaed;
  --text-secondary: #9aa0a6;
  --border: #2c3138;
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
  color: var(--text);
}
.rs-titlebar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.rs-title {
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
}
.rs-quality-badge {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.rs-chevron,
.rs-close {
  padding: 2px 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
  cursor: pointer;
}
.rs-chevron:hover,
.rs-close:hover,
.rs-details-toggle:hover {
  color: var(--text);
}
.rs-chevron:focus-visible,
.rs-close:focus-visible,
.rs-details-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.rs-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 8px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.rs-toolbar__group {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 16px;
  border-left: 1px solid var(--border);
}
.rs-toolbar__group:first-child {
  padding-left: 0;
  border-left: none;
}
.rs-toolbar__group-label {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.rs-quality {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  white-space: nowrap;
}
.rs-status {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--surface-2);
}
.rs-details-toggle {
  margin-left: auto;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}
.rs-details {
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--surface-2);
}
.rs-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.rs-canvas {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  touch-action: none;
  outline: none;
  cursor: crosshair;
  /* 画面黑边保持纯黑（视频区，非主题色） */
  background: #000;
}
.rs-canvas:focus {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.rs-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  pointer-events: none;
  text-align: center;
  padding: 0 24px;
}
.rs-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--surface);
  border-top: 1px solid var(--border);
}
</style>
