<script setup>
import { ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
defineProps({ modelValue: { type: String, default: '' }, label: String, visible: Number, total: Number })
const emit = defineEmits(['update:modelValue'])
const input = ref(null)
function clear() { emit('update:modelValue', ''); input.value?.focus() }
</script>
<template>
  <div class="task-search">
    <label class="task-search-field"><Icon name="search" :size="16" /><input ref="input" type="search" :aria-label="label" :value="modelValue" maxlength="160" autocomplete="off" placeholder="按文件名或目标路径查找" @input="emit('update:modelValue', $event.target.value)"></label>
    <button v-if="modelValue" type="button" :aria-label="'清空' + label" @click="clear"><Icon name="close" :size="16" /></button>
    <p role="status">显示 {{ visible }} / {{ total }} 项 · 仅筛选已加载任务，不影响任务运行</p>
  </div>
</template>
<style scoped>
.task-search{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.task-search-field{display:flex;align-items:center;gap:9px;flex:1;min-width:0;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-secondary);color:var(--text-muted);padding:0 12px}
.task-search-field:focus-within{outline:2px solid var(--accent-color);outline-offset:2px}.task-search-field svg{flex-shrink:0}.task-search input{min-width:0;width:100%;min-height:44px;border:0!important;outline:0!important;background:transparent!important;color:var(--text-primary);font:inherit;font-size:13px;padding:8px 0!important;box-sizing:border-box}
.task-search button{width:44px;min-height:44px;padding:8px;display:grid;place-items:center;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-primary);color:var(--text-secondary);cursor:pointer;flex-shrink:0}.task-search button:focus-visible{outline:2px solid var(--accent-color);outline-offset:2px}.task-search p{flex-basis:100%;font-size:11px;color:var(--text-secondary);line-height:1.7;margin:0}
</style>
