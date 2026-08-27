<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  confirmEmailAiProposal,
  createEmailAiProposal,
  downloadEmailAttachment,
  requestEmailAi
} from '@/shared/services/emailApi'

const props = defineProps({
  message: { type: Object, default: null },
  messageId: { type: String, default: '' },
  accountId: { type: String, default: '' },
  folderId: { type: String, default: '' },
  locationId: { type: String, default: '' },
  loading: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'reply', 'notification', 'open-source'])

const detailRoot = ref(null)
const mobileBackButton = ref(null)
const aiBusyAction = ref('')
const aiResult = ref(null)
const aiError = ref('')
const aiPanelOpen = ref(false)
const aiInstruction = ref('')
const aiAskScope = ref('message')
const aiReplyTone = ref('professional')
const aiReplyLength = ref('medium')
const aiOperationInstruction = ref('')
const aiProposal = ref(null)
const aiProposalBusyKind = ref('')
const aiProposalConfirming = ref(false)
const aiOperationResult = ref(null)
const bodyMode = ref('plain')
const attachmentDownloads = reactive({})
let aiRequestSequence = 0

const aiActionGroups = [
  {
    id: 'understand',
    label: '理解邮件',
    actions: [
      { action: 'summarize', label: '快速摘要', detail: '提炼当前邮件的关键结论', icon: 'note' },
      { action: 'thread_summary', label: '会话摘要', detail: '梳理整段会话的共识和未决项', icon: 'users' },
      { action: 'thread_changes', label: '会话变化', detail: '只看这次新增与改变的内容', icon: 'refresh' },
      { action: 'analyze', label: '深度分析', detail: '结构化判断重要性、风险与依据', icon: 'shield' },
      { action: 'tasks', label: '提取待办', detail: '找出截止时间、责任人与下一步', icon: 'list' },
      { action: 'translate', label: '翻译成中文', detail: '保留原意、语气和专业术语', icon: 'book' },
      { action: 'propose_notification_rule', label: '建议提醒规则', detail: '分析降噪方式，但不会自动保存', icon: 'bell' }
    ]
  },
  {
    id: 'write',
    label: '协助写作',
    actions: [
      { action: 'draft_reply', label: '起草回信', detail: '按所选语气与长度生成可编辑内容', icon: 'reply' }
    ]
  }
]

const aiProposalActions = [
  { kind: 'create_diary', label: '保存为日记', detail: '先预览标题、日期、正文和标签', icon: 'calendar' },
  { kind: 'create_memo', label: '保存为备忘录', detail: '先预览内容与可选截止时间', icon: 'note' },
  { kind: 'create_draft', label: '创建加密回复草稿', detail: '只创建草稿，不会自动发送', icon: 'edit' }
]

const aiActions = aiActionGroups.flatMap((group) => group.actions)

const aiToneOptions = [
  { value: 'professional', label: '专业' },
  { value: 'friendly', label: '友好' },
  { value: 'concise', label: '直接' },
  { value: 'formal', label: '正式' }
]

const aiLengthOptions = [
  { value: 'short', label: '简短' },
  { value: 'medium', label: '适中' },
  { value: 'detailed', label: '详细' }
]

const categoryNames = {
  security: '账号安全', account: '账号安全', payment: '付款账单', billing: '付款账单',
  operations: '服务运维', ops: '服务运维', server: '服务运维', work: '工作待办', action: '工作待办',
  receipt: '收据状态', status: '收据状态', personal: '个人邮件',
  newsletter: '订阅资讯', marketing: '营销推广', social: '社交通知', system: '系统通知'
}

const notificationNames = {
  immediate: '立即提醒', digest: '仅放入摘要', in_app_only: '仅站内显示', silent: '完全静音'
}

const notificationScopeNames = {
  conversation: '当前会话', sender: '这个发件人', domain: '发件人域名',
  category: '邮件分类', account: '当前邮箱'
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
const importancePercentage = computed(() => {
  const score = Number(props.message?.importanceScore || 0)
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0
})
const aiProposalPreview = computed(() => {
  const proposal = aiProposal.value
  const params = proposal?.params
  if (!proposal || !params || typeof params !== 'object') return null
  if (proposal.kind === 'create_diary') {
    return {
      title: '日记预览',
      fields: [
        { label: '标题', value: params.title },
        { label: '日期', value: params.entryDate },
        { label: '心情', value: params.mood || '未设置' },
        { label: '标签', value: Array.isArray(params.tags) ? params.tags.join('、') : '' }
      ],
      content: params.content,
      confirmLabel: '确认保存日记'
    }
  }
  if (proposal.kind === 'create_memo') {
    return {
      title: '备忘录预览',
      fields: [
        { label: '标题', value: params.title },
        { label: '截止时间', value: params.dueAt || '未设置' },
        { label: '标签', value: Array.isArray(params.tags) ? params.tags.join('、') : '' }
      ],
      content: params.content,
      confirmLabel: '确认保存备忘录'
    }
  }
  return {
    title: '加密回复草稿预览',
    fields: [
      { label: '收件人', value: Array.isArray(params.to) ? params.to.join('、') : '' },
      { label: '主题', value: params.subject }
    ],
    content: params.text,
    confirmLabel: '确认创建加密草稿'
  }
})
const aiOperationHref = computed(() => {
  const href = String(aiOperationResult.value?.receipt?.href || '').trim()
  return /^\/(?!\/)/.test(href) ? href : ''
})

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
  return String(
    result?.text
    || result?.content
    || result?.summary
    || result?.body
    || result?.data?.summary
    || result?.draft?.text
    || result?.draft?.body
    || ''
  ).trim()
}

function normalizeAiSources(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((source, index) => ({
    sourceId: String(source?.sourceId || `M${index + 1}`).slice(0, 12),
    messageId: String(source?.messageId || ''),
    accountId: String(source?.accountId || ''),
    folderId: String(source?.folderId || ''),
    locationId: String(source?.locationId || ''),
    subject: String(source?.subject || '（无主题）').slice(0, 500),
    sender: String(source?.sender || '').slice(0, 320),
    receivedAt: source?.receivedAt || ''
  }))
}

function normalizeStructuredAiResult(result, action = '') {
  if (result?.kind !== 'structured' || !result.data || typeof result.data !== 'object') return null
  const data = result.data
  if (action === 'propose_notification_rule') {
    const rawScope = String(data.scope || '').trim()
    const rawAction = String(data.action || '').trim()
    return {
      type: 'notification-rule',
      scope: rawScope === 'thread' ? 'conversation' : rawScope,
      action: rawAction === 'mute' ? 'silent' : rawAction,
      matchValue: String(data.matchValue || '').trim(),
      reason: String(data.reason || '').trim(),
      persisted: data.persisted === true
    }
  }
  const boundedList = (value) => (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 12)
  return {
    type: 'analysis',
    summary: String(data.summary || '').trim(),
    category: String(data.category || '').trim(),
    importance: String(data.importance || '').trim(),
    evidence: boundedList(data.evidence),
    actions: boundedList(data.actions),
    deadlines: boundedList(data.deadlines),
    risks: boundedList(data.risks)
  }
}

function titleForAiAction(action) {
  return aiActions.find((item) => item.action === action)?.label || 'AI 结果'
}

async function runAi(action, instruction = '', overrides = {}) {
  if (!aiAvailable.value || aiBusyAction.value || aiProposalBusyKind.value || aiProposalConfirming.value) return
  const requestMessageId = safeMessageId.value
  const requestSequence = ++aiRequestSequence
  aiBusyAction.value = action
  aiError.value = ''
  try {
    const payload = await requestEmailAi(requestMessageId, {
      action,
      instruction: String(instruction || '').trim(),
      language: action === 'translate' ? 'zh-CN' : '',
      scope: action === 'ask' ? String(overrides.scope || aiAskScope.value) : '',
      tone: action === 'draft_reply' ? String(overrides.tone || aiReplyTone.value) : '',
      length: action === 'draft_reply' ? String(overrides.length || aiReplyLength.value) : ''
    })
    if (requestSequence !== aiRequestSequence || requestMessageId !== safeMessageId.value) return
    const text = textFromAiPayload(payload)
    const structured = normalizeStructuredAiResult(payload?.result, action)
    if (!text && !structured) throw new Error('AI 没有返回可显示的内容')
    aiResult.value = {
      action,
      title: titleForAiAction(action),
      text,
      structured,
      sources: normalizeAiSources(payload?.sources),
      model: String(payload?.result?.model || '').trim()
    }
    aiPanelOpen.value = false
    aiInstruction.value = ''
  } catch (error) {
    if (requestSequence !== aiRequestSequence || requestMessageId !== safeMessageId.value) return
    aiError.value = error?.message || 'AI 邮件处理失败'
  } finally {
    if (aiBusyAction.value === action) aiBusyAction.value = ''
  }
}

async function buildAiProposal(kind) {
  if (!aiAvailable.value || aiBusyAction.value || aiProposalBusyKind.value || aiProposalConfirming.value) return
  const requestMessageId = safeMessageId.value
  const requestSequence = ++aiRequestSequence
  aiProposalBusyKind.value = kind
  aiError.value = ''
  aiOperationResult.value = null
  aiProposal.value = null
  try {
    const payload = await createEmailAiProposal(requestMessageId, {
      kind,
      instruction: aiOperationInstruction.value,
      tone: kind === 'create_draft' ? aiReplyTone.value : '',
      length: kind === 'create_draft' ? aiReplyLength.value : ''
    })
    if (requestSequence !== aiRequestSequence || requestMessageId !== safeMessageId.value) return
    if (!payload?.proposal?.previewRequired || payload.proposal.autoExecuted !== false) {
      throw new Error('服务器未返回可确认的安全预览')
    }
    aiProposal.value = payload.proposal
  } catch (error) {
    if (requestSequence !== aiRequestSequence || requestMessageId !== safeMessageId.value) return
    aiError.value = error?.message || 'AI 操作预览生成失败'
  } finally {
    if (aiProposalBusyKind.value === kind) aiProposalBusyKind.value = ''
  }
}

async function confirmAiProposal() {
  if (!aiProposal.value || aiBusyAction.value || aiProposalBusyKind.value || aiProposalConfirming.value) return
  const requestMessageId = safeMessageId.value
  const requestSequence = ++aiRequestSequence
  aiProposalConfirming.value = true
  aiError.value = ''
  try {
    const payload = await confirmEmailAiProposal(requestMessageId, aiProposal.value)
    if (requestSequence !== aiRequestSequence || requestMessageId !== safeMessageId.value) return
    aiOperationResult.value = payload
    aiProposal.value = null
    aiOperationInstruction.value = ''
  } catch (error) {
    if (requestSequence !== aiRequestSequence || requestMessageId !== safeMessageId.value) return
    aiError.value = error?.message || 'AI 操作确认失败'
  } finally {
    aiProposalConfirming.value = false
  }
}

function cancelAiProposal() {
  if (aiBusyAction.value || aiProposalBusyKind.value || aiProposalConfirming.value) return
  aiProposal.value = null
}

function canOpenAiSource(source) {
  return Boolean(source?.accountId && source?.folderId && source?.locationId)
}

function openAiSource(source) {
  if (!canOpenAiSource(source)) return
  emit('open-source', source)
}

function focusInitial() {
  const visibleMobileBack = mobileBackButton.value
    && typeof window !== 'undefined'
    && window.getComputedStyle(mobileBackButton.value).display !== 'none'
  const target = visibleMobileBack ? mobileBackButton.value : detailRoot.value
  target?.focus?.({ preventScroll: true })
}

defineExpose({ focusInitial })

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
    if (event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return
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
  aiAskScope.value = 'message'
  aiReplyTone.value = 'professional'
  aiReplyLength.value = 'medium'
  aiOperationInstruction.value = ''
  aiProposal.value = null
  aiProposalBusyKind.value = ''
  aiProposalConfirming.value = false
  aiOperationResult.value = null
  bodyMode.value = 'plain'
  for (const key of Object.keys(attachmentDownloads)) delete attachmentDownloads[key]
})
</script>

<template>
  <article ref="detailRoot" class="mail-message-detail" tabindex="-1" :aria-labelledby="message ? 'mail-message-detail-title' : undefined">
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
        <button ref="mobileBackButton" type="button" aria-label="返回邮件列表" @click="$emit('close')">
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
        <div class="mail-message-detail__ai-preferences" aria-label="回复偏好">
          <label>
            <span>回信语气</span>
            <select v-model="aiReplyTone">
              <option v-for="option in aiToneOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label>
            <span>回信长度</span>
            <select v-model="aiReplyLength">
              <option v-for="option in aiLengthOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
        </div>

        <section v-for="group in aiActionGroups" :key="group.id" class="mail-message-detail__ai-group" :aria-labelledby="`mail-ai-group-${group.id}`">
          <h4 :id="`mail-ai-group-${group.id}`">{{ group.label }}</h4>
          <div class="mail-message-detail__ai-grid">
            <button v-for="item in group.actions" :key="item.action" type="button" :disabled="Boolean(aiBusyAction || aiProposalBusyKind || aiProposalConfirming)" @click="runAi(item.action)">
              <span><Icon :name="item.icon" :size="17" /></span>
              <span><strong>{{ aiBusyAction === item.action ? '处理中…' : item.label }}</strong><small>{{ item.detail }}</small></span>
            </button>
          </div>
        </section>

        <form class="mail-message-detail__ai-question" @submit.prevent="runAi('ask', aiInstruction, { scope: aiAskScope })">
          <div class="mail-message-detail__ai-scope" role="group" aria-label="提问范围">
            <label><input v-model="aiAskScope" type="radio" value="message">当前邮件</label>
            <label><input v-model="aiAskScope" type="radio" value="thread">整个会话</label>
          </div>
          <label for="mail-ai-instruction">向邮件 AI 提问</label>
          <textarea id="mail-ai-instruction" v-model="aiInstruction" rows="3" placeholder="例如：这封邮件需要我在什么时候回复？"></textarea>
          <button type="submit" :disabled="!aiInstruction.trim() || Boolean(aiBusyAction || aiProposalBusyKind || aiProposalConfirming)"><Icon name="sparkles" :size="17" />{{ aiBusyAction === 'ask' ? '思考中…' : '询问 AI' }}</button>
        </form>

        <section class="mail-message-detail__ai-operations" aria-labelledby="mail-ai-operations-title">
          <div>
            <h4 id="mail-ai-operations-title">安全操作</h4>
            <p>AI 只生成预览；你确认后才写入 NAV，回复草稿不会自动发送。</p>
          </div>
          <label for="mail-ai-operation-instruction">补充要求（可选）</label>
          <textarea id="mail-ai-operation-instruction" v-model="aiOperationInstruction" rows="2" placeholder="例如：只记录交付节点，并加上项目标签。"></textarea>
          <div class="mail-message-detail__ai-operation-grid">
            <button v-for="item in aiProposalActions" :key="item.kind" type="button" :disabled="Boolean(aiBusyAction || aiProposalBusyKind || aiProposalConfirming)" @click="buildAiProposal(item.kind)">
              <Icon :name="item.icon" :size="17" />
              <span><strong>{{ aiProposalBusyKind === item.kind ? '生成预览中…' : item.label }}</strong><small>{{ item.detail }}</small></span>
            </button>
          </div>
          <section v-if="aiProposalPreview" class="mail-message-detail__ai-proposal" aria-labelledby="mail-ai-proposal-title">
            <div>
              <h5 id="mail-ai-proposal-title">{{ aiProposalPreview.title }}</h5>
              <span>尚未写入</span>
            </div>
            <dl>
              <div v-for="field in aiProposalPreview.fields" :key="field.label"><dt>{{ field.label }}</dt><dd>{{ field.value || '未设置' }}</dd></div>
            </dl>
            <pre>{{ aiProposalPreview.content || '没有正文内容' }}</pre>
            <div class="mail-message-detail__ai-proposal-actions">
              <button type="button" :disabled="Boolean(aiBusyAction || aiProposalBusyKind || aiProposalConfirming)" @click="cancelAiProposal">取消</button>
              <button type="button" :disabled="Boolean(aiBusyAction || aiProposalBusyKind || aiProposalConfirming)" @click="confirmAiProposal"><Icon name="check" :size="17" />{{ aiProposalConfirming ? '正在写入…' : aiProposalPreview.confirmLabel }}</button>
            </div>
          </section>
          <div v-if="aiOperationResult" class="mail-message-detail__ai-operation-success" role="status">
            <Icon name="circle-check" :size="18" />
            <span>操作已完成；系统保留了可审计回执。</span>
            <a v-if="aiOperationHref" :href="aiOperationHref">查看结果</a>
          </div>
        </section>
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
        <span v-if="importancePercentage > 0"><Icon name="star" :size="14" />重要度 {{ importancePercentage }}%</span>
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
          <h3 id="mail-ai-result-title">{{ aiResult.title }}<small v-if="aiResult.model"> · {{ aiResult.model }}</small></h3>
          <button type="button" aria-label="关闭 AI 结果" title="关闭" @click="aiResult = null"><Icon name="close" :size="16" /></button>
        </div>
        <section v-if="aiResult.structured" class="mail-message-detail__ai-structured" aria-label="结构化分析结果">
          <template v-if="aiResult.structured.type === 'notification-rule'">
            <div class="mail-message-detail__ai-rule-status"><Icon name="bell" :size="17" /><strong>AI 建议，尚未保存</strong></div>
            <dl class="mail-message-detail__ai-rule">
              <div><dt>范围</dt><dd>{{ notificationScopeNames[aiResult.structured.scope] || aiResult.structured.scope || '未指定' }}</dd></div>
              <div><dt>方式</dt><dd>{{ notificationNames[aiResult.structured.action] || aiResult.structured.action || '未指定' }}</dd></div>
              <div v-if="aiResult.structured.matchValue"><dt>匹配对象</dt><dd>{{ aiResult.structured.matchValue }}</dd></div>
              <div><dt>理由</dt><dd>{{ aiResult.structured.reason || 'AI 未提供理由。' }}</dd></div>
            </dl>
            <button type="button" class="mail-message-detail__open-rule" @click="emit('notification', message, $event.currentTarget)"><Icon name="settings" :size="17" />打开提醒规则，由我确认</button>
          </template>
          <template v-else>
            <p>{{ aiResult.structured.summary || 'AI 未提供摘要。' }}</p>
            <div class="mail-message-detail__ai-structured-tags">
              <span v-if="aiResult.structured.category">分类：{{ categoryNames[aiResult.structured.category] || aiResult.structured.category }}</span>
              <span v-if="aiResult.structured.importance">重要性：{{ aiResult.structured.importance }}</span>
            </div>
            <div v-if="aiResult.structured.actions.length"><h4>建议行动</h4><ul><li v-for="item in aiResult.structured.actions" :key="item">{{ item }}</li></ul></div>
            <div v-if="aiResult.structured.deadlines.length"><h4>时间节点</h4><ul><li v-for="item in aiResult.structured.deadlines" :key="item">{{ item }}</li></ul></div>
            <div v-if="aiResult.structured.risks.length"><h4>风险</h4><ul><li v-for="item in aiResult.structured.risks" :key="item">{{ item }}</li></ul></div>
            <div v-if="aiResult.structured.evidence.length"><h4>判断依据</h4><ul><li v-for="item in aiResult.structured.evidence" :key="item">{{ item }}</li></ul></div>
          </template>
        </section>
        <pre v-else>{{ aiResult.text }}</pre>
        <section v-if="aiResult.sources.length" class="mail-message-detail__ai-sources" aria-labelledby="mail-ai-sources-title">
          <h4 id="mail-ai-sources-title">依据来源</h4>
          <ol>
            <li v-for="source in aiResult.sources" :key="`${source.sourceId}-${source.messageId}`">
              <button type="button" :disabled="!canOpenAiSource(source)" :aria-label="canOpenAiSource(source) ? `打开来源 ${source.sourceId}：${source.subject}` : `来源 ${source.sourceId} 暂无可打开位置`" @click="openAiSource(source)">
                <span>{{ source.sourceId }}</span>
                <span><strong>{{ source.subject }}</strong><small>{{ source.sender || '未知发件人' }}<template v-if="source.receivedAt"> · {{ formatLongDate(source.receivedAt) }}</template></small></span>
              </button>
            </li>
          </ol>
        </section>
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
.mail-message-detail__ai-preferences { display: grid; margin-top: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.mail-message-detail__ai-preferences label { display: grid; gap: 5px; color: var(--text-muted); font-size: .59rem; font-weight: 700; }
.mail-message-detail__ai-preferences select { width: 100%; min-height: 44px; padding: 0 34px 0 10px; color: var(--text-primary); font: inherit; font-size: .64rem; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 11px; }
.mail-message-detail__ai-group { margin-top: 13px; }
.mail-message-detail__ai-group > h4, .mail-message-detail__ai-operations h4 { margin: 0; color: var(--text-secondary); font-size: .61rem; letter-spacing: .035em; }
.mail-message-detail__ai-grid { display: grid; margin-top: 11px; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.mail-message-detail__ai-grid button { display: grid; min-height: 66px; padding: 9px 10px; align-items: center; grid-template-columns: 32px minmax(0, 1fr); gap: 8px; text-align: left; color: var(--text-primary); font: inherit; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-message-detail__ai-grid button:disabled { opacity: .5; cursor: wait; }
.mail-message-detail__ai-grid button > span:first-child { color: var(--accent-color); }
.mail-message-detail__ai-grid button > span:last-child { display: grid; gap: 2px; }
.mail-message-detail__ai-grid strong { font-size: .65rem; }
.mail-message-detail__ai-grid small { color: var(--text-muted); font-size: .56rem; line-height: 1.35; }
.mail-message-detail__ai-panel form { display: grid; margin-top: 13px; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
.mail-message-detail__ai-panel form > label { grid-column: 1 / -1; color: var(--text-muted); font-size: .61rem; font-weight: 700; }
.mail-message-detail__ai-panel textarea { min-width: 0; padding: 10px 11px; resize: vertical; color: var(--text-primary); font: inherit; font-size: .66rem; line-height: 1.55; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; }
.mail-message-detail__ai-panel form button { display: inline-flex; min-width: 104px; min-height: 44px; padding: 0 12px; align-items: center; justify-content: center; gap: 6px; color: var(--accent-contrast, #fff); font: inherit; font-size: .64rem; font-weight: 720; background: var(--accent-color); border: 0; border-radius: 12px; cursor: pointer; }
.mail-message-detail__ai-panel form button:disabled { opacity: .5; cursor: not-allowed; }
.mail-message-detail__ai-scope { display: flex; grid-column: 1 / -1; gap: 6px; }
.mail-message-detail__ai-scope label { display: inline-flex; min-height: 38px; padding: 0 10px; align-items: center; gap: 6px; color: var(--text-secondary); font-size: .61rem; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 10px; cursor: pointer; }
.mail-message-detail__ai-scope input { width: 16px; height: 16px; accent-color: var(--accent-color); }
.mail-message-detail__ai-operations { display: grid; margin-top: 15px; padding-top: 14px; gap: 8px; border-top: 1px solid color-mix(in srgb, var(--accent-color) 16%, var(--border-light)); }
.mail-message-detail__ai-operations > div:first-child { display: grid; gap: 4px; }
.mail-message-detail__ai-operations > div:first-child p, .mail-message-detail__ai-operations > label { margin: 0; color: var(--text-muted); font-size: .58rem; line-height: 1.5; }
.mail-message-detail__ai-operation-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; }
.mail-message-detail__ai-operation-grid > button { display: grid; min-height: 70px; padding: 10px; align-items: center; grid-template-columns: auto minmax(0, 1fr); gap: 8px; text-align: left; color: var(--text-primary); font: inherit; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-message-detail__ai-operation-grid > button > svg { color: var(--accent-color); }
.mail-message-detail__ai-operation-grid > button span { display: grid; gap: 3px; }
.mail-message-detail__ai-operation-grid strong { font-size: .62rem; }
.mail-message-detail__ai-operation-grid small { color: var(--text-muted); font-size: .54rem; line-height: 1.35; }
.mail-message-detail__ai-operation-grid button:disabled { opacity: .5; cursor: wait; }
.mail-message-detail__ai-proposal { display: grid; padding: 12px; gap: 10px; background: var(--bg-card); border: 1px solid color-mix(in srgb, var(--accent-color) 25%, var(--border-light)); border-radius: 13px; }
.mail-message-detail__ai-proposal > div:first-child { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mail-message-detail__ai-proposal h5 { margin: 0; font-size: .68rem; }
.mail-message-detail__ai-proposal > div:first-child span { padding: 3px 7px; color: var(--warning-color); font-size: .54rem; background: color-mix(in srgb, var(--warning-color) 9%, var(--bg-card)); border-radius: 999px; }
.mail-message-detail__ai-proposal dl { display: grid; margin: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
.mail-message-detail__ai-proposal dl div { display: grid; gap: 2px; }
.mail-message-detail__ai-proposal dt { color: var(--text-muted); font-size: .54rem; }
.mail-message-detail__ai-proposal dd { margin: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: .61rem; }
.mail-message-detail__ai-proposal pre { max-height: 220px; margin: 0; padding: 10px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .62rem; line-height: 1.6; background: var(--bg-secondary); border-radius: 9px; }
.mail-message-detail__ai-proposal-actions { display: flex; justify-content: flex-end; gap: 7px; }
.mail-message-detail__ai-proposal-actions button { min-height: 44px; padding: 0 12px; color: var(--text-secondary); font: inherit; font-size: .61rem; font-weight: 700; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 10px; cursor: pointer; }
.mail-message-detail__ai-proposal-actions button:last-child { display: inline-flex; align-items: center; gap: 5px; color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: transparent; }
.mail-message-detail__ai-proposal-actions button:disabled { opacity: .5; cursor: wait; }
.mail-message-detail__ai-operation-success { display: flex; min-height: 44px; padding: 8px 10px; align-items: center; gap: 7px; color: var(--success-color, #4c8a64); font-size: .6rem; background: color-mix(in srgb, var(--success-color, #4c8a64) 8%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--success-color, #4c8a64) 23%, var(--border-light)); border-radius: 11px; }
.mail-message-detail__ai-operation-success a { margin-left: auto; color: var(--accent-color); font-weight: 700; }
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
.mail-message-detail__ai > div h3 small { color: var(--text-muted); font-size: .56rem; font-weight: 500; }
.mail-message-detail__ai button { display: inline-flex; min-height: 44px; padding: 0 12px; align-items: center; justify-content: center; gap: 6px; color: var(--text-secondary); font: inherit; font-size: .64rem; font-weight: 700; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 11px; cursor: pointer; }
.mail-message-detail__ai > div button { width: 44px; padding: 0; }
.mail-message-detail__ai pre { margin: 13px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .68rem; line-height: 1.7; }
.mail-message-detail__ai-structured { display: grid; margin-top: 12px; gap: 10px; }
.mail-message-detail__ai-structured > p { margin: 0; color: var(--text-secondary); font-size: .68rem; line-height: 1.7; }
.mail-message-detail__ai-structured-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.mail-message-detail__ai-structured-tags span { padding: 4px 8px; color: var(--accent-color); font-size: .57rem; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 999px; }
.mail-message-detail__ai-structured > div:not(.mail-message-detail__ai-structured-tags) { display: grid; gap: 5px; }
.mail-message-detail__ai-structured h4, .mail-message-detail__ai-sources h4 { margin: 0; color: var(--text-secondary); font-size: .61rem; }
.mail-message-detail__ai-structured ul { display: grid; margin: 0; padding-left: 18px; gap: 4px; color: var(--text-secondary); font-size: .62rem; line-height: 1.55; }
.mail-message-detail__ai-rule-status { display: flex !important; min-height: 36px; padding: 7px 9px; align-items: center; gap: 7px; color: var(--warning-color); background: color-mix(in srgb, var(--warning-color) 8%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--warning-color) 22%, var(--border-light)); border-radius: 10px; }
.mail-message-detail__ai-rule-status strong { font-size: .61rem; }
.mail-message-detail__ai-rule { display: grid; margin: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 14px; }
.mail-message-detail__ai-rule div { display: grid; gap: 3px; }
.mail-message-detail__ai-rule dt { color: var(--text-muted); font-size: .55rem; }
.mail-message-detail__ai-rule dd { margin: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: .62rem; line-height: 1.5; }
.mail-message-detail__ai .mail-message-detail__open-rule { width: fit-content; color: var(--accent-color); }
.mail-message-detail__ai-sources { display: grid; margin-top: 13px; gap: 7px; }
.mail-message-detail__ai-sources ol { display: grid; margin: 0; padding: 0; gap: 5px; list-style: none; }
.mail-message-detail__ai-sources li { min-width: 0; }
.mail-message-detail__ai-sources li > button { display: grid; width: 100%; min-height: 46px; padding: 7px 9px; align-items: center; grid-template-columns: auto minmax(0, 1fr); gap: 8px; text-align: left; color: var(--text-primary); font: inherit; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 10px; cursor: pointer; }
.mail-message-detail__ai-sources li > button:hover:not(:disabled), .mail-message-detail__ai-sources li > button:focus-visible { border-color: color-mix(in srgb, var(--accent-color) 46%, var(--border-light)); }
.mail-message-detail__ai-sources li > button:disabled { cursor: default; opacity: .74; }
.mail-message-detail__ai-sources li > button > span:first-child { display: grid; min-width: 31px; height: 26px; padding-inline: 5px; place-items: center; color: var(--accent-color); font-size: .56rem; font-weight: 760; background: var(--accent-bg); border-radius: 7px; }
.mail-message-detail__ai-sources li > button > span:last-child { display: grid; min-width: 0; gap: 2px; }
.mail-message-detail__ai-sources strong, .mail-message-detail__ai-sources small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.mail-message-detail__ai-sources strong { font-size: .61rem; }
.mail-message-detail__ai-sources small { color: var(--text-muted); font-size: .54rem; }
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
  .mail-message-detail { padding-bottom: calc(158px + env(safe-area-inset-bottom)); overflow: visible; }
  .mail-message-detail__header { top: var(--app-shell-header-height, 64px); min-height: 76px; padding: 10px 12px; }
  .mail-message-detail__header > button:first-child { display: grid; }
  .mail-message-detail__close { display: none !important; }
  .mail-message-detail__actions { display: none; }
  .mail-message-detail__ai-panel { margin-inline: 12px; }
  .mail-message-detail__ai-preferences { grid-template-columns: 1fr; }
  .mail-message-detail__ai-grid { grid-template-columns: 1fr; }
  .mail-message-detail__ai-panel form { grid-template-columns: 1fr; }
  .mail-message-detail__ai-operation-grid { grid-template-columns: 1fr; }
  .mail-message-detail__ai-proposal dl { grid-template-columns: 1fr; }
  .mail-message-detail__ai-rule { grid-template-columns: 1fr; }
  .mail-message-detail__ai-proposal-actions { display: grid; grid-template-columns: 1fr; }
  .mail-message-detail__sender { grid-template-columns: auto minmax(0, 1fr); }
  .mail-message-detail__sender time { grid-column: 2; }
  .mail-message-detail__recipients dl { grid-template-columns: 1fr; }
  .mail-message-detail__mobile-actions { position: fixed; z-index: 620; right: 14px; bottom: calc(86px + env(safe-area-inset-bottom)); left: 14px; display: grid; min-height: 64px; padding: 6px; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; background: color-mix(in srgb, var(--bg-card) 94%, transparent); border: 1px solid var(--border-light); border-radius: 18px; box-shadow: var(--shadow-card); backdrop-filter: blur(18px); }
  .mail-message-detail__mobile-actions button { display: grid; min-width: 44px; min-height: 50px; place-content: center; justify-items: center; gap: 3px; color: var(--text-secondary); font: inherit; font-size: .55rem; background: transparent; border: 0; border-radius: 12px; }
  .mail-message-detail__mobile-actions button:active { color: var(--accent-color); background: var(--accent-bg); }
}
@media (prefers-reduced-motion: reduce) {
  .mail-message-detail__header, .mail-message-detail__actions, .mail-message-detail__mobile-actions { backdrop-filter: none; }
}
</style>
