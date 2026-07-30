import { isBackendAuthEnabled } from '@/shared/services/authApi'
import { apiRequest as request } from '@/shared/services/apiClient'

export function shouldUseBackendAiSearch() {
  return isBackendAuthEnabled()
}

export async function runBackendAiSearch(engineId, query, options = {}) {
  const payload = await request('/ai-search', {
    method: 'POST',
    body: JSON.stringify({
      engineId,
      query,
      ...(options.webSearchEnabled === false
        ? { webSearchEnabled: false }
        : {})
    })
  })

  return payload.result
}

export async function testBackendAiProvider(provider, config) {
  return request('/ai-search/providers/test', {
    method: 'POST',
    body: JSON.stringify({ provider, config })
  })
}
