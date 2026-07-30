import { isBackendAuthEnabled } from '@/shared/services/authApi'
import { apiRequest as request } from '@/shared/services/apiClient'

export function shouldUseBackendMigration() {
  return isBackendAuthEnabled()
}

export async function importLocalDataToBackend(data) {
  return request('/migration/import-local', {
    method: 'POST',
    body: JSON.stringify({ data })
  })
}
