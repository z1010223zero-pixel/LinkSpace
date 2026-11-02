<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SessionView, DeviceView, TrustedDevice } from '../../shared/types'

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
  /** 可绑定的已配对设备（只取 Android 平板/手机，由父组件过滤） */
  bindTargets: TrustedDevice[]
  /** device.deviceId 对应的已配对显示名，未解析到为 null */
  pairedName: string | null
  /** 绑定/解绑进行中：按钮禁用 */
  bindBusy?: boolean
}>()

const emit = defineEmits<{
  (e: 'start', serial: string, index: number): void
  (e: 'stop', id: string): void
  (e: 'bind', serial: string, deviceId: string): void
  (e: 'unbind', serial: string): void
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

/**
 * 2.5-1 身份徽标：adb serial 解析到的 LinkSpace 身份。
 * 已配对显示对方显示名；已绑定但对方已取消配对是失效绑定（门禁会拒），
 * 须解绑后重新绑定；其余一律未配对。
 */
const identityBadge = computed(() => {
  if (props.device.paired) {
    return { cls: 'badge--ok', text: `已配对 · ${props.pairedName ?? props.device.deviceId ?? ''}` }
  }
  if (props.device.bound) {
    return { cls: 'badge--danger', text: '绑定已失效（对方已取消配对）' }
  }
  return { cls: 'badge--neutral', text: '未配对' }
})

/** 启动按钮不可点的原因：主进程门禁仍会再拦一次，这里只做前置提示 */
const startDisabledReason = computed(() => {
  if (!isOnline.value) return '设备离线'
  if (props.device.scrcpyAllowed) return ''
  if (props.device.bound) return '绑定已失效：请先解绑，再重新绑定'
  return props.device.wireless ? '未配对：请先在设备页完成配对' : '未绑定：请先绑定到一台已配对设备'
})

/** 绑定目标选择（未选时默认第一个可绑定的已配对设备） */
const bindTarget = ref('')
function onBind(): void {
  const target = bindTarget.value || props.bindTargets[0]?.deviceId
  if (!target) return
  emit('bind', props.device.serial, target)
}
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
      <span class="badge" :class="identityBadge.cls">{{ identityBadge.text }}</span>
      <span v-if="active" class="badge badge--ok">投屏中</span>
      <span v-else-if="!isOnline" class="badge badge--neutral">不可用</span>
    </div>

    <div class="device-card__serial">{{ device.serial }}</div>

    <div v-if="lastError" class="device-card__error">
      {{ lastError.message }}
    </div>

    <!-- 显式绑定入口（2.5-1）：USB 设备没有 IP 可 join，投屏前须由用户显式
         绑定到一台已配对设备一次；无线设备通常走 IP-join，不必绑。 -->
    <div v-if="!device.bound && isOnline && !active" class="device-card__bind">
      <div v-if="bindTargets.length" class="device-card__bind-row">
        <select v-model="bindTarget" class="edge-select" aria-label="绑定到已配对设备">
          <option v-for="t in bindTargets" :key="t.deviceId" :value="t.deviceId">
            {{ t.displayName }}
          </option>
        </select>
        <button class="btn btn--sm" :disabled="bindBusy" @click="onBind">
          {{ bindBusy ? '绑定中…' : '绑定' }}
        </button>
      </div>
      <div v-else class="device-card__hint">还没有已配对的 Android 设备，请先在设备页配对。</div>
    </div>
    <div v-else-if="device.bound && !active" class="device-card__bind">
      <div class="device-card__hint">已绑定到 {{ pairedName ?? device.deviceId }}</div>
      <button class="btn btn--sm" :disabled="bindBusy" @click="emit('unbind', device.serial)">
        {{ bindBusy ? '解绑中…' : '解绑' }}
      </button>
    </div>

    <div class="device-card__actions">
      <button
        v-if="!active"
        class="btn btn--primary"
        :disabled="!isOnline || !device.scrcpyAllowed || startBusy"
        :title="startDisabledReason || undefined"
        @click="emit('start', device.serial, index)"
      >
        {{ startBusy ? '启动中…' : '启动投屏' }}
      </button>
      <button v-else class="btn btn--danger" :disabled="stopBusy" @click="emit('stop', active.id)">
        {{ stopBusy ? '停止中…' : '停止投屏' }}
      </button>
    </div>
    <div v-if="!active && startDisabledReason" class="device-card__hint">
      {{ startDisabledReason }}
    </div>
  </article>
</template>
