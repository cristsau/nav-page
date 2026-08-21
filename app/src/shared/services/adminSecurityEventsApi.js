import { apiFileRequest, apiRequest } from './apiClient'

const DEFAULT_PAGE_SIZE = 25

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function buildAdminSecurityEventsPath({
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  eventType = '',
  outcome = ''
} = {}) {
  const search = new URLSearchParams({
    page: String(positiveInteger(page, 1)),
    pageSize: String(positiveInteger(pageSize, DEFAULT_PAGE_SIZE))
  })

  const normalizedEventType = String(eventType || '').trim()
  const normalizedOutcome = String(outcome || '').trim()
  if (normalizedEventType) search.set('eventType', normalizedEventType)
  if (normalizedOutcome) search.set('outcome', normalizedOutcome)

  return `/admin/security-events?${search.toString()}`
}

export function fetchAdminSecurityEvents(options = {}) {
  return apiRequest(buildAdminSecurityEventsPath(options), {
    cache: 'no-store'
  })
}

export function deleteAdminSecurityEvents({ eventIds, currentPassword }) {
  return apiRequest('/admin/security-events/delete', {
    method: 'POST',
    body: JSON.stringify({ eventIds, currentPassword })
  })
}

export function exportAdminSecurityEvents({
  format = 'csv',
  eventType = '',
  outcome = ''
} = {}) {
  const search = new URLSearchParams({ format })
  const normalizedEventType = String(eventType || '').trim()
  const normalizedOutcome = String(outcome || '').trim()
  if (normalizedEventType) search.set('eventType', normalizedEventType)
  if (normalizedOutcome) search.set('outcome', normalizedOutcome)

  return apiFileRequest(`/admin/security-events/export?${search.toString()}`, {
    cache: 'no-store'
  })
}
