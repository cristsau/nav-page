<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { apiRequest } from '@/shared/services/apiClient'
import FolderPicker from './FolderPicker.vue'
import { taskFilters, taskCounts, taskGroup, taskProgress, transferBytes as size } from './taskPresentation'
const props = defineProps({ directory: { type: String, default: '' }, video: { type: Object, default: null } })
const emit = defineEmits(['busy'])
const state = ref(null), url = ref(''), name = ref(''), destination = ref(props.directory), choosing = ref(false)
const busy = ref(false), refreshing = ref(false), error = ref(''), refreshError = ref(''), notice = ref(''), cancelId = ref('')
const filter = ref('all'), composer = ref(true), lastChecked = ref(null), pending = ref(''), queueHeading = ref(null)
const kind = ref(props.video ? 'video' : 'http'), torrent = ref(''), torrentName = ref(''), selections = ref({})
if (props.video) name.value = props.video.name.replace(/\.[^.]+$/, '') + '.compatible.mp4'
let alive = true, timer, sequence = 0
const labels = { queued: '排队中', selecting: '请选择种子文件', downloading: '下载到服务器', paused: '已暂停', uploading: '上传到 Dropbox', committing: '正在校验', complete: '已完成', cancelled: '已取消', error: '等待处理', review: '需核对云端结果' }
const stages = { metadata: '读取种子目录', bt_download: 'BT 下载中', source_download: '读取原视频', inspecting: '检查视频信息', transcoding: '后台转码中', verifying: '校验兼容副本' }
const reasons = { DOWNLOAD_TOO_LARGE: '文件超过节点单文件上限', DOWNLOAD_DISK_LIMIT: '服务器剩余空间不足，已停止', UNSAFE_DOWNLOAD_HOST: '目标地址不符合公网下载安全要求', DOWNLOAD_NOT_DIRECT_FILE: '不是可直接下载的文件，或服务器未提供大小', DOWNLOAD_HTTP_FAILED: '来源链接失效或拒绝下载', DOWNLOAD_RANGE_CHANGED: '来源文件发生变化，请更换链接', TARGET_EXISTS: 'Dropbox 已有同名项目，请核对', COMMIT_RESULT_UNKNOWN: '请先到目标目录核对，不能盲目重传' }
const entries = computed(() => state.value?.entries || [])
const counts = computed(() => taskCounts(entries.value))
const visible = computed(() => entries.value.filter(job => filter.value === 'all' || taskGroup(job) === filter.value))
const unavailable = computed(() => busy.value || !state.value?.enabled || !!refreshError.value)
const mediaUnavailable = computed(() => kind.value !== 'http' && !state.value?.media?.[kind.value === 'video' ? 'video' : 'bt'])
const hasSource = computed(() => kind.value === 'video' ? !!props.video : kind.value === 'torrent' ? !!torrent.value : !!url.value)
const connection = computed(() => refreshError.value ? '状态暂不可用' : !state.value ? '正在连接下载节点' : !state.value.enabled ? '离线下载尚未启用' : state.value.workerOnline ? '下载节点在线' : '等待下载节点连接')
const message = e => typeof e?.payload?.error === 'string' ? e.payload.error : '请求未完成，请稍后刷新核对。'
const action = (path, body) => apiRequest('/offline-downloads/' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
function schedule() { clearTimeout(timer); if (alive) timer = setTimeout(() => document.visibilityState === 'visible' ? refresh() : schedule(), 5000) }
async function refresh() {
  if (refreshing.value || busy.value || !alive) return
  refreshing.value = true
  const requestSequence = ++sequence
  try { const result = await action('status'); if (alive && requestSequence === sequence) { if (!state.value && result.entries?.length && !props.video) composer.value = false; state.value = result; refreshError.value = ''; lastChecked.value = new Date() } }
  catch (e) { if (alive && requestSequence === sequence) refreshError.value = message(e) }
  finally { refreshing.value = false; if (alive && !busy.value && requestSequence !== sequence) void refresh(); else schedule() }
}
function fillName() {
  if (name.value) return
  try { const parsed = new URL(url.value); name.value = decodeURIComponent(parsed.pathname.split('/').pop() || '').slice(0, 255) } catch { /* manual filename */ }
}
async function change(path, body) {
  if (unavailable.value) return false
  sequence++ // An older status response must not overwrite post-action feedback.
  busy.value = true; pending.value = path === 'control' ? body.id + ':' + body.command : path
  emit('busy', true); error.value = ''; notice.value = ''; clearTimeout(timer)
  let ok = false
  try {
    const result = await action(path, body); ok = true
    if (alive && path === 'clear') notice.value = Number.isSafeInteger(result.removed)
      ? `已清理 ${result.removed} 条记录。${result.pendingCleanup ? `另有 ${result.pendingCleanup} 条等待节点清理缓存，稍后再清理记录即可。` : 'Dropbox 文件保持不变。'}`
      : '清理请求已处理，请查看刷新后的列表。'
  }
  catch (e) { if (alive) error.value = message(e) }
  finally { busy.value = false; pending.value = ''; emit('busy', false) }
  // Status reads never erase a mutation error or retry a write.
  if (alive) await refresh()
  return ok
}
async function add() {
  if (mediaUnavailable.value) { error.value = '媒体节点尚未就绪，请稍后刷新。'; return }
  if (['http', 'magnet'].includes(kind.value)) {
    try { const parsed = new URL(url.value); if (!(kind.value === 'magnet' ? ['magnet:'] : ['http:', 'https:']).includes(parsed.protocol) || parsed.username || parsed.password) throw Error() }
    catch { error.value = kind.value === 'magnet' ? '请输入有效的 magnet: 磁力链接。' : '请输入 HTTP 或 HTTPS 文件直链，不含账号密码。'; return }
  }
  if (!name.value || /[\x00-\x1f\x7f/\\]/.test(name.value) || name.value !== name.value.trim() || ['.', '..'].includes(name.value)) { error.value = '请输入不含斜杠和首尾空格的文件名。'; return }
  if (await change('add', { kind: kind.value, url: url.value, torrent: torrent.value || undefined,
    ...(kind.value === 'video' ? { sourceId: props.video.id, sourceRev: props.video.rev } : {}), destination: destination.value + '/' + name.value })) {
    url.value = ''; name.value = ''; torrent.value = ''; torrentName.value = ''; filter.value = 'all'; composer.value = false; notice.value = ['magnet', 'torrent'].includes(kind.value) ? '正在读取种子目录，请稍后在任务中选择需要下载的文件。' : '任务已提交。可以关闭网页，下载节点会继续处理。'
    await nextTick(); queueHeading.value?.focus()
  }
}
async function readTorrent(event) {
  const file = event.target.files?.[0]; torrent.value = ''; torrentName.value = ''
  if (!file) return
  if (file.size > 1024 * 1024 || !/\.torrent$/i.test(file.name)) { error.value = '请选择不超过 1 MiB 的 .torrent 文件。'; event.target.value = ''; return }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    if (!alive) return
    torrent.value = btoa(binary); torrentName.value = file.name; error.value = ''
  } catch { error.value = '未能读取种子文件，请重新选择。' }
}
async function control(id, command) { if (await change('control', { id, command })) cancelId.value = '' }
function label(job) {
  if (job.intent === 'cancel' && !['complete', 'cancelled', 'review'].includes(job.state)) return '正在取消…'
  if (job.intent === 'pause' && !['paused', 'complete', 'error'].includes(job.state)) return '正在暂停…'
  return job.state === 'downloading' && stages[job.stage] ? stages[job.stage] : labels[job.state] || '待核对'
}
onMounted(refresh)
onBeforeUnmount(() => { alive = false; clearTimeout(timer); emit('busy', false) })
</script>
<template>
  <section class="offline-panel" aria-label="离线下载管理">
    <div class="connection"><div><span class="connection-mark"><Icon name="cloud" :size="20" /></span><span><strong>{{ connection }}</strong><small>{{ refreshError ? '下方保留上次结果，刷新成功后再操作' : lastChecked ? '更新于 ' + lastChecked.toLocaleTimeString('zh-CN', { hour12: false }) + ' · 可关闭网页' : '正在读取任务与连接状态' }}</small></span></div><button :disabled="busy || refreshing" aria-label="刷新离线任务" @click="refresh"><Icon name="refresh" :size="16" :class="{ spinning: refreshing }" /></button></div>
    <p v-if="refreshError" class="feedback error" role="alert">{{ refreshError }}<span>保留的任务状态不代表当前进度。</span></p>
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p><p v-if="notice" class="feedback" role="status"><Icon name="check" :size="16" />{{ notice }}</p>
    <div v-if="state?.enabled" class="composer">
      <button class="composer-toggle" :aria-expanded="composer" aria-controls="offline-create-form" @click="composer = !composer"><span><Icon name="plus" :size="17" />新建离线任务</span><Icon name="chevron-down" :size="16" :class="{ expanded: composer }" /></button>
      <form v-show="composer" id="offline-create-form" @submit.prevent="add">
        <div class="source-types" role="group" aria-label="任务类型"><button v-for="[type, title] in [['http', '文件直链'], ['magnet', '磁力链接'], ['torrent', '种子文件'], ...(video ? [['video', '兼容视频副本']] : [])]" :key="type" type="button" :aria-pressed="kind === type" :disabled="busy" @click="kind = type; error = ''">{{ title }}</button></div>
        <p v-if="kind === 'http'" class="intro">粘贴公开 HTTP(S) 文件直链，下载后自动上传到 Dropbox。不支持需要登录的分享页。</p>
        <p v-else-if="kind === 'video'" class="intro">将「{{ video?.name }}」生成 720p H.264 / AAC MP4 副本，保留原视频。后台单线程处理，可能耗时较长；最长 4 小时，空间不足会暂停。</p>
        <p v-else class="intro">仅支持公开 v1 种子；读取目录后请选择一个文件。整个种子总量 ≤ 6 GiB，不支持私有 PT / v2-only。下载时可能向同伴上传（限 64 KiB/s），完成后停止做种。</p>
        <p v-if="mediaUnavailable" class="feedback" role="status">媒体节点尚未就绪，暂不能创建此类任务。</p>
        <template v-if="['http', 'magnet'].includes(kind)"><label for="offline-url">{{ kind === 'magnet' ? '磁力链接' : '文件下载链接' }}</label><input id="offline-url" v-model="url" type="url" maxlength="8192" autocomplete="off" spellcheck="false" :placeholder="kind === 'magnet' ? 'magnet:?xt=urn:btih:…' : 'https://…'" :disabled="busy" required @blur="kind === 'http' && fillName()"></template>
        <template v-if="kind === 'torrent'"><label for="offline-torrent">种子文件（≤ 1 MiB）</label><input id="offline-torrent" type="file" accept=".torrent" :disabled="busy" @change="readTorrent"><small v-if="torrentName">已选择：{{ torrentName }}</small></template>
        <label for="offline-name">保存的文件名</label><input id="offline-name" v-model="name" maxlength="255" autocomplete="off" :disabled="busy" placeholder="例如：旅行视频.mp4" required>
        <div class="target"><Icon name="folder" :size="16" /><span><small>保存位置</small>{{ destination || 'Dropbox 根目录' }}</span><button type="button" :disabled="unavailable" @click="choosing = !choosing">选择目录</button></div>
        <FolderPicker v-if="choosing" @choose="destination = $event; choosing = false" />
        <div class="create-footer"><span>{{ size(state.maxBytes) }} / 文件 · 同时运行 1 项</span><button class="primary" :disabled="unavailable || mediaUnavailable || !hasSource || !name"><Icon :name="pending === 'add' ? 'refresh' : 'plus'" :size="15" :class="{ spinning: pending === 'add' }" />{{ pending === 'add' ? '提交中…' : '创建离线任务' }}</button></div>
      </form>
    </div>
    <div v-if="state" class="queue-heading"><h3 ref="queueHeading" tabindex="-1">任务列表 <span>{{ entries.length }}</span></h3><button :disabled="unavailable || !counts.finished" @click="change('clear', {})">{{ pending === 'clear' ? '清理中…' : '清理完成记录' }}</button></div>
    <div v-if="entries.length" class="queue-filters" role="group" aria-label="离线任务筛选"><button v-for="[key, title] in taskFilters" :key="key" :aria-pressed="filter === key" @click="filter = key; cancelId = ''">{{ title }} <span>{{ counts[key] }}</span></button></div>
    <div v-if="state && !visible.length" class="queue-empty"><Icon :name="entries.length ? 'search' : 'download'" :size="28" /><strong>{{ entries.length ? '此分类暂无任务' : '还没有下载任务' }}</strong><p>{{ entries.length ? '切换分类查看其他任务；筛选不会暂停下载。' : '添加直链后，这里会显示下载、上传和校验进度。' }}</p></div>
    <ul v-if="state" class="offline-jobs" aria-label="离线下载任务"><li v-for="job in visible" :key="job.id">
      <div class="job-heading"><strong>{{ job.name }}</strong><span class="job-badge" :data-tone="taskGroup(job)">{{ label(job) }}</span></div>
      <small class="job-destination">{{ job.destination }}</small>
      <div v-if="job.state === 'selecting'" class="torrent-selection"><label :for="'select-' + job.id">选择要保存的文件</label><select :id="'select-' + job.id" v-model="selections[job.id]" :disabled="unavailable"><option :value="undefined" disabled>请选择，不会自动下载全部文件</option><option v-for="file in job.metadata?.files || []" :key="file.index" :value="file.index">{{ file.path }} · {{ size(file.size) }}</option></select><button class="primary" :disabled="unavailable || !selections[job.id]" @click="change('select', { id: job.id, selection: selections[job.id] })">确认文件并开始下载</button></div>
      <p v-if="job.kind === 'video' && job.state === 'downloading' && ['inspecting', 'transcoding', 'verifying'].includes(job.stage)" class="feedback" role="status">{{ stages[job.stage] }}。后台运行，不必保持网页打开；处理完成后再上传副本。</p>
      <div class="job-stages" aria-label="任务传输阶段">
        <div><span><Icon name="download" :size="13" />下载到节点 <b>{{ taskProgress(job.downloaded, job.size, job.state === 'complete') }}%</b></span><progress :value="taskProgress(job.downloaded, job.size, job.state === 'complete')" max="100" :aria-label="job.name + ' 下载进度'" /></div>
        <div><span><Icon name="upload" :size="13" />上传到网盘 <b>{{ taskProgress(job.uploaded, job.size, job.state === 'complete') }}%</b></span><progress :value="taskProgress(job.uploaded, job.size, job.state === 'complete')" max="100" :aria-label="job.name + ' 上传进度'" /></div>
      </div>
      <small>已下载 {{ size(job.downloaded) }} / {{ size(job.size) }} · 已上传 {{ size(job.uploaded) }}</small>
      <p v-if="job.error" class="feedback error">{{ reasons[job.error] || '任务未完成，可检查链接或节点状态后重试。' }}</p>
      <p v-if="job.cleanupPending" class="feedback">任务已结束，等待下载节点清理缓存；云端文件不会被删除。</p>
      <div class="actions">
        <button v-if="['queued', 'downloading', 'uploading'].includes(job.state)" :disabled="unavailable || job.intent !== 'run'" @click="control(job.id, 'pause')">{{ pending === job.id + ':pause' ? '暂停中…' : '暂停' }}</button>
        <button v-if="['paused', 'error'].includes(job.state)" class="resume" :disabled="unavailable" @click="control(job.id, 'resume')">{{ pending === job.id + ':resume' ? '提交中…' : job.state === 'error' ? '重试' : '继续' }}</button>
        <button v-if="!['complete', 'cancelled', 'committing', 'review'].includes(job.state)" :disabled="unavailable || job.intent === 'cancel'" @click="cancelId = job.id">取消任务</button>
      </div>
      <div v-if="cancelId === job.id && !['complete', 'cancelled', 'committing', 'review'].includes(job.state)" class="confirmation"><p>确认取消此任务并清理它的服务器暂存文件？不会删除 Dropbox 文件。</p><div><button :disabled="busy" @click="cancelId = ''">返回</button><button :disabled="unavailable" class="danger" @click="control(job.id, 'cancel')">{{ pending === job.id + ':cancel' ? '取消中…' : '确认取消' }}</button></div></div>
    </li></ul>
    <details class="offline-help"><summary>下载规则与数据安全</summary><p>暂停/失败会保留暂存并阻塞后续任务，需继续或取消。完成校验后自动清理节点暂存；清理完成记录不删除 Dropbox 文件。备份目录不可选。</p><p>{{ state?.uploadPersistence === 'encrypted_disk' ? '上传进度已加密保存，服务重启后可从已确认位置继续；结果不明时暂停核对。' : '上传进度仅在当前服务进程保留；重启后可能需要从节点缓存重新上传。' }}</p><p>仅限本人管理的个人文件。临时签名链接不会显示在任务列表或写入普通日志；服务器不执行下载的文件。</p></details>
  </section>
</template>
<style scoped>
.source-types{display:flex;flex-wrap:wrap;gap:6px}.source-types button[aria-pressed=true]{background:var(--accent-bg);color:var(--accent-color);border-color:var(--accent-color)}.torrent-selection{display:grid;gap:10px;margin:14px 0;padding:12px;background:var(--bg-secondary);border-radius:10px}.torrent-selection select{width:100%;min-width:0;max-width:100%;font:inherit;color:inherit;background:var(--bg-primary);padding:10px;border:1px solid var(--border-color);border-radius:8px}.torrent-selection label{font-weight:550}
.offline-panel{display:grid;gap:16px;font-size:13px;color:var(--text-primary)}.intro,small{font-size:11px;color:var(--text-secondary);line-height:1.8;margin:0}.offline-panel button{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:12px;min-height:38px;padding:8px 12px;background:var(--bg-primary);color:inherit;border:1px solid var(--border-color);border-radius:9px;cursor:pointer}.offline-panel button:hover:not(:disabled){background:var(--bg-hover)}.offline-panel button:disabled{opacity:.45;cursor:not-allowed}.offline-panel :is(input,button,summary):focus-visible{outline:2px solid var(--accent-color);outline-offset:3px}
.connection{display:flex;gap:12px;align-items:center;justify-content:space-between}.connection>div{display:flex;gap:10px;align-items:center;min-width:0}.connection strong{font-size:13px;font-weight:550}.connection small{display:block;font-size:11px}.connection-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--accent-bg);color:var(--accent-color);flex-shrink:0}.connection>button{flex-shrink:0;width:38px;padding:0}.composer{border:1px solid var(--border-color);border-radius:14px;overflow:hidden}.offline-panel .composer-toggle{display:flex;width:100%;justify-content:space-between;border:0;border-radius:0;padding:14px 16px;background:var(--bg-secondary);font-weight:550}.composer-toggle span{display:flex;align-items:center;gap:8px}.expanded{transform:rotate(180deg)}.offline-panel form{display:grid;gap:10px;padding:16px}.offline-panel form>label{font-size:12px;font-weight:550;margin-top:4px}.offline-panel input{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--border-color);border-radius:9px;padding:11px;background:var(--bg-primary);color:inherit;font:inherit}.offline-panel .primary{background:var(--accent-color);color:var(--text-inverse,#fff);border-color:var(--accent-color)}.target{display:flex;align-items:center;gap:8px;border:1px solid var(--border-light);padding:10px;border-radius:10px;margin-top:4px}.target>svg{flex-shrink:0;color:var(--text-muted)}.target span{flex:1;overflow-wrap:anywhere;min-width:0;font-size:12px}.target small{display:block;font-size:10px}.target button{flex-shrink:0}.create-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:6px}.create-footer>span{font-size:11px;color:var(--text-muted)}.queue-heading,.job-heading,.actions{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.queue-heading h3{font-size:14px;margin:0}.queue-heading h3 span{font-size:11px;color:var(--text-muted);font-weight:400;margin-left:5px}.queue-heading>button{font-size:11px}.queue-filters{display:flex;gap:5px;flex-wrap:wrap}.queue-filters button{background:var(--bg-secondary);border-color:transparent;gap:7px;min-height:34px}.queue-filters button[aria-pressed=true]{background:var(--accent-bg);color:var(--accent-color);border-color:var(--border-color)}.queue-filters span{font-size:10px;opacity:.75}.offline-jobs{list-style:none;padding:0;margin:0;display:grid;gap:12px}.offline-jobs li{padding:16px;border:1px solid var(--border-color);border-radius:14px}.job-heading strong{font-weight:550;min-width:0;overflow-wrap:anywhere;flex:1}.job-heading .job-badge{font-size:11px;color:var(--text-secondary);padding:4px 8px;border-radius:6px;background:var(--bg-secondary)}.job-badge[data-tone=active]{color:var(--accent-color);background:var(--accent-bg)}.job-badge[data-tone=attention]{border:1px solid var(--border-color)}.job-destination{display:block;margin-top:5px;overflow-wrap:anywhere}.job-stages{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:14px 0 8px}.job-stages>div{min-width:0}.job-stages span{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--text-secondary)}.job-stages b{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:500}.job-stages progress{display:block;width:100%;height:5px;accent-color:var(--accent-color);margin-top:8px}.actions{justify-content:flex-end;margin-top:12px}.actions:empty{display:none}.offline-panel .resume{color:var(--accent-color);background:var(--accent-bg)}.feedback{display:flex;align-items:flex-start;gap:8px;margin:0;padding:12px;border-radius:9px;background:var(--bg-secondary);font-size:12px;line-height:1.7;overflow-wrap:anywhere}.feedback svg{flex-shrink:0;margin-top:2px}.feedback.error{display:block;color:var(--danger-color,#a84444);border-left:3px solid currentColor}.feedback span{display:block}.offline-jobs .feedback{margin-top:10px}.confirmation{padding:12px;background:var(--bg-secondary);border-radius:10px;margin-top:12px}.confirmation p{font-size:12px;line-height:1.7;margin:0 0 10px}.confirmation>div{display:flex;justify-content:flex-end;gap:8px}.offline-panel .danger{color:var(--danger-color,#a84444)}.queue-empty{padding:24px 14px;display:grid;justify-items:center;gap:10px;background:var(--bg-secondary);border-radius:12px;text-align:center;color:var(--text-secondary)}.queue-empty strong{font-size:13px;color:var(--text-primary);font-weight:550}.queue-empty p{font-size:12px;line-height:1.7;margin:0}.offline-help{font-size:11px;color:var(--text-secondary);border-top:1px solid var(--border-light);padding-top:14px}.offline-help summary{cursor:pointer}.offline-help p{line-height:1.8;margin:10px 0 0}.spinning{animation:offline-spin .8s linear infinite}@keyframes offline-spin{to{transform:rotate(360deg)}}
@media(max-width:440px){.offline-panel{gap:12px}.offline-panel form,.offline-jobs li{padding:12px}.composer-toggle{padding:12px!important}.target{flex-wrap:wrap}.target button{margin-left:24px}.create-footer{flex-direction:column;align-items:stretch}.create-footer button{min-height:42px}.job-heading strong{flex-basis:100%}.job-stages{gap:10px}.job-stages span{flex-wrap:wrap;font-size:10px}.job-stages svg{display:none}.queue-filters{gap:3px}.queue-filters button{padding:6px 8px;font-size:11px}.actions button{min-height:40px}}
@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
</style>
