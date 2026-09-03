import { computed, onBeforeUnmount, onMounted, ref, unref } from 'vue'
import { shouldUseBackendNotes } from '@/shared/services/notesApi'
import {
  fetchBackendNoteReminders,
  markAllBackendNoteRemindersRead,
  markBackendNoteReminderRead
} from '@/shared/services/noteRemindersApi'

export const NOTE_REMINDER_FOREGROUND_REFRESH_MS = 60_000
export const LOCAL_REMINDER_READ_STORAGE_KEY = 'domonav.note-reminders.read.v1'
export const NOTE_REMINDER_DELIVERED_STORAGE_KEY = 'domonav.note-reminders.delivered.v1'
const MAX_LOCAL_REMINDER_READ_IDS = 500
const MAX_DELIVERED_REMINDER_IDS = 500

function getLocalReminderStorage() {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

export function loadLocalReminderReadIds(storage = getLocalReminderStorage()) {
  if (!storage) return new Set()
  try {
    const parsed = JSON.parse(storage.getItem(LOCAL_REMINDER_READ_STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed
      .filter((value) => typeof value === 'string' && value.startsWith('local:'))
      .slice(-MAX_LOCAL_REMINDER_READ_IDS))
  } catch {
    return new Set()
  }
}

export function saveLocalReminderReadIds(readIds, storage = getLocalReminderStorage()) {
  if (!storage) return
  try {
    const values = [...readIds]
      .filter((value) => typeof value === 'string' && value.startsWith('local:'))
      .slice(-MAX_LOCAL_REMINDER_READ_IDS)
    storage.setItem(LOCAL_REMINDER_READ_STORAGE_KEY, JSON.stringify(values))
  } catch {
    // Reminders still work in memory when storage is unavailable or full.
  }
}

function loadDeliveredReminderIds(storage = getLocalReminderStorage()) {
  if (!storage) return new Set()
  try {
    const parsed = JSON.parse(storage.getItem(NOTE_REMINDER_DELIVERED_STORAGE_KEY) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.map(String).slice(-MAX_DELIVERED_REMINDER_IDS) : [])
  } catch {
    return new Set()
  }
}

function saveDeliveredReminderIds(ids, storage = getLocalReminderStorage()) {
  if (!storage) return
  try {
    storage.setItem(
      NOTE_REMINDER_DELIVERED_STORAGE_KEY,
      JSON.stringify([...ids].slice(-MAX_DELIVERED_REMINDER_IDS))
    )
  } catch {
    // Delivery deduplication remains in memory when storage is unavailable.
  }
}

function asTimestamp(value) {
  const timestamp = new Date(value || '').getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

export function createLocalNoteReminders(notes, {
  now = Date.now(),
  readIds = new Set()
} = {}) {
  return (Array.isArray(notes) ? notes : [])
    .filter((note) => {
      const dueAt = asTimestamp(note?.dueAt)
      const remindBeforeMs = Math.max(0, Number(note?.remindBeforeMinutes || 0)) * 60_000
      return (
        note?.type === 'memo'
        && !note.completed
        && dueAt !== null
        && dueAt - remindBeforeMs <= now
      )
    })
    .map((note) => {
      const remindBeforeMinutes = Math.max(0, Number(note.remindBeforeMinutes || 0))
      const reminderAt = new Date(asTimestamp(note.dueAt) - remindBeforeMinutes * 60_000).toISOString()
      const id = `local:${note.id}:${note.dueAt}:${remindBeforeMinutes}`
      return {
        id,
        noteId: note.id,
        numberId: note.numberId || null,
        title: note.encrypted ? '加密备忘录' : String(note.title || '未命名备忘录'),
        encrypted: Boolean(note.encrypted),
        dueAt: note.dueAt,
        reminderAt,
        remindBeforeMinutes,
        triggeredAt: reminderAt,
        readAt: readIds.has(id) ? new Date(now).toISOString() : null
      }
    })
    .sort((left, right) => {
      const unreadOrder = Number(Boolean(left.readAt)) - Number(Boolean(right.readAt))
      if (unreadOrder !== 0) return unreadOrder
      return asTimestamp(right.dueAt) - asTimestamp(left.dueAt)
    })
}

export function useNoteReminders({
  notes,
  onError = () => {}
} = {}) {
  const reminders = ref([])
  const unreadCount = ref(0)
  const serverNow = ref(null)
  const loading = ref(false)
  const error = ref('')
  const notificationError = ref('')
  const notificationPermission = ref(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  )
  const localReadIds = loadLocalReminderReadIds()
  const deliveredReminderIds = loadDeliveredReminderIds()
  const pendingNotificationIds = new Set()
  let requestSequence = 0
  let foregroundRefreshTimer = null

  const localOnly = computed(() => !shouldUseBackendNotes())

  async function showReminderNotification(reminder) {
    const title = reminder.encrypted
      ? '加密备忘录提醒'
      : String(reminder.title || '备忘录提醒')
    const options = {
      body: reminder.encrypted
        ? '一条加密备忘录已到提醒时间。'
        : `截止时间：${new Date(reminder.dueAt).toLocaleString('zh-CN')}`,
      icon: '/icons/cristsau-mark-192-v2.png',
      tag: `domonav-note-${reminder.id}`,
      renotify: false,
      data: { url: '/whisper?reminders=1' }
    }

    if (typeof navigator !== 'undefined' && navigator.serviceWorker?.getRegistration) {
      const registration = await navigator.serviceWorker.getRegistration()
      if (registration?.showNotification) {
        await registration.showNotification(title, options)
        return
      }
    }

    const notification = new Notification(title, options)
    notification.onclick = () => {
      window.focus()
      window.dispatchEvent(new CustomEvent('domonav:open-reminders'))
      notification.close()
    }
  }

  function deliverBrowserNotifications(nextReminders) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    for (const reminder of nextReminders) {
      const reminderId = String(reminder.id)
      if (
        reminder.readAt
        || deliveredReminderIds.has(reminderId)
        || pendingNotificationIds.has(reminderId)
      ) continue

      pendingNotificationIds.add(reminderId)
      void showReminderNotification(reminder)
        .then(() => {
          notificationError.value = ''
          deliveredReminderIds.add(reminderId)
          saveDeliveredReminderIds(deliveredReminderIds)
        })
        .catch((deliveryError) => {
          notificationError.value = '系统通知投递失败；NAV 内提醒仍然可用。'
          onError(deliveryError)
        })
        .finally(() => pendingNotificationIds.delete(reminderId))
    }
  }

  async function requestNotificationPermission() {
    notificationError.value = ''
    if (typeof Notification === 'undefined') {
      notificationPermission.value = 'unsupported'
      return notificationPermission.value
    }
    try {
      notificationPermission.value = await Notification.requestPermission()
    } catch (permissionError) {
      notificationPermission.value = Notification.permission || 'default'
      notificationError.value = '无法请求系统通知权限；NAV 内提醒仍然可用。'
      onError(permissionError)
      return notificationPermission.value
    }
    if (notificationPermission.value === 'granted') {
      deliverBrowserNotifications(reminders.value)
    }
    return notificationPermission.value
  }

  function applyLocalReminders() {
    const nextReminders = createLocalNoteReminders(unref(notes), {
      readIds: localReadIds
    })
    reminders.value = nextReminders
    unreadCount.value = nextReminders.filter((item) => !item.readAt).length
    serverNow.value = new Date().toISOString()
    deliverBrowserNotifications(nextReminders)
  }

  async function refresh() {
    const sequence = ++requestSequence
    loading.value = true
    error.value = ''

    try {
      if (localOnly.value) {
        applyLocalReminders()
        return
      }

      const payload = await fetchBackendNoteReminders()
      if (sequence !== requestSequence) return

      reminders.value = payload.reminders
      unreadCount.value = payload.unreadCount
      serverNow.value = payload.serverNow
      deliverBrowserNotifications(payload.reminders)
    } catch (refreshError) {
      if (sequence !== requestSequence) return
      error.value = refreshError.message || '到期提醒加载失败'
      onError(refreshError)
    } finally {
      if (sequence === requestSequence) loading.value = false
    }
  }

  async function markRead(reminder) {
    if (!reminder || reminder.readAt) return

    if (localOnly.value) {
      localReadIds.add(reminder.id)
      saveLocalReminderReadIds(localReadIds)
      applyLocalReminders()
      return
    }

    await markBackendNoteReminderRead(reminder.id)
    await refresh()
  }

  async function markAllRead() {
    if (localOnly.value) {
      for (const reminder of reminders.value) {
        localReadIds.add(reminder.id)
      }
      saveLocalReminderReadIds(localReadIds)
      applyLocalReminders()
      return
    }

    await markAllBackendNoteRemindersRead()
    await refresh()
  }

  function handleWindowFocus() {
    void refresh()
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      void refresh()
    }
  }

  function refreshInBackground() {
    if (!loading.value) {
      void refresh()
    }
  }

  onMounted(() => {
    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    foregroundRefreshTimer = window.setInterval(
      refreshInBackground,
      NOTE_REMINDER_FOREGROUND_REFRESH_MS
    )
  })

  onBeforeUnmount(() => {
    requestSequence += 1
    if (foregroundRefreshTimer !== null) {
      window.clearInterval(foregroundRefreshTimer)
      foregroundRefreshTimer = null
    }
    window.removeEventListener('focus', handleWindowFocus)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  })

  return {
    reminders,
    unreadCount,
    serverNow,
    loading,
    error,
    notificationError,
    localOnly,
    notificationPermission,
    requestNotificationPermission,
    refresh,
    markRead,
    markAllRead
  }
}
