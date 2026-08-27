<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { downloadEmailAttachment, requestEmailAi } from '@/shared/services/emailApi'

const props = defineProps({
  message: { type: Object, default: null },
  messageId: { type: String, default: '' },
  accountId: { type: String, default: '' },
  folderId: { type: String, default: '' },
  locationId: { type: String, default: '' },
  loading: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'reply', 'notification'])

const aiBusyAction = ref('')
const aiResult = ref(null)
const aiError = ref('')
const aiPanelOpen = ref(false)
const aiInstruction = ref('')
const bodyMode = ref('plain')
const attachmentDownloads = reactive({})
let aiRequestSequence = 0

const aiActions = [
  { action: 'summarize', label: '快速摘要', detail: '提炼关键结论和上下文', icon: 'note' },
  { action: 'thread_summary', label: '会话进展', detail: '梳理变化、未决问题与等待对象', icon: 'users' },
  { action: 'tasks', label: '提取待办', detail: '找出截止时间、责任人与下一步', icon: 'list' },
  { action: 'draft_reply', label: '起草回信', detail: '生成可编辑草稿，发送前仍需确认', icon: 'reply' },
  { action: 'translate', label: '翻译成中文', detail: '保留语气和专业术语', icon: 'book' },
  { action: 'explain_priority', label: '解释重要性', detail: '说明分类、提醒和判断依据', icon: 'bell' },
  { action: 'risk_review', label: '风险检查', detail: '辅助识别钓鱼、付款和账号风险', icon: 'shield' }
]

const categoryNames = {
  security: '账号安全', account: '账号安全', payment: '付款账单', billing: '付款账单',
  ops: '服务运维', server: '服务运维', work: '工作待办', action: '工作待办',
  receipt: '收据状态', status: '收据状态', personal: '个人邮件',
  newsletter: '订阅资讯', marketing: '营销推广', social: '社交通知', system: '系统通知'
}

const notificationNames = {
  immediate: '立即提醒', digest: '仅放入摘要', in_app_only: '仅站内显示', silent: '完全静音'
}

const safeMessageId = computed(() => String(
  props.message?.canonicalMessageId
  || props.message?.messageId
  || props.message?.id
  || props.messageId
  || ''
).trim())

const aiAvailable = computed(() => Boolean(props.message && !props.message.legacyEvent && safeMessageId.value))
const htmlBody = computed(() => String(props.message?.htmlBody || props.message?.html || '').trim())
const hasSafeHtml = computed(() => Boolean(htmlBody.value && sanitizedHtmlBody(htmlBody.value)))
const threadCount = computed(() => Math.max(1, Number(props.message?.threadMessageCount || props.message?.threadCount || 1)))
const threadEntries = computed(() => (
  Array.isArray(props.message?.threadMessages)
    ? props.message.threadMessages.filter((entry) => entry && typeof entry === 'object')
    : []
))
const categoryLabel = computed(() => {
  const value = String(props.message?.category || '').trim().toLowerCase()
  return categoryNames[value] || (value ? '智能分类' : '')
})
const notificationLabel = computed(() => notificationNames[String(props.message?.notificationAction || '').trim()] || '')

const safeHtmlDocument = computed(() => {
  const body = sanitizedHtmlBody(htmlBody.value)
  if (!body) return ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: cid:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"><meta name="color-scheme" content="light dark"><style>html{font:15px/1.7 system-ui,sans-serif;color:#252326;background:transparent}body{margin:0;overflow-wrap:anywhere}a{color:#5969d8}img{max-width:100%;height:auto}blockquote{margin-inline:0;padding-left:12px;border-left:3px solid #aaa}@media(prefers-color-scheme:dark){html{color:#e9e7eb}a{color:#a9b4ff}}</style></head><body>${body}</body></html>`
})

function sanitizedHtmlBody(value) {
  if (!value || typeof DOMParser === 'undefined') return ''
  const documentValue = new DOMParser().parseFromString(value, 'text/html')
  documentValue.querySelectorAll('script, iframe, frame, frameset, object, embed, form, input, button, textarea, select, meta, base, link, style, svg, math').forEach((node) => node.remove())
  documentValue.body.querySelectorAll('*').forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase()
      const attributeValue = attribute.value.trim()
      if (name.startsWith('on') || ['style', 'srcset', 'poster', 'action', 'formaction', 'xlink:href'].includes(name)) {
        node.removeAttribute(attribute.name)
        continue
      }
      if (name === 'src') {
        const allowed = /^(data:image\/(png|gif|jpeg|webp);|cid:)/i.test(attributeValue)
        if (!allowed) {
          node.removeAttribute(attribute.name)
          node.setAttribute('data-remote-image-blocked', 'true')
        }
      }
      if (name === 'href') {
        node.removeAttribute(attribute.name)
        if (/^https?:/i.test(attributeValue)) node.setAttribute('data-external-link', attributeValue)
      }
    }
  })
  return documentValue.body.innerHTML.trim()
}

function senderName(message) {
  return message?.from?.name || message?.senderName || message?.from?.address || message?.senderAddress || '未知发件人'
}

function senderAddress(message) {
  return message?.from?.address || message?.senderAddress || ''
}

function senderInitial(message) {
  return (senderName(message).match(/[\p{L}\p{N}]/u)?.[0] || '?').toLocaleUpperCase('zh-CN')
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
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date)
}

function attachmentName(attachment, index) {
  return attachment?.filename || attachment?.name || `附件 ${index + 1}`
}

function attachmentId(attachment) {
  return String(attachment?.id || attachment?.attachmentId || '').trim()
}

function attachmentDownloadState(attachment) {
  return attachmentDownloads[attachmentId(attachment)] || { status: 'idle', error: '' }
}

function safeDownloadName(value) {
  return String(value || 'attachment').replace(/[\\/:*?"<>|\r\n]+/g, '_') || 'attachment'
}

async function downloadAttachment(attachment, index) {
  const id = attachmentId(attachment)
  if (!id || attachmentDownloads[id]?.status === 'loading') return
  attachmentDownloads[id] = { status: 'loading', error: '' }
  let objectUrl = ''
  try {
    const file = await downloadEmailAttachment({
      accountId: props.accountId,
      locationId: props.locationId || props.messageId,
      attachmentId: id,
      folderId: props.folderId,
      filename: attachmentName(attachment, index)
    })
    objectUrl = URL.createObjectURL(file.blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = safeDownloadName(file.filename || attachmentName(attachment, index))
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    attachmentDownloads[id] = { status: 'complete', error: '' }
  } catch (error) {
    attachmentDownloads[id] = { status: 'error', error: error?.message || '附件下载失败' }
  } finally {
    if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
  }
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
  return String(result?.text || result?.content || result?.summary || result?.body || result?.draft?.text || result?.draft?.body || '').trim()
}

function titleForAiAction(action) {
  return aiActions.find((item) => item.action === action)?.label || 'AI 结果'
}

async function runAi(action, instruction = '') {
  if (!aiAvailable.value || aiBusyAction.value) return
  const requestMessageId = safeMessageId.value
  const requestSequence = ++aiRequestSequence
  aiBusyAction.value = action
  aiError.value = ''
  try {
    const payload = await requestEmailAi(requestMessageId, {
      action,
      instruction: String(instruction || '').trim(),
      language: action === 'translate' ? 'zh-CN' : ''
    })
    if (requestSequence !== aiRequestSequence || requestMessageId !== safeMessageId.value) return
    const text = textFromAiPayload(payload)
    if (!text) throw new Error('AI 没有返回可显示的内容')
    aiResult.value = { action, title: titleForAiAction(action), text }
    aiPanelOpen.value = false
    aiInstruction.value = ''
  } catch (error) {
    if (requestSequence !== aiRequestSequence || requestMessageId !== safeMessageId.value) return
    aiError.value = error?.message || 'AI 邮件处理失败'
  } finally {
    if (requestSequence === aiRequestSequence) aiBusyAction.value = ''
  }
}

function replyPayload(text = '', mode = 'reply') {
  const originalSubject = String(props.message?.subject || '').trim()
  const subjectPrefix = mode === 'forward' ? 'Fwd' : 'Re'
  const alreadyPrefixed = mode === 'forward' ? /^fwd?\s*:/i : /^re\s*:/i
  const recipient = mode === 'forward' ? '' : senderAddress(props.message)
  const cc = mode === 'reply-all' ? addressList(props.message?.cc) : ''
  let body = String(text || '')
  if (mode === 'forward' && !body) {
    body = `\n\n--- 转发邮件 ---\n发件人：${senderName(props.message)} <${senderAddress(props.message)}>\n日期：${formatLongDate(receivedValue(props.message))}\n主题：${originalSubject || '(无主题)'}\n\n${bodyText(props.message)}`
  }
  return {
    sourceMessageId: safeMessageId.value,
    to: recipient,
    cc,
    bcc: '',
    subject: alreadyPrefixed.test(originalSubject) ? originalSubject : `${subjectPrefix}: ${originalSubject || '(无主题)'}`,
    text: body
  }
}

function openReply(text = '', mode = 'reply') {
  emit('reply', replyPayload(text, mode))
}

function onDocumentKeydown(event) {
  if (event.key === 'Escape' && aiPanelOpen.value) {
    aiPanelOpen.value = false
    event.preventDefault()
  }
}

onMounted(() => document.addEventListener('keydown', onDocumentKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onDocumentKeydown))

watch(() => safeMessageId.value, () => {
  aiRequestSequence += 1
  aiBusyAction.value = ''
  aiResult.value = null
  aiError.value = ''
  aiPanelOpen.value = false
  aiInstruction.value = ''
  bodyMode.value = 'plain'
  for (const key of Object.keys(attachmentDownloads)) delete attachmentDownloads[key]
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
      <p>这里会显示完整会话、附件、通知规则和 AI 助理。</p>
    </div>
    <template v-else>
      <header class="mail-message-detail__header">
        <button type="button" aria-label="返回邮件列表" @click="$emit('close')">
          <Icon name="arrow-left" :size="19" />
        </button>
        <div>
          <p>{{ message.legacyEvent ? '历史智能分类邮件' : threadCount > 1 ? `${threadCount} 封会话邮件` : '邮件详情' }}</p>
          <h2 id="mail-message-detail-title">{{ message.subject || '(无主题)' }}</h2>
        </div>
        <button class="mail-message-detail__close" type="button" aria-label="关闭邮件详情" title="关闭" @click="$emit('close')">
          <Icon name="close" :size="18" />
        </button>
      </header>

      <section v-if="!message.legacyEvent" class="mail-message-detail__actions" aria-label="邮件操作">
        <button type="button" @click="openReply()"><Icon name="reply" :size="17" />回复</button>
        <button type="button" @click="openReply('', 'reply-all')"><Icon name="reply-all" :size="17" />全部回复</button>
        <button type="button" @click="openReply('', 'forward')"><Icon name="forward" :size="17" />转发</button>
        <button type="button" @click="emit('notification', message, $event.currentTarget)">
          <Icon :name="message.notificationAction === 'silent' ? 'bell-off' : 'bell'" :size="17" />提醒
        </button>
        <button type="button" class="is-ai" :aria-expanded="aiPanelOpen" aria-controls="mail-ai-panel" @click="aiPanelOpen = !aiPanelOpen">
          <Icon name="sparkles" :size="17" />AI 助理
        </button>
      </section>

      <section v-if="aiPanelOpen" id="mail-ai-panel" class="mail-message-detail__ai-panel" role="region" aria-label="邮件 AI 助理">
        <header>
          <div><span><Icon name="sparkles" :size="18" /></span><div><strong>邮件 AI 助理</strong><small>回答带依据，所有外发仍需你确认</small></div></div>
          <button type="button" aria-label="关闭 AI 助理" @click="aiPanelOpen = false"><Icon name="close" :size="17" /></button>
        </header>
        <div class="mail-message-detail__ai-grid">
          <button v-for="item in aiActions" :key="item.action" type="button" :disabled="Boolean(aiBusyAction)" @click="runAi(item.action)">
            <span><Icon :name="item.icon" :size="17" /></span>
            <span><strong>{{ aiBusyAction === item.action ? '处理中…' : item.label }}</strong><small>{{ item.detail }}</small></span>
          </button>
        </div>
        <form @submit.prevent="runAi('ask', aiInstruction)">
          <label for="mail-ai-instruction">就这封邮件提问</label>
          <textarea id="mail-ai-instruction" v-model="aiInstruction" rows="3" placeholder="例如：这封邮件需要我在什么时候回复？"></textarea>
          <button type="submit" :disabled="!aiInstruction.trim() || Boolean(aiBusyAction)"><Icon name="sparkles" :size="17" />{{ aiBusyAction === 'ask' ? '思考中…' : '询问 AI' }}</button>
        </form>
        <p>邮件正文被视为不可信内容；敏感值先脱敏，AI 不能自行发送、删除或移动邮件。</p>
      </section>

      <section class="mail-message-detail__sender">
        <span class="mail-message-detail__avatar" aria-hidden="true">{{ senderInitial(message) }}</span>
        <div>
          <strong>{{ senderName(message) }}</strong>
          <small>{{ senderAddress(message) }}</small>
        </div>
        <time :datetime="receivedValue(message)">{{ formatLongDate(receivedValue(message)) }}</time>
      </section>

      <div class="mail-message-detail__signals" aria-label="邮件分类和提醒">
        <span v-if="categoryLabel"><Icon name="tag" :size="14" />{{ categoryLabel }}</span>
        <span v-if="notificationLabel"><Icon :name="message.notificationAction === 'silent' ? 'bell-off' : 'bell'" :size="14" />{{ notificationLabel }}</span>
        <span v-if="Number(message.importanceScore || 0) > 0"><Icon name="star" :size="14" />重要度 {{ Math.round(Number(message.importanceScore) * 100) }}%</span>
        <small v-if="message.notificationReason">{{ message.notificationReason }}</small>
      </div>

      <section v-if="threadEntries.length > 1" class="mail-message-detail__thread" aria-labelledby="mail-thread-title">
        <h3 id="mail-thread-title">同一会话 · {{ threadEntries.length }} 封</h3>
        <details v-for="(entry, index) in threadEntries" :key="entry.id || entry.messageId || index" :open="index === threadEntries.length - 1">
          <summary>
            <span>{{ senderInitial(entry) }}</span>
            <span><strong>{{ senderName(entry) }}</strong><small>{{ entry.subject || message.subject || '(无主题)' }}</small></span>
            <time :datetime="receivedValue(entry)">{{ formatLongDate(receivedValue(entry)) }}</time>
          </summary>
          <pre>{{ bodyText(entry) }}</pre>
        </details>
      </section>

      <details class="mail-message-detail__recipients">
        <summary>查看收件人与邮件信息</summary>
        <dl>
          <div><dt>收件人</dt><dd>{{ addressList(message.to) || '未知' }}</dd></div>
          <div v-if="addressList(message.cc)"><dt>抄送</dt><dd>{{ addressList(message.cc) }}</dd></div>
          <div v-if="message.legacyEvent && message.reason"><dt>分类原因</dt><dd>{{ message.reason }}</dd></div>
          <div v-if="message.legacyEvent && message.suggestedAction"><dt>建议操作</dt><dd>{{ message.suggestedAction }}</dd></div>
        </dl>
      </details>

      <p v-if="aiError" class="mail-message-detail__ai-error" role="alert">{{ aiError }}</p>
      <section v-if="aiResult" class="mail-message-detail__ai" aria-labelledby="mail-ai-result-title">
        <div>
          <span><Icon name="sparkles" :size="18" /></span>
          <h3 id="mail-ai-result-title">{{ aiResult.title }}</h3>
          <button type="button" aria-label="关闭 AI 结果" title="关闭" @click="aiResult = null"><Icon name="close" :size="16" /></button>
        </div>
        <pre>{{ aiResult.text }}</pre>
        <button v-if="aiResult.action === 'draft_reply'" type="button" class="mail-message-detail__use-draft" @click="openReply(aiResult.text)"><Icon name="edit" :size="17" />检查并回复</button>
        <p>AI 结果可能有误。发送前仍需由你预览并明确确认。</p>
      </section>

      <section v-if="Array.isArray(message.attachments) && message.attachments.length" class="mail-message-detail__attachments" aria-labelledby="mail-attachments-title">
        <h3 id="mail-attachments-title">附件</h3>
        <ul aria-live="polite">
          <li v-for="(attachment, index) in message.attachments" :key="attachmentId(attachment) || `${attachmentName(attachment, index)}-${index}`">
            <div><span>{{ attachmentName(attachment, index) }}</span><small>{{ attachment.contentType || '文件' }}<template v-if="formatSize(attachment.size)"> · {{ formatSize(attachment.size) }}</template></small><small v-if="attachmentDownloadState(attachment).error" class="is-error" role="alert">{{ attachmentDownloadState(attachment).error }}</small></div>
            <button type="button" :disabled="!attachmentId(attachment) || attachmentDownloadState(attachment).status === 'loading'" :aria-label="`${attachmentDownloadState(attachment).status === 'error' ? '重试下载' : '下载'} ${attachmentName(attachment, index)}`" @click="downloadAttachment(attachment, index)">
              <Icon :name="attachmentDownloadState(attachment).status === 'error' ? 'refresh' : 'download'" :size="17" /><span>{{ attachmentDownloadState(attachment).status === 'loading' ? '下载中…' : attachmentDownloadState(attachment).status === 'error' ? '重试' : '下载' }}</span>
            </button>
          </li>
        </ul>
        <p>附件只会在你点击下载后读取；页面不会自动预览或执行附件。</p>
      </section>

      <section class="mail-message-detail__body" aria-labelledby="mail-body-title">
        <header>
          <h3 id="mail-body-title">正文</h3>
          <div v-if="hasSafeHtml" role="group" aria-label="正文显示模式">
            <button type="button" :aria-pressed="bodyMode === 'plain'" :class="{ 'is-active': bodyMode === 'plain' }" @click="bodyMode = 'plain'">纯文本</button>
            <button type="button" :aria-pressed="bodyMode === 'html'" :class="{ 'is-active': bodyMode === 'html' }" @click="bodyMode = 'html'">安全排版</button>
          </div>
        </header>
        <div v-if="hasSafeHtml && bodyMode === 'html'" class="mail-message-detail__html">
          <p><Icon name="shield" :size="14" />远程图片、脚本、表单和外部资源已阻止。</p>
          <iframe sandbox="" :srcdoc="safeHtmlDocument" title="安全渲染的邮件正文"></iframe>
        </div>
        <pre v-else>{{ bodyText(message) }}</pre>
      </section>

      <nav v-if="!message.legacyEvent" class="mail-message-detail__mobile-actions" aria-label="移动端邮件操作">
        <button type="button" @click="openReply()"><Icon name="reply" :size="19" /><span>回复</span></button>
        <button type="button" @click="emit('notification', message, $event.currentTarget)"><Icon name="bell" :size="19" /><span>提醒</span></button>
        <button type="button" :aria-expanded="aiPanelOpen" @click="aiPanelOpen = !aiPanelOpen"><Icon name="sparkles" :size="19" /><span>AI 助理</span></button>
        <button type="button" @click="openReply('', 'forward')"><Icon name="forward" :size="19" /><span>转发</span></button>
      </nav>
    </template>
  </article>
</template>

<style scoped>
.mail-message-detail { position: relative; min-width: 0; height: 100%; overflow-y: auto; color: var(--text-primary); background: var(--bg-card); }
.mail-message-detail__empty { display: grid; min-height: 100%; padding: 28px; place-content: center; justify-items: center; text-align: center; }
.mail-message-detail__empty > span { display: grid; width: 54px; height: 54px; margin-bottom: 14px; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 17px; }
.mail-message-detail__empty h2 { margin: 0; font-size: 1rem; }
.mail-message-detail__empty p { max-width: 420px; margin: 7px 0 0; color: var(--text-muted); font-size: .72rem; line-height: 1.65; }
.mail-message-detail__header { position: sticky; top: 0; z-index: 4; display: grid; min-height: 82px; padding: 15px clamp(16px, 2.4vw, 28px); align-items: start; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; background: color-mix(in srgb, var(--bg-card) 94%, transparent); border-bottom: 1px solid var(--border-light); backdrop-filter: blur(16px); }
.mail-message-detail__header button { display: grid; width: 44px; height: 44px; place-items: center; color: var(--text-secondary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-message-detail__header > button:first-child { display: none; }
.mail-message-detail__header p { margin: 2px 0 4px; color: var(--accent-color); font-size: .61rem; font-weight: 750; }
.mail-message-detail__header h2 { margin: 0; overflow-wrap: anywhere; font-size: clamp(.93rem, 1.6vw, 1.18rem); }
.mail-message-detail__actions { position: sticky; top: 82px; z-index: 3; display: flex; min-height: 61px; padding: 8px clamp(16px, 2.4vw, 28px); overflow-x: auto; gap: 6px; background: color-mix(in srgb, var(--bg-card) 94%, transparent); border-bottom: 1px solid var(--border-light); backdrop-filter: blur(16px); scrollbar-width: thin; }
.mail-message-detail__actions button { display: inline-flex; min-height: 44px; padding: 0 11px; flex: 0 0 auto; align-items: center; justify-content: center; gap: 6px; color: var(--text-secondary); font: inherit; font-size: .65rem; font-weight: 700; background: transparent; border: 1px solid transparent; border-radius: 11px; cursor: pointer; }
.mail-message-detail__actions button:hover, .mail-message-detail__actions button:focus-visible { color: var(--text-primary); background: var(--bg-secondary); border-color: var(--border-light); }
.mail-message-detail__actions button.is-ai { color: var(--accent-color); background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent-color) 20%, var(--border-light)); }
.mail-message-detail__ai-panel { margin: 14px clamp(16px, 2.4vw, 28px) 0; padding: 14px; background: color-mix(in srgb, var(--accent-bg) 66%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--accent-color) 24%, var(--border-light)); border-radius: 17px; box-shadow: var(--shadow-card); }
.mail-message-detail__ai-panel > header { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 10px; }
.mail-message-detail__ai-panel > header > div { display: flex; align-items: center; gap: 9px; }
.mail-message-detail__ai-panel > header > div > span { display: grid; width: 38px; height: 38px; place-items: center; color: var(--accent-color); background: var(--bg-card); border-radius: 11px; }
.mail-message-detail__ai-panel header div div { display: grid; gap: 2px; }
.mail-message-detail__ai-panel header strong { font-size: .72rem; }
.mail-message-detail__ai-panel header small { color: var(--text-muted); font-size: .59rem; }
.mail-message-detail__ai-panel > header > button { display: grid; width: 44px; height: 44px; place-items: center; color: var(--text-secondary); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 11px; cursor: pointer; }
.mail-message-detail__ai-grid { display: grid; margin-top: 11px; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.mail-message-detail__ai-grid button { display: grid; min-height: 66px; padding: 9px 10px; align-items: center; grid-template-columns: 32px minmax(0, 1fr); gap: 8px; text-align: left; color: var(--text-primary); font: inherit; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-message-detail__ai-grid button:disabled { opacity: .5; cursor: wait; }
.mail-message-detail__ai-grid button > span:first-child { color: var(--accent-color); }
.mail-message-detail__ai-grid button > span:last-child { display: grid; gap: 2px; }
.mail-message-detail__ai-grid strong { font-size: .65rem; }
.mail-message-detail__ai-grid small { color: var(--text-muted); font-size: .56rem; line-height: 1.35; }
.mail-message-detail__ai-panel form { display: grid; margin-top: 10px; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
.mail-message-detail__ai-panel form label { grid-column: 1 / -1; color: var(--text-muted); font-size: .61rem; font-weight: 700; }
.mail-message-detail__ai-panel textarea { min-width: 0; padding: 10px 11px; resize: vertical; color: var(--text-primary); font: inherit; font-size: .66rem; line-height: 1.55; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; }
.mail-message-detail__ai-panel form button { display: inline-flex; min-width: 104px; min-height: 44px; padding: 0 12px; align-items: center; justify-content: center; gap: 6px; color: var(--accent-contrast, #fff); font: inherit; font-size: .64rem; font-weight: 720; background: var(--accent-color); border: 0; border-radius: 12px; cursor: pointer; }
.mail-message-detail__ai-panel form button:disabled { opacity: .5; cursor: not-allowed; }
.mail-message-detail__ai-panel > p { margin: 10px 0 0; color: var(--text-muted); font-size: .57rem; line-height: 1.5; }
.mail-message-detail__sender { display: grid; padding: 20px clamp(16px, 2.4vw, 28px) 12px; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 11px; }
.mail-message-detail__avatar { display: grid; width: 42px; height: 42px; place-items: center; color: var(--accent-color); font-size: .75rem; font-weight: 780; background: var(--accent-bg); border: 1px solid color-mix(in srgb, var(--accent-color) 20%, var(--border-light)); border-radius: 13px; }
.mail-message-detail__sender > div { display: grid; min-width: 0; gap: 3px; }
.mail-message-detail__sender strong { overflow: hidden; font-size: .74rem; white-space: nowrap; text-overflow: ellipsis; }
.mail-message-detail__sender small, .mail-message-detail__sender time { color: var(--text-muted); font-size: .6rem; overflow-wrap: anywhere; }
.mail-message-detail__signals { display: flex; padding: 0 clamp(16px, 2.4vw, 28px) 12px; flex-wrap: wrap; gap: 5px; border-bottom: 1px solid var(--border-light); }
.mail-message-detail__signals > span { display: inline-flex; min-height: 27px; padding: 3px 8px; align-items: center; gap: 5px; color: var(--accent-color); font-size: .59rem; background: var(--accent-bg); border: 1px solid color-mix(in srgb, var(--accent-color) 18%, var(--border-light)); border-radius: 999px; }
.mail-message-detail__signals > small { width: 100%; margin-top: 3px; color: var(--text-muted); font-size: .58rem; line-height: 1.5; }
.mail-message-detail__thread { display: grid; padding: 17px clamp(16px, 2.4vw, 28px); gap: 7px; border-bottom: 1px solid var(--border-light); }
.mail-message-detail__thread > h3 { margin-bottom: 4px; }
.mail-message-detail__thread details { overflow: hidden; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; }
.mail-message-detail__thread summary { display: grid; min-height: 58px; padding: 8px 11px; align-items: center; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 9px; cursor: pointer; }
.mail-message-detail__thread summary > span:first-child { display: grid; width: 34px; height: 34px; place-items: center; color: var(--accent-color); font-size: .62rem; font-weight: 760; background: var(--accent-bg); border-radius: 10px; }
.mail-message-detail__thread summary > span:nth-child(2) { display: grid; min-width: 0; gap: 2px; }
.mail-message-detail__thread summary strong, .mail-message-detail__thread summary small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.mail-message-detail__thread summary strong { font-size: .64rem; }
.mail-message-detail__thread summary small, .mail-message-detail__thread summary time { color: var(--text-muted); font-size: .56rem; }
.mail-message-detail__thread details > pre { margin: 0; padding: 13px 15px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .65rem; line-height: 1.7; background: var(--bg-card); border-top: 1px solid var(--border-light); }
.mail-message-detail__recipients { padding: 0 clamp(16px, 2.4vw, 28px); border-bottom: 1px solid var(--border-light); }
.mail-message-detail__recipients summary { min-height: 44px; padding: 12px 0; color: var(--text-muted); font-size: .62rem; cursor: pointer; }
.mail-message-detail__recipients dl { display: grid; margin: 0; padding: 0 0 14px; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }
.mail-message-detail__recipients dl div { display: grid; min-width: 0; gap: 4px; }
.mail-message-detail__recipients dt { color: var(--text-muted); font-size: .58rem; }
.mail-message-detail__recipients dd { margin: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: .64rem; line-height: 1.55; }
.mail-message-detail__attachments, .mail-message-detail__body { padding: 20px clamp(16px, 2.4vw, 28px); border-bottom: 1px solid var(--border-light); }
.mail-message-detail h3 { margin: 0 0 12px; font-size: .72rem; }
.mail-message-detail__attachments ul { display: grid; margin: 0; padding: 0; gap: 7px; list-style: none; }
.mail-message-detail__attachments li { display: grid; min-height: 60px; padding: 8px 9px 8px 11px; align-items: center; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 11px; }
.mail-message-detail__attachments li > div { display: grid; min-width: 0; gap: 3px; }
.mail-message-detail__attachments li span { overflow-wrap: anywhere; color: var(--text-secondary); font-size: .67rem; }
.mail-message-detail__attachments li button { display: inline-flex; min-width: 92px; min-height: 44px; padding: 0 12px; align-items: center; justify-content: center; gap: 6px; color: var(--text-secondary); font: inherit; font-size: .63rem; font-weight: 700; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 10px; cursor: pointer; }
.mail-message-detail__attachments li button:disabled { opacity: .48; cursor: wait; }
.mail-message-detail__attachments li small, .mail-message-detail__attachments > p { color: var(--text-muted); font-size: .58rem; }
.mail-message-detail__attachments li small.is-error { color: var(--error-color); }
.mail-message-detail__attachments > p { margin: 10px 0 0; }
.mail-message-detail__ai, .mail-message-detail__ai-error { margin: 14px clamp(16px, 2.4vw, 28px) 0; padding: 14px; border-radius: 14px; }
.mail-message-detail__ai { background: var(--accent-bg); border: 1px solid color-mix(in srgb, var(--accent-color) 25%, transparent); }
.mail-message-detail__ai > div { display: grid; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; }
.mail-message-detail__ai > div > span { color: var(--accent-color); }
.mail-message-detail__ai > div h3 { margin: 0; }
.mail-message-detail__ai button { display: inline-flex; min-height: 44px; padding: 0 12px; align-items: center; justify-content: center; gap: 6px; color: var(--text-secondary); font: inherit; font-size: .64rem; font-weight: 700; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 11px; cursor: pointer; }
.mail-message-detail__ai > div button { width: 44px; padding: 0; }
.mail-message-detail__ai pre { margin: 13px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .68rem; line-height: 1.7; }
.mail-message-detail__ai .mail-message-detail__use-draft { margin-top: 13px; color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: transparent; }
.mail-message-detail__ai > p { margin: 11px 0 0; color: var(--text-muted); font-size: .58rem; line-height: 1.55; }
.mail-message-detail__ai-error { color: var(--error-color); font-size: .65rem; line-height: 1.55; background: color-mix(in srgb, var(--error-color) 8%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--error-color) 24%, transparent); }
.mail-message-detail__body { min-height: 260px; padding-bottom: 52px; }
.mail-message-detail__body > header { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 10px; }
.mail-message-detail__body > header h3 { margin: 0; }
.mail-message-detail__body > header > div { display: flex; padding: 3px; gap: 3px; background: var(--bg-secondary); border-radius: 10px; }
.mail-message-detail__body > header button { min-height: 36px; padding: 0 9px; color: var(--text-muted); font: inherit; font-size: .59rem; background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
.mail-message-detail__body > header button.is-active { color: var(--text-primary); background: var(--bg-card); }
.mail-message-detail__body > pre { margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .71rem; line-height: 1.82; }
.mail-message-detail__html > p { display: inline-flex; margin: 8px 0; align-items: center; gap: 5px; color: var(--text-muted); font-size: .57rem; }
.mail-message-detail__html iframe { width: 100%; min-height: 420px; background: transparent; border: 0; }
.mail-message-detail__mobile-actions { display: none; }
@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .mail-message-detail { padding-bottom: calc(74px + env(safe-area-inset-bottom)); overflow: visible; }
  .mail-message-detail__header { top: var(--app-shell-header-height, 64px); min-height: 76px; padding: 10px 12px; }
  .mail-message-detail__header > button:first-child { display: grid; }
  .mail-message-detail__close { display: none !important; }
  .mail-message-detail__actions { display: none; }
  .mail-message-detail__ai-panel { margin-inline: 12px; }
  .mail-message-detail__ai-grid { grid-template-columns: 1fr; }
  .mail-message-detail__ai-panel form { grid-template-columns: 1fr; }
  .mail-message-detail__sender { grid-template-columns: auto minmax(0, 1fr); }
  .mail-message-detail__sender time { grid-column: 2; }
  .mail-message-detail__recipients dl { grid-template-columns: 1fr; }
  .mail-message-detail__mobile-actions { position: fixed; z-index: 50; right: 14px; bottom: max(12px, env(safe-area-inset-bottom)); left: 14px; display: grid; min-height: 64px; padding: 6px; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; background: color-mix(in srgb, var(--bg-card) 94%, transparent); border: 1px solid var(--border-light); border-radius: 18px; box-shadow: var(--shadow-card); backdrop-filter: blur(18px); }
  .mail-message-detail__mobile-actions button { display: grid; min-width: 44px; min-height: 50px; place-content: center; justify-items: center; gap: 3px; color: var(--text-secondary); font: inherit; font-size: .55rem; background: transparent; border: 0; border-radius: 12px; }
  .mail-message-detail__mobile-actions button:active { color: var(--accent-color); background: var(--accent-bg); }
}
@media (prefers-reduced-motion: reduce) {
  .mail-message-detail__header, .mail-message-detail__actions, .mail-message-detail__mobile-actions { backdrop-filter: none; }
}
</style>
