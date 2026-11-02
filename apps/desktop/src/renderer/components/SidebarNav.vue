<script setup lang="ts">
export type NavPage = 'overview' | 'devices' | 'screen' | 'files' | 'settings'

const props = defineProps<{
  /** 本机显示名 */
  selfName: string
  /** 顶栏在线计数同一口径：adb 投屏设备在线数/总数 */
  onlineText: string
  currentPage: NavPage
  version: string
}>()

const emit = defineEmits<{
  (e: 'navigate', page: NavPage): void
}>()

const NAV_ITEMS: Array<{ page: NavPage; label: string; icon: string }> = [
  { page: 'overview', label: '概览', icon: '◈' },
  { page: 'devices', label: '设备', icon: '▣' },
  { page: 'screen', label: '屏幕', icon: '▤' },
  { page: 'files', label: '文件', icon: '⤓' },
  { page: 'settings', label: '设置', icon: '⚙' }
]
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__brand">
      <span class="sidebar__logo-dot" />
      LinkSpace
    </div>
    <div class="sidebar__self" :title="props.selfName">
      {{ props.selfName || '本机' }}
      <div class="sidebar__self-sub">本机 · {{ props.onlineText }}</div>
    </div>
    <nav class="sidebar__nav">
      <button
        v-for="item in NAV_ITEMS"
        :key="item.page"
        class="sidebar__nav-item"
        :class="{ 'sidebar__nav-item--active': currentPage === item.page }"
        @click="emit('navigate', item.page)"
      >
        <span class="sidebar__nav-icon">{{ item.icon }}</span>
        {{ item.label }}
      </button>
    </nav>
    <div class="sidebar__version">{{ props.version }}</div>
  </aside>
</template>
