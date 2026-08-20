<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { useAuth } from '@/shared/composables/useAuth'
import {
  deleteAdminSecurityEvents,
  fetchAdminSecurityEvents
} from '@/shared/services/adminSecurityEventsApi'
import {
  compactSecurityIdentifier,
  displaySecurityFingerprint,
  securityEventTypeLabel,
  securityOutcomeLabel,
  securityResourceTypeLabel
} from '../securityAuditUi'

const PAGE_SIZE = 25
const FALLBACK_EVENT_TYPES = [
  'auth.login',
  'auth.logout',
  'auth.recovery',
  'auth.recovery_codes.rotate',
  'auth.session.revoke',
  'auth.account.username.update',
  'auth.account.password.update',
  'admin.registration.approve',
  'admin.registration.reject',
  'admin.telegram_config.update',
  'admin.security_events.delete'
]
const FALLBACK_OUTCOMES = ['success', 'failure', 'denied']

const { currentUser, backendAuthEnabled } = useAuth()
const events = ref([])
const page = ref(1)
const total = ref(0)
const eventTypes = ref([...FALLBACK_EVENT_TYPES])
const outcomes = ref([...FALLBACK_OUTCOMES])
const selectedEventType = ref('')
const selectedOutcome = ref('')
const expanded = ref(false)
const loaded = ref(false)
const loading = ref(false)
const selectionMode = ref(false)
const selectedEventIds = ref(new Set())
const deletePassword = ref('')
const deleting = ref(false)
const deleteMessage = ref('')
const errorMessage = ref('')
const copiedKey = ref('')
let copyTimer = null
let requestSequence = 0

const isAdmin = computed(() => currentUser.value?.role === 'admin')
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))
const selectedCount = computed(() => selectedEventIds.value.size)
const allPageSelected = computed(() => (
  events.value.length > 0
  && events.value.every((event) => selectedEventIds.value.has(String(event.id)))
))
const visibleRange = computed(() => {
  if (!total.value) return '0 条'
  const start = (page.value - 1) * PAGE_SIZE + 1
  const end = Math.min(page.value * PAGE_SIZE, total.value)
  return `${start}–${end} / ${total.value} 条`
})

function formatDate(value) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date)
}

function normalizeStringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const normalized = value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  return normalized.length ? [...new Set(normalized)] : [...fallback]
}

function securityAuditError(error) {
  if (error?.status === 401) return '登录状态已失效，请重新登录。'
  if (error?.status === 403) return '只有管理员可以查看安全审计。'
  return error?.message || '安全审计读取失败，请稍后重试。'
}

async function loadEvents(nextPage = page.value) {
  if (!backendAuthEnabled.value || !isAdmin.value) return

  const sequence = ++requestSequence
  loading.value = true
  errorMessage.value = ''
  deleteMessage.value = ''

  try {
    const result = await fetchAdminSecurityEvents({
      page: nextPage,
      pageSize: PAGE_SIZE,
      eventType: selectedEventType.value,
      outcome: selectedOutcome.value
    })
    if (sequence !== requestSequence) return

    events.value = Array.isArray(result?.events) ? result.events : []
    page.value = Number(result?.pagination?.page) || nextPage
    total.value = Number(result?.pagination?.total) || 0
    eventTypes.value = normalizeStringList(
      result?.filters?.eventTypes,
      FALLBACK_EVENT_TYPES
    )
    outcomes.value = normalizeStringList(
      result?.filters?.outcomes,
      FALLBACK_OUTCOMES
    )
    loaded.value = true
    selectedEventIds.value = new Set()
    deletePassword.value = ''
  } catch (error) {
    if (sequence !== requestSequence) return
    events.value = []
    total.value = 0
    errorMessage.value = securityAuditError(error)
  } finally {
    if (sequence === requestSequence) loading.value = false
  }
}

function toggleExpanded() {
  expanded.value = !expanded.value
  if (!expanded.value) {
    cancelSelection()
    return
  }
  if (expanded.value && !loaded.value && !loading.value) {
    loadEvents(1)
  }
}

function beginSelection() {
  selectionMode.value = true
  selectedEventIds.value = new Set()
  deletePassword.value = ''
  deleteMessage.value = ''
  errorMessage.value = ''
}

function cancelSelection() {
  selectionMode.value = false
  selectedEventIds.value = new Set()
  deletePassword.value = ''
  deleteMessage.value = ''
}

function toggleEventSelection(eventId) {
  const normalized = String(eventId)
  const next = new Set(selectedEventIds.value)
  if (next.has(normalized)) next.delete(normalized)
  else next.add(normalized)
  selectedEventIds.value = next
  deletePassword.value = ''
  deleteMessage.value = ''
}

function togglePageSelection() {
  if (allPageSelected.value) {
    selectedEventIds.value = new Set()
  } else {
    selectedEventIds.value = new Set(events.value.map((event) => String(event.id)))
  }
  deletePassword.value = ''
  deleteMessage.value = ''
}

async function handleDeleteSelected() {
  if (!selectedCount.value || deleting.value) return
  if (!deletePassword.value) {
    errorMessage.value = '请输入当前密码以确认删除。'
    return
  }
  if (!window.confirm(
    `确定永久删除所选 ${selectedCount.value} 条安全审计记录吗？删除后无法从在线数据库撤销。`
  )) {
    return
  }

  deleting.value = true
  errorMessage.value = ''
  deleteMessage.value = ''
  try {
    const result = await deleteAdminSecurityEvents({
      eventIds: [...selectedEventIds.value],
      currentPassword: deletePassword.value
    })
    const deletedCount = Number(result?.deletedCount || 0)
    deletePassword.value = ''
    selectedEventIds.value = new Set()
    selectionMode.value = false
    deleteMessage.value = `已删除 ${deletedCount} 条审计记录，并保留一条新的删除操作审计。`

    const nextPage = page.value > 1 && events.value.length <= deletedCount
      ? page.value - 1
      : page.value
    await loadEvents(nextPage)
    deleteMessage.value = `已删除 ${deletedCount} 条审计记录，并保留一条新的删除操作审计。`
  } catch (error) {
    deletePassword.value = ''
    if (/current password is incorrect/i.test(String(error?.message || ''))) {
      errorMessage.value = '当前密码不正确。'
    } else {
      errorMessage.value = securityAuditError(error)
    }
  } finally {
    deleting.value = false
  }
}

function applyFilters() {
  if (selectionMode.value) cancelSelection()
  page.value = 1
  loadEvents(1)
}

function goToPage(nextPage) {
  const normalizedPage = Math.min(
    totalPages.value,
    Math.max(1, Number(nextPage) || 1)
  )
  if (normalizedPage === page.value || loading.value) return
  loadEvents(normalizedPage)
}

function fallbackCopy(value) {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  try {
    textarea.select()
    if (!document.execCommand('copy')) throw new Error('浏览器未允许复制')
  } finally {
    textarea.remove()
  }
}

async function copyIdentifier(value, key) {
  const normalized = String(value || '').trim()
  if (!normalized) return

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(normalized)
    } else {
      fallbackCopy(normalized)
    }
    copiedKey.value = key
    if (copyTimer) window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copiedKey.value = ''
      copyTimer = null
    }, 1800)
  } catch (error) {
    errorMessage.value = error?.message || '复制失败，请稍后重试。'
  }
}

onBeforeUnmount(() => {
  requestSequence += 1
  deletePassword.value = ''
  selectedEventIds.value = new Set()
  if (copyTimer) window.clearTimeout(copyTimer)
})
</script>

<template>
  <section
    v-if="backendAuthEnabled && isAdmin"
    class="audit-section"
    aria-labelledby="security-audit-title"
  >
    <div class="section-heading">
      <div>
        <h3 id="security-audit-title" class="section-heading__title">安全审计</h3>
        <p class="section-heading__desc">
          查看登录、账号恢复和管理员操作。仅展示截断的带密钥关联指纹，不展示原始值。
        </p>
      </div>
      <div class="section-heading__actions">
        <template v-if="expanded">
          <button
            class="button button--quiet"
            type="button"
            :disabled="loading || deleting"
            @click="loadEvents(page)"
          >
            <Icon name="refresh" :size="16" />
            {{ loading ? '刷新中...' : '刷新' }}
          </button>
          <button
            class="button"
            :class="selectionMode ? 'button--quiet' : 'button--danger'"
            type="button"
            :disabled="loading || deleting || (!selectionMode && !events.length)"
            @click="selectionMode ? cancelSelection() : beginSelection()"
          >
            <Icon :name="selectionMode ? 'close' : 'trash'" :size="16" />
            {{ selectionMode ? '取消删除' : '选择删除' }}
          </button>
        </template>
        <button
          class="button button--quiet audit-toggle"
          type="button"
          :aria-expanded="expanded"
          aria-controls="security-audit-content"
          @click="toggleExpanded"
        >
          {{ expanded ? '收起' : '展开' }}
          <Icon
            name="chevron-down"
            :size="16"
            :class="{ 'audit-toggle__icon--expanded': expanded }"
          />
        </button>
      </div>
    </div>

    <div v-if="expanded" id="security-audit-content" class="audit-content">
      <p v-if="deleteMessage" class="feedback feedback--success" aria-live="polite">
        {{ deleteMessage }}
      </p>

      <div v-if="selectionMode" class="delete-panel">
        <div class="delete-panel__summary">
          <strong>已选择 {{ selectedCount }} 条</strong>
          <span>每次最多删除 100 条；删除后会新建一条操作审计。</span>
        </div>
        <button
          class="button button--quiet"
          type="button"
          :disabled="deleting || !events.length"
          @click="togglePageSelection"
        >
          {{ allPageSelected ? '取消全选本页' : '全选本页' }}
        </button>
        <label class="delete-panel__password">
          <span>当前密码</span>
          <input
            v-model="deletePassword"
            type="password"
            autocomplete="current-password"
            placeholder="确认管理员身份"
            :disabled="deleting"
            @keyup.enter="handleDeleteSelected"
          >
        </label>
        <button
          class="button button--danger"
          type="button"
          :disabled="deleting || !selectedCount || !deletePassword"
          @click="handleDeleteSelected"
        >
          <Icon name="trash" :size="16" />
          {{ deleting ? '删除中...' : `删除所选 ${selectedCount} 条` }}
        </button>
      </div>

      <div class="filters" aria-label="安全审计筛选">
        <label class="filter-field">
          <span>事件类型</span>
          <select v-model="selectedEventType" :disabled="loading" @change="applyFilters">
            <option value="">全部事件</option>
            <option v-for="eventType in eventTypes" :key="eventType" :value="eventType">
              {{ securityEventTypeLabel(eventType) }}
            </option>
          </select>
        </label>
        <label class="filter-field">
          <span>处理结果</span>
          <select v-model="selectedOutcome" :disabled="loading" @change="applyFilters">
            <option value="">全部结果</option>
            <option v-for="outcome in outcomes" :key="outcome" :value="outcome">
              {{ securityOutcomeLabel(outcome) }}
            </option>
          </select>
        </label>
      </div>

      <p v-if="errorMessage" class="feedback feedback--error" role="alert">
      {{ errorMessage }}
    </p>
      <p v-else-if="loading" class="empty-state" aria-live="polite">
      正在读取安全事件...
    </p>
      <p v-else-if="!events.length" class="empty-state">
      当前筛选条件下没有安全事件。
    </p>

      <div v-else class="event-list">
      <article
        v-for="event in events"
        :key="event.id"
        class="event-card"
        :class="{ 'event-card--selected': selectedEventIds.has(String(event.id)) }"
      >
        <label v-if="selectionMode" class="event-card__selection">
          <input
            type="checkbox"
            :checked="selectedEventIds.has(String(event.id))"
            :aria-label="`选择审计事件 ${event.id}`"
            @change="toggleEventSelection(event.id)"
          >
          <span>选择此记录</span>
        </label>
        <div class="event-card__header">
          <div>
            <div class="event-card__title">
              {{ securityEventTypeLabel(event.eventType) }}
            </div>
            <time class="event-card__time" :datetime="event.createdAt">
              {{ formatDate(event.createdAt) }}
            </time>
          </div>
          <span class="outcome" :class="`outcome--${event.outcome}`">
            {{ securityOutcomeLabel(event.outcome) }}
          </span>
        </div>

        <div class="event-card__details">
          <button
            v-if="event.actorUserId"
            class="identifier"
            type="button"
            :aria-label="`复制操作用户 ID ${event.actorUserId}`"
            :title="`复制操作用户 ID：${event.actorUserId}`"
            @click="copyIdentifier(event.actorUserId, `${event.id}:actor`)"
          >
            <span class="identifier__label">操作用户 ID</span>
            <code>{{ compactSecurityIdentifier(event.actorUserId) }}</code>
            <span v-if="copiedKey === `${event.id}:actor`" class="identifier__status">已复制</span>
            <Icon v-else name="copy" :size="14" />
          </button>
          <button
            v-if="event.subjectUserId"
            class="identifier"
            type="button"
            :aria-label="`复制目标用户 ID ${event.subjectUserId}`"
            :title="`复制目标用户 ID：${event.subjectUserId}`"
            @click="copyIdentifier(event.subjectUserId, `${event.id}:subject`)"
          >
            <span class="identifier__label">目标用户 ID</span>
            <code>{{ compactSecurityIdentifier(event.subjectUserId) }}</code>
            <span v-if="copiedKey === `${event.id}:subject`" class="identifier__status">已复制</span>
            <Icon v-else name="copy" :size="14" />
          </button>
          <button
            v-if="event.resourceId"
            class="identifier"
            type="button"
            :aria-label="`复制${securityResourceTypeLabel(event.resourceType)} ID ${event.resourceId}`"
            :title="`复制${securityResourceTypeLabel(event.resourceType)} ID：${event.resourceId}`"
            @click="copyIdentifier(event.resourceId, `${event.id}:resource`)"
          >
            <span class="identifier__label">
              {{ securityResourceTypeLabel(event.resourceType) }} ID
            </span>
            <code>{{ compactSecurityIdentifier(event.resourceId) }}</code>
            <span v-if="copiedKey === `${event.id}:resource`" class="identifier__status">已复制</span>
            <Icon v-else name="copy" :size="14" />
          </button>
          <span
            v-if="event.affectedCount !== null && event.affectedCount !== undefined"
            class="detail-chip"
          >
            影响数量 {{ event.affectedCount }}
          </span>
        </div>

        <div
          v-if="displaySecurityFingerprint(event.clientFingerprint) || displaySecurityFingerprint(event.userAgentFingerprint)"
          class="fingerprints"
          aria-label="隐私保护指纹"
        >
          <button
            v-if="displaySecurityFingerprint(event.clientFingerprint)"
            class="fingerprint"
            type="button"
            :aria-label="`复制客户端关联指纹 ${displaySecurityFingerprint(event.clientFingerprint)}`"
            title="复制客户端关联指纹"
            @click="copyIdentifier(displaySecurityFingerprint(event.clientFingerprint), `${event.id}:client-fingerprint`)"
          >
            <span>客户端关联指纹</span>
            <code>{{ displaySecurityFingerprint(event.clientFingerprint) }}</code>
            <span
              v-if="copiedKey === `${event.id}:client-fingerprint`"
              class="identifier__status"
            >
              已复制
            </span>
            <Icon v-else name="copy" :size="14" />
          </button>
          <button
            v-if="displaySecurityFingerprint(event.userAgentFingerprint)"
            class="fingerprint"
            type="button"
            :aria-label="`复制浏览器关联指纹 ${displaySecurityFingerprint(event.userAgentFingerprint)}`"
            title="复制浏览器关联指纹"
            @click="copyIdentifier(displaySecurityFingerprint(event.userAgentFingerprint), `${event.id}:browser-fingerprint`)"
          >
            <span>浏览器关联指纹</span>
            <code>{{ displaySecurityFingerprint(event.userAgentFingerprint) }}</code>
            <span
              v-if="copiedKey === `${event.id}:browser-fingerprint`"
              class="identifier__status"
            >
              已复制
            </span>
            <Icon v-else name="copy" :size="14" />
          </button>
        </div>

        <button
          class="event-id"
          type="button"
          :aria-label="`复制审计事件 ID ${event.id}`"
          :title="`复制审计事件 ID：${event.id}`"
          @click="copyIdentifier(event.id, `${event.id}:event`)"
        >
          <span>审计事件 ID</span>
          <code>{{ compactSecurityIdentifier(event.id) }}</code>
          <span v-if="copiedKey === `${event.id}:event`">已复制</span>
          <Icon v-else name="copy" :size="13" />
        </button>
      </article>
    </div>

      <nav class="pagination" aria-label="安全审计分页">
      <span>{{ visibleRange }}</span>
      <div class="pagination__actions">
        <button
          class="button button--quiet"
          type="button"
          :disabled="loading || page <= 1"
          @click="goToPage(page - 1)"
        >
          上一页
        </button>
        <span class="pagination__page">第 {{ page }} / {{ totalPages }} 页</span>
        <button
          class="button button--quiet"
          type="button"
          :disabled="loading || page >= totalPages"
          @click="goToPage(page + 1)"
        >
          下一页
        </button>
      </div>
      </nav>
    </div>
  </section>
</template>

<style scoped>
.audit-section {
  padding: 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.section-heading,
.event-card__header,
.pagination {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.section-heading {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-light);
}

.section-heading__title {
  margin: 0;
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
}

.section-heading__desc {
  max-width: 620px;
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.65;
}

.section-heading__actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.audit-toggle .app-icon {
  transition: transform var(--transition-fast);
}

.audit-toggle__icon--expanded {
  transform: rotate(180deg);
}

.button {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.button--quiet {
  background: var(--bg-secondary);
  border-color: var(--border-light);
  color: var(--text-primary);
}

.button--danger {
  background: color-mix(in srgb, var(--error-color) 12%, var(--bg-secondary));
  border-color: color-mix(in srgb, var(--error-color) 24%, transparent);
  color: var(--error-color);
}

.button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.delete-panel {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) auto minmax(180px, 0.8fr) auto;
  align-items: end;
  gap: 10px;
  margin-top: 16px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--error-color) 26%, var(--border-light));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--error-color) 6%, var(--bg-secondary));
}

.delete-panel__summary {
  display: grid;
  gap: 5px;
}

.delete-panel__summary strong {
  color: var(--text-primary);
  font-size: 13px;
}

.delete-panel__summary span,
.delete-panel__password > span {
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.delete-panel__password {
  display: grid;
  gap: 6px;
}

.delete-panel__password input {
  min-height: 40px;
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  outline: none;
  background: var(--bg-card);
  color: var(--text-primary);
}

.delete-panel__password input:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 15%, transparent);
}

.filter-field {
  display: grid;
  gap: 7px;
  color: var(--text-secondary);
  font-size: 12px;
}

.filter-field select {
  min-height: 44px;
  width: 100%;
  padding: 10px 36px 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  outline: none;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
}

.filter-field select:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 15%, transparent);
}

.feedback,
.empty-state {
  margin: 16px 0 0;
  padding: 16px;
  border-radius: var(--radius-md);
  font-size: 13px;
  line-height: 1.6;
}

.feedback--error {
  background: color-mix(in srgb, var(--error-color) 12%, var(--bg-secondary));
  color: var(--error-color);
}

.feedback--success {
  background: color-mix(in srgb, var(--success-color) 12%, var(--bg-secondary));
  color: var(--success-color);
}

.empty-state {
  border: 1px dashed var(--border-color);
  color: var(--text-muted);
  text-align: center;
}

.event-list {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}

.event-card {
  padding: 15px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

.event-card--selected {
  border-color: color-mix(in srgb, var(--error-color) 42%, var(--border-light));
  background: color-mix(in srgb, var(--error-color) 5%, var(--bg-secondary));
}

.event-card__selection {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: -4px 0 10px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.event-card__selection input {
  width: 17px;
  height: 17px;
  accent-color: var(--error-color);
}

.event-card__title {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 650;
}

.event-card__time {
  display: block;
  margin-top: 5px;
  color: var(--text-muted);
  font-size: 11px;
}

.outcome {
  flex: 0 0 auto;
  padding: 5px 9px;
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 650;
}

.outcome--success {
  background: color-mix(in srgb, var(--success-color) 14%, var(--bg-secondary));
  color: var(--success-color);
}

.outcome--failure,
.outcome--denied {
  background: color-mix(in srgb, var(--error-color) 12%, var(--bg-secondary));
  color: var(--error-color);
}

.event-card__details,
.fingerprints {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.identifier,
.detail-chip,
.fingerprint {
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border: 1px solid var(--border-light);
  border-radius: 11px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 11px;
}

.identifier {
  font: inherit;
  cursor: copy;
}

.fingerprint {
  font: inherit;
  cursor: copy;
}

.identifier:hover,
.identifier:focus-visible,
.fingerprint:hover,
.fingerprint:focus-visible,
.event-id:hover,
.event-id:focus-visible {
  border-color: color-mix(in srgb, var(--accent-color) 44%, var(--border-light));
  color: var(--text-primary);
}

.identifier__label {
  color: var(--text-muted);
}

.identifier code,
.fingerprint code,
.event-id code {
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
}

.identifier .app-icon,
.fingerprint .app-icon,
.event-id .app-icon {
  opacity: 0.45;
}

.identifier__status {
  color: var(--success-color);
  font-weight: 600;
}

.fingerprints,
.fingerprint {
  color: var(--text-muted);
}

.event-id {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 10px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 10px;
  cursor: copy;
}

.pagination {
  align-items: center;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-light);
  color: var(--text-muted);
  font-size: 12px;
}

.pagination__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pagination__page {
  min-width: 90px;
  color: var(--text-secondary);
  text-align: center;
}

@media (max-width: 640px) {
  .audit-section {
    padding: 16px;
  }

  .section-heading,
  .pagination {
    align-items: stretch;
    flex-direction: column;
  }

  .section-heading > .button {
    width: 100%;
  }

  .section-heading__actions,
  .section-heading__actions .button {
    width: 100%;
  }

  .section-heading__actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .audit-toggle {
    grid-column: 1 / -1;
  }

  .delete-panel {
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .delete-panel .button,
  .delete-panel__password input {
    min-height: 44px;
    width: 100%;
  }

  .filters {
    grid-template-columns: 1fr;
  }

  .event-card__details,
  .identifier,
  .detail-chip,
  .fingerprints,
  .fingerprint {
    width: 100%;
  }

  .identifier,
  .detail-chip,
  .fingerprint,
  .event-id,
  .section-heading > .button,
  .pagination .button {
    min-height: 44px;
  }

  .pagination__actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  }
}

@media (max-width: 420px) {
  .pagination__actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .pagination__page {
    grid-column: 1 / -1;
    grid-row: 1;
  }
}
</style>
