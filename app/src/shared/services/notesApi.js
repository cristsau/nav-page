import { isBackendAuthEnabled } from '@/shared/services/authApi'
import { apiRequest as request } from '@/shared/services/apiClient'

const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || '/api'

export function shouldUseBackendNotes() {
  return isBackendAuthEnabled()
}

export async function fetchBackendNotes(type = '') {
  const search = type ? `?type=${encodeURIComponent(type)}` : ''
  const payload = await request(`/notes${search}`, { method: 'GET' })
  return (payload.notes || []).map((note) => ({ ...note, accessRole: 'owner' }))
}

export async function createBackendNote(note) {
  const payload = await request('/notes', {
    method: 'POST',
    body: JSON.stringify(note)
  })

  return payload.note
}

export async function updateBackendNote(id, updates, { includeCleanup = false } = {}) {
  const payload = await request(`/notes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(updates)
  })

  return includeCleanup
    ? { note: payload.note, mediaCleanup: payload.mediaCleanup || [] }
    : payload.note
}

export async function deleteBackendNote(id, { includeCleanup = false } = {}) {
  const payload = await request(`/notes/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
  return includeCleanup ? { mediaCleanup: payload.mediaCleanup || [] } : undefined
}

export async function uploadBackendNoteImage(file) {
  const payload = await request('/note-images', {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      'X-File-Name': encodeURIComponent(file.name || 'image')
    },
    body: file
  })

  return payload.attachment
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

export async function fetchBackendNoteVersions(noteId) {
  const payload = await request(`/notes/${encodeURIComponent(noteId)}/versions`, {
    method: 'GET'
  })
  return {
    currentRevision: Number(payload.currentRevision || 1),
    versions: payload.versions || []
  }
}

export async function restoreBackendNoteVersion(noteId, versionId) {
  const payload = await request(
    `/notes/${encodeURIComponent(noteId)}/versions/${encodeURIComponent(versionId)}/restore`,
    {
      method: 'POST',
      body: JSON.stringify({})
    }
  )
  return payload.note
}

export async function fetchBackendShareByCode(code) {
  const response = await fetch(`${API_BASE_URL}/shares/${encodeURIComponent(code)}`, {
    method: 'GET',
    credentials: 'omit',
    headers: {
      Accept: 'application/json'
    }
  })
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : { error: await response.text() }

  if (!response.ok) {
    const error = new Error(payload.error || `Request failed: ${response.status}`)
    error.status = response.status
    throw error
  }

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
