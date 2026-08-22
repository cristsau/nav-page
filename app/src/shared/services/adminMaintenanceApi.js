import { apiRequest } from './apiClient'

export function fetchAdminMaintenanceStatus() {
  return apiRequest('/admin/maintenance/status', {
    cache: 'no-store'
  })
}
