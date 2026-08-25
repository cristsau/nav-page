import { apiRequest as request } from '@/shared/services/apiClient'

export function fetchManagedIntegrations() {
  return request('/admin/integrations', { method: 'GET', cache: 'no-store' })
}

export function saveManagedMail(config) {
  return request('/admin/integrations/mail', {
    method: 'PUT',
    body: JSON.stringify(config)
  })
}

export function testManagedSmtp() {
  return request('/admin/integrations/mail/test-smtp', { method: 'POST' })
}

export function testManagedImap() {
  return request('/admin/integrations/mail/test-imap', { method: 'POST' })
}

export function saveManagedCloudBackup(config) {
  return request('/admin/integrations/cloud-backup', {
    method: 'PUT',
    body: JSON.stringify(config)
  })
}

export function testManagedCloudBackup() {
  return request('/admin/integrations/cloud-backup/test', { method: 'POST' })
}
