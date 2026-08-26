<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { requestEmailAi } from '@/shared/services/emailApi'

const props = defineProps({
  message: { type: Object, default: null },
  messageId: { type: String, default: '' },
  loading: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'reply'])

const aiBusyAction = ref('')
const aiResult = ref(null)
const aiError = ref('')
let aiRequestSequence = 0

const safeMessageId = computed(() => String(
  props.message?.canonicalMessageId
  || props.message?.messageId
  || props.message?.id
  || props.messageId
  || ''
).trim())
const aiAvailable = computed(() => Boolean(
  props.message
  && !props.message.legacyEvent
  && safeMessageId.value
))

function senderName(message) {
  return message?.from?.name || message?.senderName || message?.from?.address || message?.senderAddress || '未知发件人'
}

function senderAddress(message) {
  return message?.from?.address || message?.senderAddress || ''
}

function addressLabel(entry) {
  if (!entry) return ''
  return entry.name && entry.address ? `${entry.name} <${entry.address}>` : entry.address || entry.name || ''
}

function addressList(value) {
  return (Array.isArray(value) ? value : []).map(addressLabel).filter(Boolean).join('，')
}

function bodyText(message) {
  return message?.body || message?.text || message?.textBody || message?.plainText || '邮件正文为空'
}

function receivedValue(message) {
  return message?.internalDate || message?.receivedAt || message?.sentAt || ''
}

function formatLongDate(value) {
  if (!value) return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date)
}

function attachmentName(attachment, index) {
  return attachment?.filename || attachment?.name || `附件 ${index + 1}`
}

function formatSize(value) {
  const bytes = Number(value || 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function textFromAiPayload(payload) {
  const result = payload?.result || payload?.output || payload?.data || payload
  if (typeof result === 'string') return result.trim()
  return String(
    result?.text
    || result?.content
    || result?.summary
    || result?.body
    || result?.draft?.text
    || result?.draft?.body
    || ''
  ).trim()
}

function titleForAiAction(action) {
  return {
    summarize: 'AI 摘要',
    tasks: '待办与时间点',
    draft_reply: 'AI 回信草稿',
    translate: '中文翻译'
  }[action] || 'AI 结果'
}

async function runAi(action) {
  if (!aiAvailable.value || aiBusyAction.value) return
  const requestMessageId = safeMessageId.value
  const requestSequence = ++aiRequestSequence
  aiBusyAction.value = action
  aiError.value = ''
  try {
    const payload = await requestEmailAi(requestMessageId, {
      action,
      language: action === 'translate' ? 'zh-CN' : ''
    })
    if (requestSequence !== aiRequestSequence || requestMessageId !== safeMessageId.value) return
    const text = textFromAiPayload(payload)
    if (!text) throw new Error('AI 没有返回可显示的内容')
    aiResult.value = { action, title: titleForAiAction(action), text }
  } catch (error) {
    if (requestSequence !== aiRequestSequence || requestMessageId !== safeMessageId.value) return
    aiError.value = error?.message || 'AI 邮件处理失败'
  } finally {
    if (requestSequence === aiRequestSequence) aiBusyAction.value = ''
  }
}

function replyPayload(text = '') {
  const originalSubject = String(props.message?.subject || '').trim()
  return {
    sourceMessageId: safeMessageId.value,
    to: senderAddress(props.message),
    cc: '',
    bcc: '',
    subject: /^re\s*:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject || '(无主题)'}`,
    text: String(text || '')
  }
}

function openReply(text = '') {
  emit('reply', replyPayload(text))
}

watch(() => safeMessageId.value, () => {
  aiRequestSequence += 1
  aiBusyAction.value = ''
  aiResult.value = null
  aiError.value = ''
})
</script>

<template>
  <article class="mail-message-detail" :aria-labelledby="message ? 'mail-message-detail-title' : undefined">
    <div v-if="loading" class="mail-message-detail__empty" role="status">
      <span><Icon name="mail" :size="27" /></span>
      <p>正在安全读取邮件…</p>
    </div>
    <div v-else-if="!message" class="mail-message-detail__empty">
      <span><Icon name="mail" :size="27" /></span>
      <h2>选择一封邮件</h2>
      <p>这里会显示发件人、完整正文和附件信息。</p>
    </div>
    <template v-else>
      <header class="mail-message-detail__header">
        <button type="button" aria-label="返回邮件列表" @click="$emit('close')">
          <Icon name="arrow-left" :size="19" />
        </button>
        <div>
          <p>{{ message.legacyEvent ? '历史智能分类邮件' : '只读邮件' }}</p>
          <h2 id="mail-message-detail-title">{{ message.subject || '(无主题)' }}</h2>
        </div>
        <button class="mail-message-detail__close" type="button" aria-label="关闭邮件详情" title="关闭" @click="$emit('close')">
          <Icon name="close" :size="18" />
        </button>
      </header>

      <dl>
        <div>
          <dt>发件人</dt>
          <dd>{{ senderName(message) }}<small v-if="senderAddress(message) && senderAddress(message) !== senderName(message)">{{ senderAddress(message) }}</small></dd>
        </div>
        <div>
          <dt>接收时间</dt>
          <dd><time :datetime="receivedValue(message)">{{ formatLongDate(receivedValue(message)) }}</time></dd>
        </div>
        <div v-if="addressList(message.to)">
          <dt>收件人</dt>
          <dd>{{ addressList(message.to) }}</dd>
        </div>
        <div v-if="addressList(message.cc)">
          <dt>抄送</dt>
          <dd>{{ addressList(message.cc) }}</dd>
        </div>
        <div v-if="message.legacyEvent && message.reason">
          <dt>分类原因</dt>
          <dd>{{ message.reason }}</dd>
        </div>
        <div v-if="message.legacyEvent && message.suggestedAction">
          <dt>建议操作</dt>
          <dd>{{ message.suggestedAction }}</dd>
        </div>
      </dl>

      <section v-if="!message.legacyEvent" class="mail-message-detail__actions" aria-label="邮件操作">
        <button type="button" @click="openReply()">
          <Icon name="edit" :size="17" />
          回复
        </button>
        <button type="button" :disabled="!aiAvailable || Boolean(aiBusyAction)" @click="runAi('summarize')">
          <Icon name="sparkles" :size="17" />
          {{ aiBusyAction === 'summarize' ? '摘要中…' : 'AI 摘要' }}
        </button>
        <button type="button" :disabled="!aiAvailable || Boolean(aiBusyAction)" @click="runAi('tasks')">
          <Icon name="list" :size="17" />
          {{ aiBusyAction === 'tasks' ? '提取中…' : '提取待办' }}
        </button>
        <button type="button" :disabled="!aiAvailable || Boolean(aiBusyAction)" @click="runAi('draft_reply')">
          <Icon name="edit" :size="17" />
          {{ aiBusyAction === 'draft_reply' ? '起草中…' : 'AI 回信' }}
        </button>
        <button type="button" :disabled="!aiAvailable || Boolean(aiBusyAction)" @click="runAi('translate')">
          <Icon name="book" :size="17" />
          {{ aiBusyAction === 'translate' ? '翻译中…' : '翻译' }}
        </button>
      </section>
      <p v-if="!message.legacyEvent" class="mail-message-detail__ai-privacy">
        AI 只接收已脱敏副本；验证码、卡号、密钥、邮箱地址等敏感值不会原样发送给模型。
      </p>

      <p v-if="aiError" class="mail-message-detail__ai-error" role="alert">{{ aiError }}</p>
      <section v-if="aiResult" class="mail-message-detail__ai" aria-labelledby="mail-ai-result-title">
        <div>
          <span><Icon name="sparkles" :size="18" /></span>
          <h3 id="mail-ai-result-title">{{ aiResult.title }}</h3>
          <button type="button" aria-label="关闭 AI 结果" title="关闭" @click="aiResult = null">
            <Icon name="close" :size="16" />
          </button>
        </div>
        <pre>{{ aiResult.text }}</pre>
        <button v-if="aiResult.action === 'draft_reply'" type="button" class="mail-message-detail__use-draft" @click="openReply(aiResult.text)">
          <Icon name="edit" :size="17" />
          检查并回复
        </button>
        <p>AI 结果可能有误。邮件正文被视为不可信内容，发送前仍需由你预览并明确确认。</p>
      </section>

      <section v-if="Array.isArray(message.attachments) && message.attachments.length" class="mail-message-detail__attachments" aria-labelledby="mail-attachments-title">
        <h3 id="mail-attachments-title">附件</h3>
        <ul>
          <li v-for="(attachment, index) in message.attachments" :key="`${attachmentName(attachment, index)}-${index}`">
            <span>{{ attachmentName(attachment, index) }}</span>
            <small>{{ attachment.contentType || '文件' }}<template v-if="formatSize(attachment.size)"> · {{ formatSize(attachment.size) }}</template></small>
          </li>
        </ul>
        <p>当前阶段只显示附件元数据，不会自动下载。</p>
      </section>

      <section class="mail-message-detail__body" aria-labelledby="mail-body-title">
        <h3 id="mail-body-title">正文</h3>
        <pre>{{ bodyText(message) }}</pre>
      </section>
    </template>
  </article>
</template>

<style scoped>
.mail-message-detail { min-width: 0; height: 100%; overflow-y: auto; color: var(--text-primary); background: var(--bg-card); }
.mail-message-detail__empty { display: grid; min-height: 100%; padding: 28px; place-content: center; justify-items: center; text-align: center; }
.mail-message-detail__empty > span { display: grid; width: 54px; height: 54px; margin-bottom: 14px; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 17px; }
.mail-message-detail__empty h2 { margin: 0; font-size: 1rem; }
.mail-message-detail__empty p { max-width: 420px; margin: 7px 0 0; color: var(--text-muted); font-size: .72rem; line-height: 1.65; }
.mail-message-detail__header { position: sticky; top: 0; z-index: 2; display: grid; min-height: 96px; padding: 18px clamp(16px, 3vw, 34px); align-items: start; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; background: color-mix(in srgb, var(--bg-card) 95%, transparent); border-bottom: 1px solid var(--border-light); backdrop-filter: blur(14px); }
.mail-message-detail__header button { display: grid; width: 44px; height: 44px; place-items: center; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-message-detail__header > button:first-child { display: none; }
.mail-message-detail__header p { margin: 2px 0 5px; color: var(--accent-color); font-size: .64rem; font-weight: 730; }
.mail-message-detail__header h2 { margin: 0; overflow-wrap: anywhere; font-size: clamp(.96rem, 2vw, 1.3rem); }
.mail-message-detail dl { display: grid; margin: 0; padding: 20px clamp(16px, 3vw, 34px); grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 17px 24px; border-bottom: 1px solid var(--border-light); }
.mail-message-detail dl div { display: grid; min-width: 0; gap: 5px; }
.mail-message-detail dt { color: var(--text-muted); font-size: .63rem; }
.mail-message-detail dd { display: grid; margin: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: .72rem; line-height: 1.6; }
.mail-message-detail dd small { color: var(--text-muted); }
.mail-message-detail__attachments,
.mail-message-detail__body { padding: 20px clamp(16px, 3vw, 34px); border-bottom: 1px solid var(--border-light); }
.mail-message-detail__actions { display: flex; padding: 13px clamp(16px, 3vw, 34px); overflow-x: auto; gap: 8px; border-bottom: 1px solid var(--border-light); scrollbar-width: thin; }
.mail-message-detail__ai-privacy { margin: 0; padding: 9px clamp(16px, 3vw, 34px); color: var(--text-muted); font-size: .61rem; line-height: 1.55; border-bottom: 1px solid var(--border-light); }
.mail-message-detail__actions button,
.mail-message-detail__ai button { display: inline-flex; min-height: 44px; padding: 0 12px; flex: 0 0 auto; align-items: center; justify-content: center; gap: 6px; color: var(--text-secondary); font: inherit; font-size: .68rem; font-weight: 700; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 11px; cursor: pointer; }
.mail-message-detail__actions button:disabled { opacity: .5; cursor: wait; }
.mail-message-detail__ai,
.mail-message-detail__ai-error { margin: 16px clamp(16px, 3vw, 34px) 0; padding: 14px; border-radius: 14px; }
.mail-message-detail__ai { background: var(--accent-bg); border: 1px solid color-mix(in srgb, var(--accent-color) 25%, transparent); }
.mail-message-detail__ai > div { display: grid; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; }
.mail-message-detail__ai > div > span { color: var(--accent-color); }
.mail-message-detail__ai > div h3 { margin: 0; }
.mail-message-detail__ai > div button { width: 44px; padding: 0; }
.mail-message-detail__ai pre { margin: 13px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .71rem; line-height: 1.7; }
.mail-message-detail__ai .mail-message-detail__use-draft { margin-top: 13px; color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: transparent; }
.mail-message-detail__ai > p { margin: 11px 0 0; color: var(--text-muted); font-size: .61rem; line-height: 1.55; }
.mail-message-detail__ai-error { color: var(--error-color); font-size: .68rem; line-height: 1.55; background: color-mix(in srgb, var(--error-color) 8%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--error-color) 24%, transparent); }
.mail-message-detail h3 { margin: 0 0 12px; font-size: .75rem; }
.mail-message-detail__attachments ul { display: grid; margin: 0; padding: 0; gap: 7px; list-style: none; }
.mail-message-detail__attachments li { display: grid; min-height: 44px; padding: 8px 11px; align-content: center; gap: 3px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 11px; }
.mail-message-detail__attachments li span { overflow-wrap: anywhere; color: var(--text-secondary); font-size: .7rem; }
.mail-message-detail__attachments li small,
.mail-message-detail__attachments > p { color: var(--text-muted); font-size: .61rem; }
.mail-message-detail__attachments > p { margin: 10px 0 0; }
.mail-message-detail__body { min-height: 220px; padding-bottom: 40px; }
.mail-message-detail__body pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .74rem; line-height: 1.8; }
@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .mail-message-detail { overflow: visible; }
  .mail-message-detail__header { min-height: 80px; padding: 12px; }
  .mail-message-detail__header > button:first-child { display: grid; }
  .mail-message-detail__close { display: none !important; }
  .mail-message-detail dl { grid-template-columns: 1fr; }
}
</style>
