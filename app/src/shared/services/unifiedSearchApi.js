import {
  searchBookmarks as searchLocalBookmarks,
  searchNotes as searchLocalNotes
} from '@/shared/db/database'
import {
  searchBackendBookmarks,
  shouldUseBackendNavigation
} from '@/shared/services/navigationApi'
import {
  searchBackendNotes,
  shouldUseBackendNotes
} from '@/shared/services/notesApi'
import { buildUnifiedSearchResults } from '@/shared/utils/unifiedSearch'

export async function searchWorkspace(query, options = {}) {
  const trimmedQuery = String(query || '').trim()
  if (!trimmedQuery) {
    return {
      ...buildUnifiedSearchResults(),
      failedSources: []
    }
  }

  const tasks = [
    shouldUseBackendNavigation()
      ? searchBackendBookmarks(trimmedQuery)
      : searchLocalBookmarks(trimmedQuery),
    shouldUseBackendNotes()
      ? searchBackendNotes(trimmedQuery)
      : searchLocalNotes(trimmedQuery)
  ]
  const [bookmarkResult, noteResult] = await Promise.allSettled(tasks)
  const failedSources = []

  if (bookmarkResult.status === 'rejected') failedSources.push('导航')
  if (noteResult.status === 'rejected') failedSources.push('笔记')

  if (failedSources.length === 2) {
    throw new Error('站内内容搜索暂时不可用')
  }

  return {
    ...buildUnifiedSearchResults({
      bookmarks: bookmarkResult.status === 'fulfilled' ? bookmarkResult.value : [],
      notes: noteResult.status === 'fulfilled' ? noteResult.value : [],
      query: trimmedQuery,
      limitPerType: options.limitPerType
    }),
    failedSources
  }
}
