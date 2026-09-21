<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { apiRequest } from '@/shared/services/apiClient'
import FolderPicker from './FolderPicker.vue'
const props = defineProps({ directory: { type: String, default: '' } })
const emit = defineEmits(['busy'])
const state = ref(null), url = ref(''), name = ref(''), destination = ref(props.directory), choosing = ref(false)
const busy = ref(false), error = ref(''), notice = ref(''), cancelId = ref('')
let alive = true, timer, refreshing = false
const labels = { queued: '排队中', downloading: '下载到服务器', paused: '已暂停', uploading: '上传到 Dropbox', committing: '正在校验', complete: '已完成', cancelled: '已取消', error: '等待处理', review: '需核对云端结果' }
const reasons = { DOWNLOAD_TOO_LARGE: '文件超过节点单文件上限', DOWNLOAD_DISK_LIMIT: '服务器剩余空间不足，已停止', UNSAFE_DOWNLOAD_HOST: '目标地址不符合公网下载安全要求', DOWNLOAD_NOT_DIRECT_FILE: '不是可直接下载的文件，或服务器未提供大小', DOWNLOAD_HTTP_FAILED: '来源链接失效或拒绝下载', DOWNLOAD_RANGE_CHANGED: '来源文件发生变化，请更换链接', TARGET_EXISTS: 'Dropbox 已有同名项目，请核对', COMMIT_RESULT_UNKNOWN: '请先到目标目录核对，不能盲目重传' }
const size = n => n == null ? '待获取' : n < 1048576 ? `${Math.ceil(n / 1024)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`
const message = e => typeof e?.payload?.error === 'string' ? e.payload.error : '请求未完成，请稍后刷新核对。'
const action = (path, body) => apiRequest('/offline-downloads/' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
async function refresh() {
  if (refreshing || busy.value || !alive) return
  refreshing = true
  try { const result = await action('status'); if (alive) { state.value = result; error.value = '' } }
  catch (e) { if (alive) error.value = message(e) }
  finally { refreshing = false }
}
function fillName() {
  if (name.value) return
  try { const parsed = new URL(url.value); name.value = decodeURIComponent(parsed.pathname.split('/').pop() || '').slice(0, 255) } catch { /* manual filename */ }
}
async function change(path, body) {
  if (busy.value) return
  busy.value = true; emit('busy', true); error.value = ''; notice.value = ''
  let ok = false
  try { await action(path, body); ok = true }
  catch (e) { error.value = message(e) }
  finally { busy.value = false; emit('busy', false) }
  if (ok && alive) await refresh()
  return ok
}
async function add() {
  if (!name.value || /[\x00-\x1f\x7f/\\]/.test(name.value) || name.value !== name.value.trim() || ['.', '..'].includes(name.value)) { error.value = '请输入不含斜杠和首尾空格的文件名。'; return }
  if (await change('add', { url: url.value, destination: `${destination.value}/${name.value}` })) { url.value = ''; name.value = ''; notice.value = '任务已提交。可以关闭网页，下载节点会继续处理。' }
}
async function control(id, command) { if (await change('control', { id, command })) cancelId.value = '' }
onMounted(() => { void refresh(); timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000) })
onBeforeUnmount(() => { alive = false; clearInterval(timer); emit('busy', false) })
</script>
<template>
  <section class="offline-panel">
    <p class="intro">粘贴文件直链，服务器下载后上传到个人 Dropbox。无需保持本页打开；暂不支持磁力、种子或需要登录的分享页。</p>
    <div class="connection"><span><i :class="{ online: state?.workerOnline }"></i>{{ state?.workerOnline ? '下载节点在线' : '等待下载节点连接' }}</span><button :disabled="busy" aria-label="刷新离线任务" @click="refresh"><Icon name="refresh" :size="16" /></button></div>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <form v-if="state?.enabled" @submit.prevent="add">
      <label for="offline-url">文件下载链接</label><input id="offline-url" v-model="url" type="url" maxlength="8192" autocomplete="off" spellcheck="false" placeholder="https://…" :disabled="busy" required @blur="fillName">
      <label for="offline-name">保存的文件名</label><input id="offline-name" v-model="name" maxlength="255" autocomplete="off" :disabled="busy" placeholder="例如：旅行视频.mp4" required>
      <div class="target"><span>Dropbox 目录：{{ destination || '根目录' }}</span><button type="button" :disabled="busy" @click="choosing = !choosing">选择目录</button></div>
      <FolderPicker v-if="choosing" @choose="destination = $event; choosing = false" />
      <p class="intro">最多 {{ size(state.maxBytes) }} / 文件，单任务运行。暂停会保留暂存文件并阻塞后续任务；取消后才会清理。备份目录不可选。</p>
      <p class="intro">{{ state.uploadPersistence === 'encrypted_disk' ? '上传进度已加密保存，服务重启后可从已确认位置继续；结果不明时暂停核对。' : '上传进度仅在当前服务进程保留；重启后可能需要从节点缓存重新上传。' }}</p>
      <button class="primary" :disabled="busy || !url || !name">创建离线任务</button>
    </form>
    <div v-if="state" class="queue-heading"><h3>任务列表 · {{ state.entries.length }}</h3><button :disabled="busy" @click="change('clear', {})">清理完成记录</button></div>
    <p v-if="state && !state.entries.length" class="intro">还没有任务。下载完成并校验后自动清理服务器暂存文件，不删除 Dropbox 中的文件。</p>
    <ul v-if="state" aria-label="离线下载任务"><li v-for="job in state.entries" :key="job.id">
      <div class="job-heading"><strong>{{ job.name }}</strong><span>{{ job.intent === 'pause' && !['paused', 'complete', 'error'].includes(job.state) ? '正在暂停…' : labels[job.state] || '待核对' }}</span></div>
      <small>{{ job.destination }}</small><progress :value="job.state === 'uploading' ? job.uploaded : job.downloaded" :max="job.size || 1" :aria-label="`${job.name} 进度`" />
      <small>已下载 {{ size(job.downloaded) }} / {{ size(job.size) }}<template v-if="job.uploaded"> · 已上传 {{ size(job.uploaded) }}</template></small>
      <p v-if="job.error" class="error">{{ reasons[job.error] || '任务未完成，可检查链接或节点状态后重试。' }}</p>
      <div class="actions">
        <button v-if="['queued', 'downloading', 'uploading'].includes(job.state)" :disabled="busy || job.intent !== 'run'" @click="control(job.id, 'pause')">暂停</button>
        <button v-if="['paused', 'error'].includes(job.state)" :disabled="busy" @click="control(job.id, 'resume')">{{ job.state === 'error' ? '重试' : '继续' }}</button>
        <button v-if="!['complete', 'cancelled', 'committing', 'review'].includes(job.state)" :disabled="busy" @click="cancelId = job.id">取消任务</button>
      </div>
      <div v-if="cancelId === job.id" class="confirmation"><p>确认取消此任务并清理它的服务器暂存文件？不会删除 Dropbox 文件。</p><button :disabled="busy" @click="cancelId = ''">返回</button><button :disabled="busy" @click="control(job.id, 'cancel')">确认取消</button></div>
    </li></ul>
    <p class="intro">仅限本人管理的个人文件。含临时签名的链接不会显示在任务列表或写入普通日志；服务器不执行下载的文件。暂停/失败任务保留暂存文件，需继续或取消。</p>
  </section>
</template>
<style scoped>
.offline-panel{display:grid;gap:16px;font-size:14px;color:var(--text-primary)}.intro,small{font-size:12px;color:var(--text-secondary);line-height:1.8;margin:0}.offline-panel button{font:inherit;min-height:40px;padding:9px 13px;background:var(--bg-secondary);color:inherit;border:1px solid var(--border-color);border-radius:11px;cursor:pointer}.offline-panel button:disabled{opacity:.5;cursor:not-allowed}.offline-panel :is(input,button):focus-visible{outline:2px solid var(--accent-color);outline-offset:3px}.offline-panel form{display:grid;gap:10px;padding:16px;border:1px solid var(--border-color);border-radius:14px}.offline-panel input{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--border-color);border-radius:9px;padding:12px;background:var(--bg-primary);color:inherit;font:inherit}.offline-panel .primary{background:var(--accent-color);color:white}.connection,.target,.queue-heading,.job-heading,.actions{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.connection i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:var(--text-muted)}.connection i.online{background:#507b63}.target span,.job-heading strong{min-width:0;overflow-wrap:anywhere}.queue-heading h3{font-size:15px;margin:0}.offline-panel ul{list-style:none;padding:0;margin:0;display:grid;gap:12px}.offline-panel li{padding:16px;border:1px solid var(--border-color);border-radius:14px}.job-heading span{font-size:12px;color:var(--text-secondary)}small{display:block;overflow-wrap:anywhere}.offline-panel progress{display:block;width:100%;height:5px;margin:12px 0;accent-color:var(--accent-color)}.actions{justify-content:flex-start;margin-top:10px}.error{color:var(--danger-color,#a84444);line-height:1.7}.confirmation{padding:12px;background:var(--bg-secondary);border-radius:10px;margin-top:10px}.confirmation button+button{margin-left:8px}@media(max-width:440px){.offline-panel form,.offline-panel li{padding:12px}.target{align-items:flex-start;flex-direction:column}}
</style>
