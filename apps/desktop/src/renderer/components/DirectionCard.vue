<script setup lang="ts">
export interface DirectionCapability {
  key: string
  label: string
  /** 行内一行小字：这个能力是干什么的 */
  hint: string
  /** 开关状态。默认全关；有真实后端状态的能力（剪贴板/反向流）由父组件接真实值 */
  on: boolean
  /** 开关是否可点。不可点时只展示状态 */
  toggleable: boolean
  busy?: boolean
}

const props = defineProps<{
  title: string
  sub: string
  capabilities: DirectionCapability[]
}>()

const emit = defineEmits<{
  (e: 'toggle', key: string, next: boolean): void
  (e: 'open', key: string): void
}>()
</script>

<template>
  <section class="card">
    <div class="dir-card__head">
      <h3 class="dir-card__title">{{ props.title }}</h3>
      <span class="dir-card__sub">{{ props.sub }}</span>
    </div>
    <div
      v-for="cap in props.capabilities"
      :key="cap.key"
      class="cap-row"
    >
      <div class="cap-row__text">
        <div class="cap-row__label">{{ cap.label }}</div>
        <div class="cap-row__hint">{{ cap.hint }}</div>
      </div>
      <button
        class="toggle"
        role="switch"
        :aria-checked="cap.on"
        :aria-label="cap.label"
        :disabled="!cap.toggleable || cap.busy"
        :title="cap.toggleable ? (cap.on ? '点击关闭' : '点击开启') : '该能力按需使用，无需开关'"
        @click="emit('toggle', cap.key, !cap.on)"
      />
      <button
        class="cap-row__chev"
        :aria-label="`查看${cap.label}详情`"
        title="查看详情"
        @click="emit('open', cap.key)"
      >
        ›
      </button>
    </div>
  </section>
</template>
