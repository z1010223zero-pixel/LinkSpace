<script setup lang="ts">
import { computed } from 'vue'
import type { SessionView, DeviceView } from '../../shared/types'

const props = defineProps<{
  device: DeviceView
  sessions: SessionView[]
  index: number
  /** 当前正在被拖拽 */
  dragging?: boolean
  /** 拖拽中的卡片正悬停在本卡片上 */
  dropHint?: boolean
  /** 启动投屏进行中：按钮禁用 + 文案变「启动中…」 */
  startBusy?: boolean
  /** 停止投屏进行中 */
  stopBusy?: boolean
}>()

const emit = defineEmits<{
  (e: 'start', serial: string, index: number): void
  (e: 'stop', id: string): void
  (e: 'dragStart', serial: string): void
  (e: 'dragEnter', serial: string): void
  (e: 'dragEnd'): void
  (e: 'dropOn', serial: string): void
}>()

/** 拖拽把手：整卡可拖会让卡内文字选不中，用头部区域做把手更稳 */
function onDragStart(e: DragEvent): void {
  emit('dragStart', props.device.serial)
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // Firefox 不设数据就不会触发 drop
    e.dataTransfer.setData('text/plain', props.device.serial)
  }
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
  emit('dropOn', props.device.serial)
}

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
      // 离线用灰 + 「离线」文字，黄色只留给进行中过渡态（ui-redesign §5）
      return { cls: 'badge--neutral', text: '离线' }
    case 'unauthorized':
      return { cls: 'badge--danger', text: '未授权' }
    default:
      return { cls: 'badge--neutral', text: props.device.state }
  }
})

const displayName = computed(() => props.device.model ?? '未知设备')
</script>

<template>
  <article
    class="device-card"
    :class="{
      'device-card--offline': !isOnline,
      'device-card--dragging': dragging,
      'device-card--drop': dropHint
    }"
    @dragover.prevent="emit('dragEnter', device.serial)"
    @drop="onDrop"
  >
    <div
      class="device-card__head"
      draggable="true"
      title="按住拖动可调整顺序"
      @dragstart="onDragStart"
      @dragend="emit('dragEnd')"
    >
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
        :disabled="!isOnline || startBusy"
        @click="emit('start', device.serial, index)"
      >
        {{ startBusy ? '启动中…' : '启动投屏' }}
      </button>
      <button v-else class="btn btn--danger" :disabled="stopBusy" @click="emit('stop', active.id)">
        {{ stopBusy ? '停止中…' : '停止投屏' }}
      </button>
    </div>
  </article>
</template>
