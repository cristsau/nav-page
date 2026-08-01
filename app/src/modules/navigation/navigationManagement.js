export const MAX_MANAGED_BOOKMARKS = 100

export function normalizeManagementIds(ids) {
  return [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  )]
}

export function toggleManagementSelection(
  ids,
  id,
  limit = MAX_MANAGED_BOOKMARKS
) {
  const selected = normalizeManagementIds(ids)
  const target = String(id || '').trim()
  const safeLimit = Math.max(1, Number(limit) || MAX_MANAGED_BOOKMARKS)
  if (!target) return { ids: selected, limited: false }

  if (selected.includes(target)) {
    return {
      ids: selected.filter((selectedId) => selectedId !== target),
      limited: false
    }
  }
  if (selected.length >= safeLimit) return { ids: selected, limited: true }
  return { ids: [...selected, target], limited: false }
}

export function selectManagementIds(ids, limit = MAX_MANAGED_BOOKMARKS) {
  const normalized = normalizeManagementIds(ids)
  const safeLimit = Math.max(1, Number(limit) || MAX_MANAGED_BOOKMARKS)
  return {
    ids: normalized.slice(0, safeLimit),
    limited: normalized.length > safeLimit
  }
}

export function moveId(ids, id, direction) {
  const order = normalizeManagementIds(ids)
  const currentIndex = order.indexOf(String(id || ''))
  const nextIndex = currentIndex + Number(direction || 0)

  if (
    currentIndex < 0
    || ![-1, 1].includes(Number(direction))
    || nextIndex < 0
    || nextIndex >= order.length
  ) {
    return order
  }

  const [item] = order.splice(currentIndex, 1)
  order.splice(nextIndex, 0, item)
  return order
}

export function moveIdBefore(ids, sourceId, targetId) {
  const order = normalizeManagementIds(ids)
  const source = String(sourceId || '')
  const target = String(targetId || '')
  const sourceIndex = order.indexOf(source)
  const targetIndex = order.indexOf(target)

  if (sourceIndex < 0 || targetIndex < 0 || source === target) return order

  order.splice(sourceIndex, 1)
  order.splice(order.indexOf(target), 0, source)
  return order
}

export function sameIdOrder(left, right) {
  const leftIds = normalizeManagementIds(left)
  const rightIds = normalizeManagementIds(right)
  return leftIds.length === rightIds.length
    && leftIds.every((id, index) => id === rightIds[index])
}

export function orderRecords(records, ids) {
  const byId = new Map((Array.isArray(records) ? records : []).map((record) => [record.id, record]))
  const ordered = normalizeManagementIds(ids)
    .map((id) => byId.get(id))
    .filter(Boolean)
  const orderedIds = new Set(ordered.map((record) => record.id))

  return [
    ...ordered,
    ...(Array.isArray(records) ? records : []).filter((record) => !orderedIds.has(record.id))
  ]
}

export function buildBookmarkOrderMap(bookmarks, groups) {
  const result = {}
  for (const group of Array.isArray(groups) ? groups : []) {
    result[group.id] = (Array.isArray(bookmarks) ? bookmarks : [])
      .filter((bookmark) => bookmark.groupId === group.id)
      .map((bookmark) => bookmark.id)
  }
  return result
}

export function buildNavigationReorderPayload(groupIds, bookmarkOrderDrafts = {}) {
  const normalizedGroupIds = normalizeManagementIds(groupIds)
  return {
    groupIds: normalizedGroupIds,
    bookmarkOrders: normalizedGroupIds.map((groupId) => ({
      groupId,
      ids: normalizeManagementIds(bookmarkOrderDrafts[groupId] || [])
    }))
  }
}

const HEALTH_PRESENTATIONS = Object.freeze({
  healthy: { label: '正常', tone: 'success' },
  redirected: { label: '已跳转', tone: 'info' },
  protected: { label: '需登录', tone: 'info' },
  throttled: { label: '受限', tone: 'warning' },
  suspect: { label: '需复查', tone: 'warning' },
  broken: { label: '失效', tone: 'error' },
  unsupported: { label: '未支持', tone: 'muted' }
})

export function resolveBookmarkHealthPresentation(bookmark = {}) {
  const status = String(bookmark.healthStatus || 'unchecked').trim().toLowerCase()
  if (status === 'unchecked' || !HEALTH_PRESENTATIONS[status]) return null

  const httpStatus = Number(bookmark.healthHttpStatus)
  const presentation = HEALTH_PRESENTATIONS[status]
  return {
    ...presentation,
    status,
    httpStatus: Number.isInteger(httpStatus) && httpStatus > 0 ? httpStatus : null,
    checkedAt: bookmark.healthCheckedAt || null,
    errorCode: String(bookmark.healthErrorCode || '')
  }
}
