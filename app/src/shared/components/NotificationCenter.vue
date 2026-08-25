<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import {
  deleteNotification,
  fetchNotifications,
  fetchNotificationUnreadCount,
  markAllNotificationsRead,
  markNotificationRead
} from '@/shared/services/notificationsApi'

const router = useRouter()
const open = ref(false)
const loading = ref(false)
const notifications = ref([])
const unreadCount = ref(0)
const errorMessage = ref('')
const trigger = ref(null)
const panel = ref(null)
let pollTimer = null

function formatDate(value) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

async function refreshList() {
  loading.value = true
  errorMessage.value = ''
  try {
    const payload = await fetchNotifications({ limit: 50 })
    notifications.value = payload.notifications || []
    unreadCount.value = Number(payload.unreadCount || 0)
  } catch (error) {
    errorMessage.value = error.message || '通知加载失败'
  } finally {
    loading.value = false
  }
}

async function toggle() {
  open.value = !open.value
  if (!open.value) return
  await refreshList()
  await nextTick()
  panel.value?.focus()
}

function close({ restoreFocus = true } = {}) {
  open.value = false
  if (restoreFocus) nextTick(() => trigger.value?.focus())
}

async function openNotification(item) {
  if (!item.readAt) {
    await markNotificationRead(item.id)
    item.readAt = new Date().toISOString()
    unreadCount.value = Math.max(0, unreadCount.value - 1)
  }
  if (item.actionUrl) {
    close({ restoreFocus: false })
    await router.push(item.actionUrl)
  }
}

async function markAll() {
  await markAllNotificationsRead()
  notifications.value = notifications.value.map((item) => ({
    ...item,
    readAt: item.readAt || new Date().toISOString()
  }))
  unreadCount.value = 0
}

async function remove(item) {
  await deleteNotification(item.id)
  notifications.value = notifications.value.filter((candidate) => candidate.id !== item.id)
  if (!item.readAt) unreadCount.value = Math.max(0, unreadCount.value - 1)
}

function handleKeydown(event) {
  if (event.key === 'Escape' && open.value) close()
}

function handleDocumentClick(event) {
  if (!open.value) return
  if (panel.value?.contains(event.target) || trigger.value?.contains(event.target)) return
  close({ restoreFocus: false })
}

async function pollCount() {
  if (document.visibilityState !== 'visible') return
  try { unreadCount.value = await fetchNotificationUnreadCount() } catch {}
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('pointerdown', handleDocumentClick, true)
  void pollCount()
  pollTimer = window.setInterval(pollCount, 60_000)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('pointerdown', handleDocumentClick, true)
  if (pollTimer) window.clearInterval(pollTimer)
})
</script>

<template>
  <div class="notification-center">
    <button
      ref="trigger"
      class="notification-center__trigger"
      type="button"
      aria-label="打开通知中心"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="toggle"
    >
      <Icon name="bell" :size="18" />
      <span v-if="unreadCount" class="notification-center__badge" aria-hidden="true">
        {{ unreadCount > 99 ? '99+' : unreadCount }}
      </span>
    </button>

    <section
      v-if="open"
      ref="panel"
      class="notification-center__panel"
      role="dialog"
      aria-modal="false"
      aria-label="通知中心"
      tabindex="-1"
    >
      <header>
        <div>
          <strong>通知中心</strong>
          <span>{{ unreadCount ? `${unreadCount} 条未读` : '全部已读' }}</span>
        </div>
        <div class="notification-center__header-actions">
          <button v-if="unreadCount" type="button" @click="markAll">全部已读</button>
          <button type="button" aria-label="关闭通知中心" @click="close()">
            <Icon name="close" :size="18" />
          </button>
        </div>
      </header>

      <p v-if="errorMessage" class="notification-center__message is-error" role="alert">{{ errorMessage }}</p>
      <p v-else-if="loading" class="notification-center__message" role="status">正在读取通知…</p>
      <p v-else-if="!notifications.length" class="notification-center__empty">暂时没有通知。重要邮件、注册申请和到期提醒会出现在这里。</p>
      <div v-else class="notification-center__list">
        <article
          v-for="item in notifications"
          :key="item.id"
          :class="['notification-card', { 'is-unread': !item.readAt }]"
        >
          <button class="notification-card__body" type="button" @click="openNotification(item)">
            <span class="notification-card__title">{{ item.title }}</span>
            <span class="notification-card__summary">{{ item.summary }}</span>
            <template v-if="item.detail?.emails">
              <span v-for="email in item.detail.emails" :key="email.id" class="notification-card__email">
                <b>{{ email.subject }}</b> · {{ email.reason }}
              </span>
            </template>
            <template v-else-if="item.detail">
              <span class="notification-card__email"><b>{{ item.detail.subject }}</b></span>
              <span class="notification-card__email">原因：{{ item.detail.reason }}</span>
              <span class="notification-card__email">建议：{{ item.detail.suggestedAction }}</span>
              <span class="notification-card__email">发件人：{{ item.detail.senderName || item.detail.senderAddress }}</span>
              <span class="notification-card__email">紧急程度：{{ item.detail.urgency }}</span>
            </template>
            <time>{{ formatDate(item.createdAt) }}</time>
          </button>
          <button class="notification-card__delete" type="button" aria-label="删除通知" @click="remove(item)">
            <Icon name="trash" :size="16" />
          </button>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.notification-center { position: relative; }
.notification-center__trigger { position: relative; }
.notification-center__badge {
  position: absolute;
  top: 4px;
  right: 3px;
  display: grid;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  place-items: center;
  color: #fff;
  background: var(--error-color, #c95f5f);
  border: 2px solid var(--bg-primary);
  border-radius: 999px;
  font-size: 0.58rem;
  font-weight: 800;
}
.notification-center__panel {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  z-index: 720;
  width: min(440px, calc(100vw - 24px));
  max-height: min(680px, calc(100vh - 90px));
  overflow: hidden;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 20px;
  box-shadow: var(--shadow-lg);
}
.notification-center__panel > header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  min-height: 68px;
  padding: 13px 14px 13px 18px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: color-mix(in srgb, var(--bg-card) 94%, transparent);
  border-bottom: 1px solid var(--border-light);
  backdrop-filter: blur(16px);
}
.notification-center__panel header div:first-child { display: grid; gap: 3px; }
.notification-center__panel header span { color: var(--text-muted); font-size: 0.72rem; }
.notification-center__header-actions { display: flex; align-items: center; gap: 4px; }
.notification-center__header-actions button,
.notification-card__delete {
  min-width: 40px;
  min-height: 40px;
  padding: 0 9px;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: 11px;
  cursor: pointer;
}
.notification-center__header-actions button:hover,
.notification-center__header-actions button:focus-visible,
.notification-card__delete:hover,
.notification-card__delete:focus-visible { color: var(--text-primary); background: var(--bg-hover); }
.notification-center__list { max-height: min(610px, calc(100vh - 158px)); overflow-y: auto; padding: 8px; }
.notification-card { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 40px; border-radius: 15px; }
.notification-card.is-unread { background: var(--accent-bg); }
.notification-card__body {
  display: grid;
  min-width: 0;
  padding: 13px 10px 13px 13px;
  gap: 5px;
  text-align: left;
  color: inherit;
  background: transparent;
  border: 0;
  cursor: pointer;
}
.notification-card__title { font-weight: 740; }
.notification-card__summary,
.notification-card__email { color: var(--text-secondary); font-size: 0.76rem; line-height: 1.55; }
.notification-card__email { display: block; }
.notification-card time { color: var(--text-muted); font-size: 0.68rem; }
.notification-card__delete { align-self: center; }
.notification-center__message,
.notification-center__empty { margin: 0; padding: 28px 20px; color: var(--text-muted); line-height: 1.7; text-align: center; }
.notification-center__message.is-error { color: var(--error-color); }
@media (max-width: 640px), (pointer: coarse) {
  .notification-center__panel { position: fixed; top: 66px; right: 10px; left: 10px; width: auto; max-height: calc(100dvh - 150px); }
  .notification-center__list { max-height: calc(100dvh - 220px); }
  .notification-center__header-actions button,
  .notification-card__delete { min-width: 44px; min-height: 44px; }
}
</style>
