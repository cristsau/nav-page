import { apiRequest as request } from '@/shared/services/apiClient'

export function fetchEmailStatus() {
  return request('/email/status', { method: 'GET', cache: 'no-store' })
}

export async function fetchEmailEvents({ tier = 0, limit = 40 } = {}) {
  const query = new URLSearchParams({ tier: String(tier || 0), limit: String(limit) })
  const payload = await request(`/email/events?${query.toString()}`, {
    method: 'GET',
    cache: 'no-store'
  })
  return payload.emails || []
}

export async function fetchEmailEvent(emailEventId) {
  const payload = await request(`/email/events/${encodeURIComponent(emailEventId)}`, {
    method: 'GET',
    cache: 'no-store'
  })
  return payload.email
}

export function fetchAdminMailStatus() {
  return request('/admin/mail/status', { method: 'GET', cache: 'no-store' })
}

export function queueAdminMailTest(recipient) {
  return request('/admin/mail/test', {
    method: 'POST',
    body: JSON.stringify({ recipient })
  })
}
