<script setup lang="ts">
export type DeviceRowStatus = 'online' | 'offline' | 'unauthorized' | 'unknown'

const props = defineProps<{
  name: string
  /** 一行小字：系统 · 连接方式 · IP */
  sub: string
  status: DeviceRowStatus
  /** win | android-phone | android-tablet */
  deviceType: string
  /** 本机行加蓝色「本设备」标签 */
  isSelf?: boolean
  selected?: boolean
  /** 行内标记，如「控制中」「正在看画面」 */
  mark?: string | null
}>()

const emit = defineEmits<{
  (e: 'select'): void
}>()

const dotCls: Record<DeviceRowStatus, string> = {
  online: 'device-row__dot--online',
  // 离线用灰 + 「离线」文字，黄色只留给进行中过渡态（ui-redesign §5）
  offline: 'device-row__dot--offline',
  unauthorized: 'device-row__dot--danger',
  unknown: 'device-row__dot--offline'
}

const statusText: Record<DeviceRowStatus, string> = {
  online: '在线',
  offline: '离线',
  unauthorized: '未授权',
  unknown: '未知'
}
</script>

<template>
  <button
    class="device-row"
    :class="{ 'device-row--selected': props.selected }"
    @click="emit('select')"
  >
    <span class="device-row__dot" :class="dotCls[props.status]" />
    <span class="device-row__icon">
      <svg v-if="props.deviceType === 'win'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="3" y="4" width="18" height="12" rx="1.5" />
        <path d="M9 20h6M12 16v4" />
      </svg>
      <svg v-else-if="props.deviceType === 'android-phone'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="7" y="3" width="10" height="18" rx="2" />
        <path d="M11 18h2" />
      </svg>
      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M11 18h2" />
      </svg>
    </span>
    <span class="device-row__text">
      <span class="device-row__name">{{ props.name }}</span>
      <span class="device-row__sub">{{ props.sub }}</span>
    </span>
    <span v-if="props.mark" class="badge badge--warn">{{ props.mark }}</span>
    <span v-if="props.isSelf" class="badge badge--ok">本设备</span>
    <span class="badge badge--neutral">{{ statusText[props.status] }}</span>
  </button>
</template>
