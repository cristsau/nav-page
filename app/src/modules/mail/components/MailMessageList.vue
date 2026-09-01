<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
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

// The server searches the full mailbox; local filtering keeps the current rows
// responsive while the debounced request is in flight.
const emit = defineEmits(['select', 'load-more', 'refresh', 'open-folders', 'compose', 'notification', 'query-change'])
const search = ref('')
const activeFilter = ref('all')
let queryTimer = null

const filters = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '未读' },
  { value: 'important', label: '重要' },
  { value: 'attachments', label: '附件' }
]

const categoryNames = {
  security: '账号安全', account: '账号安全', payment: '付款账单', billing: '付款账单',
  operations: '服务运维', ops: '服务运维', server: '服务运维', work: '工作待办', action: '工作待办',
  receipt: '收据状态', status: '收据状态', personal: '个人邮件',
  newsletter: '订阅资讯', marketing: '营销推广', social: '社交通知', system: '系统通知'
}

const notificationNames = {
  immediate: '立即提醒', digest: '仅摘要', in_app_only: '仅站内', silent: '已静音'
}

const filteredMessages = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase('zh-CN')
  return props.messages.filter((message) => {
    if (activeFilter.value === 'unread' && !isUnread(message)) return false
    if (activeFilter.value === 'important' && !isImportant(message)) return false
    if (activeFilter.value === 'attachments' && !hasAttachments(message)) return false
    if (!needle) return true
    return [
      subjectLabel(message), senderLabel(message), senderAddress(message),
      message.preview, message.bodyPreview, categoryLabel(message)
    ].join(' ').toLocaleLowerCase('zh-CN').includes(needle)
  })
})

function messageId(message) {
  return String(message?.id || message?.messageId || '')
}

function senderLabel(message) {
  return message?.from?.name || message?.senderName || message?.from?.address || message?.senderAddress || '未知发件人'
}

function senderAddress(message) {
  return message?.from?.address || message?.senderAddress || ''
}

function senderInitial(message) {
  const value = senderLabel(message).trim()
  return (value.match(/[\p{L}\p{N}]/u)?.[0] || '?').toLocaleUpperCase('zh-CN')
}

function avatarTone(message) {
  const value = `${senderAddress(message)}${senderLabel(message)}`
  let hash = 0
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  return Math.abs(hash) % 6
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
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  return new Intl.DateTimeFormat('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit' }
  ).format(date)
}

function isUnread(message) {
  return message?.unread === true || message?.flags?.seen === false || message?.seen === false
}

function isImportant(message) {
  return message?.important === true
    || message?.flagged === true
    || message?.flags?.flagged === true
    || Number(message?.importanceScore || 0) >= 72
}

function hasAttachments(message) {
  return message?.hasAttachments === true || Number(message?.attachmentCount || 0) > 0
}

function categoryLabel(message) {
  const value = String(message?.category || '').trim().toLowerCase()
  return categoryNames[value] || (value ? '智能分类' : '')
}

function notificationLabel(message) {
  return notificationNames[String(message?.notificationAction || '').trim()] || ''
}

function threadCount(message) {
  return Math.max(1, Number(message?.threadMessageCount || message?.threadCount || 1))
}

function selectMessage(message, event) {
  emit('select', messageId(message), event.currentTarget)
}

function moveFocus(event, direction) {
  event.preventDefault()
  const rows = Array.from(event.currentTarget.closest('ul')?.querySelectorAll('[data-mail-row]') || [])
  const index = rows.indexOf(event.currentTarget)
  rows[Math.max(0, Math.min(rows.length - 1, index + direction))]?.focus?.()
}

watch([search, activeFilter], () => {
  if (queryTimer) window.clearTimeout(queryTimer)
  queryTimer = window.setTimeout(() => {
    emit('query-change', {
      query: search.value.trim(),
      filter: activeFilter.value === 'important' ? 'flagged' : activeFilter.value
    })
  }, 220)
})

onBeforeUnmount(() => {
  if (queryTimer) window.clearTimeout(queryTimer)
})
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
      <button class="mail-message-list__compose" type="button" aria-label="新建邮件" title="新建邮件" aria-haspopup="dialog" @click="emit('compose')">
        <Icon name="plus" :size="17" />
        <span>新建邮件</span>
      </button>
      <button type="button" :disabled="loading" aria-label="刷新邮件列表" @click="emit('refresh')">
        <Icon name="refresh" :size="17" />
      </button>
    </header>

    <label class="mail-message-list__search">
      <Icon name="search" :size="17" aria-hidden="true" />
      <span class="sr-only">搜索邮件</span>
      <input v-model="search" type="search" placeholder="搜索发件人、标题或正文" autocomplete="off">
    </label>

    <div class="mail-message-list__filters" role="group" aria-label="筛选邮件">
      <button
        v-for="filter in filters"
        :key="filter.value"
        type="button"
        :class="{ 'is-active': activeFilter === filter.value }"
        :aria-pressed="activeFilter === filter.value"
        @click="activeFilter = filter.value"
      >
        {{ filter.label }}
      </button>
    </div>

    <p v-if="loading && !messages.length" class="mail-message-list__empty" role="status">正在读取邮件…</p>
    <p v-else-if="!messages.length" class="mail-message-list__empty">这个文件夹还没有已同步的邮件。</p>
    <p v-else-if="!filteredMessages.length" class="mail-message-list__empty">
      当前搜索或筛选没有结果。
      <button type="button" @click="search = ''; activeFilter = 'all'">清除筛选</button>
    </p>
    <ul v-else :aria-busy="loading">
      <li v-for="message in filteredMessages" :key="messageId(message)" class="mail-message-row">
        <button
          type="button"
          class="mail-message-row__open"
          data-mail-row
          :class="{ 'is-active': messageId(message) === selectedMessageId, 'is-unread': isUnread(message) }"
          :aria-current="messageId(message) === selectedMessageId ? 'true' : undefined"
          :aria-label="`${isUnread(message) ? '未读，' : ''}${senderLabel(message)}，${subjectLabel(message)}`"
          @click="selectMessage(message, $event)"
          @keydown.down="moveFocus($event, 1)"
          @keydown.up="moveFocus($event, -1)"
        >
          <span class="mail-message-row__avatar" :data-tone="avatarTone(message)" aria-hidden="true">{{ senderInitial(message) }}</span>
          <span class="mail-message-row__content">
            <span class="mail-message-list__sender">
              <span v-if="isUnread(message)" class="mail-message-list__unread" aria-hidden="true"></span>
              <strong>{{ senderLabel(message) }}</strong>
              <span v-if="isUnread(message)" class="sr-only">未读，</span>
              <time :datetime="receivedValue(message)">{{ formatDate(receivedValue(message)) }}</time>
            </span>
            <span class="mail-message-list__subject">
              <Icon v-if="isImportant(message)" name="star" :size="13" label="重要邮件" />
              <span>{{ subjectLabel(message) }}</span>
              <b v-if="threadCount(message) > 1" aria-label="会话邮件数量">{{ threadCount(message) }}</b>
            </span>
            <span class="mail-message-list__preview">{{ previewLabel(message) }}</span>
            <span class="mail-message-list__meta">
              <span v-if="categoryLabel(message)" class="is-category">{{ categoryLabel(message) }}</span>
              <span v-if="hasAttachments(message)"><Icon name="attachment" :size="13" />{{ Number(message.attachmentCount || 0) || 1 }}</span>
              <span v-if="notificationLabel(message)" :class="{ 'is-silent': message.notificationAction === 'silent' }">
                <Icon :name="message.notificationAction === 'silent' ? 'bell-off' : 'bell'" :size="13" />
                {{ notificationLabel(message) }}
              </span>
            </span>
          </span>
        </button>
        <button
          type="button"
          class="mail-message-row__rule"
          :aria-label="`设置 ${senderLabel(message)} 的通知规则`"
          title="设置通知"
          @click="emit('notification', message, $event.currentTarget)"
        >
          <Icon :name="message.notificationAction === 'silent' ? 'bell-off' : 'bell'" :size="16" />
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
.mail-message-list__header { display: grid; min-height: 68px; padding: 10px 12px; align-items: center; grid-template-columns: minmax(0, 1fr) auto auto; gap: 9px; border-bottom: 1px solid var(--border-light); }
.mail-message-list__header > button { display: grid; width: 44px; height: 44px; place-items: center; color: var(--text-secondary); background: transparent; border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.mail-message-list__header > button:disabled { opacity: .5; cursor: wait; }
.mail-message-list__header > .mail-message-list__compose { display: inline-flex; width: auto; min-width: 102px; padding: 0 11px; align-items: center; justify-content: center; gap: 6px; color: var(--accent-contrast, #fff); font: inherit; font-size: .63rem; font-weight: 720; background: var(--accent-color); border-color: transparent; }
.mail-message-list__header h2 { margin: 0; overflow: hidden; font-size: .88rem; white-space: nowrap; text-overflow: ellipsis; }
.mail-message-list__header p { margin: 3px 0 0; overflow: hidden; color: var(--text-muted); font-size: .61rem; white-space: nowrap; text-overflow: ellipsis; }
.mail-message-list__folders { display: none !important; }
.mail-message-list__search { display: flex; min-height: 44px; margin: 10px 12px 8px; padding: 0 11px; align-items: center; gap: 8px; color: var(--text-muted); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; }
.mail-message-list__search:focus-within { border-color: color-mix(in srgb, var(--accent-color) 46%, var(--border-light)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 11%, transparent); }
.mail-message-list__search input { min-width: 0; flex: 1; color: var(--text-primary); font: inherit; font-size: .72rem; background: transparent; border: 0; outline: 0; }
.mail-message-list__search input::placeholder { color: var(--text-muted); }
.mail-message-list__filters { display: grid; margin: 0 12px 9px; padding: 3px; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; }
.mail-message-list__filters button { min-width: 44px; min-height: 38px; padding: 0 5px; color: var(--text-muted); font: inherit; font-size: .62rem; font-weight: 700; background: transparent; border: 0; border-radius: 9px; cursor: pointer; }
.mail-message-list__filters button.is-active { color: var(--text-primary); background: var(--bg-card); box-shadow: 0 2px 8px color-mix(in srgb, #000 8%, transparent); }
.mail-message-list > ul { min-height: 0; margin: 0; padding: 0 8px 8px; flex: 1; overflow-y: auto; list-style: none; }
.mail-message-row { position: relative; min-width: 0; }
.mail-message-row__open { display: grid; width: 100%; min-height: 132px; padding: 13px 42px 13px 10px; align-items: start; grid-template-columns: 36px minmax(0, 1fr); gap: 10px; text-align: left; color: var(--text-primary); font: inherit; background: transparent; border: 1px solid transparent; border-radius: 15px; cursor: pointer; }
.mail-message-row__open:hover,
.mail-message-row__open:focus-visible { background: var(--bg-hover); outline: 2px solid color-mix(in srgb, var(--accent-color) 42%, transparent); outline-offset: -2px; }
.mail-message-row__open.is-active { background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent-color) 25%, var(--border-light)); }
.mail-message-row__avatar { display: grid; width: 36px; height: 36px; place-items: center; color: var(--text-primary); font-size: .68rem; font-weight: 780; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 11px; }
.mail-message-row__avatar[data-tone="1"] { color: #35628a; background: color-mix(in srgb, #6ea6d7 16%, var(--bg-card)); }
.mail-message-row__avatar[data-tone="2"] { color: #4c765a; background: color-mix(in srgb, #75ad86 16%, var(--bg-card)); }
.mail-message-row__avatar[data-tone="3"] { color: #87633f; background: color-mix(in srgb, #c99b6b 16%, var(--bg-card)); }
.mail-message-row__avatar[data-tone="4"] { color: #765081; background: color-mix(in srgb, #a97ab5 16%, var(--bg-card)); }
.mail-message-row__avatar[data-tone="5"] { color: #8a4d5f; background: color-mix(in srgb, #c97991 16%, var(--bg-card)); }
.mail-message-row__content { display: grid; min-width: 0; gap: 5px; }
.mail-message-list__sender { display: grid; min-width: 0; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 7px; color: var(--text-muted); font-size: .62rem; }
.mail-message-list__sender strong { overflow: hidden; color: var(--text-secondary); white-space: nowrap; text-overflow: ellipsis; }
.mail-message-row__open.is-unread .mail-message-list__sender strong,
.mail-message-row__open.is-unread .mail-message-list__subject { color: var(--text-primary); font-weight: 790; }
.mail-message-list__unread { width: 7px; height: 7px; background: var(--accent-color); border-radius: 50%; }
.mail-message-list__subject { display: grid; min-width: 0; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 5px; color: var(--text-secondary); font-size: .74rem; font-weight: 700; }
.mail-message-list__subject > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.mail-message-list__subject > :deep(.app-icon) { color: var(--warning-color); }
.mail-message-list__subject b { min-width: 20px; padding: 1px 5px; color: var(--text-muted); text-align: center; font-size: .57rem; background: var(--bg-secondary); border-radius: 999px; }
.mail-message-list__preview { display: -webkit-box; overflow: hidden; color: var(--text-muted); font-size: .65rem; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.mail-message-list__meta { display: flex; min-width: 0; flex-wrap: wrap; gap: 4px; }
.mail-message-list__meta > span { display: inline-flex; min-height: 22px; padding: 2px 7px; align-items: center; gap: 4px; color: var(--text-muted); font-size: .57rem; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 999px; }
.mail-message-list__meta > span.is-category { color: var(--accent-color); background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent-color) 18%, var(--border-light)); }
.mail-message-list__meta > span.is-silent { color: var(--text-muted); }
.mail-message-row__rule { position: absolute; top: 7px; right: 5px; display: grid; width: 44px; height: 44px; place-items: center; color: var(--text-muted); background: transparent; border: 1px solid transparent; border-radius: 11px; cursor: pointer; }
.mail-message-row__rule:hover,
.mail-message-row__rule:focus-visible { color: var(--accent-color); background: var(--bg-card); border-color: var(--border-light); outline: 2px solid color-mix(in srgb, var(--accent-color) 35%, transparent); }
.mail-message-list__empty { margin: 0; padding: 28px 18px; color: var(--text-muted); text-align: center; font-size: .7rem; line-height: 1.65; }
.mail-message-list__empty button { min-height: 44px; color: var(--accent-color); font: inherit; background: transparent; border: 0; cursor: pointer; }
.mail-message-list__more { padding: 8px 12px 12px; border-top: 1px solid var(--border-light); }
.mail-message-list__more button { width: 100%; min-height: 44px; color: var(--accent-color); font: inherit; font-size: .7rem; font-weight: 700; background: var(--accent-bg); border: 1px solid color-mix(in srgb, var(--accent-color) 22%, var(--border-light)); border-radius: 12px; cursor: pointer; }
.mail-message-list__more button:disabled { opacity: .55; cursor: wait; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .mail-message-list { border-right: 0; }
  .mail-message-list__header { grid-template-columns: auto minmax(0, 1fr) auto auto; }
  .mail-message-list__folders { display: grid !important; }
  .mail-message-list > ul { overflow: visible; }
  .mail-message-row__open { min-height: 126px; }
}
@media (max-width: 440px) {
  .mail-message-list__header > .mail-message-list__compose { width: 44px; min-width: 44px; padding: 0; }
  .mail-message-list__compose span { display: none; }
}
</style>
