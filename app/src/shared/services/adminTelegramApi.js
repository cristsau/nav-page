import { isBackendAuthEnabled } from '@/shared/services/authApi'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  })

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() }

  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`)
  }

  return payload
}

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
