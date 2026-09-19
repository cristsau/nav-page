<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import Modal from '@/shared/components/Modal.vue'
import { registerReloadGuard } from '@/shared/services/reloadGuards'
import { contentUrl, filesAction, filesStatus, uploadChunk } from './filesApi'
import { FileTransferQueue } from './fileTransfers'
import FolderPicker from './FolderPicker.vue'
import { planFolderUpload } from './folderUploads'
import { fileFilters, fileSorts, fileTypeLabel, presentFiles, hasFileDrag, droppedFiles } from './filePresentation'

const status = ref(null), entries = ref([]), path = ref(''), search = ref(''), query = ref('')
const loading = ref(false), working = ref(false), error = ref(''), notice = ref(''), cursor = ref(null)
const dialog = ref(''), selected = ref(null), value = ref(''), dialogError = ref(''), mediaFailed = ref(false)
const content = ref(''), original = ref(''), textRev = ref(''), discard = ref(false), picker = ref(null)
const selection = ref(false), checked = ref([]), batchItems = ref([]), plans = ref([]), results = ref([]), destination = ref(null), jobs = ref([])
const lastBatchMode = ref('')
const filter = ref('all'), sort = ref('name-asc'), layout = ref('list'), dropActive = ref(false), surface = ref(null)
const pendingDrop = ref([]), dropDirectory = ref(''), copied = ref('')
const folderPicker = ref(null), folderPlan = ref(null), folderAttempted = ref(false)
const history = ref(null), historyChoice = ref(null), recoveryName = ref(''), recoveryAttempted = ref(false)
const dropBytes = computed(() => pendingDrop.value.reduce((sum, file) => sum + file.size, 0))
const selectable = computed(() => sorted.value.filter(item => item.mutable !== false))
const chosen = computed(() => entries.value.filter(item => checked.value.includes(item.id) && item.mutable !== false))
const excludedFolders = computed(() => batchItems.value.filter(item => item.type === 'folder').map(item => item.path))
const pendingUploads = computed(() => jobs.value.some(job => ['queued', 'uploading', 'paused', 'error'].includes(job.state)))
let transfers = null
const uploadStates = { queued: '等待上传', uploading: '上传中', paused: '已暂停', error: '等待重试', complete: '上传完成', cancelled: '已取消', review: '请核对云端结果' }
let alive = true, loadSequence = 0
const dirty = computed(() => dialog.value === 'edit' && content.value !== original.value)
const byteLength = computed(() => new TextEncoder().encode(content.value).length)
const crumbs = computed(() => [{ name: '全部文件', path: '' }, ...path.value.split('/').filter(Boolean).map((name, index, parts) => ({ name, path: '/' + parts.slice(0, index + 1).join('/') }))])
const sorted = computed(() => presentFiles(entries.value, filter.value, sort.value))
const titles = computed(() => ({ preview: selected.value?.name, history: '历史版本', directory: '确认上传文件夹', details: '文件详情', drop: '确认上传', edit: '编辑文本', manage: '管理文件', rename: '重命名', move: '移动到文件夹', copy: '复制到文件夹', delete: '确认删除', results: '操作结果', folder: '新建文件夹' }[dialog.value] || '文件'))
const iconName = item => item.type === 'folder' ? 'folder' : item.kind === 'image' ? 'image' : ['video', 'audio'].includes(item.kind) ? 'play' : 'note'
const official = computed(() => {
  try { const u = new URL(selected.value?.officialUrl); return u.origin === 'https://www.dropbox.com' && !u.username && !u.password ? u.href : null } catch { return null }
})
function bytes(n) { return n === undefined ? '文件夹' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB` }
function date(n) { return n ? new Date(n).toLocaleDateString('zh-CN') : '—' }
function exactDate(n) { return n && Number.isFinite(Date.parse(n)) ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '未提供' }
function changeFilter(next) { filter.value = next; checked.value = [] }
async function copyDetail(field) {
  const item = selected.value
  if (!item || !['name', 'path'].includes(field)) return
  copied.value = ''; dialogError.value = ''
  try {
    await navigator.clipboard.writeText(item[field])
    if (alive && selected.value?.id === item.id && dialog.value === 'details') copied.value = field === 'name' ? '已复制名称' : '已复制路径'
  } catch { if (alive && selected.value?.id === item.id && dialog.value === 'details') dialogError.value = '浏览器未允许复制，请选中下方文字手动复制。' }
}
function message(e) {
  if (e?.status === 401) return '登录已失效，请重新登录。'
  if (e?.status === 403) return e.code === 'BACKUP_PROTECTED' ? '备份目录受保护，不允许此操作。' : '此文件库仅限绑定的管理员本人访问。'
  if (e?.code === 'NOT_CONNECTED') return '文件库尚未接通服务器。完成独立授权并配置连接后，即可在这里管理文件。'
  return typeof e?.payload?.error === 'string' && e.payload.error.length < 200 ? e.payload.error : '操作未完成，请检查网络并刷新核对状态。'
}
function childPath(name) {
  if (!name || name !== name.trim() || /[\x00-\x1f\x7f/\\]/.test(name) || ['.', '..'].includes(name)) throw new Error('请输入有效名称，不含斜杠或首尾空格。')
  return `${path.value}/${name}`
}
async function loadEntries(more = false) {
  const sequence = ++loadSequence
  loading.value = true; error.value = ''
  if (!more) { entries.value = []; cursor.value = null; checked.value = [] }
  try {
    const result = await filesAction('list', { path: path.value, query: query.value, cursor: more ? cursor.value : null })
    if (!alive || sequence !== loadSequence) return
    const merged = more ? [...entries.value, ...result.entries] : result.entries
    entries.value = [...new Map(merged.map(item => [item.id, item])).values()]
    cursor.value = result.hasMore ? result.cursor : null
  } catch (e) { if (alive && sequence === loadSequence) error.value = message(e) }
  finally { if (alive && sequence === loadSequence) loading.value = false }
}
async function connect() {
  loading.value = true; error.value = ''
  try {
    const result = await filesStatus(); if (!alive) return; status.value = result
    if (!transfers) transfers = new FileTransferQueue({ action: filesAction, chunk: uploadChunk, limit: result.uploadLimit, chunkSize: result.chunkSize,
      errorText: message, changed: next => { jobs.value = next } })
    await loadEntries()
  }
  catch (e) { if (alive) { status.value = null; entries.value = []; error.value = message(e) } }
  finally { if (alive) loading.value = false }
}
function navigate(next) {
  if (loading.value || working.value) return
  path.value = next; search.value = ''; query.value = ''; notice.value = ''; changeFilter('all'); loadEntries()
}
function runSearch() { if (!loading.value && !working.value) { query.value = search.value.trim(); loadEntries() } }
function open(mode, item = null) {
  if (working.value) return
  if (['delete', 'move', 'copy'].includes(mode)) { void beginBatch(mode, item ? [item] : chosen.value); return }
  selected.value = item; dialog.value = mode; value.value = ''; dialogError.value = ''; discard.value = false; mediaFailed.value = false; copied.value = ''
  if (mode === 'rename') value.value = item.name
  if (mode === 'move') value.value = item.path
}
function toggleAll() {
  if (checked.value.length) checked.value = []
  else checked.value = selectable.value.slice(0, 50).map(item => item.id)
}
function toggleItem(item) {
  if (checked.value.includes(item.id)) checked.value = checked.value.filter(id => id !== item.id)
  else if (checked.value.length < 50) checked.value.push(item.id)
  else notice.value = '一次最多选择 50 项，请分批操作。'
}
async function beginBatch(mode, items) {
  if (working.value || !items.length || items.length > 50) return
  // A selected folder already covers selected descendants in recursive search results.
  const roots = items.filter(item => !items.some(parent => parent.id !== item.id && parent.type === 'folder' && item.path.toLowerCase().startsWith(parent.path.toLowerCase() + '/')))
  items = roots
  selected.value = null; batchItems.value = [...items]; plans.value = []; results.value = []; destination.value = null; dialogError.value = ''; dialog.value = mode
  lastBatchMode.value = mode
  if (mode !== 'delete') return
  working.value = true
  try {
    for (const item of items) {
      try { plans.value.push(await filesAction('delete/preview', { id: item.id })) }
      catch (e) { results.value.push({ item, ok: false, error: message(e) }) }
    }
  } finally { if (alive) working.value = false }
}
async function batchMutate() {
  const mode = dialog.value
  if (working.value || !['delete', 'move', 'copy'].includes(mode) || (mode !== 'delete' && destination.value === null)) return
  working.value = true; dialogError.value = ''
  const targets = mode === 'delete' ? plans.value.map(p => ({ ...p.item, token: p.token })) : [...batchItems.value]
  try {
    for (const item of targets) {
      try {
        await filesAction(mode, mode === 'delete' ? { id: item.id, token: item.token } : { id: item.id, destination: `${destination.value}/${item.name}` })
        results.value.push({ item, ok: true })
      } catch (e) { results.value.push({ item, ok: false, error: message(e) }) }
    }
    notice.value = `${results.value.filter(r => r.ok).length} 项成功，${results.value.filter(r => !r.ok).length} 项未完成。`
    dialog.value = 'results'; await loadEntries()
  } finally { if (alive) working.value = false }
}
function openItem(item) { if (item.type === 'folder') navigate(item.path); else open('preview', item) }
function openManaged() { const item = selected.value; close(); if (item) openItem(item) }
function close(force = false) {
  if (working.value) return
  if (dirty.value && !force) { discard.value = true; return }
  dialog.value = ''; selected.value = null; content.value = ''; original.value = ''; textRev.value = ''; discard.value = false; dialogError.value = ''; pendingDrop.value = []; copied.value = ''
}
async function edit() {
  working.value = true; dialogError.value = ''
  try {
    const result = await filesAction('text/read', { id: selected.value.id })
    if (!alive) return
    selected.value = { ...selected.value, ...result.item }; textRev.value = result.item.rev
    content.value = result.content; original.value = result.content; dialog.value = 'edit'
  } catch (e) { if (alive) dialogError.value = message(e) }
  finally { if (alive) working.value = false }
}
async function save() {
  if (!dirty.value || working.value || byteLength.value > status.value.textLimit) return
  working.value = true; dialogError.value = ''; discard.value = false
  try {
    const result = await filesAction('text/save', { id: selected.value.id, rev: textRev.value, content: content.value })
    if (!alive) return
    textRev.value = result.item.rev; selected.value = { ...selected.value, ...result.item }; original.value = content.value
    notice.value = '已保存到 Dropbox'; await loadEntries()
  } catch (e) { if (alive) dialogError.value = e?.status === 409 ? '保存未覆盖：文件已变化或发生冲突。当前草稿仍保留，请先复制草稿，再关闭并重新读取文件。' : message(e) }
  finally { if (alive) working.value = false }
}
async function mutate() {
  if (working.value) return
  dialogError.value = ''
  let action, payload
  try {
    if (dialog.value === 'folder') { action = 'folder'; payload = { path: childPath(value.value) } }
    if (dialog.value === 'rename') {
      childPath(value.value)
      action = 'move'; payload = { id: selected.value.id, destination: selected.value.path.slice(0, selected.value.path.lastIndexOf('/') + 1) + value.value }
    }
  } catch (e) { dialogError.value = e.message; return }
  if (!action) return
  working.value = true
  try {
    await filesAction(action, payload)
    if (!alive) return
    dialog.value = ''; selected.value = null; notice.value = action === 'delete' ? '文件已删除，可在 Dropbox 的已删除文件中查看恢复选项。' : '操作已完成'
    await loadEntries()
  } catch (e) { if (alive) dialogError.value = message(e) }
  finally { if (alive) working.value = false }
}
function upload(event) {
  const files = Array.from(event.target.files || []); event.target.value = ''
  if (!files.length || working.value || !transfers) return
  error.value = ''; notice.value = ''
  try { transfers.add(files, path.value) } catch (e) { error.value = e.message }
}
function chooseFolder(event) {
  const files = Array.from(event.target.files || []); event.target.value = ''
  if (!files.length || working.value || !transfers) return
  error.value = ''; notice.value = ''
  try {
    const plan = planFolderUpload(files, path.value, status.value.uploadLimit)
    if (jobs.value.length + files.length > 100) throw Error('上传队列空间不足，请先清理完成记录。')
    open('directory'); pendingDrop.value = files; dropDirectory.value = path.value; folderPlan.value = plan; folderAttempted.value = false
  } catch (e) { error.value = e.message }
}
async function confirmFolder() {
  if (working.value || folderAttempted.value || !folderPlan.value || !pendingDrop.value.length) return
  working.value = true; folderAttempted.value = true; dialogError.value = ''; let created = 0
  try {
    for (const directory of folderPlan.value.directories) {
      const result = await filesAction('folder', { path: directory })
      if (result.item?.path !== directory || result.item?.type !== 'folder') throw Error('目录回执需要核对。')
      created++
    }
    transfers.add(pendingDrop.value, dropDirectory.value, folderPlan.value.paths)
    dialog.value = ''; pendingDrop.value = []; folderPlan.value = null; notice.value = '文件夹已创建，文件已加入上传队列。'; await loadEntries()
  } catch (e) {
    dialogError.value = `已确认创建 ${created} 个目录；文件尚未加入队列。${message(e)} 请关闭后刷新核对，不会自动删除已创建目录或重复提交。`
  } finally { if (alive) working.value = false }
}
async function showHistory() {
  if (working.value) return
  dialog.value = 'history'; working.value = true; dialogError.value = ''; history.value = null; historyChoice.value = null; recoveryAttempted.value = false
  try { history.value = await filesAction('history', { id: selected.value.id }) }
  catch (e) { dialogError.value = message(e) }
  finally { if (alive) working.value = false }
}
function selectRevision(item) {
  historyChoice.value = item; recoveryAttempted.value = false; dialogError.value = ''
  const name = history.value.current.name, dot = name.lastIndexOf('.')
  recoveryName.value = dot > 0 ? `${name.slice(0, dot)}-恢复-${item.rev.slice(-8)}${name.slice(dot)}` : `${name}-恢复-${item.rev.slice(-8)}`
}
async function recoverVersion() {
  if (working.value || recoveryAttempted.value || !historyChoice.value) return
  const current = history.value.current
  try { childPath(recoveryName.value) } catch (e) { dialogError.value = e.message; return }
  working.value = true; recoveryAttempted.value = true; dialogError.value = ''
  try {
    await filesAction('history/copy', { id: current.id, rev: historyChoice.value.rev, destination: current.path.slice(0, current.path.lastIndexOf('/') + 1) + recoveryName.value })
    dialog.value = ''; selected.value = null; notice.value = '历史版本已另存为新文件，原文件未覆盖。'; await loadEntries()
  } catch (e) { dialogError.value = `${message(e)} 请先刷新目录核对是否已另存成功，不会自动重复提交。` }
  finally { if (alive) working.value = false }
}
function dragOver(event) {
  if (!hasFileDrag(event.dataTransfer)) return
  event.preventDefault()
  const allowed = status.value && !loading.value && !working.value && !dialog.value && surface.value?.contains(event.target)
  event.dataTransfer.dropEffect = allowed ? 'copy' : 'none'
  dropActive.value = Boolean(allowed)
}
function dragLeave(event) { if (!event.relatedTarget || !surface.value?.contains(event.relatedTarget)) dropActive.value = false }
function drop(event) {
  dropActive.value = false
  if (!hasFileDrag(event.dataTransfer)) return
  event.preventDefault()
  // Also cancel browser file navigation outside the drop area, without touching editor drafts.
  if (!status.value || loading.value || working.value || dialog.value || !surface.value?.contains(event.target)) return
  error.value = ''; notice.value = ''
  try {
    const files = droppedFiles(event.dataTransfer)
    if (files.some(file => file.size > status.value.uploadLimit)) throw Error('包含超过单文件上传上限的文件，本次未加入队列。')
    open('drop'); pendingDrop.value = files; dropDirectory.value = path.value
  } catch (e) { error.value = e.message }
}
function confirmDrop() {
  if (dialog.value !== 'drop' || !transfers || !pendingDrop.value.length || working.value) return
  try { transfers.add(pendingDrop.value, dropDirectory.value); close() }
  catch (e) { dialogError.value = e.message }
}
const unregister = registerReloadGuard(() => dirty.value || working.value || pendingUploads.value ? '请先保存文件，或完成/取消上传任务。' : '')
function beforeUnload(event) { if (dirty.value || working.value || pendingUploads.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(() => { if (dirty.value || working.value || pendingUploads.value) { if (dirty.value) discard.value = true; notice.value = '请先保存文件，或完成/取消上传任务后再离开。'; return false } return true })
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); window.addEventListener('dragover', dragOver); window.addEventListener('drop', drop); window.addEventListener('dragleave', dragLeave); connect() })
onBeforeUnmount(() => { alive = false; loadSequence++; transfers?.dispose(); content.value = ''; original.value = ''; pendingDrop.value = []; unregister(); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('dragover', dragOver); window.removeEventListener('drop', drop); window.removeEventListener('dragleave', dragLeave) })
</script>

<template>
  <main class="drive-page">
    <header class="drive-heading">
      <div><p class="drive-eyebrow">PERSONAL CLOUD · DROPBOX</p><h1>文件库</h1><p class="drive-subtitle">你的文件，随时打开。只向绑定的管理员本人开放。</p></div>
      <a class="drive-button" href="https://www.dropbox.com/home" target="_blank" rel="noopener noreferrer">打开 Dropbox <Icon name="external-link" :size="15" /></a>
    </header>
    <div class="drive-protection"><Icon name="lock" :size="16" /><span>NAV 加密备份目录受保护，与日常文件管理分开。</span><router-link to="/settings?section=cloud-backup">备份设置</router-link></div>
    <section ref="surface" class="drive-surface" :class="{ 'drive-drop-active': dropActive }" aria-label="Dropbox 文件" :aria-busy="loading || working">
      <div v-if="dropActive" class="drive-drop-overlay" role="status"><Icon name="upload" :size="32" /><strong>松开后确认上传</strong><span>目标：{{ path || '全部文件（根目录）' }}</span></div>
      <div class="drive-toolbar">
        <form class="drive-search" @submit.prevent="runSearch"><Icon name="search" :size="18" /><input v-model="search" aria-label="搜索文件名" placeholder="搜索当前目录及子目录中的文件名" maxlength="200" :disabled="!status || working"><button class="drive-button drive-small" :disabled="!status || loading || working">搜索</button></form>
        <div class="drive-actions"><button class="drive-button" type="button" :disabled="!status || loading || working" @click="open('folder')"><Icon name="folder" :size="17" />新建文件夹</button><button class="drive-button drive-primary" type="button" :disabled="!status || loading || working" @click="picker.click()"><Icon name="upload" :size="17" />上传文件</button><button class="drive-button" type="button" :disabled="!status || loading || working" @click="folderPicker.click()"><Icon name="folder" :size="17" />上传文件夹</button><input ref="folderPicker" class="drive-hidden" type="file" webkitdirectory multiple aria-label="选择上传文件夹" @change="chooseFolder"><input ref="picker" class="drive-hidden" type="file" multiple aria-label="选择上传文件" @change="upload"></div>
      </div>
      <div class="drive-location"><nav aria-label="文件路径"><template v-for="(crumb, index) in crumbs" :key="crumb.path"><Icon v-if="index" name="chevron-right" :size="13" /><button type="button" :aria-current="index === crumbs.length - 1 ? 'location' : undefined" :disabled="loading || working || !status" @click="navigate(crumb.path)">{{ crumb.name }}</button></template></nav><button class="drive-button drive-small" type="button" :disabled="loading || working" aria-label="刷新文件列表" @click="connect"><Icon name="refresh" :size="15" /></button></div>
      <p v-if="query" class="drive-query">搜索“{{ query }}”<button class="drive-button drive-small" type="button" :disabled="loading || working" @click="search = ''; runSearch()">清除搜索</button></p>
      <div v-if="status" class="drive-view-options">
        <label>类型<select :value="filter" :disabled="working || loading" aria-label="文件类型筛选" @change="changeFilter($event.target.value)"><option v-for="[key, label] in fileFilters" :key="key" :value="key">{{ label }}</option></select></label>
        <label>排序<select v-model="sort" :disabled="working || loading" aria-label="文件排序"><option v-for="[key, label] in fileSorts" :key="key" :value="key">{{ label }}</option></select></label>
        <div class="drive-view-switch" role="group" aria-label="显示方式"><button class="drive-button drive-small" :aria-pressed="layout === 'list'" @click="layout = 'list'">列表</button><button class="drive-button drive-small" :aria-pressed="layout === 'grid'" @click="layout = 'grid'">网格</button></div>
        <p>排序与筛选仅针对已加载项目<span v-if="cursor">，可继续加载更多</span>。<span class="drive-drop-hint">可拖入文件，确认后上传到当前目录。</span></p>
      </div>
      <div v-if="error" class="drive-feedback drive-error" role="alert"><Icon name="alert" :size="18" /><span>{{ error }}</span></div>
      <p v-if="notice" class="drive-feedback" role="status">{{ notice }}</p>
      <section v-if="jobs.length" class="drive-transfers" aria-label="上传队列">
        <header><strong>上传队列</strong><button class="drive-button drive-small" @click="transfers.clearFinished()">清理完成记录</button></header>
        <p>单文件最高 50 GB · 每块 8 MB · 暂停/继续在本页有效。关闭或刷新页面、服务器重启后需重新选择上传；手机切到后台可能暂停。</p>
        <ul><li v-for="job in jobs" :key="job.id"><div class="drive-transfer-title"><strong :title="job.name">{{ job.name }}</strong><span>{{ job.pause && job.state === 'uploading' ? '正在暂停…' : job.cancel && job.state === 'uploading' ? '正在取消…' : uploadStates[job.state] }}</span></div><progress :value="job.offset" :max="job.size || 1" :aria-label="`${job.name} 上传进度`" /><div class="drive-transfer-meta"><span>{{ bytes(job.offset) }} / {{ bytes(job.size) }}<template v-if="job.state === 'uploading' && job.rate"> · {{ bytes(job.rate) }}/s · 约 {{ Math.ceil((job.size - job.offset) / job.rate) }} 秒</template></span><div><button v-if="['queued', 'uploading'].includes(job.state)" class="drive-button drive-small" :disabled="job.pause || job.cancel" @click="transfers.pause(job.id)">暂停</button><button v-if="['paused', 'error'].includes(job.state)" class="drive-button drive-small" @click="transfers.resume(job.id)">{{ job.state === 'error' ? '重试' : '继续' }}</button><button v-if="['queued', 'uploading', 'paused', 'error'].includes(job.state)" class="drive-button drive-small" :disabled="job.cancel" @click="transfers.cancel(job.id)">取消上传</button></div></div><p v-if="job.error" role="alert">{{ job.error }}</p></li></ul>
        <button class="drive-button drive-small" :disabled="loading || working" @click="loadEntries()">刷新查看已上传文件</button>
      </section>
      <div v-if="status" class="drive-selection-toggle"><button class="drive-button drive-small" :disabled="working || loading" @click="selection = !selection; checked = []">{{ selection ? '结束选择' : '选择文件' }}</button><span v-if="selection">仅选择已显示项目，一次最多 50 项</span></div>
      <div v-if="selection" class="drive-batch-bar" aria-label="批量文件操作"><button class="drive-button drive-small" :disabled="loading || working" @click="toggleAll">{{ checked.length ? '取消选择' : '选择已显示（最多50项）' }}</button><strong>已选 {{ checked.length }} 项</strong><div><button class="drive-button drive-small" :disabled="!chosen.length || working" @click="open('move')">移动</button><button class="drive-button drive-small" :disabled="!chosen.length || working" @click="open('copy')">复制</button><button class="drive-button drive-small drive-danger" :disabled="!chosen.length || working" @click="open('delete')">删除</button></div></div>
      <div v-if="!status && !loading" class="drive-empty"><Icon name="cloud" :size="36" /><h2>连接你的个人文件库</h2><p>文件管理使用独立的 Full Dropbox 授权，不会复用备份凭据。</p><button class="drive-button" type="button" @click="connect">重新检查连接</button></div>
      <template v-else>
        <div v-if="layout === 'list'" class="drive-table-head" :class="{ 'drive-selecting': selection }" aria-hidden="true"><span v-if="selection"></span><span>名称</span><span>大小</span><span>修改日期</span><span>操作</span></div>
        <ul class="drive-list" :class="{ 'drive-grid': layout === 'grid' }" aria-label="文件列表">
          <li v-for="item in sorted" :key="item.id" :data-kind="item.kind" :class="{ 'drive-selecting': selection, 'drive-row-checked': checked.includes(item.id) }">
            <label v-if="selection" class="drive-checkbox"><input type="checkbox" :checked="checked.includes(item.id)" :disabled="working || loading || item.mutable === false" :aria-label="`选择 ${item.name}`" @change="toggleItem(item)"></label>
            <button class="drive-file" type="button" :disabled="loading || working" @click="openItem(item)"><span class="drive-file-icon"><Icon :name="iconName(item)" :size="22" /></span><span class="drive-file-label"><strong>{{ item.name }}</strong><small v-if="query">{{ item.path }}</small><small v-else class="drive-mobile-meta">{{ bytes(item.size) }} · {{ date(item.modified) }}</small></span><Icon v-if="item.mutable === false" name="lock" :size="14" /></button>
            <span class="drive-desktop-meta">{{ bytes(item.size) }}</span><span class="drive-desktop-meta">{{ date(item.modified) }}</span>
            <button class="drive-button drive-small" type="button" :disabled="loading || working" :aria-label="`管理 ${item.name}`" @click="open('manage', item)"><Icon name="more-horizontal" :size="18" /></button>
          </li>
        </ul>
        <div v-if="loading" class="drive-empty drive-loading" role="status"><span class="drive-spinner" />正在读取文件…</div>
        <div v-else-if="!entries.length && !error" class="drive-empty"><Icon :name="query ? 'search' : 'folder'" :size="34" /><h2>{{ query ? '没有找到匹配的文件' : '这里还没有可显示的文件' }}</h2><p>{{ query ? '试试更短的文件名，或返回全部文件搜索。' : '可以上传文件或创建文件夹；受保护的备份内容不会出现在这里。' }}</p></div>
        <div v-else-if="!loading && !sorted.length && !error" class="drive-empty"><Icon name="search" :size="34" /><h2>已加载项目中没有此类型</h2><p>{{ cursor ? '还有未加载的项目，可点击下方“加载更多”继续查找。' : '试试其他类型，或清除筛选查看全部。' }}</p><button class="drive-button" @click="changeFilter('all')">清除类型筛选</button></div>
        <footer v-if="status" class="drive-list-footer"><span>显示 {{ sorted.length }} / 已加载 {{ entries.length }} 项<span v-if="cursor"> · 还有更多</span></span><button v-if="cursor" class="drive-button" :disabled="loading || working" @click="loadEntries(true)">加载更多</button><span>分块上传 ≤ {{ bytes(status.uploadLimit) }} / 文件</span></footer>
      </template>
    </section>
    <p class="drive-footnote">文件不保存到浏览器离线缓存。视频使用浏览器原生播放；不兼容的编码可下载或在 Dropbox 打开。</p>

    <Modal :show="Boolean(dialog)" :title="titles" :width="['preview', 'edit'].includes(dialog) ? '880px' : '520px'" :close-disabled="working" @close="close()">
      <div class="drive-dialog">
        <p v-if="selected" class="drive-item-path">{{ selected.path }}</p>
        <p v-if="dialogError" class="drive-feedback drive-error" role="alert">{{ dialogError }}</p>
        <div v-if="working" class="drive-inline-status" role="status"><span class="drive-spinner" />正在处理，请稍候…</div>
        <template v-if="dialog === 'directory'">
          <p class="drive-detail">将 {{ pendingDrop.length }} 个文件（{{ bytes(dropBytes) }}）按原层级上传到：</p>
          <p class="drive-drop-target">{{ dropDirectory }}/{{ folderPlan.root }}</p>
          <p class="drive-detail">先创建 {{ folderPlan.directories.length }} 个目录，再加入上传队列。同名目录会停止，不合并、不覆盖；不上传空文件夹。此批最多 50 个文件、50 个目录、10 层子目录。移动端不支持目录选择时请使用“上传文件”。</p>
          <ul class="drive-operation-items"><li v-for="file in pendingDrop" :key="file.webkitRelativePath"><span>{{ file.webkitRelativePath }}</span><small>{{ bytes(file.size) }}</small></li></ul>
          <button class="drive-button drive-primary" :disabled="working || folderAttempted" @click="confirmFolder">确认创建并上传</button>
        </template>
        <template v-else-if="dialog === 'history'">
          <p class="drive-detail">最多显示最近 20 个可用版本，保留期限由 Dropbox 决定。下载历史版本不会修改文件；另存副本不覆盖原文件。</p>
          <ul v-if="history" class="drive-operation-items drive-history"><li v-for="item in history.entries" :key="item.rev"><span><strong>{{ exactDate(item.modified) }}{{ item.rev === history.current.rev ? ' · 当前版本' : '' }}</strong><small>{{ bytes(item.size) }} · {{ item.rev }}</small></span><div><a v-if="item.downloadable" class="drive-button drive-small" :href="contentUrl(selected.id, false, item.rev)" target="_blank" rel="noopener noreferrer">下载版本</a><button v-if="item.downloadable && item.size <= history.recoveryLimit" class="drive-button drive-small" :disabled="working" @click="selectRevision(item)">另存副本</button></div></li></ul>
          <p class="drive-detail">直接另存副本上限 20 MB；更大的历史版本可下载或到 Dropbox 官方页面恢复。普通文件上传仍支持 50 GB。</p>
          <div v-if="historyChoice" class="drive-form"><label for="recovery-name">副本名称（与原文件同一目录）</label><input id="recovery-name" v-model="recoveryName" maxlength="512" :disabled="working"><p class="drive-detail">已选版本：{{ historyChoice.rev }}。同名时停止，不自动覆盖或重试。</p><button class="drive-button drive-primary" :disabled="working || recoveryAttempted || !recoveryName" @click="recoverVersion">确认另存新文件</button></div>
        </template>
        <template v-else-if="dialog === 'details'">
          <div class="drive-details-heading"><span class="drive-file-icon"><Icon :name="iconName(selected)" :size="25" /></span><strong>{{ selected.name }}</strong></div>
          <dl class="drive-details"><dt>名称</dt><dd>{{ selected.name }}<button class="drive-button drive-small" aria-label="复制文件名称" @click="copyDetail('name')"><Icon name="copy" :size="14" /></button></dd><dt>位置</dt><dd>{{ selected.path }}<button class="drive-button drive-small" aria-label="复制文件路径" @click="copyDetail('path')"><Icon name="copy" :size="14" /></button></dd><dt>类型</dt><dd>{{ fileTypeLabel(selected) }}</dd><dt>大小</dt><dd>{{ selected.type === 'folder' ? '未统计（不扫描子目录）' : `${bytes(selected.size)} · ${selected.size.toLocaleString('zh-CN')} 字节` }}</dd><dt>修改时间</dt><dd>{{ exactDate(selected.modified) }}<small v-if="selected.modified">当前设备时区</small></dd><dt v-if="selected.rev">版本标识</dt><dd v-if="selected.rev">{{ selected.rev }}</dd><dt>管理权限</dt><dd>{{ selected.mutable === false ? '包含受保护备份，仅可浏览' : '可管理（操作时重新校验）' }}</dd><dt v-if="selected.type === 'file'">下载</dt><dd v-if="selected.type === 'file'">{{ selected.downloadable ? '支持' : '请在 Dropbox 官方页面打开' }}</dd></dl>
          <p v-if="copied" class="drive-detail" role="status">{{ copied }}</p><p class="drive-detail">信息来自本次已加载列表。外部客户端修改后，请关闭并刷新列表查看最新状态。</p>
        </template>
        <template v-else-if="dialog === 'drop'"><p class="drive-detail">将 {{ pendingDrop.length }} 个文件（{{ bytes(dropBytes) }}）上传到：</p><p class="drive-drop-target">{{ dropDirectory || '全部文件（根目录）' }}</p><ul class="drive-operation-items"><li v-for="(file, index) in pendingDrop" :key="index"><Icon name="note" :size="18" /><span><strong>{{ file.name }}</strong><small>{{ bytes(file.size) }}</small></span></li></ul><p class="drive-detail">确认后才加入上传队列；同名文件不会覆盖。取消或关闭弹窗不会上传。</p></template>
        <template v-else-if="dialog === 'preview'">
          <div v-if="!mediaFailed && ['image', 'video', 'audio'].includes(selected.kind) && selected.downloadable" class="drive-preview">
            <img v-if="selected.kind === 'image'" :src="contentUrl(selected.id, true)" :alt="selected.name" @error="mediaFailed = true">
            <video v-else-if="selected.kind === 'video'" :src="contentUrl(selected.id, true)" controls playsinline preload="metadata" @error="mediaFailed = true" />
            <audio v-else :src="contentUrl(selected.id, true)" controls preload="metadata" @error="mediaFailed = true" />
          </div>
          <div v-else class="drive-empty"><Icon :name="iconName(selected)" :size="38" /><h3>{{ selected.kind === 'text' ? '读取并编辑文本' : mediaFailed ? '浏览器暂时无法播放或预览' : '在 Dropbox 中打开此文件' }}</h3><p>{{ selected.kind === 'text' ? '支持 UTF-8 文本，最大 1 MB。点击下方“编辑文本”读取内容。' : '可使用下方下载按钮，或前往 Dropbox 官方页面预览。Office 文档由官方页面提供编辑能力。' }}</p></div>
          <p class="drive-detail">{{ bytes(selected.size) }} · 修改于 {{ date(selected.modified) }}</p>
        </template>
        <template v-else-if="dialog === 'edit'"><label for="drive-editor" class="drive-field-label">文件内容 <span>{{ dirty ? '有未保存修改' : '与 Dropbox 一致' }}</span></label><textarea id="drive-editor" v-model="content" class="drive-editor" spellcheck="false" :disabled="working" @keydown.ctrl.s.prevent="save" @keydown.meta.s.prevent="save" /><p class="drive-detail">{{ bytes(byteLength) }} / 1 MB · 保存前会检查文件版本，不覆盖外部修改。</p></template>
        <div v-else-if="dialog === 'manage'" class="drive-manage"><button v-if="selected.type === 'file'" class="drive-button" @click="showHistory">历史版本</button><button class="drive-button" :disabled="working" @click="openManaged">打开</button><button class="drive-button" @click="open('details', selected)"><Icon name="note" :size="17" />文件详情</button><button class="drive-button" :disabled="selected.mutable === false" @click="open('rename', selected)"><Icon name="edit" :size="17" />重命名</button><button class="drive-button" :disabled="selected.mutable === false" @click="open('move', selected)"><Icon name="folder" :size="17" />移动</button><button class="drive-button" :disabled="selected.mutable === false" @click="open('copy', selected)"><Icon name="copy" :size="17" />复制</button><button class="drive-button drive-danger" :disabled="selected.mutable === false" @click="open('delete', selected)"><Icon name="trash" :size="17" />{{ selected.type === 'folder' ? '删除文件夹' : '删除文件' }}</button><p v-if="selected.mutable === false" class="drive-detail">此目录包含受保护的备份，不能移动、复制、改名或删除。</p></div>
        <template v-else-if="dialog === 'delete'"><p class="drive-detail">将删除以下 {{ plans.length }} 项。文件夹会包含其中的子文件；不执行永久删除，恢复期限以 Dropbox 账号规则为准。</p><ul class="drive-operation-items"><li v-for="plan in plans" :key="plan.item.id"><Icon :name="iconName(plan.item)" :size="18" /><span><strong>{{ plan.item.name }}</strong><small v-if="plan.item.type === 'folder'">包含 {{ plan.descendants }} 个子项 · {{ bytes(plan.bytes) }}</small></span></li></ul><p v-for="result in results" :key="result.item.id" class="drive-feedback drive-error">{{ result.item.name }}：{{ result.error }}</p><p class="drive-detail">确认前会再次核对版本和目录内容；备份目录始终受保护。操作期间请勿在其他客户端修改这个目录。</p></template>
        <template v-else-if="['move', 'copy'].includes(dialog)"><p class="drive-detail">{{ dialog === 'move' ? '移动' : '复制' }} {{ batchItems.length }} 项到所选文件夹；同名文件不会被覆盖。</p><ul class="drive-operation-items"><li v-for="item in batchItems" :key="item.id"><Icon :name="iconName(item)" :size="18" /><span>{{ item.name }}</span></li></ul><FolderPicker :excluded="excludedFolders" @choose="destination = $event" /></template>
        <template v-else-if="dialog === 'results'"><p class="drive-detail">{{ notice }}</p><ul class="drive-operation-items"><li v-for="result in results" :key="result.item.id"><Icon :name="result.ok ? 'check' : 'alert'" :size="18" /><span><strong>{{ result.item.name }}</strong><small>{{ result.ok ? '已完成' : result.error }}</small></span></li></ul><p class="drive-detail">未完成项重新核对并确认后才会重试；成功项不会重复执行。</p><button v-if="results.some(result => !result.ok)" class="drive-button" :disabled="working" @click="beginBatch(lastBatchMode, results.filter(result => !result.ok).map(result => result.item))">重新核对未完成项</button></template>
        <form v-else class="drive-form" @submit.prevent="mutate"><label for="drive-value">{{ dialog === 'folder' ? '文件夹名称' : '新名称' }}</label><input id="drive-value" v-model="value" :disabled="working" maxlength="512" autocomplete="off"><p v-if="dialog === 'rename'" class="drive-detail">目标已存在时会停止，不覆盖同名文件。</p><button type="submit" class="drive-hidden" tabindex="-1">提交</button></form>
        <div v-if="discard" class="drive-discard" role="alert"><p>当前修改尚未保存。保存或放弃修改后，再关闭或切换页面。</p><button class="drive-button" @click="discard = false">继续编辑</button><button class="drive-button drive-danger" @click="close(true)">放弃修改并关闭</button></div>
      </div>
      <template #footer><div class="drive-footer"><button class="drive-button" :disabled="working" @click="close()">{{ dirty ? '关闭编辑' : '关闭' }}</button><template v-if="dialog === 'preview'"><button class="drive-button" @click="open('details', selected)">详情</button><a v-if="selected.downloadable" class="drive-button" :href="contentUrl(selected.id)" target="_blank" rel="noopener noreferrer"><Icon name="download" :size="16" />下载</a><a class="drive-button" :href="official || 'https://www.dropbox.com/home'" target="_blank" rel="noopener noreferrer">{{ official ? '在 Dropbox 打开' : '打开 Dropbox 查找' }}</a><button v-if="selected.kind === 'text' && selected.downloadable && selected.size <= status.textLimit" class="drive-button drive-primary" :disabled="working" @click="edit">编辑文本</button></template><button v-else-if="dialog === 'details'" class="drive-button drive-primary" @click="openManaged">打开</button><button v-else-if="dialog === 'drop'" class="drive-button drive-primary" :disabled="working || !pendingDrop.length" @click="confirmDrop">确认上传 {{ pendingDrop.length }} 个文件</button><button v-else-if="dialog === 'edit'" class="drive-button drive-primary" :disabled="working || !dirty || byteLength > status.textLimit" @click="save">{{ working ? '保存中…' : '保存到 Dropbox' }}</button><button v-else-if="['rename', 'folder'].includes(dialog)" class="drive-button drive-primary" :disabled="working || !value" @click="mutate">{{ working ? '处理中…' : '确认' }}</button><button v-else-if="['delete', 'move', 'copy'].includes(dialog)" class="drive-button" :class="dialog === 'delete' ? 'drive-danger' : 'drive-primary'" :disabled="working || (dialog === 'delete' ? !plans.length : destination === null)" @click="batchMutate">{{ working ? '处理中…' : dialog === 'delete' ? '确认删除' : '确认' }}</button></div></template>
    </Modal>
  </main>
</template>

<style scoped>
.drive-page{max-width:1160px;margin:auto;padding:36px 24px 48px;color:var(--text-primary);font-family:var(--font-family,sans-serif)}
.drive-heading{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:24px}.drive-eyebrow{font-size:11px;letter-spacing:.12em;color:var(--text-muted);margin:0 0 10px}.drive-heading h1{font-size:30px;letter-spacing:-.03em;margin:0 0 10px;line-height:1.2}.drive-subtitle{color:var(--text-secondary);font-size:14px;line-height:1.7;margin:0}
.drive-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:40px;min-width:40px;padding:9px 13px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-primary);color:var(--text-primary);font:inherit;font-size:13px;line-height:1.4;text-decoration:none;cursor:pointer;white-space:nowrap}.drive-button:hover:not(:disabled){background:var(--bg-hover)}.drive-button:disabled{opacity:.5;cursor:not-allowed}.drive-primary{background:var(--accent-color);color:var(--text-inverse,#fff);border-color:var(--accent-color)}.drive-primary:hover:not(:disabled){background:var(--accent-hover,var(--accent-color));filter:brightness(.95)}.drive-small{padding:6px 10px;min-height:36px}.drive-danger{color:var(--danger-color,#ad3333);background:transparent}.drive-page button:focus-visible,.drive-page a:focus-visible,.drive-dialog input:focus-visible,.drive-dialog textarea:focus-visible,.drive-footer button:focus-visible,.drive-footer a:focus-visible{outline:2px solid var(--accent-color);outline-offset:3px}
.drive-protection{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--text-secondary);margin-bottom:18px;line-height:1.7}.drive-protection svg{flex-shrink:0}.drive-protection a{color:var(--accent-color);margin-left:auto;white-space:nowrap}.drive-surface{background:var(--bg-card);border:1px solid var(--border-color);border-radius:18px;overflow:hidden}.drive-toolbar{display:flex;gap:16px;padding:20px;align-items:center;border-bottom:1px solid var(--border-light)}.drive-search{display:flex;flex:1;min-width:0;gap:9px;align-items:center;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:11px;padding:4px 5px 4px 12px}.drive-search>svg{color:var(--text-muted);flex-shrink:0}.drive-search input{min-width:0;width:100%;padding:6px 0;border:0;background:transparent;border-radius:0;color:var(--text-primary);font:inherit;font-size:13px;outline:none}.drive-search:focus-within{outline:2px solid var(--accent-color);outline-offset:2px}.drive-actions{display:flex;gap:8px}.drive-location{display:flex;gap:12px;justify-content:space-between;align-items:center;padding:12px 20px}.drive-location nav{display:flex;align-items:center;flex-wrap:wrap;gap:4px;min-width:0}.drive-location nav button{font:inherit;font-size:12px;color:var(--text-secondary);border:0;background:none;padding:7px;border-radius:6px;cursor:pointer;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.drive-location button[aria-current]{color:var(--text-primary);font-weight:600}.drive-query{padding:0 24px;display:flex;align-items:center;gap:12px;font-size:13px;overflow-wrap:anywhere}
.drive-table-head,.drive-list>li{display:grid;grid-template-columns:minmax(0,1fr) 100px 116px 44px;align-items:center;gap:16px;padding:0 24px}.drive-table-head{background:var(--bg-secondary);min-height:36px;color:var(--text-muted);font-size:11px}.drive-list{list-style:none;padding:0;margin:0}.drive-list>li{min-height:76px;border-bottom:1px solid var(--border-light)}.drive-list>li:hover{background:var(--bg-hover)}.drive-file{display:flex;min-width:0;align-items:center;gap:12px;border:0;background:none;padding:14px 0;border-radius:0;text-align:left;color:inherit;font:inherit;cursor:pointer;width:100%}.drive-file-label{min-width:0;flex:1}.drive-file-label strong{font-size:14px;font-weight:550;display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.drive-file-label small{display:block;font-size:11px;color:var(--text-muted);margin-top:5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.drive-file-icon{display:grid;place-items:center;width:40px;height:44px;border-radius:10px;background:var(--bg-secondary);color:var(--text-secondary);flex-shrink:0}.drive-list li[data-kind=folder] .drive-file-icon{color:var(--accent-color);background:var(--accent-bg)}.drive-desktop-meta{font-size:12px;color:var(--text-secondary)}.drive-file-label .drive-mobile-meta{display:none}.drive-list-footer{padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:var(--text-muted);flex-wrap:wrap}.drive-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;padding:48px 24px;color:var(--text-secondary)}.drive-empty>svg{color:var(--text-muted)}.drive-empty h2,.drive-empty h3{font-size:16px;font-weight:550;margin:0;color:var(--text-primary)}.drive-empty p{font-size:13px;line-height:1.8;margin:0;max-width:430px}.drive-feedback{display:flex;gap:9px;align-items:flex-start;padding:12px 16px;margin:12px 20px;background:var(--bg-secondary);border-radius:10px;font-size:13px;line-height:1.7;overflow-wrap:anywhere}.drive-error{color:var(--danger-color,#ad3333);border:1px solid color-mix(in srgb,currentColor 20%,transparent)}.drive-feedback svg{flex-shrink:0;margin-top:3px}.drive-footnote{color:var(--text-muted);font-size:11px;line-height:1.8;margin:16px 2px}.drive-hidden{display:none!important}
.drive-dialog{color:var(--text-primary);font-family:var(--font-family,sans-serif)}.drive-item-path{font-size:12px;color:var(--text-muted);overflow-wrap:anywhere;margin:0 0 16px}.drive-preview{display:flex;align-items:center;justify-content:center;min-height:180px;background:var(--bg-secondary);border-radius:12px;overflow:hidden}.drive-preview img{max-width:100%;max-height:55dvh;object-fit:contain}.drive-preview video{width:100%;max-height:55dvh;background:#16181b}.drive-preview audio{width:min(100%,460px);margin:30px 12px}.drive-detail{font-size:12px;color:var(--text-secondary);line-height:1.8;overflow-wrap:anywhere}.drive-manage{display:grid;grid-template-columns:1fr 1fr;gap:12px}.drive-manage p{grid-column:1/-1;margin:0}.drive-form{display:grid;gap:12px}.drive-form label,.drive-field-label{font-size:13px;font-weight:550}.drive-field-label{display:flex;justify-content:space-between;gap:12px;margin-bottom:10px}.drive-field-label span{font-weight:400;color:var(--text-muted);font-size:12px}.drive-form input{width:100%;box-sizing:border-box;min-height:44px;border:1px solid var(--border-color);border-radius:9px;background:var(--bg-primary);color:var(--text-primary);font:inherit;font-size:14px;padding:10px 12px}.drive-editor{box-sizing:border-box;display:block;width:100%;height:45dvh;min-height:200px;resize:vertical;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:10px;padding:16px;font:13px/1.8 ui-monospace,Consolas,monospace;tab-size:2}.drive-dialog .drive-feedback{margin:0 0 16px}.drive-footer{width:100%;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.drive-discard{background:var(--bg-secondary);padding:14px;border-radius:10px;font-size:13px;line-height:1.7}.drive-discard p{margin:0 0 12px}.drive-discard button{margin-right:8px;margin-bottom:4px}.drive-inline-status{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);padding:0 0 12px}.drive-spinner{width:15px;height:15px;display:inline-block;border:2px solid var(--border-color);border-top-color:var(--accent-color);border-radius:50%;animation:drive-spin .8s linear infinite;flex-shrink:0}@keyframes drive-spin{to{transform:rotate(360deg)}}
@media(max-width:720px){.drive-page{padding:24px 14px 36px}.drive-heading{align-items:flex-start;gap:14px;flex-direction:column}.drive-heading h1{font-size:26px}.drive-toolbar{flex-wrap:wrap;padding:14px;gap:12px}.drive-search{flex-basis:100%}.drive-actions{width:100%}.drive-actions>.drive-button{flex:1}.drive-protection{flex-wrap:wrap;font-size:11px}.drive-protection a{margin-left:25px}.drive-location{padding:9px 12px}.drive-table-head{display:none}.drive-list>li{grid-template-columns:minmax(0,1fr) 38px;padding:0 14px;gap:8px;min-height:74px}.drive-desktop-meta{display:none}.drive-file-label .drive-mobile-meta{display:block}.drive-file-label strong{font-size:13px}.drive-file{gap:10px}.drive-file-icon{width:34px;height:40px}.drive-feedback{margin:10px 12px;padding:10px 12px}.drive-list-footer{padding:14px}.drive-empty{padding:36px 16px}.drive-footer{justify-content:stretch}.drive-footer>.drive-button{flex:1 0 auto;max-width:100%;white-space:normal}.drive-location nav button{max-width:170px}.drive-editor{padding:12px;font-size:14px}.drive-preview{min-height:120px}.drive-field-label{flex-wrap:wrap}}
@media(prefers-reduced-motion:reduce){.drive-spinner{animation:none}}
.drive-selection-toggle{display:flex;align-items:center;gap:10px;padding:8px 20px 14px;font-size:11px;color:var(--text-muted)}.drive-batch-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 20px;background:var(--accent-bg);font-size:12px;border-block:1px solid var(--border-color)}.drive-batch-bar>div{display:flex;gap:6px;margin-left:auto}.drive-selecting.drive-table-head,.drive-list>li.drive-selecting{grid-template-columns:26px minmax(0,1fr) 100px 116px 44px}.drive-checkbox{display:grid;place-items:center;min-height:44px;cursor:pointer}.drive-checkbox input{width:18px;height:18px;margin:0;accent-color:var(--accent-color)}.drive-row-checked{background:var(--accent-bg)}.drive-operation-items{list-style:none;padding:0;margin:12px 0;max-height:210px;overflow:auto}.drive-operation-items li{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border-light);font-size:13px}.drive-operation-items svg{flex-shrink:0;margin-top:2px}.drive-operation-items span{min-width:0;overflow-wrap:anywhere}.drive-operation-items strong{font-weight:550;display:block}.drive-operation-items small{display:block;color:var(--text-secondary);font-size:12px;margin-top:4px;line-height:1.7}.drive-transfers{margin:12px 20px;padding:14px;border:1px solid var(--border-color);border-radius:12px;font-size:12px;background:var(--bg-primary)}.drive-transfers header,.drive-transfer-title,.drive-transfer-meta{display:flex;align-items:center;justify-content:space-between;gap:12px}.drive-transfers p{font-size:11px;color:var(--text-muted);line-height:1.8;margin:8px 0;overflow-wrap:anywhere}.drive-transfers ul{list-style:none;padding:0;margin:0;max-height:320px;overflow:auto}.drive-transfers li{padding:12px 0;border-top:1px solid var(--border-light)}.drive-transfer-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-weight:550}.drive-transfer-title>span{white-space:nowrap;color:var(--text-secondary);font-size:11px}.drive-transfers progress{display:block;width:100%;height:5px;accent-color:var(--accent-color);margin:12px 0}.drive-transfer-meta{flex-wrap:wrap;font-size:11px;color:var(--text-secondary)}.drive-transfer-meta>div{display:flex;gap:6px}.drive-transfers [role=alert]{color:var(--danger-color,#ad3333)}
@media(max-width:720px){.drive-list>li.drive-selecting{grid-template-columns:24px minmax(0,1fr) 38px;gap:6px}.drive-selecting .drive-file-icon{display:none}.drive-selection-toggle{padding:6px 14px 12px;flex-wrap:wrap}.drive-transfers{margin:10px 12px;padding:12px}.drive-batch-bar{position:fixed;z-index:80;bottom:calc(var(--mobile-dock-height,78px) + env(safe-area-inset-bottom,0px) + 14px);left:14px;right:14px;padding:10px 12px;border:1px solid var(--border-color);border-radius:14px;background:var(--bg-card);box-shadow:0 8px 32px #0002}.drive-batch-bar>button{max-width:100%;font-size:11px}.drive-batch-bar>div{margin-left:0;flex:1;justify-content:flex-end}.drive-page:has(.drive-batch-bar){padding-bottom:150px}.drive-transfer-meta>div{flex-wrap:wrap}}
.drive-view-options{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 20px 12px}.drive-view-options label{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--text-muted);min-width:0}.drive-view-options select{font:inherit;font-size:12px;color:var(--text-primary);background:var(--bg-primary);border:1px solid var(--border-color);border-radius:9px;min-height:38px;padding:6px 9px;max-width:100%}.drive-view-options select:focus-visible{outline:2px solid var(--accent-color);outline-offset:2px}.drive-view-options p{margin:0;flex-basis:100%;font-size:11px;color:var(--text-muted);line-height:1.8}.drive-view-switch{display:flex;gap:4px;margin-left:auto}.drive-view-switch [aria-pressed=true]{color:var(--accent-color);background:var(--accent-bg);border-color:var(--accent-color)}
.drive-list.drive-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:14px 20px}.drive-grid>li,.drive-grid>li.drive-selecting{position:relative;display:flex;flex-direction:column;align-items:stretch;gap:0;padding:16px 12px 12px;border:1px solid var(--border-color);border-radius:12px;min-width:0;background:var(--bg-primary)}.drive-grid>li.drive-row-checked{border-color:var(--accent-color);background:var(--accent-bg)}.drive-grid .drive-file{flex-direction:column;align-items:flex-start;padding:0 0 10px;min-height:122px;gap:12px}.drive-grid .drive-file-label{width:100%}.drive-grid .drive-file-label strong{white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.5;min-height:3em}.drive-grid .drive-file-label .drive-mobile-meta{display:block}.drive-grid .drive-desktop-meta{display:none}.drive-grid .drive-file>svg{position:absolute;right:18px;top:27px;color:var(--text-muted)}.drive-grid>li>.drive-button{align-self:flex-end;min-width:44px;min-height:40px}.drive-grid .drive-checkbox{position:absolute;right:10px;top:6px;min-width:38px;z-index:1}.drive-grid .drive-selecting .drive-file-icon{display:grid}.drive-grid .drive-selecting .drive-file>svg{top:auto;bottom:24px;left:16px}
.drive-details-heading{display:flex;gap:12px;align-items:center;margin-bottom:20px}.drive-details-heading strong{font-size:16px;font-weight:550;overflow-wrap:anywhere;min-width:0}.drive-details{display:grid;grid-template-columns:74px minmax(0,1fr);margin:0;font-size:13px;line-height:1.8}.drive-details dt,.drive-details dd{padding:10px 0;border-top:1px solid var(--border-light);margin:0;overflow-wrap:anywhere;white-space:pre-wrap;user-select:text}.drive-details dt{color:var(--text-muted);font-size:12px}.drive-details dd small{display:block;color:var(--text-muted);font-size:11px}.drive-details dd button{margin:4px 0 0 8px;vertical-align:middle}.drive-surface{position:relative}.drive-drop-active{outline:2px solid var(--accent-color);outline-offset:3px}.drive-drop-overlay{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:color-mix(in srgb,var(--bg-card) 96%,transparent);pointer-events:none;text-align:center;padding:28px;color:var(--accent-color)}.drive-drop-overlay span{overflow-wrap:anywhere;font-size:13px;color:var(--text-secondary)}.drive-drop-target{overflow-wrap:anywhere;padding:12px;background:var(--bg-secondary);border-radius:10px;font-size:13px}
@media(max-width:720px){.drive-view-options{padding:8px 14px 12px;gap:10px}.drive-view-options label{flex:1 1 calc(50% - 10px);flex-direction:column;align-items:stretch;gap:4px}.drive-view-options select{width:100%;min-height:42px}.drive-view-switch{margin-left:0}.drive-view-switch .drive-button{min-width:54px;min-height:40px}.drive-drop-hint{display:none}.drive-list.drive-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:10px 12px}.drive-grid>li,.drive-grid>li.drive-selecting{padding:14px 10px 10px}.drive-grid .drive-file-label strong{font-size:12px}.drive-grid .drive-file-label small{font-size:10px}.drive-details{grid-template-columns:65px minmax(0,1fr);font-size:12px}}
.drive-actions{flex-wrap:wrap}.drive-history li{flex-wrap:wrap}.drive-history li>div{display:flex;gap:6px;flex-wrap:wrap}.drive-history li>span{flex:1 1 210px}
@media(max-width:720px){.drive-actions>.drive-button{flex:1 1 40%}}
</style>
