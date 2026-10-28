<script setup lang="ts">
import { computed } from 'vue'
import type { SessionView, DeviceView } from '../../shared/types'

const props = defineProps<{
  device: DeviceView
  sessions: SessionView[]
  index: number
}>()

const emit = defineEmits<{
  (e: 'start', serial: string, index: number): void
  (e: 'stop', id: string): void
}>()

const isOnline = computed(() => props.device.state === 'device')
const active = computed(() =>
  props.sessions.find((s) => s.state === 'starting' || s.state === 'running' || s.state === 'stopping')
)
const lastError = computed(() => props.sessions.find((s) => s.state === 'error' && s.error)?.error)

const stateBadge = computed(() => {
  switch (props.device.state) {
    case 'device':
      return { cls: 'badge--ok', text: '在线' }
    case 'offline':
      return { cls: 'badge--warn', text: '离线' }
    case 'unauthorized':
      return { cls: 'badge--danger', text: '未授权' }
    default:
      return { cls: 'badge--neutral', text: props.device.state }
  }
})

const displayName = computed(() => props.device.model ?? '未知设备')
</script>

<template>
  <article class="device-card" :class="{ 'device-card--offline': !isOnline }">
    <div class="device-card__head">
      <div class="device-card__name">{{ displayName }}</div>
      <span class="badge" :class="stateBadge.cls">
        <span class="badge__dot" />
        {{ stateBadge.text }}
      </span>
    </div>

    <div class="device-card__meta">
      <span class="badge badge--neutral">{{ device.wireless ? '无线' : 'USB' }}</span>
      <span v-if="active" class="badge badge--ok">投屏中</span>
      <span v-else-if="!isOnline" class="badge badge--neutral">不可用</span>
    </div>

    <div class="device-card__serial">{{ device.serial }}</div>

    <div v-if="lastError" class="device-card__error">
      {{ lastError.message }}
    </div>

    <div class="device-card__actions">
      <button
        v-if="!active"
        class="btn btn--primary"
        :disabled="!isOnline"
        @click="emit('start', device.serial, index)"
      >
        启动投屏
      </button>
      <button v-else class="btn btn--danger" @click="emit('stop', active.id)">停止投屏</button>
    </div>
  </article>
</template>
