<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import FolderPicker from './FolderPicker.vue'
import { filesAction, deletedContentUrl } from './filesApi'
const props = defineProps({ directory: { type: String, default: '' } })
const emit = defineEmits(['busy', 'recovered'])
const path = ref(props.directory), entries = ref([]), cursor = ref(null), busy = ref(false), error = ref(''), notice = ref('')
const history = ref(null), chosen = ref(null), name = ref(''), attempted = ref(false), selecting = ref(false), folder = ref(null)
let alive = true
function setBusy(value) { busy.value = value; emit('busy', value) }
const message = e => typeof e?.payload?.error === 'string' ? e.payload.error : '读取未完成。文件夹、已过恢复期限或被其他设备修改的记录，请在 Dropbox 官方回收站处理。'
const size = n => n < 1048576 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`
async function load(more = false) {
  setBusy(true); error.value = ''; history.value = null; chosen.value = null
  if (!more) { entries.value = []; cursor.value = null }
  try {
    const result = await filesAction('deleted/list', { path: path.value, cursor: more ? cursor.value : null })
    if (!alive) return
    entries.value = [...new Map([...entries.value, ...result.entries].map(item => [item.path, item])).values()]
    cursor.value = result.hasMore ? result.cursor : null
  } catch (e) { if (alive) error.value = message(e) }
  finally { if (alive) setBusy(false) }
}
async function inspect(item) {
  setBusy(true); error.value = ''; notice.value = ''; history.value = null; chosen.value = null
  try { const result = await filesAction('deleted/history', { path: item.path }); if (alive) history.value = result }
  catch (e) { if (alive) error.value = message(e) }
  finally { if (alive) setBusy(false) }
}
function choose(item) {
  chosen.value = item; attempted.value = false; error.value = ''
  const dot = item.name.lastIndexOf('.')
  name.value = dot > 0 ? `${item.name.slice(0, dot)}-找回${item.name.slice(dot)}` : `${item.name}-找回`
}
async function recover() {
  if (busy.value || attempted.value || !chosen.value) return
  if (!name.value || name.value !== name.value.trim() || /[\x00-\x1f\x7f/\\]/.test(name.value) || ['.', '..'].includes(name.value)
    || name.value.toLowerCase() === history.value.deleted.name.toLowerCase()) { error.value = '请使用新的副本名称，不含斜杠或首尾空格。'; return }
  setBusy(true); error.value = ''; attempted.value = true
  try {
    const source = history.value.deleted.path
    await filesAction('deleted/copy', { path: source, rev: chosen.value.rev, destination: source.slice(0, source.lastIndexOf('/') + 1) + name.value })
    if (alive) { notice.value = '已找回为同目录的新副本，未覆盖其他文件。'; chosen.value = null; emit('recovered') }
  } catch (e) { if (alive) error.value = `${message(e)} 请先检查目录，不会自动重复提交。` }
  finally { if (alive) setBusy(false) }
}
onMounted(() => load())
onBeforeUnmount(() => { alive = false; emit('busy', false) })
</script>
<template>
  <section class="deleted-files" :aria-busy="busy">
    <p class="explanation">仅列当前目录的已删除记录，不扫描整个网盘。文件夹或过期记录请到官方回收站；这里没有永久删除功能。</p>
    <div class="location"><strong>{{ path || '全部文件（根目录）' }}</strong><button :disabled="busy" @click="selecting = !selecting">选择目录</button><button :disabled="busy" @click="load()" aria-label="刷新已删除记录"><Icon name="refresh" :size="16" /></button></div>
    <div v-if="selecting" class="folder-selection"><FolderPicker @choose="folder = $event" /><button :disabled="busy || folder === null" @click="path = folder; selecting = false; load()">查看该目录</button></div>
    <p v-if="busy" role="status">正在核对记录…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="notice" class="success" role="status">{{ notice }}</p>
    <ul aria-label="已删除记录"><li v-for="item in entries" :key="item.path"><span><strong>{{ item.name }}</strong><small>{{ item.path }}</small></span><button :disabled="busy" @click="inspect(item)">查看可用版本</button></li></ul>
    <p v-if="!busy && !entries.length && !error" class="explanation">本页没有可显示的删除记录<span v-if="cursor">，可继续加载后面的记录</span>。这不代表整个网盘回收站为空。</p>
    <button v-if="cursor" :disabled="busy" @click="load(true)">继续加载记录</button>
    <div v-if="history" class="versions"><h3>{{ history.deleted.name }} · 可用版本</h3><p class="explanation">最多 20 个版本。下载不修改云端；20 MB 内可另存新副本。找回范围以 Dropbox 实际保留的版本为准。</p>
      <ul aria-label="已删除文件版本"><li v-for="item in history.entries" :key="item.rev"><span>{{ new Date(item.modified).toLocaleString('zh-CN') }}<small>{{ size(item.size) }} · {{ item.rev }}</small></span><div class="actions"><a v-if="item.downloadable" :href="deletedContentUrl(item.downloadToken)" target="_blank" rel="noopener noreferrer">下载版本</a><button v-if="item.downloadable && item.size <= history.recoveryLimit" :disabled="busy" @click="choose(item)">找回副本</button></div></li></ul>
      <p v-if="!history.entries.length">没有可用的文件版本，请在官方页面检查。</p>
    </div>
    <form v-if="chosen" @submit.prevent="recover"><label for="deleted-copy-name">找回后的新文件名</label><input id="deleted-copy-name" v-model="name" maxlength="512" :disabled="busy || attempted"><p class="explanation">保存在原目录，不覆盖同名文件。结果不明确时先检查目录。</p><button class="primary" :disabled="busy || attempted || !name">确认找回新副本</button></form>
    <a class="official" href="https://www.dropbox.com/deleted_files" target="_blank" rel="noopener noreferrer">打开 Dropbox 官方回收站 <Icon name="external-link" :size="15" /></a>
  </section>
</template>
<style scoped>
.deleted-files{display:grid;gap:16px;color:var(--text-primary);font-size:14px}.explanation,small{color:var(--text-secondary);line-height:1.65}.location,.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.location strong{flex:1;min-width:120px;overflow-wrap:anywhere}.deleted-files button,.deleted-files a:not(.official){display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;padding:9px 13px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:12px;font:inherit;text-decoration:none;cursor:pointer}.deleted-files button:disabled{opacity:.5;cursor:not-allowed}.deleted-files :is(button,a,input):focus-visible{outline:2px solid var(--accent-color);outline-offset:3px}.deleted-files ul{list-style:none;margin:0;padding:0}.deleted-files li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid var(--border-color)}.deleted-files li>span{min-width:0;overflow-wrap:anywhere}.deleted-files small{display:block;font-size:12px}.deleted-files h3{font-size:16px;margin:0 0 10px}.versions,.folder-selection,form{border:1px solid var(--border-color);padding:16px;border-radius:16px}.deleted-files form{display:grid;gap:12px}.deleted-files input{width:100%;min-width:0;box-sizing:border-box;padding:12px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-primary);color:inherit;font:inherit}.deleted-files .primary{background:var(--accent-color);color:white}.official{color:var(--text-secondary);display:inline-flex;gap:8px;align-items:center}.error{color:var(--error-color,#a84444)}.success{color:var(--success-color,#40785a)}@media(max-width:440px){.deleted-files li{align-items:flex-start;flex-direction:column}.actions{width:100%}.versions,form{padding:12px}}
</style>
