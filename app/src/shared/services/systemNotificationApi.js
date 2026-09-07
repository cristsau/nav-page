import { apiRequest } from './apiClient'

export function fetchAdminMailStatus() {
  return apiRequest('/admin/mail/status', { method: 'GET', cache: 'no-store' })
}

export function queueAdminMailTest(recipient) {
  return apiRequest('/admin/mail/test', { method: 'POST', body: JSON.stringify({ recipient }) })
}
