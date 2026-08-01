import { apiRequest as request } from '@/shared/services/apiClient'

export async function fetchBackendNoteReminders(limit = 50) {
  const payload = await request(
    `/note-reminders?limit=${encodeURIComponent(limit)}`,
    {
      method: 'GET',
      cache: 'no-store'
    }
  )

  return {
    reminders: Array.isArray(payload.reminders) ? payload.reminders : [],
    unreadCount: Number(payload.unreadCount || 0),
    serverNow: payload.serverNow || null
  }
}

export async function markBackendNoteReminderRead(reminderId) {
  return request(`/note-reminders/${encodeURIComponent(reminderId)}/read`, {
    method: 'POST',
    body: JSON.stringify({})
  })
}

export async function markAllBackendNoteRemindersRead() {
  return request('/note-reminders/read-all', {
    method: 'POST',
    body: JSON.stringify({})
  })
}
