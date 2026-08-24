import { apiRequest } from '@/shared/services/apiClient'
import {
  createCommentOffline,
  deleteCommentOffline,
  getCachedWorkspaceComments,
  getCachedWorkspaceMembers,
  resolveCommentOffline,
  updateCommentOffline
} from '@/shared/services/offlineWorkspace'

export async function fetchCollaborationDetail(noteId) {
  try {
    return await apiRequest(`/collaboration/notes/${encodeURIComponent(noteId)}`, { method: 'GET' })
  } catch (error) {
    if (error?.status) throw error
    return {
      note: null,
      members: await getCachedWorkspaceMembers(noteId),
      comments: await getCachedWorkspaceComments(noteId),
      offline: true
    }
  }
}

export async function updateCollaborativeNoteMetadata(noteId, data) {
  return apiRequest(`/collaboration/notes/${encodeURIComponent(noteId)}/metadata`, {
    method: 'PATCH',
    body: JSON.stringify(data)
  })
}

export async function addCollaborator(noteId, username, role) {
  return apiRequest(`/collaboration/notes/${encodeURIComponent(noteId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ username, role })
  })
}

export async function updateCollaborator(noteId, userId, role) {
  return apiRequest(
    `/collaboration/notes/${encodeURIComponent(noteId)}/members/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: JSON.stringify({ role }) }
  )
}

export async function removeCollaborator(noteId, userId) {
  return apiRequest(
    `/collaboration/notes/${encodeURIComponent(noteId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  )
}

export async function addComment(noteId, data) {
  if (!navigator.onLine) return { comment: await createCommentOffline(noteId, data), offline: true }
  try {
    return await apiRequest(`/collaboration/notes/${encodeURIComponent(noteId)}/comments`, {
      method: 'POST',
      body: JSON.stringify(data)
    })
  } catch (error) {
    if (error?.status) throw error
    return { comment: await createCommentOffline(noteId, data), offline: true }
  }
}

export async function updateComment(noteId, commentId, body) {
  if (!navigator.onLine) return { comment: await updateCommentOffline(noteId, commentId, body), offline: true }
  try {
    return await apiRequest(
      `/collaboration/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(commentId)}`,
      { method: 'PATCH', body: JSON.stringify({ body }) }
    )
  } catch (error) {
    if (error?.status) throw error
    return { comment: await updateCommentOffline(noteId, commentId, body), offline: true }
  }
}

export async function resolveComment(noteId, commentId, resolved = true) {
  if (!navigator.onLine) return { comment: await resolveCommentOffline(noteId, commentId, resolved), offline: true }
  try {
    return await apiRequest(
      `/collaboration/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(commentId)}/resolve`,
      { method: 'POST', body: JSON.stringify({ resolved }) }
    )
  } catch (error) {
    if (error?.status) throw error
    return { comment: await resolveCommentOffline(noteId, commentId, resolved), offline: true }
  }
}

export async function deleteComment(noteId, commentId) {
  if (!navigator.onLine) return deleteCommentOffline(noteId, commentId)
  try {
    return await apiRequest(
      `/collaboration/notes/${encodeURIComponent(noteId)}/comments/${encodeURIComponent(commentId)}`,
      { method: 'DELETE' }
    )
  } catch (error) {
    if (error?.status) throw error
    return deleteCommentOffline(noteId, commentId)
  }
}
