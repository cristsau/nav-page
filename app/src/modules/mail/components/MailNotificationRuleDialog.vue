<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  createEmailNotificationRule,
  previewEmailNotificationRule
} from '@/shared/services/emailApi'

const props = defineProps({
  open: { type: Boolean, default: false },
  message: { type: Object, default: null },
  accountId: { type: String, default: '' }
})

const emit = defineEmits(['close', 'saved'])
const dialog = ref(null)
const firstControl = ref(null)
const scope = ref('sender')
const action = ref('silent')
const expiry = ref('never')
const criticalConfirmed = ref(false)
const preview = ref(null)
const busy = ref('')
const error = ref('')
let restoreTarget = null

const actionOptions = [
  { value: 'immediate', label: '立即提醒', detail: '发送 Web Push，并保留站内通知。', icon: 'bell' },
  { value: 'digest', label: '仅放入摘要', detail: '不即时打扰，在每日摘要中集中处理。', icon: 'note' },
  { value: 'in_app_only', label: '仅站内显示', detail: '只在 DOMO NAV 通知中心出现。', icon: 'mail' },
  { value: 'silent', label: '完全静音', detail: '邮件仍会正常同步，不产生提醒。', icon: 'bell-off' }
]

function senderAddress() {
  return String(props.message?.from?.address || props.message?.senderAddress || '').trim().toLowerCase()
}

function senderDomain() {
  return senderAddress().split('@')[1] || ''
}

function conversationKey() {
  const value = String(props.message?.threadKey || props.message?.thread_key || '').trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(value) ? value : ''
}

function categoryValue() {
  return String(props.message?.category || '').trim().toLowerCase()
}

const scopeOptions = computed(() => [
  { value: 'conversation', label: '当前会话', detail: '只影响这一串往来邮件', available: Boolean(conversationKey()) },
  { value: 'sender', label: '这个发件人', detail: senderAddress() || '缺少发件人地址', available: Boolean(senderAddress()) },
  { value: 'domain', label: '这个发件人域名', detail: senderDomain() || '缺少发件人域名', available: Boolean(senderDomain()) },
  { value: 'category', label: '这类邮件', detail: categoryValue() || '邮件尚未分类', available: Boolean(categoryValue()) },
  { value: 'account', label: '当前邮箱默认', detail: '作为更具体规则之外的默认值', available: Boolean(props.accountId) }
])

const suppressiveAction = computed(() => ['digest', 'in_app_only', 'silent'].includes(action.value))
const requiresCriticalConfirmation = computed(() => (
  suppressiveAction.value && preview.value?.requiresCriticalConfirmation === true
))
const saveBlocked = computed(() => (
  busy.value
  || !preview.value
  || (requiresCriticalConfirmation.value && !criticalConfirmed.value)
))

function matchValueForScope() {
  return {
    conversation: conversationKey(),
    sender: senderAddress(),
    domain: senderDomain(),
    category: categoryValue(),
    account: ''
  }[scope.value] || ''
}

function expiresAtValue() {
  if (expiry.value === 'never') return null
  const date = new Date()
  date.setDate(date.getDate() + Number(expiry.value || 0))
  return date.toISOString()
}

function payload() {
  const result = {
    accountId: String(props.accountId || '').trim(),
    scope: scope.value,
    action: action.value,
    expiresAt: expiresAtValue(),
    enabled: true
  }
  const matchValue = matchValueForScope()
  if (matchValue) result.matchValue = matchValue
  if (requiresCriticalConfirmation.value) {
    result.criticalOverrideConfirmed = criticalConfirmed.value
  }
  return result
}

function fallbackPreview() {
  const selectedScope = scopeOptions.value.find((item) => item.value === scope.value)
  const selectedAction = actionOptions.find((item) => item.value === action.value)
  return `${selectedScope?.label || '这组邮件'}将设为“${selectedAction?.label || '自定义提醒'}”。邮件仍会正常同步，规则不会删除或隐藏原邮件。`
}

function previewText(value) {
  return String(
    value?.explanation
    || value?.preview?.text
    || value?.previewText
    || value?.description
    || value?.message
    || fallbackPreview()
  ).trim()
}

async function buildPreview() {
  if (busy.value) return
  busy.value = 'preview'
  error.value = ''
  preview.value = null
  try {
    const result = await previewEmailNotificationRule(payload())
    preview.value = {
      text: previewText(result),
      matchCount: Number(result?.matchCount ?? result?.preview?.matchedCount ?? result?.matchedCount ?? 0),
      criticalMatchCount: Number(result?.criticalMatchCount ?? 0),
      requiresCriticalConfirmation: result?.requiresCriticalConfirmation === true
    }
  } catch (requestError) {
    error.value = requestError?.message || '通知规则预览失败'
  } finally {
    busy.value = ''
  }
}

async function saveRule() {
  if (saveBlocked.value) return
  busy.value = 'save'
  error.value = ''
  try {
    const result = await createEmailNotificationRule(payload())
    emit('saved', result?.rule || result)
    close()
  } catch (requestError) {
    error.value = requestError?.message || '通知规则保存失败'
  } finally {
    busy.value = ''
  }
}

function close() {
  if (busy.value === 'save') return
  emit('close')
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
  scope.value = scopeOptions.value.find((item) => item.value === 'sender' && item.available)?.value
    || scopeOptions.value.find((item) => item.available)?.value
    || 'account'
  action.value = 'silent'
  expiry.value = 'never'
  criticalConfirmed.value = false
  preview.value = null
  error.value = ''
  busy.value = ''
  document.addEventListener('keydown', onKeydown)
  await nextTick()
  firstControl.value?.focus?.()
})

watch([scope, action, expiry], () => {
  preview.value = null
  criticalConfirmed.value = false
  error.value = ''
})

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mail-rule-backdrop" @mousedown.self="close">
      <section
        ref="dialog"
        class="mail-rule-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-rule-title"
        aria-describedby="mail-rule-description"
      >
        <header>
          <div>
            <span><Icon name="bell" :size="19" /></span>
            <div>
              <p>邮件通知</p>
              <h2 id="mail-rule-title">设置提醒规则</h2>
            </div>
          </div>
          <button type="button" aria-label="关闭通知规则" @click="close">
            <Icon name="close" :size="18" />
          </button>
        </header>

        <div class="mail-rule-dialog__body">
          <p id="mail-rule-description">手动规则始终优先于 AI 分类。关闭提醒不会删除、拒收或隐藏邮件。</p>

          <label>
            <span>作用范围</span>
            <select ref="firstControl" v-model="scope">
              <option
                v-for="option in scopeOptions"
                :key="option.value"
                :value="option.value"
                :disabled="!option.available"
              >
                {{ option.label }} · {{ option.detail }}
              </option>
            </select>
          </label>

          <fieldset>
            <legend>提醒方式</legend>
            <label v-for="option in actionOptions" :key="option.value" class="mail-rule-choice">
              <input v-model="action" type="radio" name="mail-notification-action" :value="option.value">
              <span aria-hidden="true"><Icon :name="option.icon" :size="18" /></span>
              <span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span>
            </label>
          </fieldset>

          <label>
            <span>有效时间</span>
            <select v-model="expiry">
              <option value="never">长期有效</option>
              <option value="1">静音 1 天</option>
              <option value="7">静音 7 天</option>
              <option value="30">静音 30 天</option>
            </select>
          </label>

          <label v-if="requiresCriticalConfirmation" class="mail-rule-critical">
            <input v-model="criticalConfirmed" type="checkbox">
            <span>预览发现 {{ preview.criticalMatchCount || '部分' }} 封关键邮件。我确认仍要降低这条规则的提醒强度；邮件本身会继续保留。</span>
          </label>

          <p v-if="error" class="mail-rule-dialog__error" role="alert">{{ error }}</p>
          <section v-if="preview" class="mail-rule-dialog__preview" aria-live="polite">
            <span><Icon name="circle-check" :size="18" /></span>
            <div>
              <strong>规则预览</strong>
              <p>{{ preview.text }}</p>
              <small v-if="preview.matchCount">最近数据中预计匹配 {{ preview.matchCount }} 封邮件。</small>
            </div>
          </section>
        </div>

        <footer>
          <button type="button" class="is-secondary" :disabled="Boolean(busy)" @click="buildPreview">
            {{ busy === 'preview' ? '正在预览…' : preview ? '重新预览' : '预览规则' }}
          </button>
          <button type="button" :disabled="Boolean(saveBlocked)" @click="saveRule">
            {{ busy === 'save' ? '保存中…' : '确认并启用' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.mail-rule-backdrop { position: fixed; inset: 0; z-index: 1200; display: grid; padding: 16px; place-items: center; background: color-mix(in srgb, #000 54%, transparent); backdrop-filter: blur(12px); }
.mail-rule-dialog { display: flex; width: min(540px, 100%); max-height: min(760px, calc(100dvh - 32px)); overflow: hidden; flex-direction: column; color: var(--text-primary); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 22px; box-shadow: var(--shadow-modal, 0 28px 80px rgba(0, 0, 0, .32)); }
.mail-rule-dialog > header { display: flex; min-height: 76px; padding: 14px 16px 14px 20px; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 12px; background: color-mix(in srgb, var(--bg-card) 94%, transparent); border-bottom: 1px solid var(--border-light); }
.mail-rule-dialog > header > div { display: flex; min-width: 0; align-items: center; gap: 11px; }
.mail-rule-dialog > header > div > span { display: grid; width: 42px; height: 42px; flex: 0 0 auto; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 13px; }
.mail-rule-dialog header p { margin: 0 0 3px; color: var(--accent-color); font-size: .63rem; font-weight: 760; }
.mail-rule-dialog h2 { margin: 0; font-size: 1rem; }
.mail-rule-dialog > header button { display: grid; width: 44px; height: 44px; place-items: center; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-rule-dialog__body { display: grid; min-height: 0; padding: 18px 20px; overflow-y: auto; gap: 16px; }
.mail-rule-dialog__body > p:first-child { margin: 0; color: var(--text-muted); font-size: .69rem; line-height: 1.65; }
.mail-rule-dialog__body > label { display: grid; gap: 7px; color: var(--text-secondary); font-size: .67rem; font-weight: 700; }
.mail-rule-dialog select { width: 100%; min-height: 46px; padding: 0 12px; color: var(--text-primary); font: inherit; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; }
.mail-rule-dialog fieldset { display: grid; margin: 0; padding: 0; gap: 7px; border: 0; }
.mail-rule-dialog legend { margin-bottom: 8px; color: var(--text-secondary); font-size: .67rem; font-weight: 700; }
.mail-rule-choice { display: grid; min-height: 58px; padding: 9px 11px; align-items: center; grid-template-columns: auto 34px minmax(0, 1fr); gap: 8px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 13px; cursor: pointer; }
.mail-rule-choice:has(input:checked) { background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent-color) 34%, var(--border-light)); }
.mail-rule-choice input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent-color); }
.mail-rule-choice > span:nth-of-type(1) { color: var(--accent-color); }
.mail-rule-choice > span:last-child { display: grid; gap: 2px; }
.mail-rule-choice strong { color: var(--text-primary); font-size: .7rem; }
.mail-rule-choice small { color: var(--text-muted); font-size: .62rem; line-height: 1.45; }
.mail-rule-critical { grid-template-columns: auto minmax(0, 1fr) !important; padding: 12px; align-items: start; color: var(--warning-color) !important; font-weight: 600 !important; line-height: 1.55; background: color-mix(in srgb, var(--warning-color) 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--warning-color) 24%, transparent); border-radius: 12px; }
.mail-rule-critical input { width: 20px; height: 20px; margin: 0; accent-color: var(--warning-color); }
.mail-rule-dialog__error { margin: 0; padding: 11px 12px; color: var(--error-color); font-size: .67rem; line-height: 1.55; background: color-mix(in srgb, var(--error-color) 8%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--error-color) 24%, transparent); border-radius: 12px; }
.mail-rule-dialog__preview { display: grid; padding: 12px; grid-template-columns: auto minmax(0, 1fr); gap: 9px; color: var(--success-color, #4c8a64); background: color-mix(in srgb, var(--success-color, #4c8a64) 8%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--success-color, #4c8a64) 24%, transparent); border-radius: 12px; }
.mail-rule-dialog__preview div { display: grid; gap: 4px; }
.mail-rule-dialog__preview strong { font-size: .68rem; }
.mail-rule-dialog__preview p, .mail-rule-dialog__preview small { margin: 0; color: var(--text-secondary); font-size: .65rem; line-height: 1.55; }
.mail-rule-dialog__preview small { color: var(--text-muted); }
.mail-rule-dialog > footer { display: flex; min-height: 74px; padding: 12px 20px; flex: 0 0 auto; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--border-light); }
.mail-rule-dialog > footer button { min-height: 46px; padding: 0 15px; color: var(--accent-contrast, #fff); font: inherit; font-size: .69rem; font-weight: 730; background: var(--accent-color); border: 1px solid transparent; border-radius: 12px; cursor: pointer; }
.mail-rule-dialog > footer button.is-secondary { color: var(--text-secondary); background: var(--bg-secondary); border-color: var(--border-light); }
.mail-rule-dialog > footer button:disabled { opacity: .48; cursor: not-allowed; }
@media (max-width: 640px), (pointer: coarse) and (max-width: 900px) {
  .mail-rule-backdrop { padding: 0; align-items: end; }
  .mail-rule-dialog { width: 100%; max-height: min(88dvh, 760px); border-radius: 22px 22px 0 0; }
  .mail-rule-dialog__body { padding: 16px; }
  .mail-rule-dialog > footer { padding: 11px 16px max(11px, env(safe-area-inset-bottom)); }
  .mail-rule-dialog > footer button { flex: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .mail-rule-backdrop { backdrop-filter: none; }
}
</style>
