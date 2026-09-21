<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { filesAction } from './filesApi'
const props = defineProps({ disabled: Boolean })
const emit = defineEmits(['choose', 'close'])
const path = ref(''), query = ref(''), search = ref(''), items = ref([]), cursor = ref(null), loading = ref(false), error = ref('')
const panel = ref(null), searchInput = ref(null)
const crumbs = computed(() => [{ name: '全部文件', path: '' }, ...path.value.split('/').filter(Boolean).map((name, i, parts) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))])
let sequence = 0, alive = true
async function load(next = path.value, more = false) {
  const turn = ++sequence; loading.value = true; error.value = ''
  if (!more) { path.value = next; items.value = []; cursor.value = null }
  try {
    const result = await filesAction('list', { path: path.value, query: query.value, cursor: more ? cursor.value : null })
    if (!alive || turn !== sequence) return
    items.value = [...items.value, ...result.entries]; cursor.value = result.hasMore ? result.cursor : null
  } catch { if (alive && turn === sequence) error.value = '无法读取个人文件库。请确认已登录绑定 Dropbox 的管理员账号，然后重试。' }
  finally { if (alive && turn === sequence) loading.value = false }
}
function navigate(next) { query.value = ''; search.value = ''; void load(next) }
function find() { query.value = search.value.trim(); void load() }
onMounted(async () => { await load(); await nextTick(); if (alive) { panel.value?.scrollIntoView({ block: 'nearest' }); searchInput.value?.focus({ preventScroll: true }) } })
onBeforeUnmount(() => { alive = false; sequence++ })
</script>
<template>
  <section ref="panel" class="note-file-picker" aria-label="选择 Dropbox 文件" :aria-busy="loading">
    <header><div><strong>从个人文件库插入</strong><p>插入私有文件引用，不公开分享、不复制原文件。图片与视频将在文件库中预览；共享笔记不会授予网盘权限。</p></div><button type="button" aria-label="关闭文件选择" @click="emit('close')"><Icon name="close" :size="18" /></button></header>
    <nav aria-label="Dropbox 文件路径"><button v-for="crumb in crumbs" :key="crumb.path" type="button" :disabled="loading || disabled" @click="navigate(crumb.path)">{{ crumb.name }}</button></nav>
    <div class="note-file-search"><input ref="searchInput" v-model="search" aria-label="搜索 Dropbox 文件" placeholder="搜索当前目录及子目录" :disabled="loading || disabled" @keydown.enter.prevent="find"><button type="button" :disabled="loading || disabled" @click="find">搜索</button></div>
    <p v-if="error" role="alert">{{ error }} <button type="button" :disabled="loading || disabled" @click="load()">重试</button></p>
    <p v-if="loading" role="status">正在读取…</p>
    <ul v-if="!error" aria-label="可插入文件"><li v-for="item in items" :key="item.id"><button type="button" :disabled="loading || disabled || item.mutable === false" @click="item.type === 'folder' ? navigate(item.path) : emit('choose', item)"><Icon :name="item.type === 'folder' ? 'folder' : 'note'" :size="18" /><span>{{ item.name }}<small v-if="query">{{ item.path }}</small></span><span class="note-file-action">{{ item.mutable === false ? '受保护' : item.type === 'folder' ? '打开' : '插入' }}</span></button></li></ul>
    <p v-if="!loading && !error && !items.length">{{ query ? '没有匹配的文件。' : '这个文件夹是空的。' }}</p>
    <button v-if="cursor" type="button" :disabled="loading || disabled" @click="load(path, true)">加载更多</button>
  </section>
</template>
<style scoped>
.note-file-picker{border:1px solid var(--border-color);border-radius:14px;padding:16px;background:var(--bg-primary);color:var(--text-primary);font-size:13px;margin-top:12px;min-width:0}.note-file-picker header{display:flex;align-items:flex-start;gap:12px}.note-file-picker header>div{flex:1;min-width:0}.note-file-picker p{font-size:12px;line-height:1.7;color:var(--text-secondary);margin:6px 0 12px}.note-file-picker button,.note-file-picker input{font:inherit;color:inherit;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:8px;min-height:40px;padding:8px 10px;box-sizing:border-box}.note-file-picker button{cursor:pointer}.note-file-picker button:disabled{opacity:.5;cursor:not-allowed}.note-file-picker :focus-visible{outline:2px solid var(--accent-color);outline-offset:2px}.note-file-picker nav{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.note-file-picker nav button{overflow-wrap:anywhere;max-width:100%}.note-file-search{display:flex;gap:8px}.note-file-search input{flex:1;min-width:0}.note-file-picker ul{list-style:none;margin:12px 0 0;padding:0;max-height:260px;overflow:auto}.note-file-picker li button{display:flex;align-items:center;gap:10px;border:0;border-radius:8px;width:100%;text-align:left;min-height:48px}.note-file-picker li button:hover{background:var(--bg-hover)}.note-file-picker li button>span:first-of-type{flex:1;min-width:0;overflow-wrap:anywhere}.note-file-picker small{display:block;color:var(--text-muted);font-size:11px}.note-file-action{color:var(--accent-color);font-size:12px;white-space:nowrap}
</style>
