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

export function shouldUseBackendAiSearch() {
  return isBackendAuthEnabled()
}

export async function runBackendAiSearch(engineId, query) {
  const payload = await request('/ai-search', {
    method: 'POST',
    body: JSON.stringify({ engineId, query })
  })

  return payload.result
}

export async function testBackendAiProvider(provider, config) {
  return request('/ai-search/providers/test', {
    method: 'POST',
    body: JSON.stringify({ provider, config })
  })
}
