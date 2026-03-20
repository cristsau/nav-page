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

export function shouldUseBackendSettings() {
  return isBackendAuthEnabled()
}

export async function fetchBackendSetting(key) {
  const payload = await request(`/settings/${encodeURIComponent(key)}`, {
    method: 'GET'
  })

  return payload.value
}

export async function saveBackendSetting(key, value) {
  const payload = await request(`/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value })
  })

  return payload.value
}
