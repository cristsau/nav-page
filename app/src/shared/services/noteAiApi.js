import { isBackendAuthEnabled } from '@/shared/services/authApi'
import { apiRequest } from '@/shared/services/apiClient'

export function canUseBackendNoteAi() {
  return isBackendAuthEnabled()
}

export async function runBackendNoteAi(action, note) {
  const payload = await apiRequest('/notes/ai', {
    method: 'POST',
    body: JSON.stringify({
      action,
      type: note?.type || 'memo',
      title: note?.title || '',
      content: note?.content || ''
    })
  })

  return payload.result
}
