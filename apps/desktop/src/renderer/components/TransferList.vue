<script setup lang="ts">
import type { TransferTaskView } from '../../shared/types'

const props = defineProps<{
  transfers: TransferTaskView[]
  /** 速率采样（字节/秒），由父组件按 4.3 的差分口径提供 */
  rates: Record<string, number>
  busy: Record<string, boolean>
}>()

const emit = defineEmits<{
  (e: 'accept', id: string): void
  (e: 'cancel', id: string): void
}>()

const STATE_LABEL: Record<string, string> = {
  waiting: '等待设备上线',
  offered: '等待对端确认',
  accepted: '传输中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消'
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

function speedOf(t: TransferTaskView): string {
  const r = props.rates[t.id]
  return r === undefined ? '' : `${bytes(r)}/s`
}
</script>

<template>
  <div>
    <div v-if="!props.transfers.length" class="empty empty--sm">
      <div class="empty__title">暂无传输任务</div>
      <div class="empty__hint">在设备页选择一台已信任的设备，点击「发送文件」；对方发来的文件会在这里等你确认接收。</div>
    </div>
    <div v-else>
      <div v-for="t in props.transfers" :key="t.id" class="session-row">
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
          :disabled="props.busy['accept:' + t.id]"
          @click="emit('accept', t.id)"
        >
          {{ props.busy['accept:' + t.id] ? '接收中…' : '选择位置接收' }}
        </button>
        <button
          v-if="t.state === 'offered' || t.state === 'accepted' || t.state === 'waiting'"
          class="btn btn--sm btn--danger"
          :disabled="props.busy['cancel:' + t.id]"
          @click="emit('cancel', t.id)"
        >
          {{ props.busy['cancel:' + t.id] ? '取消中…' : '取消' }}
        </button>
      </div>
    </div>
  </div>
</template>
