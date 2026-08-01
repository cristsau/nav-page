import { computed, onBeforeUnmount, onMounted, ref, unref } from 'vue'
import { shouldUseBackendNotes } from '@/shared/services/notesApi'
import {
  fetchBackendNoteReminders,
  markAllBackendNoteRemindersRead,
  markBackendNoteReminderRead
} from '@/shared/services/noteRemindersApi'

export const NOTE_REMINDER_FOREGROUND_REFRESH_MS = 60_000
export const LOCAL_REMINDER_READ_STORAGE_KEY = 'domonav.note-reminders.read.v1'
const MAX_LOCAL_REMINDER_READ_IDS = 500

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
      return (
        note?.type === 'memo'
        && !note.completed
        && dueAt !== null
        && dueAt <= now
      )
    })
    .map((note) => {
      const id = `local:${note.id}:${note.dueAt}`
      return {
        id,
        noteId: note.id,
        numberId: note.numberId || null,
        title: note.encrypted ? '加密备忘录' : String(note.title || '未命名备忘录'),
        encrypted: Boolean(note.encrypted),
        dueAt: note.dueAt,
        triggeredAt: note.dueAt,
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
  const localReadIds = loadLocalReminderReadIds()
  let requestSequence = 0
  let foregroundRefreshTimer = null

  const localOnly = computed(() => !shouldUseBackendNotes())

  function applyLocalReminders() {
    const nextReminders = createLocalNoteReminders(unref(notes), {
      readIds: localReadIds
    })
    reminders.value = nextReminders
    unreadCount.value = nextReminders.filter((item) => !item.readAt).length
    serverNow.value = new Date().toISOString()
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

  function refreshWhileVisible() {
    if (document.visibilityState === 'visible' && !loading.value) {
      void refresh()
    }
  }

  onMounted(() => {
    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    foregroundRefreshTimer = window.setInterval(
      refreshWhileVisible,
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
    localOnly,
    refresh,
    markRead,
    markAllRead
  }
}
