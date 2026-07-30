import { isBackendAuthEnabled } from '@/shared/services/authApi'
import { apiRequest as request } from '@/shared/services/apiClient'

export function shouldUseBackendSearchEngines() {
  return isBackendAuthEnabled()
}

export async function fetchBackendCustomSearchEngines() {
  const payload = await request('/search-engines/custom', { method: 'GET' })
  return payload.engines || []
}

export async function createBackendCustomSearchEngine(engine) {
  const payload = await request('/search-engines/custom', {
    method: 'POST',
    body: JSON.stringify(engine)
  })

  return payload.engine
}

export async function updateBackendCustomSearchEngine(id, engine) {
  const payload = await request(`/search-engines/custom/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(engine)
  })

  return payload.engine
}

export async function deleteBackendCustomSearchEngine(id) {
  await request(`/search-engines/custom/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
}
