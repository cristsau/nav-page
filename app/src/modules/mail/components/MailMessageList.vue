<script setup>
import { computed, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'

const props = defineProps({
  messages: { type: Array, default: () => [] },
  selectedMessageId: { type: String, default: '' },
  folderName: { type: String, default: '收件箱' },
  loading: { type: Boolean, default: false },
  loadingMore: { type: Boolean, default: false },
  hasMore: { type: Boolean, default: false },
  realtimeLabel: { type: String, default: '' }
})

const emit = defineEmits(['select', 'load-more', 'refresh', 'open-folders'])
const search = ref('')

const filteredMessages = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase('zh-CN')
  if (!needle) return props.messages
  return props.messages.filter((message) => [
    subjectLabel(message),
    senderLabel(message),
    message.preview,
    message.bodyPreview
  ].join(' ').toLocaleLowerCase('zh-CN').includes(needle))
})

function messageId(message) {
  return String(message?.id || message?.messageId || '')
}

function senderLabel(message) {
  return message?.from?.name
    || message?.senderName
    || message?.from?.address
    || message?.senderAddress
    || '未知发件人'
}

function subjectLabel(message) {
  return message?.subject || '(无主题)'
}

function previewLabel(message) {
  return message?.preview || message?.bodyPreview || '暂无摘要'
}

function receivedValue(message) {
  return message?.internalDate || message?.receivedAt || message?.sentAt || ''
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)
}

function isUnread(message) {
  return message?.unread === true || message?.flags?.seen === false || message?.seen === false
}

function selectMessage(message, event) {
  emit('select', messageId(message), event.currentTarget)
}
</script>

<template>
  <section class="mail-message-list" aria-labelledby="mail-message-list-title">
    <header class="mail-message-list__header">
      <button class="mail-message-list__folders" type="button" aria-label="选择邮箱文件夹" @click="emit('open-folders')">
        <Icon name="folder" :size="18" />
      </button>
      <div>
        <h2 id="mail-message-list-title">{{ folderName }}</h2>
        <p v-if="realtimeLabel" role="status">{{ realtimeLabel }}</p>
      </div>
      <button type="button" :disabled="loading" aria-label="刷新邮件列表" @click="emit('refresh')">
        <Icon name="refresh" :size="17" />
      </button>
    </header>

    <label class="mail-message-list__search">
      <Icon name="search" :size="17" aria-hidden="true" />
      <span class="sr-only">搜索当前已加载的邮件</span>
      <input v-model="search" type="search" placeholder="搜索已加载邮件" autocomplete="off">
    </label>

    <p v-if="loading && !messages.length" class="mail-message-list__empty" role="status">正在读取邮件…</p>
    <p v-else-if="!messages.length" class="mail-message-list__empty">这个文件夹还没有已同步的邮件。</p>
    <p v-else-if="!filteredMessages.length" class="mail-message-list__empty">
      没有匹配的已加载邮件。
      <button type="button" @click="search = ''">清除搜索</button>
    </p>
    <ul v-else :aria-busy="loading">
      <li v-for="message in filteredMessages" :key="messageId(message)">
        <button
          type="button"
          :class="{ 'is-active': messageId(message) === selectedMessageId, 'is-unread': isUnread(message) }"
          :aria-current="messageId(message) === selectedMessageId ? 'true' : undefined"
          @click="selectMessage(message, $event)"
        >
          <span class="mail-message-list__sender">
            <span v-if="isUnread(message)" class="mail-message-list__unread" aria-hidden="true"></span>
            <strong>{{ senderLabel(message) }}</strong>
            <span v-if="isUnread(message)" class="sr-only">未读，</span>
            <time :datetime="receivedValue(message)">{{ formatDate(receivedValue(message)) }}</time>
          </span>
          <span class="mail-message-list__subject">{{ subjectLabel(message) }}</span>
          <span class="mail-message-list__preview">{{ previewLabel(message) }}</span>
          <span v-if="message.hasAttachments || Number(message.attachmentCount || 0)" class="mail-message-list__attachment">
            {{ Number(message.attachmentCount || 0) || 1 }} 个附件
          </span>
        </button>
      </li>
    </ul>

    <div v-if="hasMore" class="mail-message-list__more">
      <button type="button" :disabled="loadingMore" @click="emit('load-more')">
        {{ loadingMore ? '正在加载…' : '加载更多' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.mail-message-list { display: flex; min-width: 0; height: 100%; flex-direction: column; color: var(--text-primary); background: var(--bg-card); border-right: 1px solid var(--border-light); }
.mail-message-list__header { display: grid; min-height: 68px; padding: 10px 12px; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 9px; border-bottom: 1px solid var(--border-light); }
.mail-message-list__header > button { display: grid; width: 44px; height: 44px; place-items: center; color: var(--text-secondary); background: transparent; border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-message-list__header > button:disabled { opacity: .5; cursor: wait; }
.mail-message-list__header h2 { margin: 0; overflow: hidden; font-size: .84rem; white-space: nowrap; text-overflow: ellipsis; }
.mail-message-list__header p { margin: 3px 0 0; overflow: hidden; color: var(--text-muted); font-size: .61rem; white-space: nowrap; text-overflow: ellipsis; }
.mail-message-list__folders { display: none !important; }
.mail-message-list__search { display: flex; min-height: 44px; margin: 10px 12px; padding: 0 11px; align-items: center; gap: 8px; color: var(--text-muted); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; }
.mail-message-list__search input { min-width: 0; flex: 1; color: var(--text-primary); font: inherit; font-size: .72rem; background: transparent; border: 0; outline: 0; }
.mail-message-list__search input::placeholder { color: var(--text-muted); }
.mail-message-list ul { min-height: 0; margin: 0; padding: 0 8px 8px; flex: 1; overflow-y: auto; list-style: none; }
.mail-message-list li > button { position: relative; display: grid; width: 100%; min-height: 116px; padding: 13px 12px 13px 15px; text-align: left; gap: 5px; color: var(--text-primary); font: inherit; background: transparent; border: 1px solid transparent; border-radius: 14px; cursor: pointer; }
.mail-message-list li > button:hover,
.mail-message-list li > button:focus-visible { background: var(--bg-hover); outline: 2px solid color-mix(in srgb, var(--accent-color) 42%, transparent); outline-offset: -2px; }
.mail-message-list li > button.is-active { background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent-color) 25%, var(--border-light)); }
.mail-message-list__sender { display: grid; min-width: 0; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 7px; color: var(--text-muted); font-size: .62rem; }
.mail-message-list__sender strong { overflow: hidden; color: var(--text-secondary); white-space: nowrap; text-overflow: ellipsis; }
.mail-message-list__unread { width: 7px; height: 7px; background: var(--accent-color); border-radius: 50%; }
.mail-message-list__subject { overflow: hidden; font-size: .75rem; font-weight: 720; white-space: nowrap; text-overflow: ellipsis; }
.mail-message-list__preview { display: -webkit-box; overflow: hidden; color: var(--text-muted); font-size: .66rem; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.mail-message-list__attachment { width: fit-content; padding: 3px 7px; color: var(--text-muted); font-size: .59rem; background: var(--bg-secondary); border-radius: 999px; }
.mail-message-list__empty { margin: 0; padding: 28px 18px; color: var(--text-muted); text-align: center; font-size: .7rem; line-height: 1.65; }
.mail-message-list__empty button { min-height: 44px; color: var(--accent-color); font: inherit; background: transparent; border: 0; cursor: pointer; }
.mail-message-list__more { padding: 8px 12px 12px; border-top: 1px solid var(--border-light); }
.mail-message-list__more button { width: 100%; min-height: 44px; color: var(--accent-color); font: inherit; font-size: .7rem; font-weight: 700; background: var(--accent-bg); border: 1px solid color-mix(in srgb, var(--accent-color) 22%, var(--border-light)); border-radius: 12px; cursor: pointer; }
.mail-message-list__more button:disabled { opacity: .55; cursor: wait; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .mail-message-list { border-right: 0; }
  .mail-message-list__folders { display: grid !important; }
  .mail-message-list ul { overflow: visible; }
}
</style>
