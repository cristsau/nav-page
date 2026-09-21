<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import Modal from '@/shared/components/Modal.vue'
import { fetchDropboxBackupControl, requestDropboxBackupJob, saveDropboxBackupSchedule, dropboxCiphertextUrl } from '@/shared/services/integrationApi'

const props = defineProps({ points: { type: Array, default: () => [] } })
const emit = defineEmits(['updated'])
const state = ref(null), loading = ref(false), saving = ref(false), error = ref(''), notice = ref('')
const dialog = ref(''), pointId = ref(''), draftTime = ref('03:45'), draftEnabled = ref(false), pending = ref(null), expanded = ref(false)
let timer, disposed = false
const ready = computed(() => state.value?.connected === true)
const blocked = computed(() => !ready.value || state.value.busy || state.value.reviewRequired || saving.value || !!pending.value)
const jobs = computed(() => (state.value?.jobs || []).slice(0, expanded.value ? 50 : 5))
const states = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '未完成', review: '需人工核对' }
const stages = { queued: '等待执行器', snapshot: '创建本地快照', upload: '加密上传并回读校验', verify: '回读并校验密文', completed: '已校验，不代表恢复验收', stopped: '已停止' }
const errors = { INTERRUPTED_REVIEW_REQUIRED: '执行器中断，先核对结果再继续', BACKUP_REVIEW_REQUIRED: '备份未完整确认，不会自动重复执行',
  OPERATION_DISABLED: '执行前安全条件发生变化', VERIFICATION_FAILED: '密文校验失败，请检查连接与备份记录' }
const when = value => new Date(value).toLocaleString('zh-CN', { hour12: false })
async function refresh({ preserveError = false } = {}) {
  if (loading.value || disposed) return
  loading.value = true
  try {
    const oldBusy = state.value?.busy, next = await fetchDropboxBackupControl()
    if (disposed) return
    state.value = next; if (!preserveError) error.value = ''
    if (pending.value && next.jobs?.some(j => j.id === pending.value.id)) {
      pending.value = null; dialog.value = ''; notice.value = '请求已在任务记录中确认，不会重复创建。'
    }
    if (oldBusy && !next.busy) emit('updated')
  } catch (e) { if (!disposed) { state.value = null; error.value = e.message || '暂时无法读取执行器状态。' } }
  finally {
    loading.value = false; clearTimeout(timer)
    if (!disposed && (state.value?.busy || pending.value)) timer = setTimeout(() => { if (!document.hidden) refresh(); else timer = setTimeout(refresh, 15000) }, 5000)
  }
}
function open(kind, id = '') {
  dialog.value = kind; pointId.value = id; error.value = ''; notice.value = ''
  if (kind === 'schedule') { draftEnabled.value = state.value.schedule.enabled; draftTime.value = state.value.schedule.time }
}
async function submit() {
  if (saving.value) return
  saving.value = true; error.value = ''
  try {
    if (dialog.value === 'schedule') {
      await saveDropboxBackupSchedule({ enabled: draftEnabled.value, time: draftTime.value, revision: state.value.revision })
      notice.value = draftEnabled.value ? '定时设置已保存；首次运行从明天开始。' : '定时设置已保存，自动任务关闭。'
    } else {
      if (!pending.value) pending.value = { id: crypto.randomUUID().replaceAll('-', ''), kind: dialog.value,
        ...(dialog.value === 'verify' ? { pointId: pointId.value } : {}) }
      await requestDropboxBackupJob(pending.value)
      pending.value = null; notice.value = '请求已登记，请在下方任务记录中查看执行结果。'
    }
    dialog.value = ''
  } catch (e) { error.value = e.message || '请求结果尚未确认，请刷新核对任务记录。' }
  finally { saving.value = false; await refresh({ preserveError: true }) }
}
function close() { if (!saving.value) dialog.value = '' }
onMounted(refresh)
onBeforeUnmount(() => { disposed = true; clearTimeout(timer) })
</script>

<template>
  <section class="backup-actions" aria-labelledby="backup-actions-title" :aria-busy="saving">
    <header><div><h5 id="backup-actions-title">备份操作</h5><p>手动执行与自动计划分开管理，恢复私钥始终不进入网页。</p></div>
      <button class="backup-button" :disabled="loading" @click="refresh"><Icon name="refresh" :size="15" />{{ loading ? '读取中' : '刷新任务' }}</button></header>
    <p v-if="!ready && !error" class="backup-tip">执行器尚未接通。安装并授权后才能操作；下方备份记录仍可独立查看。</p>
    <p v-if="error" class="backup-alert" role="alert">{{ error }}</p>
    <p v-if="notice" class="backup-tip" role="status">{{ notice }}</p>
    <p v-if="pending" class="backup-alert">请求结果待确认。请刷新核对；如需重新发送，将沿用同一请求编号。<button class="backup-button" :disabled="saving || !ready" @click="dialog = pending.kind">查看待确认请求</button></p>
    <p v-if="state?.reviewRequired" class="backup-alert">有任务中断或结果不明，已暂停新的备份。管理员需先核对台账，不会自动重试。</p>
    <div class="backup-toolbar">
      <button class="backup-button backup-primary" :disabled="blocked || !state?.capabilities.backup" @click="open('backup')"><Icon name="upload" :size="17" />立即备份</button>
      <button class="backup-button" :disabled="!ready || saving || !!pending" @click="open('schedule')"><Icon name="clock" :size="17" />定时设置</button>
      <span v-if="ready" class="backup-schedule-status">{{ state.schedule.active ? `每天 ${state.schedule.time}（北京时间）` : state.schedule.enabled ? '已配置，但安全条件未满足，暂停执行' : '自动备份未开启' }}</span>
    </div>
    <details v-if="points.length" class="backup-downloads"><summary>校验与下载云端密文</summary>
      <p>按记录的精确版本回读并检查大小、SHA-256 和 Dropbox 内容哈希，不解密、不覆盖；下载只传密文，不在服务器额外保存一份。</p>
      <ul><li v-for="point in points" :key="point.id"><div><strong>{{ when(point.createdAt) }}</strong><code>{{ point.id }}</code></div>
        <button class="backup-button" :disabled="blocked || !state?.capabilities.verify" @click="open('verify', point.id)">校验</button>
        <button class="backup-button" :disabled="blocked || !state?.capabilities.download" @click="open('download', point.id)">下载</button></li></ul>
    </details>
    <div v-if="ready" class="backup-jobs"><h6>最近任务 <span>{{ state.jobs.length }} 条 · 最多保留 50 条近期记录</span></h6>
      <p v-if="!jobs.length" class="backup-tip">还没有通过此入口发起任务。</p>
      <ol v-else><li v-for="job in jobs" :key="job.id"><div class="backup-job-main"><strong>{{ job.kind === 'backup' ? '加密备份' : '密文校验' }}</strong><span :class="['backup-badge', job.state]">{{ states[job.state] }}</span></div>
        <p>{{ errors[job.code] || stages[job.stage] }}</p><small>{{ when(job.createdAt) }} · {{ job.source === 'schedule' ? '定时' : '手动' }}</small></li></ol>
      <button v-if="state.jobs.length > 5" class="backup-button" @click="expanded = !expanded">{{ expanded ? '收起' : '查看全部近期任务' }}</button>
    </div>
    <Modal :show="!!dialog" :title="({ backup: '立即加密备份', verify: '校验云端密文', download: '下载加密备份', schedule: '定时备份' })[dialog]" width="480px" :close-disabled="saving" @close="close">
      <div class="backup-confirm">
        <template v-if="dialog === 'backup'"><p>创建 NAV 本地快照，加密上传到专用 Dropbox 文件夹，再回读校验。</p><p>上限 3 份 / 5 GB。容量不足或状态不明时停止；只有已开放并满足保护条件的轮换才会执行。不恢复、不覆盖业务数据。</p></template>
        <template v-else-if="dialog === 'verify'"><p>重新下载所选备份进行完整密文哈希校验，会使用服务器和 Dropbox 流量；不保存明文，也不等于恢复演练。</p><code>{{ pointId }}</code></template>
        <template v-else-if="dialog === 'download'"><p>下载的是 .tar.age 加密文件。恢复仍需要独立保存的恢复钥匙和口令，请勿上传或粘贴到网页。</p><p>连接或校验失败时下载会中断，请检查浏览器下载结果；不要把半份文件当成完整备份。</p><code>{{ pointId }}</code></template>
        <template v-else-if="dialog === 'schedule'"><label class="backup-toggle"><input v-model="draftEnabled" type="checkbox" :disabled="!state?.capabilities.schedule && !draftEnabled" />开启每日备份</label>
          <label class="backup-time">北京时间<input v-model="draftTime" type="time" required /></label>
          <p>保存后从明天开始，每天最多一次；错过多天不补跑积压任务。停止定时不会中止正在执行的任务。</p>
          <p v-if="!state?.capabilities.schedule" class="backup-alert">最终恢复验证和服务器授权尚未齐备。可以先保存关闭状态的时间设置，暂不能开启。</p></template>
        <p v-if="error" class="backup-alert" role="alert">{{ error }}</p>
      </div>
      <template #footer><div class="backup-dialog-footer"><button class="backup-button" :disabled="saving" @click="close">取消</button>
        <a v-if="dialog === 'download'" class="backup-button backup-primary" :href="dropboxCiphertextUrl(pointId)" target="_blank" rel="noopener noreferrer" @click="close">下载密文</a>
        <button v-else class="backup-button backup-primary" :disabled="saving || !ready || (dialog === 'schedule' && !draftTime)" @click="submit">{{ saving ? '提交中…' : dialog === 'schedule' ? '保存设置' : pending ? '以同一编号重新发送' : '确认执行' }}</button></div></template>
    </Modal>
  </section>
</template>

<style scoped>
.backup-actions { margin: 22px 0; border: 1px solid var(--border-color); border-radius: 14px; padding: 18px; }
.backup-actions header,.backup-toolbar,.backup-job-main,.backup-dialog-footer { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.backup-actions header { justify-content:space-between; align-items:flex-start; }
.backup-actions h5,.backup-actions h6 { font-size:14px; margin:0 0 6px; }
.backup-actions p,.backup-confirm p { font-size:13px; line-height:1.7; color:var(--text-secondary); margin:8px 0; }
.backup-button { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:38px; border:1px solid var(--border-color); border-radius:9px; padding:8px 12px; background:var(--bg-primary); color:var(--text-primary); font:inherit; font-size:13px; text-decoration:none; cursor:pointer; }
.backup-primary { background:var(--accent-color); color:#fff; border-color:var(--accent-color); }
.backup-button:disabled { opacity:.45; cursor:not-allowed; }
.backup-button:focus-visible,.backup-actions summary:focus-visible,.backup-confirm input:focus-visible { outline:2px solid var(--accent-color); outline-offset:3px; }
.backup-toolbar { margin-top:16px; }
.backup-schedule-status,.backup-tip { font-size:12px; color:var(--text-secondary); }
.backup-alert { padding:10px 12px; border-left:3px solid #aa804d; background:var(--bg-secondary); border-radius:4px 10px 10px 4px; }
.backup-downloads { margin-top:18px; border-top:1px solid var(--border-color); padding-top:16px; }
.backup-downloads summary { cursor:pointer; font-size:13px; }
.backup-downloads ul,.backup-jobs ol { list-style:none; padding:0; margin:12px 0 0; }
.backup-downloads li { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:12px 0; border-bottom:1px solid var(--border-color); }
.backup-downloads li>div { flex:1; min-width:150px; }
.backup-downloads strong { font-size:12px; font-weight:500; }
.backup-downloads code,.backup-confirm code { display:block; font-size:11px; overflow-wrap:anywhere; color:var(--text-secondary); }
.backup-jobs { margin-top:20px; }
.backup-jobs h6 span { display:inline-block; font-weight:400; color:var(--text-secondary); font-size:11px; margin-left:6px; }
.backup-jobs li { padding:12px 0; border-top:1px solid var(--border-color); }
.backup-job-main { justify-content:space-between; font-size:13px; }
.backup-jobs small { color:var(--text-secondary); font-size:11px; }
.backup-badge { padding:3px 8px; font-size:11px; border-radius:6px; background:var(--bg-secondary); }
.backup-badge.review,.backup-badge.failed { color:var(--text-primary); border:1px solid #aa804d; }
.backup-badge.running { color:var(--accent-color); }
.backup-dialog-footer { justify-content:flex-end; }
.backup-toggle,.backup-time { display:flex; align-items:center; gap:10px; font-size:14px; margin:14px 0; }
.backup-time input { padding:8px 10px; color:var(--text-primary); background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:8px; }
.backup-toggle input { accent-color:var(--accent-color); width:18px; height:18px; }
@media(max-width:640px) { .backup-actions { padding:14px; }.backup-actions header>div { width:100%; }.backup-schedule-status { width:100%; }.backup-downloads li>div { flex-basis:100%; } }
</style>
