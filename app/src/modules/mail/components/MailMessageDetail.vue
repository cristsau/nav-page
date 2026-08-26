<script setup>
import Icon from '@/shared/components/Icon.vue'

defineProps({
  message: { type: Object, default: null },
  loading: { type: Boolean, default: false }
})

defineEmits(['close'])

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
