import { isBackendAuthEnabled } from '@/shared/services/authApi'
import { apiRequest as request } from '@/shared/services/apiClient'

export function shouldUseBackendTelegramAdmin() {
  return isBackendAuthEnabled()
}

export async function fetchBackendTelegramConfig() {
  const payload = await request('/admin/telegram-config', { method: 'GET' })
  return payload.config || { enabled: false, botToken: '', adminChatId: '' }
}

export async function saveBackendTelegramConfig(config) {
  const payload = await request('/admin/telegram-config', {
    method: 'PUT',
    body: JSON.stringify(config)
  })

  return payload.value || config
}

export async function testBackendTelegramConfig(config) {
  return request('/admin/telegram-config/test', {
    method: 'POST',
    body: JSON.stringify(config)
  })
}

export async function syncBackendTelegramApprovals() {
  return request('/admin/telegram/sync', {
    method: 'POST',
    body: JSON.stringify({})
  })
}
