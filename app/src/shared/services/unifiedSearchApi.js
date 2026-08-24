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
import { apiRequest as request } from '@/shared/services/apiClient'

function emptyResults() {
  return {
    bookmarks: [],
    notes: [],
    all: [],
    total: 0,
    failedSources: []
  }
}

function normalizeBackendWorkspaceResult(payload = {}, limitPerType) {
  const limit = Number.isSafeInteger(Number(limitPerType)) && Number(limitPerType) > 0
    ? Number(limitPerType)
    : Infinity
  const bookmarks = (Array.isArray(payload.bookmarks) ? payload.bookmarks : [])
    .slice(0, limit)
  const notes = (Array.isArray(payload.notes) ? payload.notes : [])
    .slice(0, limit)
  return {
    bookmarks,
    notes,
    all: [...bookmarks, ...notes].sort((left, right) => (
      Number(right.score || 0) - Number(left.score || 0)
      || new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime()
      || String(left.kind || '').localeCompare(String(right.kind || ''))
      || String(left.id || '').localeCompare(String(right.id || ''))
    )),
    total: bookmarks.length + notes.length,
    failedSources: [],
    fuzzyEnabled: payload.fuzzyEnabled === true
  }
}

async function searchLocalWorkspace(trimmedQuery, options, failedSources = []) {
  const [bookmarkResult, noteResult] = await Promise.allSettled([
    searchLocalBookmarks(trimmedQuery),
    searchLocalNotes(trimmedQuery)
  ])
  const localFailures = [...failedSources]
  if (bookmarkResult.status === 'rejected') localFailures.push('本地导航缓存')
  if (noteResult.status === 'rejected') localFailures.push('本地笔记缓存')
  if (bookmarkResult.status === 'rejected' && noteResult.status === 'rejected') {
    throw new Error('站内内容搜索暂时不可用')
  }
  return {
    ...buildUnifiedSearchResults({
      bookmarks: bookmarkResult.status === 'fulfilled' ? bookmarkResult.value : [],
      notes: noteResult.status === 'fulfilled' ? noteResult.value : [],
      query: trimmedQuery,
      limitPerType: options.limitPerType
    }),
    failedSources: localFailures
  }
}

export async function searchWorkspace(query, options = {}) {
  const trimmedQuery = String(query || '').trim()
  if (!trimmedQuery) {
    return emptyResults()
  }

  if (shouldUseBackendNavigation() && shouldUseBackendNotes()) {
    try {
      const limitPerType = Number(options.limitPerType || 0)
      const requestedLimit = Number.isSafeInteger(limitPerType) && limitPerType > 0
        ? Math.min(50, limitPerType * 2)
        : 16
      const payload = await request(
        `/workspace/search?q=${encodeURIComponent(trimmedQuery)}&limit=${requestedLimit}`,
        { method: 'GET', cache: 'no-store' }
      )
      return normalizeBackendWorkspaceResult(payload, options.limitPerType)
    } catch {
      return searchLocalWorkspace(trimmedQuery, options, ['服务器搜索'])
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
