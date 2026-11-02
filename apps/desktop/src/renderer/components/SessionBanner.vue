<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'

export type BannerLevel = 'info' | 'warn' | 'danger' | 'ok'

export interface BannerAction {
  id: string
  label: string
  /** primary | danger | default */
  kind?: string
  /** 进行中：按钮禁用 + 文案加「…」 */
  busy?: boolean
}

export interface BannerItem {
  id: string
  level: BannerLevel
  text: string
  hint?: string
  actions?: BannerAction[]
  closable?: boolean
  /** info 级成功反馈自动消失；danger 常驻到被关闭 */
  autoDismiss?: boolean
}

const props = defineProps<{
  items: BannerItem[]
}>()

const emit = defineEmits<{
  (e: 'close', id: string): void
  (e: 'action', bannerId: string, actionId: string): void
}>()

const timers = new Map<string, number>()

function armAutoDismiss(item: BannerItem): void {
  if (!item.autoDismiss || timers.has(item.id)) return
  timers.set(
    item.id,
    window.setTimeout(() => {
      emit('close', item.id)
    }, 6000)
  )
}

watch(
  () => props.items,
  (items) => {
    for (const item of items) armAutoDismiss(item)
    // 已消失的横条清掉计时器
    for (const id of timers.keys()) {
      if (!items.some((i) => i.id === id)) {
        window.clearTimeout(timers.get(id))
        timers.delete(id)
      }
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  for (const t of timers.values()) window.clearTimeout(t)
  timers.clear()
})
</script>

<template>
  <div v-if="props.items.length" class="banner-stack">
    <div
      v-for="item in props.items"
      :key="item.id"
      class="banner"
      :class="`banner--${item.level}`"
    >
      <div class="banner__body">
        <div>{{ item.text }}</div>
        <div v-if="item.hint" class="pairing-hint pairing-hint--flush">{{ item.hint }}</div>
      </div>
      <span class="banner__actions">
        <button
          v-for="a in item.actions ?? []"
          :key="a.id"
          class="btn btn--sm"
          :class="a.kind === 'primary' ? 'btn--primary' : a.kind === 'danger' ? 'btn--danger' : ''"
          :disabled="a.busy"
          @click="emit('action', item.id, a.id)"
        >
          {{ a.label }}{{ a.busy ? '…' : '' }}
        </button>
        <button
          v-if="item.closable"
          class="btn-icon banner__close"
          aria-label="关闭通知"
          @click="emit('close', item.id)"
        >
          ✕
        </button>
      </span>
    </div>
  </div>
</template>
