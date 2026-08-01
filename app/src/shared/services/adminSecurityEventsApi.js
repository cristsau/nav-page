import { apiRequest } from './apiClient'

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
