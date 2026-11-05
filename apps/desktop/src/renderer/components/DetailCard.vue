<script setup lang="ts">
import { ref, watch } from 'vue'
import type { DeviceEdge } from '../../shared/types'

export interface DetailDevice {
  deviceId: string
  displayName: string
  deviceType: string
  host?: string
  port?: number
  scope?: string[]
  fingerprint?: string
  trustedAt?: number
  noConfirmUntil?: number
}

const props = defineProps<{
  device: DetailDevice
  clipboardOn: boolean
  /** Win 设备方位；'' = 不参与键鼠共享 */
  edge: DeviceEdge | ''
  nativeReady: boolean
  /** 本机正在控制该设备（Win 键鼠或反向流） */
  controlling: boolean
  /** 反向流进行中（正在看该平板画面） */
  reverseWatching: boolean
  busy: Record<string, boolean>
}>()

const emit = defineEmits<{
  (e: 'control'): void
  (e: 'send-file'): void
  (e: 'toggle-clipboard'): void
  (e: 'set-edge', edge: DeviceEdge | ''): void
  (e: 'set-no-confirm', durationMs: number): void
  (e: 'revoke'): void
  (e: 'stop-reverse'): void
}>()

const NO_CONFIRM_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: '每次询问' },
  { value: 24 * 3600 * 1000, label: '1 天免确认' },
  { value: 3 * 24 * 3600 * 1000, label: '3 天免确认' },
  { value: 7 * 24 * 3600 * 1000, label: '7 天免确认' },
  { value: 30 * 24 * 3600 * 1000, label: '30 天免确认' },
  { value: -1, label: '永久免确认' }
]

function noConfirmStatusLabel(until?: number): string {
  if (until === -1) return '当前：永久免确认'
  if (!until || until <= Date.now()) return '当前：每次需手动确认'
  const remainHours = Math.max(1, Math.ceil((until - Date.now()) / (3600 * 1000)))
  if (remainHours >= 24) return `当前：免确认（剩余约 ${Math.ceil(remainHours / 24)} 天）`
  return `当前：免确认（剩余约 ${remainHours} 小时）`
}

const EDGE_OPTIONS: Array<{ value: DeviceEdge | ''; label: string }> = [
  { value: '', label: '不参与' },
  { value: 'left', label: '在左侧' },
  { value: 'right', label: '在右侧' },
  { value: 'top', label: '在上方' },
  { value: 'bottom', label: '在下方' }
]

/** 撤销信任二次确认：第一次点进入待确认态，3 秒内再点才执行 */
const confirmingRevoke = ref(false)
let revokeTimer: number | null = null

function onRevokeClick(): void {
  if (!confirmingRevoke.value) {
    confirmingRevoke.value = true
    revokeTimer = window.setTimeout(() => {
      confirmingRevoke.value = false
    }, 3000)
    return
  }
  if (revokeTimer !== null) window.clearTimeout(revokeTimer)
  confirmingRevoke.value = false
  emit('revoke')
}

watch(
  () => props.device.deviceId,
  () => {
    confirmingRevoke.value = false
  }
)

function typeLabel(t: string): string {
  if (t === 'win') return '电脑（Windows）'
  if (t === 'android-phone') return '手机（Android）'
  if (t === 'android-tablet') return '平板（Android）'
  return t
}

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}
</script>

<template>
  <section class="card">
    <div class="detail-card__head">
      <span class="device-row__icon">
        <svg v-if="props.device.deviceType === 'win'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="3" y="4" width="18" height="12" rx="1.5" />
          <path d="M9 20h6M12 16v4" />
        </svg>
        <svg v-else-if="props.device.deviceType === 'android-phone'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="7" y="3" width="10" height="18" rx="2" />
          <path d="M11 18h2" />
        </svg>
        <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M11 18h2" />
        </svg>
      </span>
      <div>
        <h3 class="detail-card__name">{{ props.device.displayName }}</h3>
        <div class="detail-card__sub">{{ typeLabel(props.device.deviceType) }}</div>
      </div>
      <span class="topbar__spacer" />
      <span v-if="props.reverseWatching" class="badge badge--warn">正在看画面</span>
      <span v-else-if="props.controlling" class="badge badge--ok">控制中</span>
    </div>

    <div class="action-grid">
      <button
        class="action-grid__btn"
        :disabled="props.busy['control:' + props.device.deviceId] || props.controlling"
        :title="
          props.device.deviceType === 'win'
            ? props.nativeReady
              ? '请求控制对方键鼠（对方确认后生效）'
              : '本机注入层不可用，无法发起键鼠控制'
            : '在电脑窗口里看平板画面并用键鼠控制（平板每次都要确认）'
        "
        @click="emit('control')"
      >
        <span class="action-grid__icon">⌨</span>
        {{ props.busy['control:' + props.device.deviceId] ? '连接中…' : props.controlling ? '控制中' : '控制' }}
      </button>
      <button
        class="action-grid__btn"
        :disabled="props.busy['send:' + props.device.deviceId]"
        @click="emit('send-file')"
      >
        <span class="action-grid__icon">⤓</span>
        {{ props.busy['send:' + props.device.deviceId] ? '发送中…' : '发送文件' }}
      </button>
      <button class="action-grid__btn" @click="emit('toggle-clipboard')">
        <span class="action-grid__icon">⧉</span>
        剪贴板 {{ props.clipboardOn ? '开' : '关' }}
        <span class="action-grid__note">{{ props.clipboardOn ? '同步中' : '已关闭' }}</span>
      </button>
      <button
        class="action-grid__btn"
        disabled
        title="扩展屏功能研制中，暂不可用"
      >
        <span class="action-grid__icon">▤</span>
        扩展屏
        <span class="action-grid__note">研制中</span>
      </button>
      <button
        v-if="props.reverseWatching"
        class="action-grid__btn action-grid__btn--danger"
        :disabled="props.busy['stop-reverse:' + props.device.deviceId]"
        @click="emit('stop-reverse')"
      >
        <span class="action-grid__icon">✕</span>
        {{ props.busy['stop-reverse:' + props.device.deviceId] ? '断开中…' : '断开画面' }}
      </button>
      <button
        class="action-grid__btn action-grid__btn--danger"
        :class="{ 'action-grid__btn--armed': confirmingRevoke }"
        :disabled="props.busy['revoke:' + props.device.deviceId]"
        title="撤销信任会级联断开与该设备的所有会话"
        @click="onRevokeClick"
      >
        <span class="action-grid__icon">⛔</span>
        {{
          props.busy['revoke:' + props.device.deviceId]
            ? '撤销中…'
            : confirmingRevoke
              ? '确认撤销？'
              : '断开'
        }}
      </button>
    </div>

    <div class="settings-row">
      <div class="settings-row__text">
        <div class="settings-row__label">免确认控制有效期</div>
        <div class="settings-row__hint">
          有效期内对方请求控制本机无需再弹确认框（{{ noConfirmStatusLabel(props.device.noConfirmUntil) }}）
        </div>
      </div>
      <select
        class="edge-select"
        :value="props.device.noConfirmUntil === -1 ? -1 : 0"
        @change="emit('set-no-confirm', Number(($event.target as HTMLSelectElement).value))"
      >
        <option disabled value="0">{{ noConfirmStatusLabel(props.device.noConfirmUntil) }}</option>
        <option v-for="o in NO_CONFIRM_OPTIONS" :key="o.value" :value="o.value">
          设为：{{ o.label }}
        </option>
      </select>
    </div>

    <div v-if="props.device.deviceType === 'win'" class="settings-row">
      <div class="settings-row__text">
        <div class="settings-row__label">屏幕方位</div>
        <div class="settings-row__hint">对方屏幕相对本机的位置；鼠标移到对应边缘即可发起跨屏控制</div>
      </div>
      <select
        class="edge-select"
        :value="props.edge"
        @change="emit('set-edge', ($event.target as HTMLSelectElement).value as DeviceEdge | '')"
      >
        <option v-for="o in EDGE_OPTIONS" :key="o.value" :value="o.value">
          {{ o.label }}
        </option>
      </select>
    </div>

    <dl class="kv-list">
      <div class="kv-list__row">
        <dt class="kv-list__key">系统</dt>
        <dd class="kv-list__value">{{ typeLabel(props.device.deviceType) }}</dd>
      </div>
      <div v-if="props.device.host" class="kv-list__row">
        <dt class="kv-list__key">地址</dt>
        <dd class="kv-list__value">{{ props.device.host }}:{{ props.device.port }}</dd>
      </div>
      <div class="kv-list__row">
        <dt class="kv-list__key">连接方式</dt>
        <dd class="kv-list__value">局域网</dd>
      </div>
      <div v-if="props.device.scope" class="kv-list__row">
        <dt class="kv-list__key">授权范围</dt>
        <dd class="kv-list__value">{{ props.device.scope.join(', ') }}</dd>
      </div>
      <div v-if="props.device.fingerprint" class="kv-list__row">
        <dt class="kv-list__key">指纹</dt>
        <dd class="kv-list__value">{{ props.device.fingerprint.slice(0, 17) }}…</dd>
      </div>
      <div v-if="props.device.trustedAt" class="kv-list__row">
        <dt class="kv-list__key">信任时间</dt>
        <dd class="kv-list__value">{{ fmtTime(props.device.trustedAt) }}</dd>
      </div>
    </dl>
  </section>
</template>
