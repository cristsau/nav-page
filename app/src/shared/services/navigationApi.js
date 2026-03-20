import { isBackendAuthEnabled } from '@/shared/services/authApi'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  })

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() }

  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`)
  }

  return payload
}

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

export async function createBackendBookmark(bookmark) {
  const payload = await request('/bookmarks', {
    method: 'POST',
    body: JSON.stringify(bookmark)
  })

  return payload.bookmark
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

export async function searchBackendBookmarks(query) {
  const payload = await request(`/bookmarks/search?q=${encodeURIComponent(query)}`, {
    method: 'GET'
  })

  return payload.bookmarks || []
}
