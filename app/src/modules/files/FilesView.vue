<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import Modal from '@/shared/components/Modal.vue'
import { registerReloadGuard } from '@/shared/services/reloadGuards'
import { contentUrl, filesAction, filesStatus, uploadFile } from './filesApi'

const status = ref(null), entries = ref([]), path = ref(''), search = ref(''), query = ref('')
const loading = ref(false), working = ref(false), error = ref(''), notice = ref(''), cursor = ref(null)
const dialog = ref(''), selected = ref(null), value = ref(''), dialogError = ref(''), mediaFailed = ref(false)
const content = ref(''), original = ref(''), textRev = ref(''), discard = ref(false), picker = ref(null)
let alive = true, loadSequence = 0
const dirty = computed(() => dialog.value === 'edit' && content.value !== original.value)
const byteLength = computed(() => new TextEncoder().encode(content.value).length)
const crumbs = computed(() => [{ name: '全部文件', path: '' }, ...path.value.split('/').filter(Boolean).map((name, index, parts) => ({ name, path: '/' + parts.slice(0, index + 1).join('/') }))])
const sorted = computed(() => [...entries.value].sort((a, b) => (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true })))
const titles = computed(() => ({ preview: selected.value?.name, edit: '编辑文本', manage: '管理文件', rename: '重命名', move: '移动到其他位置', delete: '删除文件', folder: '新建文件夹' }[dialog.value] || '文件'))
const iconName = item => item.type === 'folder' ? 'folder' : item.kind === 'image' ? 'image' : ['video', 'audio'].includes(item.kind) ? 'play' : 'note'
const official = computed(() => {
  try { const u = new URL(selected.value?.officialUrl); return u.origin === 'https://www.dropbox.com' && !u.username && !u.password ? u.href : null } catch { return null }
})
function bytes(n) { return n === undefined ? '文件夹' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB` }
function date(n) { return n ? new Date(n).toLocaleDateString('zh-CN') : '—' }
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
  if (!more) { entries.value = []; cursor.value = null }
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
  try { const result = await filesStatus(); if (!alive) return; status.value = result; await loadEntries() }
  catch (e) { if (alive) { status.value = null; entries.value = []; error.value = message(e) } }
  finally { if (alive) loading.value = false }
}
function navigate(next) {
  if (loading.value || working.value) return
  path.value = next; search.value = ''; query.value = ''; notice.value = ''; loadEntries()
}
function runSearch() { if (!loading.value && !working.value) { query.value = search.value.trim(); loadEntries() } }
function open(mode, item = null) {
  if (working.value) return
  selected.value = item; dialog.value = mode; value.value = ''; dialogError.value = ''; discard.value = false; mediaFailed.value = false
  if (mode === 'rename') value.value = item.name
  if (mode === 'move') value.value = item.path
}
function openItem(item) { if (item.type === 'folder') navigate(item.path); else open('preview', item) }
function openManaged() { const item = selected.value; close(); if (item) openItem(item) }
function close(force = false) {
  if (working.value) return
  if (dirty.value && !force) { discard.value = true; return }
  dialog.value = ''; selected.value = null; content.value = ''; original.value = ''; textRev.value = ''; discard.value = false; dialogError.value = ''
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
    if (dialog.value === 'move') {
      if (!value.value.startsWith('/') || value.value.endsWith('/')) throw new Error('填写完整目标路径，包含文件名，例如 /旅行/照片.jpg。')
      action = 'move'; payload = { id: selected.value.id, destination: value.value }
    }
    if (dialog.value === 'delete') {
      if (value.value !== selected.value.name) throw new Error('请输入完整文件名确认。')
      action = 'delete'; payload = { id: selected.value.id, rev: selected.value.rev, confirmation: value.value }
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
async function upload(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file || working.value) return
  error.value = ''; notice.value = ''
  if (file.size > status.value.uploadLimit) { error.value = '单文件上限 20 MB；更大的文件请使用 Dropbox 官方上传。'; return }
  let destination
  try { destination = childPath(file.name) } catch (e) { error.value = e.message; return }
  working.value = true; notice.value = '正在上传，请勿关闭页面…'
  try { await uploadFile(destination, file); if (!alive) return; notice.value = '上传完成'; await loadEntries() }
  catch (e) { if (alive) { error.value = message(e); notice.value = '' } }
  finally { if (alive) working.value = false }
}
const unregister = registerReloadGuard(() => dirty.value || working.value ? '请先保存文件或等待文件操作结束。' : '')
function beforeUnload(event) { if (dirty.value || working.value) { event.preventDefault(); event.returnValue = '' } }
onBeforeRouteLeave(() => { if (dirty.value || working.value) { if (dirty.value) discard.value = true; return false } return true })
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); connect() })
onBeforeUnmount(() => { alive = false; loadSequence++; content.value = ''; original.value = ''; unregister(); window.removeEventListener('beforeunload', beforeUnload) })
</script>

<template>
  <main class="drive-page">
    <header class="drive-heading">
      <div><p class="drive-eyebrow">PERSONAL CLOUD · DROPBOX</p><h1>文件库</h1><p class="drive-subtitle">你的文件，随时打开。只向绑定的管理员本人开放。</p></div>
      <a class="drive-button" href="https://www.dropbox.com/home" target="_blank" rel="noopener noreferrer">打开 Dropbox <Icon name="external-link" :size="15" /></a>
    </header>
    <div class="drive-protection"><Icon name="lock" :size="16" /><span>NAV 加密备份目录受保护，与日常文件管理分开。</span><router-link to="/settings?section=cloud-backup">备份设置</router-link></div>
    <section class="drive-surface" aria-label="Dropbox 文件" :aria-busy="loading || working">
      <div class="drive-toolbar">
        <form class="drive-search" @submit.prevent="runSearch"><Icon name="search" :size="18" /><input v-model="search" aria-label="搜索文件名" placeholder="搜索当前目录及子目录中的文件名" maxlength="200" :disabled="!status || working"><button class="drive-button drive-small" :disabled="!status || loading || working">搜索</button></form>
        <div class="drive-actions"><button class="drive-button" type="button" :disabled="!status || loading || working" @click="open('folder')"><Icon name="folder" :size="17" />新建文件夹</button><button class="drive-button drive-primary" type="button" :disabled="!status || loading || working" @click="picker.click()"><Icon name="upload" :size="17" />上传文件</button><input ref="picker" class="drive-hidden" type="file" aria-label="选择上传文件" @change="upload"></div>
      </div>
      <div class="drive-location"><nav aria-label="文件路径"><template v-for="(crumb, index) in crumbs" :key="crumb.path"><Icon v-if="index" name="chevron-right" :size="13" /><button type="button" :aria-current="index === crumbs.length - 1 ? 'location' : undefined" :disabled="loading || working || !status" @click="navigate(crumb.path)">{{ crumb.name }}</button></template></nav><button class="drive-button drive-small" type="button" :disabled="loading || working" aria-label="刷新文件列表" @click="connect"><Icon name="refresh" :size="15" /></button></div>
      <p v-if="query" class="drive-query">搜索“{{ query }}”<button class="drive-button drive-small" type="button" :disabled="loading || working" @click="search = ''; runSearch()">清除搜索</button></p>
      <div v-if="error" class="drive-feedback drive-error" role="alert"><Icon name="alert" :size="18" /><span>{{ error }}</span></div>
      <p v-if="notice" class="drive-feedback" role="status">{{ notice }}</p>
      <div v-if="!status && !loading" class="drive-empty"><Icon name="cloud" :size="36" /><h2>连接你的个人文件库</h2><p>文件管理使用独立的 Full Dropbox 授权，不会复用备份凭据。</p><button class="drive-button" type="button" @click="connect">重新检查连接</button></div>
      <template v-else>
        <div class="drive-table-head" aria-hidden="true"><span>名称</span><span>大小</span><span>修改日期</span><span>操作</span></div>
        <ul class="drive-list" aria-label="文件列表">
          <li v-for="item in sorted" :key="item.id" :data-kind="item.kind">
            <button class="drive-file" type="button" :disabled="loading || working" @click="openItem(item)"><span class="drive-file-icon"><Icon :name="iconName(item)" :size="22" /></span><span class="drive-file-label"><strong>{{ item.name }}</strong><small v-if="query">{{ item.path }}</small><small v-else class="drive-mobile-meta">{{ bytes(item.size) }} · {{ date(item.modified) }}</small></span><Icon v-if="item.mutable === false" name="lock" :size="14" /></button>
            <span class="drive-desktop-meta">{{ bytes(item.size) }}</span><span class="drive-desktop-meta">{{ date(item.modified) }}</span>
            <button class="drive-button drive-small" type="button" :disabled="loading || working" :aria-label="`管理 ${item.name}`" @click="open('manage', item)"><Icon name="more-horizontal" :size="18" /></button>
          </li>
        </ul>
        <div v-if="loading" class="drive-empty drive-loading" role="status"><span class="drive-spinner" />正在读取文件…</div>
        <div v-else-if="!entries.length && !error" class="drive-empty"><Icon :name="query ? 'search' : 'folder'" :size="34" /><h2>{{ query ? '没有找到匹配的文件' : '这里还没有可显示的文件' }}</h2><p>{{ query ? '试试更短的文件名，或返回全部文件搜索。' : '可以上传文件或创建文件夹；受保护的备份内容不会出现在这里。' }}</p></div>
        <footer v-if="status" class="drive-list-footer"><span>已显示 {{ entries.length }} 项<span v-if="cursor"> · 还有更多</span></span><button v-if="cursor" class="drive-button" :disabled="loading || working" @click="loadEntries(true)">加载更多</button><span>上传 ≤ 20 MB / 文件</span></footer>
      </template>
    </section>
    <p class="drive-footnote">文件不保存到浏览器离线缓存。视频使用浏览器原生播放；不兼容的编码可下载或在 Dropbox 打开。</p>

    <Modal :show="Boolean(dialog)" :title="titles" :width="['preview', 'edit'].includes(dialog) ? '880px' : '520px'" :close-disabled="working" @close="close()">
      <div class="drive-dialog">
        <p v-if="selected" class="drive-item-path">{{ selected.path }}</p>
        <p v-if="dialogError" class="drive-feedback drive-error" role="alert">{{ dialogError }}</p>
        <div v-if="working" class="drive-inline-status" role="status"><span class="drive-spinner" />正在处理，请稍候…</div>
        <template v-if="dialog === 'preview'">
          <div v-if="!mediaFailed && ['image', 'video', 'audio'].includes(selected.kind) && selected.downloadable" class="drive-preview">
            <img v-if="selected.kind === 'image'" :src="contentUrl(selected.id, true)" :alt="selected.name" @error="mediaFailed = true">
            <video v-else-if="selected.kind === 'video'" :src="contentUrl(selected.id, true)" controls playsinline preload="metadata" @error="mediaFailed = true" />
            <audio v-else :src="contentUrl(selected.id, true)" controls preload="metadata" @error="mediaFailed = true" />
          </div>
          <div v-else class="drive-empty"><Icon :name="iconName(selected)" :size="38" /><h3>{{ selected.kind === 'text' ? '读取并编辑文本' : mediaFailed ? '浏览器暂时无法播放或预览' : '在 Dropbox 中打开此文件' }}</h3><p>{{ selected.kind === 'text' ? '支持 UTF-8 文本，最大 1 MB。点击下方“编辑文本”读取内容。' : '可使用下方下载按钮，或前往 Dropbox 官方页面预览。Office 文档由官方页面提供编辑能力。' }}</p></div>
          <p class="drive-detail">{{ bytes(selected.size) }} · 修改于 {{ date(selected.modified) }}</p>
        </template>
        <template v-else-if="dialog === 'edit'"><label for="drive-editor" class="drive-field-label">文件内容 <span>{{ dirty ? '有未保存修改' : '与 Dropbox 一致' }}</span></label><textarea id="drive-editor" v-model="content" class="drive-editor" spellcheck="false" :disabled="working" @keydown.ctrl.s.prevent="save" @keydown.meta.s.prevent="save" /><p class="drive-detail">{{ bytes(byteLength) }} / 1 MB · 保存前会检查文件版本，不覆盖外部修改。</p></template>
<div v-else-if="dialog === 'manage'" class="drive-manage"><button class="drive-button" :disabled="working" @click="openManaged">打开</button><button class="drive-button" :disabled="selected.mutable === false" @click="open('rename', selected)"><Icon name="edit" :size="17" />重命名</button><button class="drive-button" :disabled="selected.mutable === false" @click="open('move', selected)"><Icon name="folder" :size="17" />移动</button><button v-if="selected.type === 'file'" class="drive-button drive-danger" :disabled="selected.mutable === false" @click="open('delete', selected)"><Icon name="trash" :size="17" />删除文件</button><p v-if="selected.mutable === false" class="drive-detail">此目录包含受保护的备份，不能移动或改名。</p><p v-if="selected.type === 'folder'" class="drive-detail">为避免递归误删，文件夹删除请在 Dropbox 官方页面操作。</p></div>
        <form v-else class="drive-form" @submit.prevent="mutate"><label for="drive-value">{{ dialog === 'delete' ? '输入完整文件名确认删除' : dialog === 'move' ? '完整目标路径（包含文件名）' : dialog === 'folder' ? '文件夹名称' : '新名称' }}</label><p v-if="dialog === 'delete'" class="drive-detail">将从 Dropbox 删除“{{ selected.name }}”。恢复能力与保留时间以 Dropbox 账号规则为准，不进行永久删除。</p><input id="drive-value" v-model="value" :disabled="working" :maxlength="dialog === 'move' ? 2048 : 512" autocomplete="off" :placeholder="dialog === 'move' ? '/旅行/文件名.txt' : ''"><p v-if="['move','rename'].includes(dialog)" class="drive-detail">目标已存在时会停止，不覆盖同名文件。</p><button type="submit" class="drive-hidden" tabindex="-1">提交</button></form>
        <div v-if="discard" class="drive-discard" role="alert"><p>当前修改尚未保存。保存或放弃修改后，再关闭或切换页面。</p><button class="drive-button" @click="discard = false">继续编辑</button><button class="drive-button drive-danger" @click="close(true)">放弃修改并关闭</button></div>
      </div>
      <template #footer><div class="drive-footer"><button class="drive-button" :disabled="working" @click="close()">{{ dirty ? '关闭编辑' : '关闭' }}</button><template v-if="dialog === 'preview'"><a v-if="selected.downloadable" class="drive-button" :href="contentUrl(selected.id)" target="_blank" rel="noopener noreferrer"><Icon name="download" :size="16" />下载</a><a class="drive-button" :href="official || 'https://www.dropbox.com/home'" target="_blank" rel="noopener noreferrer">{{ official ? '在 Dropbox 打开' : '打开 Dropbox 查找' }}</a><button v-if="selected.kind === 'text' && selected.downloadable && selected.size <= status.textLimit" class="drive-button drive-primary" :disabled="working" @click="edit">编辑文本</button></template><button v-else-if="dialog === 'edit'" class="drive-button drive-primary" :disabled="working || !dirty || byteLength > status.textLimit" @click="save">{{ working ? '保存中…' : '保存到 Dropbox' }}</button><button v-else-if="['rename', 'move', 'folder', 'delete'].includes(dialog)" class="drive-button" :class="dialog === 'delete' ? 'drive-danger' : 'drive-primary'" :disabled="working || !value || (dialog === 'delete' && value !== selected.name)" @click="mutate">{{ working ? '处理中…' : dialog === 'delete' ? '确认删除' : '确认' }}</button></div></template>
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
</style>
