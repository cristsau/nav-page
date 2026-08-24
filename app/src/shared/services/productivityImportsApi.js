import { apiRequest as request } from '@/shared/services/apiClient'

export function importBackendBookmarks(items, targetGroupId = '') {
  return request('/imports/bookmarks', {
    method: 'POST',
    body: JSON.stringify({ items, targetGroupId })
  })
}

export function importBackendNotes(notes) {
  return request('/imports/notes', {
    method: 'POST',
    body: JSON.stringify({ notes })
  })
}
