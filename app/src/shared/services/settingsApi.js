import { isBackendAuthEnabled } from '@/shared/services/authApi'
import { apiRequest as request } from '@/shared/services/apiClient'

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
