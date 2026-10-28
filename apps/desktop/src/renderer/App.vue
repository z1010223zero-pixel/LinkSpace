<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DeviceView, EnvInfo, SessionView } from '../shared/types'
import DeviceCard from './components/DeviceCard.vue'

const devices = ref<DeviceView[]>([])
const sessions = ref<SessionView[]>([])
const env = ref<EnvInfo | null>(null)
const notice = ref('')
let refreshing = false

let unsubDevices: (() => void) | null = null
let unsubSessions: (() => void) | null = null
let pollTimer: number | null = null

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

async function loadSessions(): Promise<void> {
  const list = await window.linkspace.listSessions()
  sessions.value = Array.isArray(list) ? list : []
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
  await loadDevices()
  await loadSessions()

  unsubDevices = window.linkspace.onDevicesChanged(() => {
    void loadDevices()
    void loadSessions()
  })
  unsubSessions = window.linkspace.onSessionsChanged(() => {
    void loadSessions()
  })

  // 事件之外的兜底轮询：设备插拔时 adb 不会主动通知
  pollTimer = window.setInterval(() => {
    void loadDevices()
    void loadSessions()
  }, 5000)
})

onBeforeUnmount(() => {
  unsubDevices?.()
  unsubSessions?.()
  if (pollTimer !== null) window.clearInterval(pollTimer)
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
      <div class="topbar__spacer" />
      <div class="topbar__actions">
        <span v-if="env" class="badge" :class="env.ready ? 'badge--ok' : 'badge--warn'">
          <span class="badge__dot" />
          {{ env.ready ? 'scrcpy 就绪' : 'scrcpy 未就绪' }}
        </span>
        <span class="badge badge--neutral">在线 {{ onlineCount }}/{{ devices.length }}</span>
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

      <h2 class="section-title">设备</h2>

      <div v-if="devices.length" class="device-grid">
        <DeviceCard
          v-for="(device, index) in devices"
          :key="device.serial"
          :device="device"
          :sessions="sessionsFor(device.serial)"
          :index="index"
          @start="startMirror"
          @stop="stopMirror"
        />
      </div>

      <div v-else class="empty">
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
          <button class="btn btn--sm btn--danger" @click="stopMirror(s.id)">停止</button>
        </div>
      </section>
    </main>

    <footer class="footer">
      <span>v0.1.0 · 原型</span>
      <span>·</span>
      <span>投屏会话 {{ sessions.length }} 个</span>
      <span class="topbar__spacer" />
      <span>设备布局与文件传输将在后续阶段实现</span>
    </footer>
  </div>
</template>
