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
