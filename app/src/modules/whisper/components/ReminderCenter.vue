<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  reminders: {
    type: Array,
    default: () => []
  },
  unreadCount: {
    type: Number,
    default: 0
  },
  loading: {
    type: Boolean,
    default: false
  },
  error: {
    type: String,
    default: ''
  },
  localOnly: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'refresh', 'read', 'read-all', 'view', 'complete'])
const panelRef = ref(null)
const closeButtonRef = ref(null)
let previousBodyOverflow = ''
let previouslyFocusedElement = null

function formatDueAt(value) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return '截止时间未知'

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function isOverdue(reminder) {
  const dueAt = new Date(reminder?.dueAt || '').getTime()
  return Number.isFinite(dueAt) && dueAt <= Date.now()
}

function requestClose() {
  emit('close')
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }

  if (event.key !== 'Tab') return

  const focusable = [...(panelRef.value?.querySelectorAll(
    'button:not([disabled]), [href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
  ) || [])]
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

watch(() => props.show, async (show) => {
  if (show) {
    previouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    await nextTick()
    closeButtonRef.value?.focus()
    return
  }

  document.body.style.overflow = previousBodyOverflow
  await nextTick()
  if (previouslyFocusedElement?.isConnected) {
    previouslyFocusedElement.focus()
  }
  previouslyFocusedElement = null
})

onBeforeUnmount(() => {
  if (props.show) {
    document.body.style.overflow = previousBodyOverflow
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="reminder-center">
      <div
        v-if="show"
        class="reminder-center"
        role="presentation"
        @pointerdown.self="requestClose"
      >
        <section
          ref="panelRef"
          class="reminder-center__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reminder-center-title"
          aria-describedby="reminder-center-description"
          @keydown="handleKeydown"
        >
          <header class="reminder-center__header">
            <div>
              <p class="reminder-center__eyebrow">到期提醒</p>
              <h2 id="reminder-center-title">需要处理的备忘录</h2>
              <p id="reminder-center-description">
                {{ unreadCount ? `${unreadCount} 条未读提醒` : '当前没有未读提醒' }}
              </p>
            </div>
            <button
              ref="closeButtonRef"
              class="reminder-center__icon-button"
              type="button"
              aria-label="关闭到期提醒"
              @click="requestClose"
            >
              <Icon name="close" :size="19" />
            </button>
          </header>

          <div class="reminder-center__toolbar">
            <button type="button" :disabled="loading" @click="emit('refresh')">
              <Icon name="refresh" :size="16" />
              刷新
            </button>
            <button type="button" :disabled="unreadCount === 0" @click="emit('read-all')">
              <Icon name="circle-check" :size="16" />
              全部已读
            </button>
          </div>

          <p v-if="localOnly" class="reminder-center__notice" role="note">
            本地模式仅在此页面打开时计算到期提醒；关闭页面后不会发送系统通知。
          </p>
          <p v-else class="reminder-center__notice" role="note">
            提醒会在打开 NAV 时同步；当前版本不会请求浏览器系统通知。
          </p>

          <div class="reminder-center__content" aria-live="polite">
            <div v-if="loading && reminders.length === 0" class="reminder-center__state">
              <span class="reminder-center__spinner" aria-hidden="true"></span>
              <span>正在同步提醒</span>
            </div>

            <div v-else-if="error" class="reminder-center__state is-error" role="alert">
              <Icon name="alert" :size="22" />
              <span>{{ error }}</span>
              <button type="button" @click="emit('refresh')">重新加载</button>
            </div>

            <div v-else-if="reminders.length === 0" class="reminder-center__state">
              <Icon name="circle-check" :size="28" />
              <strong>暂无到期提醒</strong>
              <span>为备忘录设置截止时间后，到期项目会显示在这里。</span>
            </div>

            <ul v-else class="reminder-center__list" aria-label="到期提醒列表">
              <li
                v-for="reminder in reminders"
                :key="reminder.id"
                class="reminder-card"
                :class="{ 'is-read': reminder.readAt }"
              >
                <div class="reminder-card__icon" aria-hidden="true">
                  <Icon :name="reminder.encrypted ? 'lock' : 'clock'" :size="19" />
                </div>
                <div class="reminder-card__body">
                  <div class="reminder-card__heading">
                    <strong>{{ reminder.title }}</strong>
                    <span v-if="!reminder.readAt" class="reminder-card__unread">未读</span>
                  </div>
                  <span v-if="reminder.numberId" class="reminder-card__id">#{{ reminder.numberId }}</span>
                  <time :datetime="reminder.dueAt" :class="{ 'is-overdue': isOverdue(reminder) }">
                    {{ isOverdue(reminder) ? '已到期' : '即将到期' }} · {{ formatDueAt(reminder.dueAt) }}
                  </time>
                  <div class="reminder-card__actions">
                    <button type="button" @click="emit('view', reminder)">查看</button>
                    <button type="button" @click="emit('complete', reminder)">
                      <Icon name="check" :size="15" />
                      完成
                    </button>
                    <button
                      v-if="!reminder.readAt"
                      type="button"
                      @click="emit('read', reminder)"
                    >
                      标为已读
                    </button>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.reminder-center {
  position: fixed;
  inset: 0;
  z-index: 1450;
  display: grid;
  place-items: center;
  padding: 20px;
  background: color-mix(in srgb, #17110d 58%, transparent);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}

.reminder-center__panel {
  width: min(620px, 100%);
  max-height: min(760px, calc(100dvh - 40px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  box-shadow: var(--shadow-lg);
}

.reminder-center__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 24px;
  border-bottom: 1px solid var(--border-light);
}

.reminder-center__eyebrow {
  margin: 0 0 6px;
  color: var(--accent-color);
  font-size: 11px;
  font-weight: 720;
  letter-spacing: 0.14em;
}

.reminder-center__header h2 {
  margin: 0;
  font-size: clamp(20px, 4vw, 26px);
  letter-spacing: -0.025em;
}

.reminder-center__header p:last-child {
  margin: 7px 0 0;
  color: var(--text-muted);
  font-size: 13px;
}

.reminder-center__icon-button {
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 14px;
  cursor: pointer;
}

.reminder-center__toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 0;
}

.reminder-center__toolbar button,
.reminder-card__actions button,
.reminder-center__state button {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 11px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.reminder-center__toolbar button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.reminder-center__notice {
  margin: 12px 20px 0;
  padding: 10px 12px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.55;
  background: var(--bg-secondary);
  border-radius: 12px;
}

.reminder-center__content {
  min-height: 220px;
  padding: 16px 20px 22px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.reminder-center__state {
  min-height: 220px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 9px;
  color: var(--text-muted);
  text-align: center;
}

.reminder-center__state.is-error {
  color: var(--error-color);
}

.reminder-center__spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: reminder-spin 0.8s linear infinite;
}

.reminder-center__list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.reminder-card {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 12px;
  padding: 14px;
  background: color-mix(in srgb, var(--accent-bg) 50%, var(--bg-card));
  border: 1px solid color-mix(in srgb, var(--accent-color) 20%, var(--border-light));
  border-radius: 16px;
}

.reminder-card.is-read {
  background: var(--bg-secondary);
  border-color: var(--border-light);
  opacity: 0.75;
}

.reminder-card__icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  color: var(--accent-color);
  background: var(--bg-card);
  border-radius: 13px;
}

.reminder-card__body {
  min-width: 0;
  display: grid;
  gap: 6px;
}

.reminder-card__heading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.reminder-card__heading strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reminder-card__unread {
  padding: 3px 7px;
  color: var(--accent-color);
  font-size: 10px;
  font-weight: 700;
  background: var(--bg-card);
  border-radius: 999px;
}

.reminder-card__id,
.reminder-card time {
  color: var(--text-muted);
  font-size: 12px;
}

.reminder-card time.is-overdue {
  color: var(--error-color);
}

.reminder-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 4px;
}

.reminder-card__actions button:hover,
.reminder-card__actions button:focus-visible,
.reminder-center__toolbar button:hover:not(:disabled),
.reminder-center__toolbar button:focus-visible:not(:disabled),
.reminder-center__icon-button:hover,
.reminder-center__icon-button:focus-visible {
  color: var(--text-primary);
  border-color: var(--accent-color);
  outline: none;
}

.reminder-center-enter-active,
.reminder-center-leave-active {
  transition: opacity 0.18s ease;
}

.reminder-center-enter-active .reminder-center__panel,
.reminder-center-leave-active .reminder-center__panel {
  transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.reminder-center-enter-from,
.reminder-center-leave-to,
.reminder-center-enter-from .reminder-center__panel,
.reminder-center-leave-to .reminder-center__panel {
  opacity: 0;
}

.reminder-center-enter-from .reminder-center__panel,
.reminder-center-leave-to .reminder-center__panel {
  transform: translateY(10px) scale(0.985);
}

@keyframes reminder-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 640px) {
  .reminder-center {
    place-items: end center;
    padding: 12px 10px max(10px, env(safe-area-inset-bottom));
  }

  .reminder-center__panel {
    max-height: 85dvh;
    border-radius: 24px 24px 18px 18px;
  }

  .reminder-center__header {
    padding: 20px 18px 16px;
  }

  .reminder-center__toolbar {
    padding-inline: 16px;
  }

  .reminder-center__notice {
    margin-inline: 16px;
  }

  .reminder-center__content {
    padding: 14px 16px max(18px, env(safe-area-inset-bottom));
  }

  .reminder-center__toolbar button,
  .reminder-card__actions button,
  .reminder-center__state button {
    min-height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .reminder-center-enter-active,
  .reminder-center-leave-active,
  .reminder-center-enter-active .reminder-center__panel,
  .reminder-center-leave-active .reminder-center__panel {
    transition-duration: 0.01ms !important;
  }

  .reminder-center__spinner {
    animation-duration: 1.8s;
  }
}
</style>
