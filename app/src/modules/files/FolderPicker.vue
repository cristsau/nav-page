<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { filesAction } from './filesApi'
const props = defineProps({ excluded: { type: Array, default: () => [] } })
const emit = defineEmits(['choose'])
const path = ref(''), folders = ref([]), cursor = ref(null), loading = ref(false), error = ref('')
const crumbs = computed(() => [{ name: '全部文件', path: '' }, ...path.value.split('/').filter(Boolean).map((name, i, parts) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))])
let sequence = 0, alive = true
const excluded = p => props.excluded.some(source => p.toLowerCase() === source.toLowerCase() || p.toLowerCase().startsWith(source.toLowerCase() + '/'))
async function load(next = '', more = false) {
  const turn = ++sequence; loading.value = true; error.value = ''; emit('choose', null)
  if (!more) { path.value = next; folders.value = []; cursor.value = null }
  try {
    const result = await filesAction('list', { path: path.value, cursor: more ? cursor.value : null })
    if (!alive || turn !== sequence) return
    folders.value = [...folders.value, ...result.entries.filter(item => item.type === 'folder')]
    cursor.value = result.hasMore ? result.cursor : null; emit('choose', path.value)
  } catch { if (alive && turn === sequence) error.value = '目录读取失败，请重试。' }
  finally { if (alive && turn === sequence) loading.value = false }
}
onMounted(() => load())
onBeforeUnmount(() => { alive = false; sequence++ })
</script>
<template>
  <div class="folder-picker" :aria-busy="loading">
    <nav aria-label="目标文件夹路径"><button v-for="crumb in crumbs" :key="crumb.path" type="button" :disabled="loading" @click="load(crumb.path)">{{ crumb.name }}</button></nav>
    <p class="destination">目标文件夹：{{ path || '全部文件（根目录）' }}</p>
    <p v-if="error" role="alert">{{ error }} <button @click="load(path)">重试</button></p>
    <p v-if="loading" role="status">正在读取目录…</p>
    <ul aria-label="目标文件夹列表"><li v-for="folder in folders" :key="folder.id"><button type="button" :disabled="loading || excluded(folder.path)" @click="load(folder.path)"><Icon name="folder" :size="18" /><span>{{ folder.name }}</span><Icon name="chevron-right" :size="14" /></button></li></ul>
    <p v-if="!loading && !error && !folders.length">没有可进入的子文件夹，可选择当前目录。</p>
    <button v-if="cursor" type="button" :disabled="loading" @click="load(path, true)">加载更多目录</button>
  </div>
</template>
<style scoped>
.folder-picker{border:1px solid var(--border-color);border-radius:12px;padding:12px;font-size:13px;min-width:0}.folder-picker nav{display:flex;gap:6px;flex-wrap:wrap}.folder-picker button{font:inherit;color:var(--text-primary);border:1px solid var(--border-color);background:var(--bg-primary);border-radius:8px;padding:9px 12px;cursor:pointer;max-width:100%;overflow-wrap:anywhere;text-align:left}.folder-picker button:disabled{opacity:.45;cursor:not-allowed}.folder-picker button:focus-visible{outline:2px solid var(--accent-color);outline-offset:2px}.folder-picker ul{list-style:none;padding:0;margin:8px 0;max-height:220px;overflow:auto}.folder-picker li button{display:flex;width:100%;align-items:center;gap:9px;border:0;min-height:44px}.folder-picker li span{flex:1;min-width:0;overflow-wrap:anywhere}.folder-picker li button:hover{background:var(--bg-hover)}.folder-picker p{color:var(--text-secondary);line-height:1.7;overflow-wrap:anywhere;margin:10px 0}.destination{font-weight:550}
</style>
