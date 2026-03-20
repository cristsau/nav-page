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

export function shouldUseBackendNotes() {
  return isBackendAuthEnabled()
}

export async function fetchBackendNotes(type = '') {
  const search = type ? `?type=${encodeURIComponent(type)}` : ''
  const payload = await request(`/notes${search}`, { method: 'GET' })
  return payload.notes || []
}

export async function createBackendNote(note) {
  const payload = await request('/notes', {
    method: 'POST',
    body: JSON.stringify(note)
  })

  return payload.note
}

export async function updateBackendNote(id, updates) {
  const payload = await request(`/notes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  })

  return payload.note
}

export async function deleteBackendNote(id) {
  await request(`/notes/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
}

export async function toggleBackendNotePin(id) {
  const payload = await request(`/notes/${encodeURIComponent(id)}/pin-toggle`, {
    method: 'POST',
    body: JSON.stringify({})
  })

  return payload.note
}

export async function searchBackendNotes(query) {
  const payload = await request(`/notes/search?q=${encodeURIComponent(query)}`, {
    method: 'GET'
  })

  return payload.notes || []
}

export async function fetchBackendShareByCode(code) {
  const payload = await request(`/shares/${encodeURIComponent(code)}`, {
    method: 'GET'
  })

  return {
    share: payload.share,
    note: payload.note
  }
}

export async function createBackendShare(noteId, expireAt = null) {
  const payload = await request(`/notes/${encodeURIComponent(noteId)}/shares`, {
    method: 'POST',
    body: JSON.stringify({ expireAt })
  })

  return payload.share
}

export async function fetchBackendShares(noteId = '') {
  const search = noteId ? `?noteId=${encodeURIComponent(noteId)}` : ''
  const payload = await request(`/shares${search}`, { method: 'GET' })
  return payload.shares || []
}

export async function cancelBackendShare(shareId) {
  await request(`/shares/${encodeURIComponent(shareId)}`, {
    method: 'DELETE'
  })
}
