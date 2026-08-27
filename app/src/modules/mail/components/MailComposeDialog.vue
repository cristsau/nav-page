<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import Modal from '@/shared/components/Modal.vue'
import {
  confirmEmailDraft,
  createEmailDraft,
  deleteEmailDraftAttachment,
  fetchEmailDraft,
  uploadEmailDraftAttachment
} from '@/shared/services/emailApi'

const MAX_ATTACHMENT_COUNT = 10
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024
const AMBIGUOUS_DELIVERY_ERROR = 'AMBIGUOUS_DELIVERY_STATE'
const PARTIAL_DELIVERY_ERROR = 'PARTIAL_RECIPIENT_REJECTION'

const props = defineProps({
  show: { type: Boolean, default: false },
  accountId: { type: String, default: '' },
  sourceMessageId: { type: String, default: '' },
  initial: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['close', 'queued'])

const form = reactive({
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  text: ''
})
const stage = ref('edit')
const draftId = ref('')
const contentHash = ref('')
const confirmed = ref(false)
const busy = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const attachmentMessage = ref('')
const selectedAttachments = ref([])
const fileInput = ref(null)
const deliveryStatus = ref('')
const deliveryErrorCode = ref('')
const sentSyncStatus = ref('')
const deliveryStatusTerminal = ref(false)
const sentSyncStatusTerminal = ref(false)
let statusPollTimer = null
let statusPollInFlight = false
let statusPollGeneration = 0

const isReviewing = computed(() => stage.value === 'review')
const isUploading = computed(() => stage.value === 'upload')
const isQueued = computed(() => stage.value === 'queued')
const attachmentTotalBytes = computed(() => selectedAttachments.value.reduce(
  (total, attachment) => total + Number(attachment.file?.size || attachment.serverAttachment?.size || 0),
  0
))
const failedAttachments = computed(() => selectedAttachments.value.filter((item) => item.status === 'error'))
const deliveryManualReviewMessage = computed(() => {
  const errorCode = String(deliveryErrorCode.value || '').trim().toUpperCase()
  if (errorCode === AMBIGUOUS_DELIVERY_ERROR || deliveryStatus.value === 'ambiguous') {
    return '投递结果不确定：邮件可能已送达。请先核对“已发送”文件夹或收件情况，不要直接重发。'
  }
  if (errorCode === PARTIAL_DELIVERY_ERROR || deliveryStatus.value === 'partial') {
    return '部分收件人未接收：邮件可能已送达其他收件人。请先核对，不要直接整体重发。'
  }
  return ''
})
const deliveryStatusLabel = computed(() => deliveryManualReviewMessage.value || ({
  accepted: 'SMTP 已接受',
  delivered: 'SMTP 已接受',
  smtp_accepted: 'SMTP 已接受',
  failed: 'SMTP 投递失败',
  blocked: 'SMTP 投递已阻止，请检查配置',
  expired: 'SMTP 投递已过期，请检查失败原因',
  unavailable: 'SMTP 投递状态不可用，请稍后检查',
  queued: '等待 SMTP 投递',
  sending: '正在投递'
}[deliveryStatus.value] || '等待 SMTP 投递'))
const sentSyncStatusLabel = computed(() => ({
  synced: '已同步到已发送文件夹',
  appended: '已同步到已发送文件夹',
  sentCopy: '已同步到已发送文件夹',
  sent_copy: '已同步到已发送文件夹',
  appending: '正在同步到已发送文件夹',
  reconciling: '正在核对已发送文件夹',
  failed: '已发送文件夹同步失败，可后台重试',
  blocked: '已发送文件夹同步已阻止，请检查配置',
  unavailable: '已发送文件夹不可用，请检查配置',
  disabled: '已发送文件夹同步未启用',
  not_started: '等待 SMTP 接受后开始同步',
  pending: '等待同步到已发送文件夹',
  syncing: '正在同步到已发送文件夹'
}[sentSyncStatus.value] || '等待同步到已发送文件夹'))
const canSave = computed(() => (
  !busy.value
  && stage.value === 'edit'
  && Boolean(form.to.trim())
  && Boolean(form.subject.trim())
  && Boolean(form.text.trim())
))
const canSend = computed(() => (
  isReviewing.value
  && !busy.value
  && confirmed.value
  && Boolean(draftId.value)
  && Boolean(contentHash.value)
))

function splitAddresses(value) {
  return String(value || '')
    .split(/[;,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function addressText(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry?.name && entry?.address) return `${entry.name} <${entry.address}>`
      return entry?.address || entry?.name || ''
    }).filter(Boolean).join(', ')
  }
  return String(value || '')
}

function normalizedStatus(value) {
  const rawStatus = value && typeof value === 'object'
    ? (value.status || value.state || value.phase || '')
    : value
  return {
    status: String(rawStatus || '')
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .toLowerCase(),
    terminal: Boolean(value && typeof value === 'object' && value.terminal === true)
  }
}

function stopQueuedStatusPolling() {
  statusPollGeneration += 1
  if (statusPollTimer) window.clearTimeout(statusPollTimer)
  statusPollTimer = null
}

function queuedStatusIsTerminal() {
  // Partial SMTP delivery is already terminal for retry purposes, but its one
  // frozen Sent copy may still be synchronizing. Keep only status polling alive
  // until that independent idempotent job reaches a terminal state.
  if (deliveryStatus.value === 'partial' && !sentSyncStatusTerminal.value) return false
  return deliveryStatusTerminal.value || sentSyncStatusTerminal.value
}

function updateQueuedStatusMessage() {
  if (deliveryManualReviewMessage.value) {
    errorMessage.value = deliveryManualReviewMessage.value
    successMessage.value = ''
    attachmentMessage.value = '该状态需要人工核对，系统不会自动重试。'
    return
  }
  if (['failed', 'blocked', 'expired', 'cancelled', 'unavailable'].includes(deliveryStatus.value)) {
    errorMessage.value = deliveryStatusLabel.value
    successMessage.value = ''
    return
  }
  if (['appended', 'synced', 'sent_copy'].includes(sentSyncStatus.value)) {
    successMessage.value = 'SMTP 已接受邮件，并已同步到“已发送”文件夹。'
    attachmentMessage.value = ''
    return
  }
  if (['failed', 'blocked', 'unavailable', 'disabled'].includes(sentSyncStatus.value)) {
    attachmentMessage.value = sentSyncStatusLabel.value
  }
}

function scheduleQueuedStatusRefresh(generation, delay = 2_000) {
  if (
    generation !== statusPollGeneration
    || !props.show
    || stage.value !== 'queued'
    || queuedStatusIsTerminal()
  ) return
  if (statusPollTimer) window.clearTimeout(statusPollTimer)
  statusPollTimer = window.setTimeout(() => {
    statusPollTimer = null
    void refreshQueuedStatus(generation)
  }, delay)
}

async function refreshQueuedStatus(generation) {
  if (
    generation !== statusPollGeneration
    || !props.show
    || stage.value !== 'queued'
    || queuedStatusIsTerminal()
  ) return
  if (statusPollInFlight) {
    scheduleQueuedStatusRefresh(generation)
    return
  }
  statusPollInFlight = true
  try {
    const draft = unwrapDraft(await fetchEmailDraft(draftId.value))
    if (generation !== statusPollGeneration || stage.value !== 'queued') return
    applyDraftSnapshot(draft)
    updateQueuedStatusMessage()
  } catch {
    if (generation === statusPollGeneration && stage.value === 'queued') {
      attachmentMessage.value = '发送状态暂时无法刷新，系统会继续重试。'
    }
  } finally {
    statusPollInFlight = false
    if (generation === statusPollGeneration && !queuedStatusIsTerminal()) {
      scheduleQueuedStatusRefresh(generation)
    }
  }
}

function startQueuedStatusPolling() {
  stopQueuedStatusPolling()
  const generation = statusPollGeneration
  scheduleQueuedStatusRefresh(generation)
}

function resetDialog() {
  stopQueuedStatusPolling()
  form.to = addressText(props.initial?.to)
  form.cc = addressText(props.initial?.cc)
  form.bcc = addressText(props.initial?.bcc)
  form.subject = String(props.initial?.subject || '')
  form.text = String(props.initial?.text || '')
  stage.value = 'edit'
  draftId.value = ''
  contentHash.value = ''
  confirmed.value = false
  busy.value = false
  errorMessage.value = ''
  successMessage.value = ''
  attachmentMessage.value = ''
  selectedAttachments.value = []
  deliveryStatus.value = ''
  deliveryErrorCode.value = ''
  sentSyncStatus.value = ''
  deliveryStatusTerminal.value = false
  sentSyncStatusTerminal.value = false
}

function unwrapDraft(payload) {
  return payload?.draft || payload?.data?.draft || payload?.data || payload || {}
}

function draftAttachmentList(draft) {
  return Array.isArray(draft?.attachments) ? draft.attachments : []
}

function draftHash(draft, payload = {}) {
  return String(draft?.contentHash || draft?.content_hash || payload?.contentHash || '').trim()
}

function formatSize(value) {
  const bytes = Number(value || 0)
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function newAttachmentEntry(file) {
  return {
    clientId: `${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
    file,
    status: 'pending',
    serverAttachment: null,
    error: ''
  }
}

function attachmentStatusLabel(entry) {
  return {
    pending: '等待上传',
    uploading: '正在上传',
    uploaded: '已安全上传',
    error: '上传失败'
  }[entry?.status] || '等待上传'
}

function chooseAttachments() {
  if (!busy.value && stage.value === 'edit') fileInput.value?.click()
}

function onAttachmentSelection(event) {
  const files = Array.from(event.target?.files || [])
  if (event.target) event.target.value = ''
  if (!files.length) return
  errorMessage.value = ''
  attachmentMessage.value = ''
  const next = [...selectedAttachments.value]
  const rejected = []
  let totalBytes = attachmentTotalBytes.value
  for (const file of files) {
    if (next.length >= MAX_ATTACHMENT_COUNT) {
      rejected.push(`${file.name}：最多 ${MAX_ATTACHMENT_COUNT} 个附件`)
      continue
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(`${file.name}：单个文件不能超过 10 MB`)
      continue
    }
    if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      rejected.push(`${file.name}：附件总大小不能超过 25 MB`)
      continue
    }
    next.push(newAttachmentEntry(file))
    totalBytes += file.size
  }
  selectedAttachments.value = next
  attachmentMessage.value = rejected.length
    ? `已添加 ${files.length - rejected.length} 个附件；${rejected.join('；')}`
    : `已添加 ${files.length} 个附件。`
}

function removeLocalAttachment(entry) {
  selectedAttachments.value = selectedAttachments.value.filter((item) => item.clientId !== entry.clientId)
  attachmentMessage.value = `已移除 ${entry.file?.name || entry.serverAttachment?.filename || '附件'}。`
}

function applyDraftSnapshot(draft) {
  const nextHash = draftHash(draft)
  if (nextHash) contentHash.value = nextHash
  const suppliedDeliveryErrorCode = draft?.deliveryErrorCode !== undefined
    ? draft.deliveryErrorCode
    : draft?.delivery_error_code
  const nextDeliveryErrorCode = String(
    suppliedDeliveryErrorCode !== undefined ? (suppliedDeliveryErrorCode || '') : deliveryErrorCode.value
  ).trim().toUpperCase()
  deliveryErrorCode.value = nextDeliveryErrorCode
  const delivery = normalizedStatus(
    draft?.deliveryStatus
    ?? draft?.delivery_status
    ?? draft?.delivery
    ?? deliveryStatus.value
  )
  const sentSync = normalizedStatus(
    draft?.sentSyncStatus
    ?? draft?.sent_sync_status
    ?? draft?.sentCopy
    ?? draft?.sent_copy
    ?? sentSyncStatus.value
  )
  if (delivery.status) deliveryStatus.value = delivery.status
  if (nextDeliveryErrorCode === AMBIGUOUS_DELIVERY_ERROR) deliveryStatus.value = 'ambiguous'
  else if (nextDeliveryErrorCode === PARTIAL_DELIVERY_ERROR) deliveryStatus.value = 'partial'
  if (sentSync.status) sentSyncStatus.value = sentSync.status
  deliveryStatusTerminal.value = delivery.terminal || [
    'ambiguous', 'partial', 'failed', 'blocked', 'expired', 'cancelled', 'unavailable'
  ].includes(deliveryStatus.value)
  sentSyncStatusTerminal.value = sentSync.terminal || [
    'appended', 'synced', 'sent_copy', 'failed', 'blocked', 'unavailable', 'disabled', 'skipped'
  ].includes(sentSyncStatus.value)
}

function matchUploadedAttachment(draft, entry, previousIds = new Set()) {
  const candidates = draftAttachmentList(draft)
  return candidates.find((attachment) => (
    attachment?.id
    && !previousIds.has(String(attachment.id))
    && String(attachment.filename || '') === String(entry.file?.name || '')
    && Number(attachment.size || 0) === Number(entry.file?.size || 0)
  )) || candidates.find((attachment) => (
    attachment?.id && !previousIds.has(String(attachment.id))
  )) || null
}

async function uploadAttachmentEntry(entry) {
  if (!draftId.value || !entry?.file) return false
  const previousIds = new Set(selectedAttachments.value
    .map((item) => item.serverAttachment?.id)
    .filter(Boolean)
    .map(String))
  entry.status = 'uploading'
  entry.error = ''
  attachmentMessage.value = `正在上传 ${entry.file.name}…`
  try {
    const payload = await uploadEmailDraftAttachment(draftId.value, entry.file)
    const draft = unwrapDraft(payload)
    entry.serverAttachment = matchUploadedAttachment(draft, entry, previousIds)
    if (!entry.serverAttachment?.id) throw new Error('服务器未返回附件编号')
    entry.status = 'uploaded'
    applyDraftSnapshot(draft)
    attachmentMessage.value = `${entry.file.name} 已安全上传。`
    return true
  } catch (error) {
    entry.status = 'error'
    entry.error = error?.message || '附件上传失败'
    attachmentMessage.value = `${entry.file.name} 上传失败，可以重试或移除。`
    return false
  }
}

async function refreshDraftAndReview() {
  const draft = unwrapDraft(await fetchEmailDraft(draftId.value))
  applyDraftSnapshot(draft)
  if (!contentHash.value) throw new Error('服务器未返回可确认的草稿指纹，请刷新后重试。')
  confirmed.value = false
  stage.value = 'review'
  attachmentMessage.value = selectedAttachments.value.length
    ? `${selectedAttachments.value.length} 个附件已纳入发送前检查。`
    : ''
}

async function uploadPendingAttachments() {
  for (const entry of selectedAttachments.value) {
    if (entry.status === 'pending' || entry.status === 'error') {
      await uploadAttachmentEntry(entry)
    }
  }
  if (failedAttachments.value.length) {
    errorMessage.value = `${failedAttachments.value.length} 个附件上传失败。请重试或移除后继续。`
    return false
  }
  await refreshDraftAndReview()
  return true
}

async function saveAndReview() {
  if (!canSave.value) return
  busy.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const payload = await createEmailDraft({
      accountId: props.accountId,
      sourceMessageId: props.sourceMessageId || undefined,
      to: splitAddresses(form.to),
      cc: splitAddresses(form.cc),
      bcc: splitAddresses(form.bcc),
      subject: form.subject.trim(),
      text: form.text
    })
    let draft = unwrapDraft(payload)
    const nextDraftId = String(draft.id || draft.draftId || payload?.draftId || '').trim()
    let nextContentHash = draftHash(draft, payload)
    if (nextDraftId && !nextContentHash) {
      draft = unwrapDraft(await fetchEmailDraft(nextDraftId))
      nextContentHash = String(draft.contentHash || draft.content_hash || '').trim()
    }
    if (!nextDraftId || !nextContentHash) {
      throw new Error('服务器未返回可确认的草稿指纹，请刷新后重试。')
    }
    const canonicalPayload = draft?.payload || {}
    form.to = addressText(canonicalPayload.to || form.to)
    form.cc = addressText(canonicalPayload.cc || form.cc)
    form.bcc = addressText(canonicalPayload.bcc || form.bcc)
    form.subject = String(canonicalPayload.subject || form.subject)
    form.text = String(canonicalPayload.text || form.text)
    draftId.value = nextDraftId
    contentHash.value = nextContentHash
    confirmed.value = false
    stage.value = 'upload'
    await uploadPendingAttachments()
  } catch (error) {
    errorMessage.value = error?.message || '草稿保存失败'
  } finally {
    busy.value = false
  }
}

function returnToEdit() {
  stopQueuedStatusPolling()
  stage.value = 'edit'
  draftId.value = ''
  contentHash.value = ''
  confirmed.value = false
  errorMessage.value = ''
  successMessage.value = ''
  deliveryStatus.value = ''
  deliveryErrorCode.value = ''
  sentSyncStatus.value = ''
  selectedAttachments.value = selectedAttachments.value.map((entry) => ({
    ...entry,
    status: 'pending',
    serverAttachment: null,
    error: ''
  }))
  attachmentMessage.value = selectedAttachments.value.length
    ? '正文或附件修改后会生成新的草稿指纹。'
    : ''
}

async function retryAttachment(entry) {
  if (busy.value || entry.status !== 'error') return
  busy.value = true
  errorMessage.value = ''
  try {
    await uploadAttachmentEntry(entry)
    if (!failedAttachments.value.length) await refreshDraftAndReview()
  } catch (error) {
    errorMessage.value = error?.message || '附件重试失败'
  } finally {
    busy.value = false
  }
}

async function removeAttachment(entry) {
  if (busy.value) return
  if (!entry.serverAttachment?.id || !draftId.value) {
    removeLocalAttachment(entry)
    if (isUploading.value && draftId.value && !failedAttachments.value.length) {
      busy.value = true
      try {
        await refreshDraftAndReview()
      } catch (error) {
        errorMessage.value = error?.message || '草稿刷新失败'
      } finally {
        busy.value = false
      }
    }
    return
  }
  busy.value = true
  errorMessage.value = ''
  try {
    const payload = await deleteEmailDraftAttachment(draftId.value, entry.serverAttachment.id)
    applyDraftSnapshot(unwrapDraft(payload))
    removeLocalAttachment(entry)
    if (isUploading.value && !failedAttachments.value.length) await refreshDraftAndReview()
  } catch (error) {
    errorMessage.value = error?.message || '附件删除失败'
  } finally {
    busy.value = false
  }
}

async function sendConfirmedDraft() {
  if (!canSend.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    const payload = await confirmEmailDraft(draftId.value, contentHash.value)
    const draft = unwrapDraft(payload)
    applyDraftSnapshot(draft)
    if (!deliveryStatus.value) deliveryStatus.value = 'queued'
    if (!sentSyncStatus.value) sentSyncStatus.value = 'pending'
    stage.value = 'queued'
    successMessage.value = '邮件已提交安全发送队列，尚不代表 SMTP 已完成投递。'
    emit('queued', {
      draftId: draftId.value,
      deliveryStatus: deliveryStatus.value || 'queued',
      sentSyncStatus: sentSyncStatus.value || 'pending'
    })
    startQueuedStatusPolling()
  } catch (error) {
    errorMessage.value = error?.message || '邮件发送失败'
  } finally {
    busy.value = false
  }
}

function close() {
  if (!busy.value) {
    stopQueuedStatusPolling()
    emit('close')
  }
}

watch(() => props.show, (show) => {
  if (show) resetDialog()
  else stopQueuedStatusPolling()
})

onBeforeUnmount(stopQueuedStatusPolling)
</script>

<template>
  <Modal
    :show="show"
    :title="sourceMessageId ? '回复邮件' : '撰写邮件'"
    width="720px"
    initial-focus-selector="#mail-compose-to"
    :close-disabled="busy"
    @close="close"
  >
    <form v-if="stage === 'edit'" class="mail-compose" @submit.prevent="saveAndReview">
      <p class="mail-compose__safety">
        <Icon name="shield" :size="17" />
        保存只会生成加密草稿；下一步预览并再次确认后才会外发。
      </p>

      <label for="mail-compose-to">收件人 <span aria-hidden="true">*</span></label>
      <input id="mail-compose-to" v-model="form.to" class="input" type="text" autocomplete="off" required placeholder="name@example.com；多个地址用逗号分隔">

      <details class="mail-compose__optional">
        <summary>抄送与密送</summary>
        <div>
          <label for="mail-compose-cc">抄送</label>
          <input id="mail-compose-cc" v-model="form.cc" class="input" type="text" autocomplete="off" placeholder="可选">
          <label for="mail-compose-bcc">密送</label>
          <input id="mail-compose-bcc" v-model="form.bcc" class="input" type="text" autocomplete="off" placeholder="可选">
        </div>
      </details>

      <label for="mail-compose-subject">主题 <span aria-hidden="true">*</span></label>
      <input id="mail-compose-subject" v-model="form.subject" class="input" type="text" maxlength="240" required placeholder="邮件主题">

      <label for="mail-compose-text">正文 <span aria-hidden="true">*</span></label>
      <textarea id="mail-compose-text" v-model="form.text" class="input" rows="10" maxlength="80000" required placeholder="输入正文；AI 生成的回信仍需由你检查"></textarea>

      <section class="mail-attachments-editor" aria-labelledby="mail-compose-attachments-heading">
        <div class="mail-attachments-editor__heading">
          <div>
            <h3 id="mail-compose-attachments-heading">附件</h3>
            <p>最多 10 个；单个不超过 10 MB；合计不超过 25 MB。</p>
          </div>
          <button type="button" :disabled="busy || selectedAttachments.length >= MAX_ATTACHMENT_COUNT" @click="chooseAttachments">
            <Icon name="plus" :size="17" />
            添加附件
          </button>
          <input
            ref="fileInput"
            class="mail-attachments-editor__input"
            type="file"
            multiple
            tabindex="-1"
            aria-hidden="true"
            @change="onAttachmentSelection"
          >
        </div>
        <ul v-if="selectedAttachments.length" class="mail-attachment-list">
          <li v-for="entry in selectedAttachments" :key="entry.clientId">
            <span><Icon name="note" :size="17" /></span>
            <div>
              <strong>{{ entry.file?.name || entry.serverAttachment?.filename || '附件' }}</strong>
              <small>{{ formatSize(entry.file?.size || entry.serverAttachment?.size) }}</small>
            </div>
            <button type="button" :aria-label="`移除 ${entry.file?.name || '附件'}`" :disabled="busy" @click="removeAttachment(entry)">
              <Icon name="trash" :size="17" />
            </button>
          </li>
        </ul>
        <p v-else>尚未添加附件。</p>
        <p v-if="selectedAttachments.length" class="mail-attachments-editor__total">
          共 {{ selectedAttachments.length }} 个，{{ formatSize(attachmentTotalBytes) }}
        </p>
      </section>
    </form>

    <section v-else-if="isUploading" class="mail-upload" aria-labelledby="mail-upload-heading">
      <div class="mail-review__heading">
        <span><Icon name="upload" :size="21" /></span>
        <div>
          <h3 id="mail-upload-heading">正在安全保存附件</h3>
          <p>正文草稿已保存；附件会按顺序上传，失败项目不会进入发送确认。</p>
        </div>
      </div>
      <ul class="mail-attachment-list is-status">
        <li v-for="entry in selectedAttachments" :key="entry.clientId" :class="`is-${entry.status}`">
          <span><Icon name="note" :size="17" /></span>
          <div>
            <strong>{{ entry.file?.name || entry.serverAttachment?.filename || '附件' }}</strong>
            <small>{{ formatSize(entry.file?.size || entry.serverAttachment?.size) }} · {{ attachmentStatusLabel(entry) }}</small>
            <small v-if="entry.error" class="is-error">{{ entry.error }}</small>
          </div>
          <div class="mail-attachment-list__actions">
            <button
              v-if="entry.status === 'error'"
              type="button"
              :aria-label="`重试上传 ${entry.file?.name || '附件'}`"
              :disabled="busy"
              @click="retryAttachment(entry)"
            >
              <Icon name="refresh" :size="17" />
            </button>
            <button
              v-if="entry.status !== 'uploading'"
              type="button"
              :aria-label="`移除 ${entry.file?.name || '附件'}`"
              :disabled="busy"
              @click="removeAttachment(entry)"
            >
              <Icon name="trash" :size="17" />
            </button>
          </div>
        </li>
      </ul>
    </section>

    <section v-else-if="isReviewing" class="mail-review" aria-labelledby="mail-review-heading">
      <div class="mail-review__heading">
        <span><Icon name="mail" :size="21" /></span>
        <div>
          <h3 id="mail-review-heading">发送前最后检查</h3>
          <p>草稿内容已锁定。若要修改，请返回编辑并重新生成草稿指纹。</p>
        </div>
      </div>
      <dl>
        <div><dt>收件人</dt><dd>{{ form.to }}</dd></div>
        <div v-if="form.cc"><dt>抄送</dt><dd>{{ form.cc }}</dd></div>
        <div v-if="form.bcc"><dt>密送</dt><dd>{{ form.bcc }}</dd></div>
        <div><dt>主题</dt><dd>{{ form.subject }}</dd></div>
      </dl>
      <pre>{{ form.text }}</pre>
      <section v-if="selectedAttachments.length" class="mail-review__attachments" aria-labelledby="mail-review-attachments-heading">
        <h4 id="mail-review-attachments-heading">附件（{{ selectedAttachments.length }}）</h4>
        <ul class="mail-attachment-list">
          <li v-for="entry in selectedAttachments" :key="entry.clientId">
            <span><Icon name="note" :size="17" /></span>
            <div>
              <strong>{{ entry.serverAttachment?.filename || entry.file?.name || '附件' }}</strong>
              <small>{{ entry.serverAttachment?.contentType || entry.file?.type || 'application/octet-stream' }} · {{ formatSize(entry.serverAttachment?.size || entry.file?.size) }}</small>
            </div>
          </li>
        </ul>
      </section>
      <label class="mail-review__confirm">
        <input v-model="confirmed" type="checkbox">
        <span>我已核对收件人、主题、正文和附件，确认将这封邮件发送到外部邮箱（先提交安全发送队列）。</span>
      </label>
    </section>

    <section v-else class="mail-compose__queued" role="status">
      <span><Icon name="circle-check" :size="28" /></span>
      <h3>已提交发送队列</h3>
      <p>这表示后台任务已接收，并不等于邮件已经送达收件人。</p>
      <dl>
        <div><dt>外部投递</dt><dd>{{ deliveryStatusLabel }}</dd></div>
        <div><dt>已发送同步</dt><dd>{{ sentSyncStatusLabel }}</dd></div>
      </dl>
    </section>

    <p v-if="errorMessage" class="mail-compose__message is-error" role="alert">{{ errorMessage }}</p>
    <p v-if="successMessage" class="mail-compose__message is-success" role="status" aria-live="polite">{{ successMessage }}</p>
    <p class="mail-compose__attachment-live" role="status" aria-live="polite">{{ attachmentMessage }}</p>

    <template #footer>
      <button v-if="isReviewing" type="button" class="mail-compose__button is-secondary" :disabled="busy" @click="returnToEdit">
        返回修改
      </button>
      <button v-else-if="!isQueued" type="button" class="mail-compose__button is-secondary" :disabled="busy" @click="close">
        取消
      </button>
      <button v-if="stage === 'edit'" type="button" class="mail-compose__button is-primary" :disabled="!canSave" @click="saveAndReview">
        <Icon name="edit" :size="17" />
        {{ busy ? '正在保存…' : '保存并预览' }}
      </button>
      <button v-else-if="isReviewing" type="button" class="mail-compose__button is-danger" :disabled="!canSend" @click="sendConfirmedDraft">
        <Icon name="mail" :size="17" />
        {{ busy ? '正在提交…' : '确认发送' }}
      </button>
      <button v-else-if="isQueued" type="button" class="mail-compose__button is-primary" @click="close">
        完成
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.mail-compose { display: grid; gap: 9px; }
.mail-compose label { margin-top: 8px; color: var(--text-secondary); font-size: .72rem; font-weight: 700; }
.mail-compose .input { min-height: 46px; border: 1px solid var(--border-light); }
.mail-compose textarea.input { min-height: 210px; line-height: 1.65; }
.mail-compose__safety { display: flex; margin: 0 0 5px; padding: 11px 12px; align-items: flex-start; gap: 8px; color: var(--text-secondary); font-size: .68rem; line-height: 1.55; background: var(--accent-bg); border: 1px solid color-mix(in srgb, var(--accent-color) 24%, transparent); border-radius: 12px; }
.mail-compose__optional { margin: 4px 0; padding: 10px 12px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; }
.mail-compose__optional summary { min-height: 24px; color: var(--text-secondary); font-size: .7rem; font-weight: 700; cursor: pointer; }
.mail-compose__optional > div { display: grid; gap: 8px; }
.mail-attachments-editor { margin-top: 8px; padding: 13px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 14px; }
.mail-attachments-editor__heading { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mail-attachments-editor h3,
.mail-review__attachments h4 { margin: 0; color: var(--text-secondary); font-size: .74rem; }
.mail-attachments-editor__heading p,
.mail-attachments-editor > p { margin: 4px 0 0; color: var(--text-muted); font-size: .62rem; line-height: 1.55; }
.mail-attachments-editor__heading button { display: inline-flex; min-height: 44px; padding: 0 13px; flex: 0 0 auto; align-items: center; justify-content: center; gap: 6px; color: var(--text-secondary); font: inherit; font-size: .68rem; font-weight: 700; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 11px; cursor: pointer; }
.mail-attachments-editor__heading button:disabled { opacity: .48; cursor: not-allowed; }
.mail-attachments-editor__input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.mail-attachment-list { display: grid; margin: 12px 0 0; padding: 0; gap: 7px; list-style: none; }
.mail-attachment-list li { display: grid; min-height: 52px; padding: 7px 8px 7px 11px; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 9px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 11px; }
.mail-attachment-list li > span { color: var(--accent-color); }
.mail-attachment-list li > div { display: grid; min-width: 0; gap: 3px; }
.mail-attachment-list strong { overflow: hidden; color: var(--text-secondary); font-size: .68rem; font-weight: 690; text-overflow: ellipsis; white-space: nowrap; }
.mail-attachment-list small { color: var(--text-muted); font-size: .6rem; line-height: 1.45; }
.mail-attachment-list small.is-error { color: var(--error-color); }
.mail-attachment-list button { display: grid; width: 44px; height: 44px; padding: 0; place-items: center; color: var(--text-secondary); background: transparent; border: 0; border-radius: 10px; cursor: pointer; }
.mail-attachment-list button:hover { background: var(--bg-hover); }
.mail-attachment-list button:disabled { opacity: .45; cursor: not-allowed; }
.mail-attachment-list__actions { display: flex !important; gap: 2px !important; }
.mail-attachments-editor__total { text-align: right; }
.mail-upload { min-height: 260px; }
.mail-upload .mail-attachment-list { margin-top: 18px; }
.mail-upload .mail-attachment-list li.is-error { border-color: color-mix(in srgb, var(--error-color) 28%, var(--border-light)); }
.mail-review__heading { display: flex; align-items: center; gap: 12px; }
.mail-review__heading > span { display: grid; width: 46px; height: 46px; flex: 0 0 auto; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 14px; }
.mail-review h3,
.mail-compose__queued h3 { margin: 0; font-size: .95rem; }
.mail-review__heading p,
.mail-compose__queued p { margin: 5px 0 0; color: var(--text-muted); font-size: .68rem; line-height: 1.55; }
.mail-review dl { display: grid; margin: 18px 0 12px; gap: 8px; }
.mail-review dl div { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 10px; }
.mail-review dt { color: var(--text-muted); font-size: .67rem; }
.mail-review dd { margin: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: .7rem; }
.mail-review pre { max-height: 260px; margin: 0; padding: 15px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .72rem; line-height: 1.7; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 13px; }
.mail-review__attachments { margin-top: 14px; padding: 13px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 13px; }
.mail-review__attachments .mail-attachment-list { margin-top: 9px; }
.mail-review__confirm { display: flex; min-height: 48px; margin-top: 14px; padding: 11px 12px; align-items: flex-start; gap: 10px; color: var(--text-secondary); font-size: .68rem; line-height: 1.55; background: color-mix(in srgb, var(--warning-color) 7%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--warning-color) 24%, transparent); border-radius: 12px; cursor: pointer; }
.mail-review__confirm input { width: 20px; height: 20px; flex: 0 0 auto; accent-color: var(--accent-color); }
.mail-compose__queued { display: grid; min-height: 260px; place-content: center; justify-items: center; text-align: center; }
.mail-compose__queued > span { display: grid; width: 58px; height: 58px; margin-bottom: 15px; place-items: center; color: var(--success-color); background: color-mix(in srgb, var(--success-color) 10%, var(--bg-card)); border-radius: 18px; }
.mail-compose__queued dl { display: grid; width: min(100%, 440px); margin: 18px 0 0; gap: 7px; }
.mail-compose__queued dl div { display: flex; min-height: 44px; padding: 9px 11px; align-items: center; justify-content: space-between; gap: 12px; text-align: left; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 11px; }
.mail-compose__queued dt { color: var(--text-muted); font-size: .63rem; }
.mail-compose__queued dd { margin: 0; color: var(--text-secondary); font-size: .67rem; }
.mail-compose__message { margin: 14px 0 0; padding: 10px 12px; font-size: .68rem; line-height: 1.55; border-radius: 11px; }
.mail-compose__message.is-error { color: var(--error-color); background: color-mix(in srgb, var(--error-color) 8%, var(--bg-card)); }
.mail-compose__message.is-success { color: var(--success-color); background: color-mix(in srgb, var(--success-color) 8%, var(--bg-card)); }
.mail-compose__attachment-live { min-height: 1.1em; margin: 9px 0 0; color: var(--text-muted); font-size: .63rem; line-height: 1.55; }
.mail-compose__button { display: inline-flex; min-height: 44px; padding: 0 16px; align-items: center; justify-content: center; gap: 7px; color: var(--text-secondary); font: inherit; font-size: .72rem; font-weight: 720; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-compose__button:disabled { opacity: .48; cursor: not-allowed; }
.mail-compose__button.is-primary { color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: transparent; }
.mail-compose__button.is-danger { color: #fff; background: var(--error-color); border-color: transparent; }
@media (max-width: 600px) {
  .mail-attachments-editor__heading { align-items: flex-start; }
  .mail-attachment-list__actions { flex-direction: column; }
  .mail-review dl div { grid-template-columns: 1fr; gap: 3px; }
  .mail-review pre { max-height: 34vh; }
  .mail-compose textarea.input { min-height: 180px; }
}
</style>
