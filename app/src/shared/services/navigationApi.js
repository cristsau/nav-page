import { isBackendAuthEnabled } from '@/shared/services/authApi'
import { apiRequest as request } from '@/shared/services/apiClient'

export function shouldUseBackendNavigation() {
  return isBackendAuthEnabled()
}

export async function fetchBackendGroups() {
  const payload = await request('/groups', { method: 'GET' })
  return payload.groups || []
}

export async function createBackendGroup(group) {
  const payload = await request('/groups', {
    method: 'POST',
    body: JSON.stringify(group)
  })

  return payload.group
}

export async function updateBackendGroup(id, updates) {
  const payload = await request(`/groups/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  })

  return payload.group
}

export async function deleteBackendGroup(id) {
  await request(`/groups/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
}

export async function reorderBackendGroups(ids) {
  await request('/groups/reorder', {
    method: 'POST',
    body: JSON.stringify({ ids })
  })
}

export async function fetchBackendBookmarks(groupId = '') {
  const search = groupId ? `?groupId=${encodeURIComponent(groupId)}` : ''
  const payload = await request(`/bookmarks${search}`, { method: 'GET' })
  return payload.bookmarks || []
}

export async function createBackendBookmark(bookmark, { withOutcome = false } = {}) {
  const payload = await request('/bookmarks', {
    method: 'POST',
    body: JSON.stringify(bookmark)
  })

  return withOutcome ? payload : payload.bookmark
}

export async function updateBackendBookmark(id, updates) {
  const payload = await request(`/bookmarks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  })

  return payload.bookmark
}

export async function deleteBackendBookmark(id) {
  await request(`/bookmarks/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
}

export async function reorderBackendBookmarks(groupId, ids) {
  await request('/bookmarks/reorder', {
    method: 'POST',
    body: JSON.stringify({ groupId, ids })
  })
}

export async function reorderBackendNavigation(groupIds, bookmarkOrders) {
  await request('/navigation/reorder', {
    method: 'POST',
    body: JSON.stringify({ groupIds, bookmarkOrders })
  })
}

export async function moveBackendBookmarks(ids, targetGroupId) {
  const payload = await request('/bookmarks/bulk/move', {
    method: 'POST',
    body: JSON.stringify({ ids, targetGroupId })
  })

  return payload.bookmarks || []
}

export async function deleteBackendBookmarks(ids) {
  const payload = await request('/bookmarks/bulk/delete', {
    method: 'POST',
    body: JSON.stringify({ ids })
  })

  return payload.bookmarks || []
}

export async function checkBackendBookmarkHealth(ids) {
  const payload = await request('/bookmarks/health-check', {
    method: 'POST',
    body: JSON.stringify({ ids })
  })

  return payload.bookmarks || []
}

export async function searchBackendBookmarks(query) {
  const payload = await request(`/bookmarks/search?q=${encodeURIComponent(query)}`, {
    method: 'GET'
  })

  return payload.bookmarks || []
}

export async function suggestBackendBookmarkTags(bookmarkId) {
  const payload = await request(
    `/bookmarks/${encodeURIComponent(bookmarkId)}/ai/tags`,
    {
      method: 'POST',
      body: JSON.stringify({})
    }
  )
  const result = payload?.result

  if (
    result?.kind !== 'tags'
    || !Array.isArray(result.tags)
    || result.tags.some((tag) => typeof tag !== 'string')
  ) {
    throw new Error('AI 标签结果格式无效，请重新生成。')
  }

  return result
}
