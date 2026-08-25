import { apiRequest as request } from '@/shared/services/apiClient'

export async function fetchNotifications({ unreadOnly = false, limit = 40 } = {}) {
  const query = new URLSearchParams({ unreadOnly: String(unreadOnly), limit: String(limit) })
  return request(`/notifications?${query.toString()}`, { method: 'GET', cache: 'no-store' })
}

export async function fetchNotificationUnreadCount() {
  const payload = await request('/notifications/unread-count', { method: 'GET', cache: 'no-store' })
  return Number(payload.unreadCount || 0)
}

export function markNotificationRead(notificationId) {
  return request(`/notifications/${encodeURIComponent(notificationId)}/read`, {
    method: 'PATCH',
    body: JSON.stringify({})
  })
}

export function markAllNotificationsRead() {
  return request('/notifications/read-all', { method: 'POST', body: JSON.stringify({}) })
}

export function deleteNotification(notificationId) {
  return request(`/notifications/${encodeURIComponent(notificationId)}`, { method: 'DELETE' })
}
