<script setup>
import { computed, reactive, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import Modal from '@/shared/components/Modal.vue'
import {
  confirmEmailDraft,
  createEmailDraft,
  fetchEmailDraft
} from '@/shared/services/emailApi'

const props = defineProps({
  show: { type: Boolean, default: false },
  accountId: { type: String, default: '' },
  sourceMessageId: { type: String, default: '' },
  initial: { type: Object, default: () => ({}) }
})

const emit = defineEmits(['close', 'sent'])

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

const isReviewing = computed(() => stage.value === 'review')
const isSent = computed(() => stage.value === 'sent')
const canSave = computed(() => (
  !busy.value
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

function resetDialog() {
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
}

function unwrapDraft(payload) {
  return payload?.draft || payload?.data?.draft || payload?.data || payload || {}
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
    let nextContentHash = String(draft.contentHash || draft.content_hash || payload?.contentHash || '').trim()
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
    stage.value = 'review'
  } catch (error) {
    errorMessage.value = error?.message || '草稿保存失败'
  } finally {
    busy.value = false
  }
}

function returnToEdit() {
  stage.value = 'edit'
  draftId.value = ''
  contentHash.value = ''
  confirmed.value = false
  errorMessage.value = ''
}

async function sendConfirmedDraft() {
  if (!canSend.value) return
  busy.value = true
  errorMessage.value = ''
  try {
    await confirmEmailDraft(draftId.value, contentHash.value)
    stage.value = 'sent'
    successMessage.value = '邮件已进入安全发送队列。'
    emit('sent', { draftId: draftId.value })
  } catch (error) {
    errorMessage.value = error?.message || '邮件发送失败'
  } finally {
    busy.value = false
  }
}

function close() {
  if (!busy.value) emit('close')
}

watch(() => props.show, (show) => {
  if (show) resetDialog()
})
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
    </form>

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
      <label class="mail-review__confirm">
        <input v-model="confirmed" type="checkbox">
        <span>我已核对收件人、主题和正文，确认将这封邮件发送到外部邮箱。</span>
      </label>
    </section>

    <section v-else class="mail-compose__sent" role="status">
      <span><Icon name="circle-check" :size="28" /></span>
      <h3>已加入发送队列</h3>
      <p>系统会在后台安全投递；若 SMTP 拒绝邮件，会保留失败状态供你检查。</p>
    </section>

    <p v-if="errorMessage" class="mail-compose__message is-error" role="alert">{{ errorMessage }}</p>
    <p v-if="successMessage" class="mail-compose__message is-success" role="status">{{ successMessage }}</p>

    <template #footer>
      <button v-if="isReviewing" type="button" class="mail-compose__button is-secondary" :disabled="busy" @click="returnToEdit">
        返回修改
      </button>
      <button v-else-if="!isSent" type="button" class="mail-compose__button is-secondary" :disabled="busy" @click="close">
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
      <button v-else type="button" class="mail-compose__button is-primary" @click="close">
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
.mail-review__heading { display: flex; align-items: center; gap: 12px; }
.mail-review__heading > span { display: grid; width: 46px; height: 46px; flex: 0 0 auto; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 14px; }
.mail-review h3,
.mail-compose__sent h3 { margin: 0; font-size: .95rem; }
.mail-review__heading p,
.mail-compose__sent p { margin: 5px 0 0; color: var(--text-muted); font-size: .68rem; line-height: 1.55; }
.mail-review dl { display: grid; margin: 18px 0 12px; gap: 8px; }
.mail-review dl div { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 10px; }
.mail-review dt { color: var(--text-muted); font-size: .67rem; }
.mail-review dd { margin: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: .7rem; }
.mail-review pre { max-height: 260px; margin: 0; padding: 15px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .72rem; line-height: 1.7; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 13px; }
.mail-review__confirm { display: flex; min-height: 48px; margin-top: 14px; padding: 11px 12px; align-items: flex-start; gap: 10px; color: var(--text-secondary); font-size: .68rem; line-height: 1.55; background: color-mix(in srgb, var(--warning-color) 7%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--warning-color) 24%, transparent); border-radius: 12px; cursor: pointer; }
.mail-review__confirm input { width: 20px; height: 20px; flex: 0 0 auto; accent-color: var(--accent-color); }
.mail-compose__sent { display: grid; min-height: 260px; place-content: center; justify-items: center; text-align: center; }
.mail-compose__sent > span { display: grid; width: 58px; height: 58px; margin-bottom: 15px; place-items: center; color: var(--success-color); background: color-mix(in srgb, var(--success-color) 10%, var(--bg-card)); border-radius: 18px; }
.mail-compose__message { margin: 14px 0 0; padding: 10px 12px; font-size: .68rem; line-height: 1.55; border-radius: 11px; }
.mail-compose__message.is-error { color: var(--error-color); background: color-mix(in srgb, var(--error-color) 8%, var(--bg-card)); }
.mail-compose__message.is-success { color: var(--success-color); background: color-mix(in srgb, var(--success-color) 8%, var(--bg-card)); }
.mail-compose__button { display: inline-flex; min-height: 44px; padding: 0 16px; align-items: center; justify-content: center; gap: 7px; color: var(--text-secondary); font: inherit; font-size: .72rem; font-weight: 720; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-compose__button:disabled { opacity: .48; cursor: not-allowed; }
.mail-compose__button.is-primary { color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: transparent; }
.mail-compose__button.is-danger { color: #fff; background: var(--error-color); border-color: transparent; }
@media (max-width: 600px) {
  .mail-review dl div { grid-template-columns: 1fr; gap: 3px; }
  .mail-review pre { max-height: 34vh; }
  .mail-compose textarea.input { min-height: 180px; }
}
</style>
