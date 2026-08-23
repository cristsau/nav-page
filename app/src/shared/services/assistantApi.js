import { apiRequest as request } from '@/shared/services/apiClient'

export async function queryWorkspaceAssistant(query) {
  return request('/assistant/query', {
    method: 'POST',
    body: JSON.stringify({ query })
  })
}
