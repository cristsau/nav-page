<script setup>
import { computed, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { taskFilters, taskGroup, taskCounts, taskProgress, transferBytes as bytes, remainingTime, uploadLabel } from './taskPresentation'
const props = defineProps({ jobs: { type: Array, required: true }, persistence: String, busy: Boolean, clearing: Boolean })
const emit = defineEmits(['pause', 'resume', 'reselect', 'cancel', 'clear', 'refresh'])
const expanded = ref(true), filter = ref('all'), cancelId = ref(null)
const counts = computed(() => taskCounts(props.jobs))
const visible = computed(() => props.jobs.filter(job => filter.value === 'all' || taskGroup(job) === filter.value))
const completed = computed(() => props.jobs.filter(job => job.state === 'complete').length)
const progress = job => taskProgress(job.state === 'checking' ? job.hashOffset : job.offset, job.size, job.state === 'complete')
function selectFilter(key) { filter.value = key; cancelId.value = null }
function confirmCancel(job) {
  if (!['queued', 'checking', 'awaiting_file', 'uploading', 'paused', 'error'].includes(job.state) || job.cancel) return
  cancelId.value = null; emit('cancel', job.id)
}
</script>
<template>
  <section class="drive-transfers transfer-panel" aria-label="上传队列">
    <header class="transfer-heading">
      <span class="transfer-mark"><Icon name="upload" :size="19" /></span>
      <div class="transfer-heading-copy"><strong>上传队列 <span>{{ jobs.length }}</span></strong><p role="status">{{ counts.active }} 项进行中 · {{ counts.attention }} 项待处理 · {{ completed }} 项已上传</p></div>
      <button class="transfer-icon" :aria-expanded="expanded" aria-controls="upload-task-content" :aria-label="expanded ? '收起上传队列' : '展开上传队列'" @click="expanded = !expanded"><Icon name="chevron-down" :size="18" :class="{ 'is-expanded': expanded }" /></button>
    </header>
    <div v-show="expanded" id="upload-task-content">
      <div class="transfer-filters" role="group" aria-label="上传任务筛选"><button v-for="[key, label] in taskFilters" :key="key" :aria-pressed="filter === key" @click="selectFilter(key)">{{ label }} <span>{{ counts[key] }}</span></button></div>
      <ul class="transfer-list"><li v-for="job in visible" :key="job.id" :data-state="job.state">
        <div class="transfer-title"><strong :title="job.name">{{ job.name }}</strong><span class="transfer-badge" :data-tone="taskGroup(job)">{{ uploadLabel(job) }}</span></div>
        <small class="transfer-path">{{ job.path }}</small>
        <div class="transfer-progress"><progress :value="progress(job)" max="100" :aria-label="`${job.name} ${job.state === 'checking' ? '核对' : '上传'}进度`" /><span>{{ progress(job) }}%</span></div>
        <div class="transfer-meta"><span>{{ job.state === 'checking' ? '本地核对' : '已传输' }} {{ bytes(job.state === 'checking' ? job.hashOffset : job.offset) }} / {{ bytes(job.size) }}<template v-if="job.state === 'uploading' && job.rate"> · {{ bytes(job.rate) }}/s <span>{{ remainingTime(job.size - job.offset, job.rate) }}</span></template></span></div>
        <p v-if="job.error" class="transfer-error" role="alert">{{ job.error }}</p>
        <div class="transfer-actions">
          <button v-if="['queued', 'checking', 'uploading'].includes(job.state)" :disabled="job.pause || job.cancel" @click="emit('pause', job.id)">暂停</button>
          <button v-if="job.state === 'awaiting_file'" class="transfer-primary" @click="emit('reselect', job.id)">重选原文件</button>
          <button v-if="['paused', 'error'].includes(job.state)" class="transfer-primary" @click="emit('resume', job.id)">{{ job.state === 'error' ? '重试' : '继续' }}</button>
          <button v-if="['queued', 'checking', 'awaiting_file', 'uploading', 'paused', 'error'].includes(job.state)" :disabled="job.cancel" @click="cancelId = job.id">取消上传</button>
        </div>
        <div v-if="cancelId === job.id && !['complete', 'cancelled', 'review'].includes(job.state)" class="transfer-confirm" role="group" :aria-label="`确认取消 ${job.name}`"><p>取消此上传？只停止任务，不删除已提交的云端文件。</p><div><button @click="cancelId = null">保留任务</button><button :disabled="job.cancel" class="transfer-danger" @click="confirmCancel(job)">确认取消上传</button></div></div>
      </li></ul>
      <p v-if="!visible.length" class="transfer-empty">此分类暂无任务。其他分类的任务仍会继续处理。</p>
      <footer class="transfer-footer"><button :disabled="clearing || !counts.finished" @click="emit('clear')">{{ clearing ? '清理中…' : '清理完成记录' }}</button><button :disabled="busy" @click="emit('refresh')"><Icon name="refresh" :size="14" />查看已上传文件</button></footer>
      <details class="transfer-help"><summary>续传与上传说明</summary><p>最高 50 GB · 每块 8 MB。刷新后重选原文件，核对完整内容后续传。<template v-if="persistence === 'reselect_after_restart_encrypted'">进度已加密保存，服务器重启后也可续传；24 小时无活动会过期。</template><template v-else>进度仅在服务器内存中，服务器重启后需重传。</template></p><p>文件正文不缓存；手机后台可能暂停。清理会同步移除服务器已完成的任务记录，不删除 Dropbox 文件。结果待核对的任务不会被清理；先核对云端，避免重复上传。</p></details>
    </div>
  </section>
</template>
<style scoped>
.transfer-panel{margin:12px 20px;border:1px solid var(--border-color);border-radius:14px;background:var(--bg-primary);color:var(--text-primary);overflow:hidden;font-size:13px;padding:0}
.transfer-heading{display:flex;align-items:center;gap:12px;padding:16px}.transfer-mark{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:var(--accent-bg);color:var(--accent-color);flex-shrink:0}.transfer-heading-copy{flex:1;min-width:0}.transfer-heading-copy strong{font-size:14px}.transfer-heading-copy strong span{font-size:11px;color:var(--text-muted);margin-left:6px}.transfer-heading-copy p{font-size:11px;color:var(--text-secondary);margin:5px 0 0;line-height:1.6}
.transfer-panel button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:7px 11px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-primary);color:inherit;font:inherit;font-size:12px;cursor:pointer}.transfer-panel button:hover:not(:disabled){background:var(--bg-hover)}.transfer-panel button:disabled{opacity:.45;cursor:not-allowed}.transfer-panel button:focus-visible,.transfer-help summary:focus-visible{outline:2px solid var(--accent-color);outline-offset:2px}.transfer-icon{width:36px;padding:0!important;flex-shrink:0}.transfer-icon svg{transition:transform .15s}.transfer-icon .is-expanded{transform:rotate(180deg)}
.transfer-filters{display:flex;gap:5px;padding:0 16px 12px;flex-wrap:wrap}.transfer-filters button{border-color:transparent;background:var(--bg-secondary);gap:5px}.transfer-filters button[aria-pressed=true]{background:var(--accent-bg);color:var(--accent-color);border-color:var(--border-color)}.transfer-filters span{font-size:10px;opacity:.75}
.transfer-list{list-style:none;padding:0 16px;margin:0;max-height:340px;overflow:auto;overscroll-behavior:contain}.transfer-list>li{padding:14px 0;border-top:1px solid var(--border-light)}.transfer-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.transfer-title strong{font-size:13px;font-weight:550;min-width:0;overflow-wrap:anywhere}.transfer-badge{font-size:11px;white-space:nowrap;color:var(--text-secondary);padding:3px 7px;border-radius:5px;background:var(--bg-secondary)}.transfer-badge[data-tone=attention]{color:var(--text-primary);border:1px solid var(--border-color)}.transfer-badge[data-tone=active]{color:var(--accent-color);background:var(--accent-bg)}.transfer-path{display:block;font-size:11px;color:var(--text-muted);margin-top:4px;overflow-wrap:anywhere}.transfer-progress{display:flex;align-items:center;gap:10px;margin:10px 0 5px}.transfer-progress progress{flex:1;width:0;height:5px;accent-color:var(--accent-color)}.transfer-progress span{font-size:11px;color:var(--text-secondary);font-variant-numeric:tabular-nums}.transfer-meta{font-size:11px;color:var(--text-secondary);line-height:1.7}.transfer-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.transfer-actions:empty{display:none}.transfer-panel .transfer-primary{color:var(--accent-color);background:var(--accent-bg)}.transfer-panel .transfer-danger{color:var(--text-primary);border-color:var(--error-color)}.transfer-error{color:var(--text-primary);border-left:2px solid var(--error-color);padding-left:8px}.transfer-error{font-size:12px;line-height:1.7;overflow-wrap:anywhere;margin:8px 0}.transfer-confirm{margin-top:10px;padding:12px;background:var(--bg-secondary);border-radius:10px}.transfer-confirm p{font-size:12px;line-height:1.7;margin:0 0 10px}.transfer-confirm>div{display:flex;gap:6px;flex-wrap:wrap}.transfer-footer{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--border-light)}.transfer-help{padding:12px 16px;border-top:1px solid var(--border-light);color:var(--text-secondary);font-size:11px}.transfer-help summary{cursor:pointer}.transfer-help p{line-height:1.8;margin:8px 0 0}.transfer-empty{padding:18px 16px;color:var(--text-muted);font-size:12px;margin:0}
@media(max-width:720px){.transfer-panel{margin:10px 12px}.transfer-heading{padding:12px;gap:9px}.transfer-mark{width:32px;height:32px}.transfer-filters{padding:0 12px 10px;gap:3px}.transfer-filters button{padding:6px 8px;font-size:11px}.transfer-list{padding:0 12px}.transfer-title{flex-wrap:wrap;gap:5px}.transfer-title strong{flex-basis:100%}.transfer-footer,.transfer-help{padding:12px}.transfer-actions button{min-height:40px}}
@media(prefers-reduced-motion:reduce){.transfer-icon svg{transition:none}}
</style>
