const DEFAULT_RESULT_LIMIT = 6

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN')
}

function normalizeInlineText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`*_>#~[\]()!-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function scoreText(value, term, weights) {
  const normalized = normalizeSearchText(value)
  if (!normalized) return 0
  if (normalized === term) return weights.exact
  if (normalized.startsWith(term)) return weights.prefix
  if (normalized.includes(term)) return weights.includes
  return 0
}

function scoreTags(tags, term) {
  return (Array.isArray(tags) ? tags : []).reduce(
    (score, tag) => Math.max(score, scoreText(tag, term, {
      exact: 56,
      prefix: 46,
      includes: 36
    })),
    0
  )
}

function makeSnippet(value, query, maxLength = 132) {
  const text = normalizeInlineText(value)
  if (!text) return ''

  const normalizedText = normalizeSearchText(text)
  const normalizedQuery = normalizeSearchText(query)
  const matchIndex = normalizedText.indexOf(normalizedQuery)
  const start = matchIndex > 44 ? matchIndex - 32 : 0
  const slice = text.slice(start, start + maxLength)

  return `${start > 0 ? '…' : ''}${slice}${start + maxLength < text.length ? '…' : ''}`
}

function toTimestamp(value) {
  const timestamp = new Date(value || 0).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function normalizeResultUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return ''
  }
}

function sortRankedResults(left, right) {
  if (left.score !== right.score) return right.score - left.score
  return right.updatedTimestamp - left.updatedTimestamp
}

function rankBookmark(bookmark, query, term) {
  const titleScore = scoreText(bookmark.title, term, {
    exact: 140,
    prefix: 112,
    includes: 92
  })
  const tagScore = scoreTags(bookmark.tags, term)
  const idScore = scoreText(bookmark.id, term, {
    exact: 84,
    prefix: 64,
    includes: 48
  })
  const urlScore = scoreText(bookmark.url, term, {
    exact: 52,
    prefix: 42,
    includes: 32
  })
  const descriptionScore = scoreText(bookmark.description, term, {
    exact: 44,
    prefix: 34,
    includes: 24
  })
  const score = titleScore + Math.max(tagScore, idScore, urlScore, descriptionScore)

  return {
    id: bookmark.id,
    kind: 'bookmark',
    kindLabel: '导航',
    title: String(bookmark.title || bookmark.url || '未命名导航'),
    subtitle: String(bookmark.url || ''),
    snippet: makeSnippet(bookmark.description || (bookmark.tags || []).join(' · '), query),
    href: normalizeResultUrl(bookmark.url),
    score,
    updatedTimestamp: toTimestamp(bookmark.updatedAt || bookmark.createdAt)
  }
}

function rankNote(note, query, term) {
  const numberId = note.numberId === undefined || note.numberId === null
    ? ''
    : String(note.numberId)
  const titleScore = scoreText(note.title, term, {
    exact: 140,
    prefix: 112,
    includes: 92
  })
  const tagScore = scoreTags(note.tags, term)
  const idScore = scoreText(note.id, term, {
    exact: 84,
    prefix: 64,
    includes: 48
  })
  const numberIdScore = Math.max(
    scoreText(numberId, term.replace(/^#/, ''), {
      exact: 132,
      prefix: 72,
      includes: 54
    }),
    scoreText(numberId ? `#${numberId}` : '', term, {
      exact: 132,
      prefix: 72,
      includes: 54
    })
  )
  const contentScore = scoreText(note.content, term, {
    exact: 42,
    prefix: 34,
    includes: 26
  })
  const score = titleScore + Math.max(tagScore, idScore, numberIdScore, contentScore)
  const noteType = note.type === 'diary'
    ? '日记'
    : note.type === 'memo'
      ? '备忘录'
      : '笔记'

  return {
    id: note.id,
    kind: 'note',
    kindLabel: noteType,
    numberId,
    title: String(note.title || '无标题'),
    subtitle: [
      numberId ? `#${numberId}` : '',
      ...(Array.isArray(note.tags) ? note.tags : [])
    ].filter(Boolean).join(' · '),
    snippet: makeSnippet(note.content, query),
    score,
    updatedTimestamp: toTimestamp(note.updatedAt || note.createdAt)
  }
}

function limitRankedResults(items, limit) {
  return items
    .filter((item) => item.score > 0)
    .sort(sortRankedResults)
    .slice(0, limit)
}

export function buildUnifiedSearchResults({
  bookmarks = [],
  notes = [],
  query = '',
  limitPerType = DEFAULT_RESULT_LIMIT
} = {}) {
  const normalizedQuery = normalizeSearchText(query)

  if (!normalizedQuery) {
    return {
      bookmarks: [],
      notes: [],
      all: [],
      total: 0
    }
  }

  const rankedBookmarks = limitRankedResults(
    bookmarks.map((bookmark) => rankBookmark(bookmark, query, normalizedQuery)),
    limitPerType
  )
  const rankedNotes = limitRankedResults(
    notes
      .filter((note) => !note.encrypted)
      .map((note) => rankNote(note, query, normalizedQuery)),
    limitPerType
  )

  return {
    bookmarks: rankedBookmarks,
    notes: rankedNotes,
    all: [...rankedBookmarks, ...rankedNotes],
    total: rankedBookmarks.length + rankedNotes.length
  }
}

export function createHighlightedSegments(value, query) {
  const text = String(value ?? '')
  const term = String(query ?? '').trim()
  if (!text || !term) {
    return [{ text, match: false }]
  }

  const lowerText = text.toLocaleLowerCase('zh-CN')
  const lowerTerm = term.toLocaleLowerCase('zh-CN')
  const segments = []
  let cursor = 0
  let matchIndex = lowerText.indexOf(lowerTerm)

  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      segments.push({
        text: text.slice(cursor, matchIndex),
        match: false
      })
    }

    segments.push({
      text: text.slice(matchIndex, matchIndex + term.length),
      match: true
    })
    cursor = matchIndex + term.length
    matchIndex = lowerText.indexOf(lowerTerm, cursor)
  }

  if (cursor < text.length) {
    segments.push({
      text: text.slice(cursor),
      match: false
    })
  }

  return segments.length ? segments : [{ text, match: false }]
}

export function buildWebSearchUrl(baseUrl, query) {
  const url = String(baseUrl || '')
  const encodedQuery = encodeURIComponent(String(query || '').trim())

  if (url.includes('{query}')) {
    return url.replaceAll('{query}', encodedQuery)
  }

  return `${url}${encodedQuery}`
}

export function normalizeEngineMonogram(value, fallback = 'S') {
  const characters = Array.from(String(value ?? '').normalize('NFKC'))
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .slice(0, 2)

  return characters.length
    ? characters.join('').toLocaleUpperCase('zh-CN')
    : fallback
}
