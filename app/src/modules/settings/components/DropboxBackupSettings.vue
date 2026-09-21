<script setup>
import { computed, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import DropboxBackupActions from './DropboxBackupActions.vue'

const props = defineProps({ state: { type: Object, default: null }, loading: Boolean })
defineEmits(['refresh'])
const selected = ref('local')
const report = computed(() => props.state?.report || null)
const fresh = computed(() => props.state?.state === 'available')
const records = computed(() => report.value?.[selected.value]?.points || [])
const statusText = computed(() => {
  if (props.loading) return '正在读取'
  if (props.state?.state === 'stale') return '记录已过期'
  if (!fresh.value) return props.state?.state === 'invalid_report' ? '状态需检查' : '状态尚未接通'
  return report.value?.cloud.uploadConfigured ? '仅已允许上传' : '云上传未开启'
})
const gates = computed(() => [
  { title: '服务器连接配置', ok: fresh.value && report.value?.cloud.credentialsPresent,
    text: '仅检查凭据文件是否就位，不代表 Dropbox 连接已验证。' },
  { title: '加密公钥', ok: fresh.value && report.value?.cloud.recipientConfigured,
    text: '服务器只需要公钥；恢复私钥和口令不进入网页。' },
  { title: '独立恢复钥匙副本', ok: false,
    text: '需在独立个人设备保存并核对，当前状态报告不能代替本人确认。' },
  { title: '完整恢复演练', ok: fresh.value && report.value?.cloud.points.some(p => p.state === 'restore_verified'),
    text: '上传、下载校验和完整恢复是三个不同阶段。' }
])
const stateLabels = { manifest_checked: '清单已检查', uploaded: '已上传', download_verified: '下载已校验', restore_verified: '恢复已验证' }
const retentionText = computed(() => ({
  not_initialized: '云端台账尚未初始化。', needs_reconciliation: '有操作结果尚未核对，保留全部备份并暂停轮换。',
  no_verified_restore: '按当前安排，完整恢复演练留到最终验收；在此之前不自动清理云备份。',
  protected_limit: '最新两份与最近一次恢复验证的备份都需保留，暂时无法安全腾出一个位置。',
  ready: '下次备份前可轮换下列较旧备份；执行时仍会重新核对云端文件及容量。',
  not_required: '目前无需清理；达到 3 份后才会评估下一次轮换。'
}[report.value?.cloud.retention?.reason] || '服务器尚未提供保留计划，请勿根据旧记录手动清理。'))
function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无记录' }
function bytes(value) {
  if (!Number.isFinite(value)) return '未知'
  if (value === 0) return '0 B'
  const unit = value >= 1e9 ? ['GB', 1e9] : value >= 1e6 ? ['MB', 1e6] : ['KB', 1e3]
  return `${(value / unit[1]).toFixed(1)} ${unit[0]}`
}
</script>

<template>
  <section class="dropbox-panel" aria-labelledby="dropbox-backup-title" :aria-busy="loading">
    <header class="dropbox-heading">
      <div class="dropbox-mark"><Icon name="cloud" :size="22" /></div>
      <div class="dropbox-intro">
        <p class="dropbox-eyebrow">个人备份 · App Folder</p>
        <h4 id="dropbox-backup-title">Dropbox 加密备份</h4>
        <p>只使用 NAV 专用文件夹，不浏览其他网盘文件。</p>
      </div>
      <button type="button" class="dropbox-refresh" :disabled="loading" @click="$emit('refresh')">
        <Icon name="refresh" :size="16" />{{ loading ? '读取中' : '刷新记录' }}
      </button>
    </header>

    <div class="dropbox-notice" role="status">
      <Icon name="clock" :size="18" /><div><strong>{{ statusText }}</strong>
        <p v-if="state?.state === 'stale'">以下为旧记录，不代表当前状态；请检查服务器状态采集任务。</p>
        <p v-else-if="!report">等待服务器提供脱敏状态报告。未读取到记录不等于没有备份。</p>
        <p v-else>以下记录由服务器提供；实际操作与运行状态见备份操作区。刷新不会上传或删除数据，网页不提供解密恢复。</p>
      </div>
    </div>

    <dl class="dropbox-metrics">
      <div><dt>服务器本地</dt><dd>{{ report?.local.state === 'checked' ? report.local.points.length + ' 份' : '待检查' }}</dd>
        <span>保留最新 3 份 · {{ report ? (report.local.pruneConfigured ? '清理配置已开启' : '清理配置未开启') : '配置未知' }}</span></div>
      <div><dt>Dropbox 备份台账</dt><dd>{{ report?.cloud.ledgerState === 'valid' ? report.cloud.points.length + ' 份' : report ? '未初始化' : '未知' }}</dd>
        <span>上限 3 份 · {{ report?.cloud.pruneConfigured ? '轮换配置已开启' : '自动轮换未开启' }}</span></div>
      <div><dt>台账记录的云端大小</dt><dd>{{ report?.cloud.ledgerState === 'valid' ? bytes(report.cloud.recordedBytes) : '未知' }} <small>/ 5 GB</small></dd>
        <span>非实时网盘用量，未知文件另计</span></div>
    </dl>

    <DropboxBackupActions :points="report?.cloud.points || []" @updated="$emit('refresh')" />

    <p v-if="report?.cloud.pendingUploads" class="dropbox-warning" role="alert">有 {{ report.cloud.pendingUploads }} 次上传未完成核对，继续上传前需要处理。</p>
    <p v-if="report?.cloud.pendingDeletes" class="dropbox-warning" role="alert">有清理结果尚未核对，已暂停后续云端写入，不会自动重试删除。</p>
    <details class="dropbox-retention">
      <summary>查看云备份保留计划 <span>只查看，不执行删除</span></summary>
      <p>{{ retentionText }}</p>
      <p>最多 3 份 / 5 GB；至少保留最新两份和最近一份恢复验证成功的备份。容量不足、未知文件或回执不明时暂停。</p>
      <ul v-if="report?.cloud.retention?.eligibleIds?.length">
        <li v-for="id in report.cloud.retention.eligibleIds" :key="id"><code>{{ id }}</code><span>下一次备份前的候选</span></li>
      </ul>
      <p class="dropbox-boundary">这是本地台账预估，不是实时网盘清单；查看计划和刷新记录不会上传或清理。</p>
    </details>
    <details class="dropbox-readiness">
      <summary>查看启用条件 <span>为什么还不能自动备份？</span></summary>
      <ul><li v-for="gate in gates" :key="gate.title">
        <Icon :name="gate.ok ? 'circle-check' : 'clock'" :size="18" />
        <div><strong>{{ gate.title }} · {{ gate.ok ? '已记录' : '待验证' }}</strong><p>{{ gate.text }}</p></div>
      </li></ul>
      <p class="dropbox-boundary">上方操作区单独查询执行器，自动任务是否运行以执行器实时状态为准，不以“允许上传”推断。</p>
    </details>

    <div class="dropbox-records">
      <div class="dropbox-records-heading"><h5>备份记录</h5>
        <div class="dropbox-switch" role="group" aria-label="备份记录位置">
          <button type="button" :aria-pressed="selected === 'local'" @click="selected = 'local'">服务器</button>
          <button type="button" :aria-pressed="selected === 'cloud'" @click="selected = 'cloud'">Dropbox</button>
        </div>
      </div>
      <ul v-if="records.length" class="dropbox-record-list">
        <li v-for="point in records" :key="point.id">
          <Icon :name="selected === 'local' ? 'database' : 'cloud'" :size="18" />
          <div><strong>{{ date(point.createdAt) }}</strong><code>{{ point.id }}</code></div>
          <span>{{ bytes(point.bytes) }}</span><span class="dropbox-stage">{{ stateLabels[point.state] }}</span>
        </li>
      </ul>
      <p v-else class="dropbox-empty">{{ !report ? '状态接通后将在这里显示记录。' : selected === 'local' ? '暂未取得可核对的本地备份记录。' : '暂无云备份记录；本地备份不会自动算作云备份。' }}</p>
    </div>
    <footer><span>记录时间：{{ date(report?.generatedAt) }}</span><span>清单校验不等于业务恢复验收；附件原件以备份清单为准。</span></footer>
  </section>
</template>

<style scoped>
.dropbox-panel { border: 1px solid var(--border-color, #dfe2ec); border-radius: 20px; background: var(--bg-primary, #fff); padding: 24px; color: var(--text-primary, #202331); }
.dropbox-heading { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: start; gap: 14px; }
.dropbox-mark { display: grid; place-items: center; flex: 0 0 44px; height: 44px; border-radius: 14px; background: var(--bg-secondary, #f2f3f9); color: var(--accent-color, #6264cf); }
.dropbox-intro { flex: 1; min-width: 0; }
.dropbox-intro h4 { font-size: 19px; line-height: 1.4; margin: 3px 0 6px; }
.dropbox-intro p, .dropbox-notice p, .dropbox-readiness p { margin: 0; color: var(--text-secondary, #626879); font-size: 13px; line-height: 1.7; }
.dropbox-intro .dropbox-eyebrow { font-size: 11px; letter-spacing: .08em; }
.dropbox-refresh { display: inline-flex; align-items: center; gap: 7px; padding: 9px 12px; border: 1px solid var(--border-color, #dfe2ec); border-radius: 10px; background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.dropbox-refresh:disabled { opacity: .55; cursor: wait; }
.dropbox-retention { margin-top: 18px; border: 1px solid var(--border-color, #dfe2ec); border-radius: 12px; padding: 14px 16px; }
.dropbox-retention summary { cursor: pointer; font-size: 14px; line-height: 1.7; }
.dropbox-retention summary span { display: inline-block; margin-left: 8px; font-size: 12px; color: var(--text-secondary, #626879); }
.dropbox-retention p { color: var(--text-secondary, #626879); font-size: 13px; line-height: 1.7; margin: 10px 0 0; }
.dropbox-retention ul { list-style: none; padding: 0; margin: 12px 0; }
.dropbox-retention li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; padding: 8px 0; font-size: 12px; }
.dropbox-retention code { overflow-wrap: anywhere; }
.dropbox-panel button:focus-visible, .dropbox-panel summary:focus-visible { outline: 2px solid var(--accent-color, #6264cf); outline-offset: 3px; }
.dropbox-notice { display: flex; gap: 10px; align-items: flex-start; margin: 20px 0; padding: 14px 16px; background: var(--bg-secondary, #f2f3f9); border-radius: 12px; }
.dropbox-notice > svg { flex-shrink: 0; margin-top: 2px; }
.dropbox-notice strong { display: block; font-size: 14px; margin-bottom: 3px; }
.dropbox-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; gap: 14px; }
.dropbox-metrics > div { border: 1px solid var(--border-color, #dfe2ec); padding: 16px; border-radius: 12px; }
.dropbox-metrics dt { font-size: 12px; color: var(--text-secondary, #626879); }
.dropbox-metrics dd { margin: 8px 0; font-weight: 650; font-size: 22px; line-height: 1.5; }
.dropbox-metrics small { font-size: 12px; font-weight: 400; color: var(--text-secondary, #626879); }
.dropbox-metrics span { font-size: 11px; line-height: 1.6; color: var(--text-secondary, #626879); }
.dropbox-warning { font-size: 13px; border-left: 3px solid #bd8540; padding: 10px 12px; }
.dropbox-readiness { border-bottom: 1px solid var(--border-color, #dfe2ec); padding: 18px 0; margin-bottom: 20px; }
.dropbox-readiness summary { cursor: pointer; font-size: 13px; padding: 3px 0; }
.dropbox-readiness summary span { color: var(--text-secondary, #626879); margin-left: 10px; font-size: 12px; }
.dropbox-readiness ul { padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; list-style: none; margin: 20px 0 14px; }
.dropbox-readiness li { display: flex; gap: 9px; }
.dropbox-readiness li svg { flex-shrink: 0; margin-top: 2px; color: var(--accent-color, #6264cf); }
.dropbox-readiness strong { font-size: 13px; }
.dropbox-readiness .dropbox-boundary { font-size: 12px; }
.dropbox-records-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dropbox-records-heading h5 { font-size: 14px; margin: 0; }
.dropbox-switch { display: flex; padding: 3px; background: var(--bg-secondary, #f2f3f9); border-radius: 10px; }
.dropbox-switch button { border: 0; border-radius: 7px; padding: 7px 14px; background: transparent; color: var(--text-secondary, #626879); cursor: pointer; font: inherit; font-size: 12px; }
.dropbox-switch button[aria-pressed="true"] { background: var(--bg-primary, #fff); color: var(--accent-color, #6264cf); box-shadow: 0 1px 4px #0000000a; }
.dropbox-record-list { padding: 0; margin: 10px 0 0; list-style: none; }
.dropbox-record-list li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto auto; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--border-color, #dfe2ec); font-size: 12px; }
.dropbox-record-list strong { display: block; font-size: 13px; font-weight: 500; }
.dropbox-record-list code { display: block; font-size: 10px; color: var(--text-secondary, #626879); overflow-wrap: anywhere; margin-top: 4px; }
.dropbox-stage { background: var(--bg-secondary, #f2f3f9); border-radius: 6px; padding: 5px 8px; }
.dropbox-empty { padding: 28px 16px; margin: 12px 0 0; text-align: center; border: 1px dashed var(--border-color, #dfe2ec); border-radius: 12px; color: var(--text-secondary, #626879); font-size: 13px; line-height: 1.7; }
.dropbox-panel footer { display: flex; flex-wrap: wrap; gap: 6px 20px; justify-content: space-between; font-size: 11px; color: var(--text-secondary, #626879); line-height: 1.7; margin-top: 16px; }
@media (max-width: 640px) {
  .dropbox-panel { padding: 16px; border-radius: 16px; }
  .dropbox-heading { grid-template-columns: 44px minmax(0, 1fr); gap: 10px; }
  .dropbox-refresh { grid-column: 2; justify-self: start; }
  .dropbox-metrics, .dropbox-readiness ul { grid-template-columns: 1fr; }
  .dropbox-metrics > div { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; padding: 12px; }
  .dropbox-metrics dd { margin: 0; font-size: 19px; }
  .dropbox-metrics span { grid-column: 1 / -1; }
  .dropbox-readiness summary span { display: block; margin: 6px 0 0 16px; }
  .dropbox-record-list li { grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; }
  .dropbox-stage { grid-column: 2 / -1; justify-self: start; }
}
</style>
