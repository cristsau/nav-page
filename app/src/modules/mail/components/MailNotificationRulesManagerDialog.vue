<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  createEmailNotificationRule,
  deleteEmailNotificationRule,
  fetchEmailNotificationRules,
  previewEmailNotificationRule,
  updateEmailNotificationRule
} from '@/shared/services/emailApi'

const props = defineProps({
  open: { type: Boolean, default: false },
  accountId: { type: String, default: '' },
  accountLabel: { type: String, default: '当前邮箱' }
})

const emit = defineEmits(['close', 'changed'])
const dialog = ref(null)
const closeButton = ref(null)
const rules = ref([])
const loading = ref(false)
const busyRuleId = ref('')
const error = ref('')
const notice = ref('')
const deleteConfirmId = ref('')
const criticalConfirmRuleId = ref('')
const inlineConfirmButton = ref(null)
const defaultAction = ref('immediate')
const defaultPreview = ref(null)
const defaultCriticalConfirmed = ref(false)
let restoreTarget = null
let inlineRestoreTarget = null

const actionOptions = [
  { value: 'immediate', label: '立即提醒', icon: 'bell' },
  { value: 'digest', label: '仅放入摘要', icon: 'note' },
  { value: 'in_app_only', label: '仅站内显示', icon: 'mail' },
  { value: 'silent', label: '完全静音', icon: 'bell-off' }
]

const scopeLabels = Object.freeze({
  conversation: '当前会话',
  sender: '发件人',
  domain: '发件人域名',
  category: '邮件类别',
  account: '邮箱默认'
})

const categoryLabels = Object.freeze({
  security: '安全',
  payment: '支付',
  operations: '运维',
  action: '待处理',
  status: '状态通知',
  personal: '个人往来',
  marketing: '营销',
  social: '社交',
  other: '其他'
})

const hasAccount = computed(() => Boolean(String(props.accountId || '').trim()))
const defaultRule = computed(() => rules.value.find((rule) => rule.scope === 'account') || null)
const defaultNeedsCriticalConfirmation = computed(() => (
  defaultPreview.value?.requiresCriticalConfirmation === true
))

function actionMeta(value) {
  return actionOptions.find((item) => item.value === value)
    || { value, label: '自定义提醒', icon: 'bell' }
}

function ruleScope(rule) {
  return scopeLabels[rule?.scope] || '自定义范围'
}

function ruleMatch(rule) {
  const value = String(rule?.matchValue || '').trim()
  if (rule?.scope === 'account') return props.accountLabel || '当前邮箱'
  if (rule?.scope === 'category') return categoryLabels[value] || value || '未分类'
  if (rule?.scope === 'conversation') return value ? `会话 ${value.slice(0, 8)}` : '当前会话'
  return value || '匹配值不可用'
}

function ruleState(rule) {
  if (rule?.state === 'expired') return { label: '已到期', className: 'is-expired' }
  if (rule?.enabled === false || rule?.state === 'paused') return { label: '已暂停', className: 'is-paused' }
  return { label: '生效中', className: 'is-active' }
}

function ruleIsActive(rule) {
  return rule?.enabled !== false && rule?.state !== 'expired'
}

function formatDate(value, fallback = '长期有效') {
  if (!value) return fallback
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return fallback
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(parsed)
}

function hitSummary(rule) {
  const count = Math.max(0, Number(rule?.hitCount || 0))
  if (!count) return '尚未命中'
  const suffix = rule?.lastHitAt ? ` · 最近 ${formatDate(rule.lastHitAt, '')}` : ''
  return `已命中 ${count} 次${suffix}`
}

function defaultPayload({ criticalOverrideConfirmed = false } = {}) {
  return {
    accountId: String(props.accountId || '').trim(),
    scope: 'account',
    action: defaultAction.value,
    enabled: true,
    expiresAt: null,
    criticalOverrideConfirmed
  }
}

async function loadRules() {
  defaultAction.value = 'immediate'
  if (!hasAccount.value) {
    rules.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const payload = await fetchEmailNotificationRules({ accountId: props.accountId })
    rules.value = Array.isArray(payload?.rules) ? payload.rules : []
    if (defaultRule.value) defaultAction.value = defaultRule.value.action
  } catch (requestError) {
    error.value = requestError?.message || '提醒规则读取失败'
  } finally {
    loading.value = false
  }
}

async function toggleRule(rule, { criticalConfirmed = false } = {}) {
  if (!rule?.id || busyRuleId.value) return
  let focusCriticalConfirmation = false
  const restoreActionAfterRequest = criticalConfirmed
  busyRuleId.value = rule.id
  error.value = ''
  notice.value = ''
  criticalConfirmRuleId.value = ''
  try {
    const enabling = !ruleIsActive(rule)
    const payload = {
      enabled: enabling,
      ...(enabling && rule?.state === 'expired' ? { expiresAt: null } : {}),
      ...(criticalConfirmed ? { criticalOverrideConfirmed: true } : {})
    }
    const result = await updateEmailNotificationRule(rule.id, payload)
    const updated = result?.rule || result
    rules.value = rules.value.map((item) => item.id === rule.id ? updated : item)
    notice.value = updated.enabled ? '规则已启用。' : '规则已暂停；邮件仍会正常同步。'
    emit('changed', updated)
  } catch (requestError) {
    if (requestError?.code === 'EMAIL_CRITICAL_NOTIFICATION_CONFIRMATION_REQUIRED') {
      deleteConfirmId.value = ''
      criticalConfirmRuleId.value = rule.id
      focusCriticalConfirmation = true
      error.value = '这条规则可能降低关键邮件提醒。请明确确认后再启用。'
    } else {
      error.value = requestError?.message || '提醒规则更新失败'
    }
  } finally {
    busyRuleId.value = ''
    if (focusCriticalConfirmation) await focusInlineConfirmation('toggle', rule.id)
    else if (restoreActionAfterRequest) await restoreInlineActionFocus()
  }
}

async function removeRule(rule) {
  if (!rule?.id || busyRuleId.value) return
  busyRuleId.value = rule.id
  error.value = ''
  notice.value = ''
  try {
    await deleteEmailNotificationRule(rule.id)
    rules.value = rules.value.filter((item) => item.id !== rule.id)
    deleteConfirmId.value = ''
    criticalConfirmRuleId.value = ''
    notice.value = '规则已删除；原邮件不受影响。'
    emit('changed', { id: rule.id, deleted: true })
    inlineRestoreTarget = null
    inlineConfirmButton.value = null
    await nextTick()
    closeButton.value?.focus?.()
  } catch (requestError) {
    error.value = requestError?.message || '提醒规则删除失败'
  } finally {
    busyRuleId.value = ''
  }
}

async function saveDefaultRule() {
  if (!hasAccount.value || busyRuleId.value) return
  busyRuleId.value = 'default'
  error.value = ''
  notice.value = ''
  try {
    const preview = await previewEmailNotificationRule(defaultPayload({
      criticalOverrideConfirmed: defaultCriticalConfirmed.value
    }))
    defaultPreview.value = preview
    if (preview?.requiresCriticalConfirmation === true && !defaultCriticalConfirmed.value) {
      error.value = '默认规则可能降低安全或支付邮件提醒。确认后才会保存。'
      return
    }
    const result = await createEmailNotificationRule(defaultPayload({
      criticalOverrideConfirmed: defaultCriticalConfirmed.value
    }))
    const saved = result?.rule || result
    const index = rules.value.findIndex((item) => item.id === saved.id || item.scope === 'account')
    if (index >= 0) rules.value.splice(index, 1, saved)
    else rules.value.push(saved)
    defaultPreview.value = null
    defaultCriticalConfirmed.value = false
    notice.value = '当前邮箱默认提醒已保存。更具体的规则仍会优先。'
    emit('changed', saved)
  } catch (requestError) {
    error.value = requestError?.message || '默认提醒规则保存失败'
  } finally {
    busyRuleId.value = ''
  }
}

function close() {
  if (busyRuleId.value) return
  emit('close')
}

function setInlineConfirmButton(element) {
  if (element) inlineConfirmButton.value = element
}

function findRuleActionButton(target = inlineRestoreTarget) {
  if (!target) return null
  return Array.from(dialog.value?.querySelectorAll('[data-rule-action][data-rule-id]') || [])
    .find((element) => (
      element.dataset.ruleAction === target.kind
      && element.dataset.ruleId === String(target.ruleId)
    )) || null
}

async function focusInlineConfirmation(kind, ruleId) {
  inlineRestoreTarget = { kind, ruleId: String(ruleId) }
  await nextTick()
  inlineConfirmButton.value?.focus?.()
}

async function restoreInlineActionFocus() {
  const target = inlineRestoreTarget
  inlineRestoreTarget = null
  inlineConfirmButton.value = null
  await nextTick()
  findRuleActionButton(target)?.focus?.()
}

async function cancelInlineConfirmation() {
  deleteConfirmId.value = ''
  criticalConfirmRuleId.value = ''
  await restoreInlineActionFocus()
}

async function openDeleteConfirmation(rule) {
  if (!rule?.id || busyRuleId.value) return
  criticalConfirmRuleId.value = ''
  deleteConfirmId.value = rule.id
  await focusInlineConfirmation('delete', rule.id)
}

function focusableElements() {
  return Array.from(dialog.value?.querySelectorAll(
    'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ) || [])
}

function onKeydown(event) {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (deleteConfirmId.value || criticalConfirmRuleId.value) {
      void cancelInlineConfirmation()
      return
    }
    close()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = focusableElements()
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.open, async (open) => {
  if (!open) {
    document.removeEventListener('keydown', onKeydown)
    restoreTarget?.focus?.()
    restoreTarget = null
    return
  }
  restoreTarget = document.activeElement
  error.value = ''
  notice.value = ''
  deleteConfirmId.value = ''
  criticalConfirmRuleId.value = ''
  inlineRestoreTarget = null
  inlineConfirmButton.value = null
  defaultPreview.value = null
  defaultCriticalConfirmed.value = false
  document.addEventListener('keydown', onKeydown)
  await nextTick()
  closeButton.value?.focus?.()
  await loadRules()
})

watch(() => props.accountId, () => {
  if (props.open) void loadRules()
})

watch(defaultAction, () => {
  defaultPreview.value = null
  defaultCriticalConfirmed.value = false
  error.value = ''
})

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mail-rules-backdrop" @mousedown.self="close">
      <section
        ref="dialog"
        class="mail-rules-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-rules-title"
        aria-describedby="mail-rules-description"
      >
        <header>
          <div>
            <span aria-hidden="true"><Icon name="bell" :size="20" /></span>
            <div>
              <p>邮件降噪</p>
              <h2 id="mail-rules-title">提醒规则</h2>
            </div>
          </div>
          <button ref="closeButton" type="button" aria-label="关闭提醒规则管理" @click="close">
            <Icon name="close" :size="19" />
          </button>
        </header>

        <div class="mail-rules-dialog__body">
          <p id="mail-rules-description" class="mail-rules-dialog__intro">
            手动规则优先级为会话、发件人、域名、类别、邮箱默认。暂停或删除规则不会删除、拒收或隐藏邮件。
          </p>

          <section class="mail-rules-default" aria-labelledby="mail-rules-default-title">
            <div>
              <span><Icon name="settings" :size="18" /></span>
              <div>
                <h3 id="mail-rules-default-title">当前邮箱默认提醒</h3>
                <p>{{ accountLabel }} · 只有没有更具体规则时才使用</p>
              </div>
            </div>
            <label>
              <span>默认方式</span>
              <select v-model="defaultAction" :disabled="!hasAccount || Boolean(busyRuleId)">
                <option v-for="option in actionOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </label>
            <label v-if="defaultNeedsCriticalConfirmation" class="mail-rules-critical">
              <input v-model="defaultCriticalConfirmed" type="checkbox">
              <span>我确认仍要降低安全或支付邮件的即时提醒；邮件本身会继续保留。</span>
            </label>
            <button
              type="button"
              :disabled="!hasAccount || Boolean(busyRuleId) || (defaultNeedsCriticalConfirmation && !defaultCriticalConfirmed)"
              @click="saveDefaultRule"
            >
              <Icon name="circle-check" :size="17" />
              {{ busyRuleId === 'default' ? '保存中…' : defaultRule ? '更新邮箱默认' : '建立邮箱默认' }}
            </button>
          </section>

          <p v-if="error" class="mail-rules-dialog__error" role="alert">{{ error }}</p>
          <p v-if="notice" class="mail-rules-dialog__notice" role="status">{{ notice }}</p>

          <section class="mail-rules-list" aria-labelledby="mail-rules-list-title" :aria-busy="loading">
            <div class="mail-rules-list__heading">
              <div>
                <h3 id="mail-rules-list-title">已建立规则</h3>
                <p>{{ loading ? '正在读取…' : `共 ${rules.length} 条` }}</p>
              </div>
              <button type="button" :disabled="loading || Boolean(busyRuleId)" @click="loadRules">
                <Icon name="refresh" :size="17" />
                <span>刷新</span>
              </button>
            </div>

            <div v-if="loading && !rules.length" class="mail-rules-empty" role="status">
              正在读取提醒规则…
            </div>
            <div v-else-if="!rules.length" class="mail-rules-empty">
              <Icon name="bell" :size="22" />
              <strong>还没有提醒规则</strong>
              <p>可先建立当前邮箱默认规则，或从任意邮件创建发件人、域名、类别与会话规则。</p>
            </div>
            <article v-for="rule in rules" v-else :key="rule.id" class="mail-rule-card">
              <div class="mail-rule-card__main">
                <span class="mail-rule-card__icon" aria-hidden="true">
                  <Icon :name="actionMeta(rule.action).icon" :size="18" />
                </span>
                <div>
                  <div class="mail-rule-card__title">
                    <strong>{{ ruleScope(rule) }}</strong>
                    <span :class="ruleState(rule).className">{{ ruleState(rule).label }}</span>
                  </div>
                  <p>{{ ruleMatch(rule) }}</p>
                  <dl>
                    <div><dt>提醒</dt><dd>{{ actionMeta(rule.action).label }}</dd></div>
                    <div><dt>有效期</dt><dd>{{ formatDate(rule.expiresAt) }}</dd></div>
                    <div><dt>命中</dt><dd>{{ hitSummary(rule) }}</dd></div>
                  </dl>
                </div>
              </div>

              <div v-if="criticalConfirmRuleId === rule.id" class="mail-rule-card__confirm is-warning">
                <p>确认降低关键邮件提醒？邮件仍会保留，并可随时重新启用即时提醒。</p>
                <div>
                  <button type="button" :disabled="Boolean(busyRuleId)" @click="cancelInlineConfirmation">取消</button>
                  <button :ref="setInlineConfirmButton" type="button" :disabled="Boolean(busyRuleId)" @click="toggleRule(rule, { criticalConfirmed: true })">确认启用</button>
                </div>
              </div>
              <div v-else-if="deleteConfirmId === rule.id" class="mail-rule-card__confirm is-danger">
                <p>确认删除“{{ ruleScope(rule) }}”规则？此操作不会删除任何邮件。</p>
                <div>
                  <button type="button" :disabled="Boolean(busyRuleId)" @click="cancelInlineConfirmation">取消</button>
                  <button :ref="setInlineConfirmButton" type="button" :disabled="Boolean(busyRuleId)" @click="removeRule(rule)">
                    {{ busyRuleId === rule.id ? '删除中…' : '确认删除' }}
                  </button>
                </div>
              </div>
              <div v-else class="mail-rule-card__actions">
                <button type="button" data-rule-action="toggle" :data-rule-id="rule.id" :disabled="Boolean(busyRuleId)" @click="toggleRule(rule)">
                  <Icon :name="ruleIsActive(rule) ? 'bell-off' : 'bell'" :size="17" />
                  {{ busyRuleId === rule.id ? '处理中…' : ruleIsActive(rule) ? '暂停' : '启用' }}
                </button>
                <button type="button" class="is-danger" data-rule-action="delete" :data-rule-id="rule.id" :disabled="Boolean(busyRuleId)" @click="openDeleteConfirmation(rule)">
                  <Icon name="trash" :size="17" />
                  删除
                </button>
              </div>
            </article>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.mail-rules-backdrop { position: fixed; inset: 0; z-index: 1250; display: grid; padding: 16px; place-items: center; background: color-mix(in srgb, #000 54%, transparent); backdrop-filter: blur(12px); }
.mail-rules-dialog { display: flex; width: min(760px, 100%); max-height: min(840px, calc(100dvh - 32px)); overflow: hidden; flex-direction: column; color: var(--text-primary); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 22px; box-shadow: var(--shadow-modal, 0 28px 80px rgba(0, 0, 0, .32)); }
.mail-rules-dialog > header { display: flex; min-height: 76px; padding: 14px 16px 14px 20px; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; background: color-mix(in srgb, var(--bg-card) 94%, transparent); border-bottom: 1px solid var(--border-light); }
.mail-rules-dialog > header > div { display: flex; min-width: 0; align-items: center; gap: 11px; }
.mail-rules-dialog > header > div > span { display: grid; width: 42px; height: 42px; flex: 0 0 auto; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 13px; }
.mail-rules-dialog header p { margin: 0 0 3px; color: var(--accent-color); font-size: .63rem; font-weight: 760; }
.mail-rules-dialog h2 { margin: 0; font-size: 1rem; }
.mail-rules-dialog > header button { display: grid; width: 44px; height: 44px; place-items: center; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-rules-dialog__body { display: grid; min-height: 0; padding: 18px 20px 22px; overflow-y: auto; gap: 16px; }
.mail-rules-dialog__intro { margin: 0; color: var(--text-muted); font-size: .7rem; line-height: 1.65; }
.mail-rules-default { display: grid; padding: 15px; grid-template-columns: minmax(0, 1fr) minmax(150px, 190px) auto; align-items: end; gap: 12px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 16px; }
.mail-rules-default > div:first-child { display: flex; min-width: 0; align-items: center; gap: 10px; }
.mail-rules-default > div:first-child > span { display: grid; width: 38px; height: 38px; flex: 0 0 auto; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 11px; }
.mail-rules-default h3, .mail-rules-list h3 { margin: 0; font-size: .78rem; }
.mail-rules-default p, .mail-rules-list__heading p { margin: 4px 0 0; color: var(--text-muted); font-size: .63rem; line-height: 1.5; }
.mail-rules-default > label:not(.mail-rules-critical) { display: grid; gap: 6px; color: var(--text-secondary); font-size: .62rem; font-weight: 700; }
.mail-rules-default select { min-height: 44px; padding: 0 10px; color: var(--text-primary); font: inherit; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 11px; }
.mail-rules-default > button, .mail-rules-list__heading button, .mail-rule-card__actions button, .mail-rule-card__confirm button { display: inline-flex; min-height: 44px; padding: 0 12px; align-items: center; justify-content: center; gap: 7px; color: var(--text-secondary); font: inherit; font-size: .67rem; font-weight: 700; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 11px; cursor: pointer; }
.mail-rules-default > button { color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: transparent; }
.mail-rules-default button:disabled, .mail-rules-list button:disabled { opacity: .5; cursor: not-allowed; }
.mail-rules-critical { display: grid; grid-column: 1 / -1; padding: 11px; align-items: start; grid-template-columns: auto minmax(0, 1fr); gap: 8px; color: var(--warning-color); font-size: .66rem; line-height: 1.55; background: color-mix(in srgb, var(--warning-color) 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--warning-color) 25%, transparent); border-radius: 11px; }
.mail-rules-critical input { width: 20px; height: 20px; margin: 0; accent-color: var(--warning-color); }
.mail-rules-dialog__error, .mail-rules-dialog__notice { margin: 0; padding: 11px 12px; font-size: .68rem; line-height: 1.5; border-radius: 11px; }
.mail-rules-dialog__error { color: var(--error-color); background: color-mix(in srgb, var(--error-color) 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--error-color) 26%, transparent); }
.mail-rules-dialog__notice { color: var(--success-color, #4c8a64); background: color-mix(in srgb, var(--success-color, #4c8a64) 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--success-color, #4c8a64) 26%, transparent); }
.mail-rules-list { display: grid; gap: 9px; }
.mail-rules-list__heading { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 12px; }
.mail-rules-list__heading button { background: var(--bg-secondary); }
.mail-rules-empty { display: grid; min-height: 170px; padding: 20px; place-items: center; align-content: center; gap: 7px; color: var(--text-muted); text-align: center; background: var(--bg-secondary); border: 1px dashed var(--border-light); border-radius: 15px; }
.mail-rules-empty strong { color: var(--text-primary); font-size: .75rem; }
.mail-rules-empty p { max-width: 430px; margin: 0; font-size: .67rem; line-height: 1.6; }
.mail-rule-card { display: grid; padding: 13px; gap: 11px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 15px; }
.mail-rule-card__main { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 10px; }
.mail-rule-card__icon { display: grid; width: 40px; height: 40px; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 12px; }
.mail-rule-card__title { display: flex; min-height: 24px; align-items: center; justify-content: space-between; gap: 10px; }
.mail-rule-card__title strong { font-size: .72rem; }
.mail-rule-card__title span { padding: 3px 7px; color: var(--text-muted); font-size: .58rem; font-weight: 730; background: var(--bg-card); border-radius: 999px; }
.mail-rule-card__title span.is-active { color: var(--success-color, #4c8a64); }
.mail-rule-card__title span.is-expired { color: var(--warning-color); }
.mail-rule-card__main p { margin: 1px 0 8px; overflow: hidden; color: var(--text-secondary); font-size: .69rem; text-overflow: ellipsis; white-space: nowrap; }
.mail-rule-card dl { display: grid; margin: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.mail-rule-card dl div { display: grid; min-width: 0; gap: 2px; }
.mail-rule-card dt { color: var(--text-muted); font-size: .57rem; }
.mail-rule-card dd { margin: 0; overflow: hidden; color: var(--text-secondary); font-size: .62rem; text-overflow: ellipsis; white-space: nowrap; }
.mail-rule-card__actions { display: flex; justify-content: flex-end; gap: 7px; }
.mail-rule-card__actions button.is-danger, .mail-rule-card__confirm.is-danger button:last-child { color: var(--error-color); }
.mail-rule-card__confirm { padding: 11px; color: var(--warning-color); background: color-mix(in srgb, var(--warning-color) 8%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--warning-color) 24%, transparent); border-radius: 11px; }
.mail-rule-card__confirm.is-danger { color: var(--error-color); background: color-mix(in srgb, var(--error-color) 8%, var(--bg-card)); border-color: color-mix(in srgb, var(--error-color) 24%, transparent); }
.mail-rule-card__confirm p { margin: 0; font-size: .66rem; line-height: 1.55; }
.mail-rule-card__confirm div { display: flex; margin-top: 9px; justify-content: flex-end; gap: 7px; }
@media (max-width: 680px), (pointer: coarse) and (max-width: 900px) {
  .mail-rules-backdrop { padding: 0; align-items: end; }
  .mail-rules-dialog { width: 100%; max-height: 92dvh; border-radius: 22px 22px 0 0; }
  .mail-rules-dialog__body { padding: 15px 14px max(18px, env(safe-area-inset-bottom)); }
  .mail-rules-default { grid-template-columns: minmax(0, 1fr); align-items: stretch; }
  .mail-rules-default > button { width: 100%; }
  .mail-rule-card dl { grid-template-columns: 1fr; }
  .mail-rule-card__actions button { flex: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .mail-rules-backdrop { backdrop-filter: none; }
}
</style>
