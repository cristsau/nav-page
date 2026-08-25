<script setup>
import { computed, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  downloadAiUsageCsv,
  fetchAiUsageSummary
} from '@/shared/services/aiUsageApi'

const ranges = [7, 30, 90]
const selectedDays = ref(30)
const loading = ref(false)
const downloading = ref(false)
const error = ref('')
const summary = ref(null)

const featureLabels = Object.freeze({
  web_search: 'Web AI 搜索',
  bookmark_analysis: '书签分析',
  bookmark_tags: '书签标签',
  note_summarize: '笔记总结',
  note_polish: '笔记润色',
  note_tasks: '提取待办',
  note_continue: '笔记续写',
  note_tags: '笔记标签',
  assistant: '个人资料助理',
  email_classification: '邮件智能分类',
  provider_test: '连接测试'
})

const totals = computed(() => summary.value?.totals || {
  requestCount: 0,
  successCount: 0,
  failureCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  averageLatencyMs: 0,
  cost: { known: false, partial: false, estimatedUsd: null }
})

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0))
}

function formatCost(cost) {
  if (cost?.estimatedUsd === null || cost?.estimatedUsd === undefined) return '未知'
  return `${cost.partial ? '≥ ' : ''}$${Number(cost.estimatedUsd).toFixed(6)}`
}

async function loadUsage(days = selectedDays.value) {
  if (loading.value) return
  selectedDays.value = days
  loading.value = true
  error.value = ''
  try {
    summary.value = await fetchAiUsageSummary(days)
  } catch (loadError) {
    error.value = loadError.message || 'AI 用量加载失败'
  } finally {
    loading.value = false
  }
}

async function downloadCsv() {
  if (downloading.value) return
  downloading.value = true
  error.value = ''
  try {
    await downloadAiUsageCsv(selectedDays.value)
  } catch (downloadError) {
    error.value = downloadError.message || 'CSV 导出失败'
  } finally {
    downloading.value = false
  }
}

onMounted(() => loadUsage())
</script>

<template>
  <section class="usage-panel" aria-labelledby="ai-usage-title">
    <header class="usage-panel__header">
      <div>
        <h4 id="ai-usage-title">AI 用量</h4>
        <p>只统计按天聚合的次数、Token 与延迟；不会保存问题、正文或回答。</p>
      </div>
      <div class="usage-panel__actions">
        <div class="usage-panel__ranges" aria-label="用量统计范围">
          <button
            v-for="days in ranges"
            :key="days"
            type="button"
            :class="{ 'is-active': selectedDays === days }"
            :aria-pressed="selectedDays === days"
            @click="loadUsage(days)"
          >
            {{ days }} 天
          </button>
        </div>
        <button class="usage-panel__download" type="button" :disabled="downloading" @click="downloadCsv">
          <Icon name="download" :size="15" />
          {{ downloading ? '导出中' : 'CSV' }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="usage-panel__state" role="status">正在读取用量汇总…</div>
    <div v-else-if="error" class="usage-panel__state is-error" role="alert">{{ error }}</div>
    <template v-else>
      <div class="usage-panel__metrics">
        <div><span>请求</span><strong>{{ formatNumber(totals.requestCount) }}</strong></div>
        <div><span>成功 / 失败</span><strong>{{ formatNumber(totals.successCount) }} / {{ formatNumber(totals.failureCount) }}</strong></div>
        <div><span>输入 / 输出 Token</span><strong>{{ formatNumber(totals.inputTokens) }} / {{ formatNumber(totals.outputTokens) }}</strong></div>
        <div><span>平均延迟</span><strong>{{ formatNumber(totals.averageLatencyMs) }} ms</strong></div>
        <div>
          <span>估算成本</span>
          <strong>{{ formatCost(totals.cost) }}</strong>
          <small v-if="totals.cost?.estimatedUsd === null">未配置匹配的模型单价</small>
          <small v-else-if="totals.cost?.partial">部分请求单价未知</small>
        </div>
      </div>

      <div v-if="summary?.breakdown?.length" class="usage-panel__breakdown">
        <div
          v-for="item in summary.breakdown.slice(0, 8)"
          :key="`${item.feature}-${item.provider}-${item.model}-${item.apiMode}`"
          class="usage-panel__row"
        >
          <div>
            <strong>{{ featureLabels[item.feature] || item.feature }}</strong>
            <span>{{ item.provider }} · {{ item.model }} · {{ item.apiMode }}</span>
          </div>
          <div>{{ formatNumber(item.requestCount) }} 次</div>
        </div>
      </div>
      <div v-else class="usage-panel__state">这个时间范围内还没有 AI 调用。</div>
    </template>
  </section>
</template>

<style scoped>
.usage-panel {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--border-light);
  border-radius: 18px;
  background: color-mix(in srgb, var(--bg-secondary) 82%, var(--bg-card));
}

.usage-panel__header,
.usage-panel__actions,
.usage-panel__ranges,
.usage-panel__row {
  display: flex;
  align-items: center;
}

.usage-panel__header {
  justify-content: space-between;
  gap: 16px;
}

.usage-panel h4 {
  margin: 0;
  color: var(--text-primary);
  font-size: 14px;
}

.usage-panel p {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.usage-panel__actions,
.usage-panel__ranges {
  gap: 6px;
}

.usage-panel button {
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}

.usage-panel button.is-active {
  border-color: var(--accent-color);
  background: var(--accent-bg);
  color: var(--accent-color);
}

.usage-panel__download {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.usage-panel__metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}

.usage-panel__metrics > div {
  min-width: 0;
  display: grid;
  gap: 4px;
  padding: 12px;
  border-radius: 14px;
  background: var(--bg-card);
}

.usage-panel__metrics span,
.usage-panel__metrics small,
.usage-panel__row span {
  color: var(--text-muted);
  font-size: 10px;
}

.usage-panel__metrics strong,
.usage-panel__row strong {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  text-overflow: ellipsis;
}

.usage-panel__breakdown {
  display: grid;
  gap: 6px;
  margin-top: 12px;
}

.usage-panel__row {
  justify-content: space-between;
  gap: 12px;
  padding: 9px 11px;
  border-radius: 12px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 11px;
}

.usage-panel__row > div:first-child {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.usage-panel__state {
  margin-top: 12px;
  padding: 14px;
  border-radius: 13px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 12px;
}

.usage-panel__state.is-error {
  color: var(--error-color);
}

@media (max-width: 900px) {
  .usage-panel__metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 620px) {
  .usage-panel__header { align-items: flex-start; flex-direction: column; }
  .usage-panel__actions { width: 100%; justify-content: space-between; }
  .usage-panel__metrics { grid-template-columns: 1fr; }
}
</style>
