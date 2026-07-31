import { normalizeExistingNoteTags } from './noteTags.js'

const MAX_BOOKMARK_TITLE_LENGTH = 300
const MAX_BOOKMARK_DESCRIPTION_LENGTH = 10_000

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

export function sanitizeBookmarkAiUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol)) return ''

    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

export function buildBookmarkAiTagInput(bookmark = {}) {
  const title = normalizeText(bookmark.title, MAX_BOOKMARK_TITLE_LENGTH)
  const description = normalizeText(
    bookmark.description,
    MAX_BOOKMARK_DESCRIPTION_LENGTH
  )
  const safeUrl = sanitizeBookmarkAiUrl(bookmark.url)

  return {
    action: 'tags',
    type: 'bookmark',
    title,
    content: [
      safeUrl ? `书签网址：${safeUrl}` : '',
      description ? `现有描述：${description}` : ''
    ].filter(Boolean).join('\n'),
    tags: normalizeExistingNoteTags(bookmark.tags)
  }
}
