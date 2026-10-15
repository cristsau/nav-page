<script setup>
import { computed, nextTick, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { mediaPreviewPosition } from './filePresentation'
const props = defineProps({ items: { type: Array, required: true }, selectedId: String })
const emit = defineEmits(['select'])
const navigation = ref(null)
const position = computed(() => mediaPreviewPosition(props.items, props.selectedId))
async function move(direction) {
  const item = position.value[direction]
  if (!item) return
  emit('select', item)
  await nextTick()
  // Keep keyboard focus usable when an end-of-list button becomes disabled.
  if (document.activeElement?.disabled || !navigation.value?.contains(document.activeElement)) navigation.value?.focus()
}
function onKey(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.repeat) return
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault(); event.stopPropagation()
  void move(event.key === 'ArrowLeft' ? 'previous' : 'next')
}
</script>
<template>
  <div v-if="position.index >= 0 && position.total > 1" class="preview-navigation">
    <div ref="navigation" class="preview-navigation-controls" role="group" aria-label="媒体连续预览" tabindex="0" @keydown="onKey">
      <button type="button" :disabled="!position.previous" @click="move('previous')"><Icon name="chevron-right" class="previous-icon" :size="17" />上一项</button>
      <span role="status" aria-live="polite">{{ position.index + 1 }} / {{ position.total }}</span>
      <button type="button" :disabled="!position.next" @click="move('next')">下一项<Icon name="chevron-right" :size="17" /></button>
    </div>
    <p>仅当前已加载、筛选后的媒体；不会自动翻页或播放。聚焦切换区可用左右键。</p>
  </div>
</template>
<style scoped>
.preview-navigation{margin:0 0 16px}.preview-navigation-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;border-radius:10px}
.preview-navigation button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:9px 12px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-primary);color:var(--text-primary);font:inherit;font-size:12px;cursor:pointer}
.preview-navigation button:hover:not(:disabled){background:var(--bg-hover)}.preview-navigation button:disabled{opacity:.4;cursor:not-allowed}.preview-navigation :focus-visible{outline:2px solid var(--accent-color);outline-offset:2px}
.preview-navigation-controls:focus-visible{outline:2px solid var(--accent-color);outline-offset:3px}.preview-navigation span{font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}.preview-navigation p{margin:8px 0 0;color:var(--text-muted);font-size:11px;line-height:1.7}.previous-icon{transform:rotate(180deg)}
@media(max-width:440px){.preview-navigation-controls{gap:8px}.preview-navigation button{padding:8px}.preview-navigation p{font-size:11px}}
</style>
