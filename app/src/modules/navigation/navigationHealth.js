// Acknowledgement hides one check result, never changes a bookmark's actual health.
export const HEALTH_DISMISSALS_KEY = 'navigationHealthDismissalsV1'
export const isHealthProblem = (bookmark) => ['broken', 'suspect', 'unsupported'].includes(bookmark?.healthStatus)

export function healthResultKey(bookmark) {
  return JSON.stringify([
    bookmark.id, bookmark.healthStatus, bookmark.healthCheckedAt || '',
    bookmark.healthFailureCount || 0, bookmark.healthHttpStatus || null,
    bookmark.healthErrorCode || ''
  ])
}

export function normalizeHealthDismissals(value, bookmarks) {
  if (!Array.isArray(value)) return []
  const current = new Set(bookmarks.filter(isHealthProblem).map(healthResultKey))
  return [...new Set(value.filter(key => typeof key === 'string' && current.has(key)))]
}

export function dismissHealthResults(previous, bookmarks, targets) {
  return normalizeHealthDismissals([...previous, ...targets.filter(isHealthProblem).map(healthResultKey)], bookmarks)
}
