export const BOOKMARK_IMPORT_LIMIT = 1000

const ENTITY_MAP = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
  nbsp: ' '
})

export function decodeBookmarkHtml(value) {
  return String(value || '').replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity) => {
      const normalized = entity.toLowerCase()
      if (normalized.startsWith('#x')) {
        const codePoint = Number.parseInt(normalized.slice(2), 16)
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match
      }
      if (normalized.startsWith('#')) {
        const codePoint = Number.parseInt(normalized.slice(1), 10)
        return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match
      }
      return ENTITY_MAP[normalized] ?? match
    }
  )
}

function normalizeText(value, fallback = '') {
  return decodeBookmarkHtml(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || fallback
}

function readAttribute(source, name) {
  const match = String(source || '').match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  )
  return decodeBookmarkHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? '')
}

export function normalizeImportedBookmarkUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    if (url.username || url.password) return ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}

export function bookmarkImportDedupeKey(value) {
  const normalized = normalizeImportedBookmarkUrl(value)
  if (!normalized) return ''
  const url = new URL(normalized)
  url.hostname = url.hostname.toLowerCase()
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = ''
  }
  return url.href.replace(/\/$/, '')
}

export function parseBookmarkHtml(source, { maxEntries = BOOKMARK_IMPORT_LIMIT } = {}) {
  const limit = Math.min(BOOKMARK_IMPORT_LIMIT, Math.max(1, Number(maxEntries) || 1))
  const tokens = String(source || '').match(/<\/?(?:DL|H3|A)\b[^>]*>|[^<]+/gi) || []
  const folders = []
  const entries = []
  const warnings = []
  let pendingFolder = ''
  let totalLinks = 0

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (/^<H3\b/i.test(token)) {
      const text = []
      while (++index < tokens.length && !/^<\/H3/i.test(tokens[index])) text.push(tokens[index])
      pendingFolder = normalizeText(text.join(''), '未命名目录').slice(0, 80)
      continue
    }
    if (/^<DL\b/i.test(token)) {
      if (pendingFolder) {
        folders.push(pendingFolder)
        pendingFolder = ''
      }
      continue
    }
    if (/^<\/DL/i.test(token)) {
      folders.pop()
      continue
    }
    if (!/^<A\b/i.test(token)) continue

    totalLinks += 1
    const text = []
    while (++index < tokens.length && !/^<\/A/i.test(tokens[index])) text.push(tokens[index])
    if (entries.length >= limit) continue

    const url = normalizeImportedBookmarkUrl(readAttribute(token, 'HREF'))
    if (!url) {
      warnings.push(`已跳过不受支持或包含账号信息的链接：${normalizeText(text.join(''), '未命名')}`)
      continue
    }
    entries.push({
      title: normalizeText(text.join(''), new URL(url).hostname).slice(0, 200),
      url,
      favicon: normalizeImportedBookmarkUrl(readAttribute(token, 'ICON')),
      folderPath: [...folders]
    })
  }

  if (totalLinks > limit) warnings.push(`文件包含 ${totalLinks} 个链接，本次最多预览 ${limit} 个。`)
  return {
    entries,
    totalLinks,
    skipped: Math.max(0, totalLinks - entries.length),
    truncated: totalLinks > limit,
    warnings: warnings.slice(0, 20)
  }
}

export function planBookmarkImport(entries, {
  targetGroupId = '',
  preserveFolders = true,
  existingBookmarks = [],
  folderGroupIds = {}
} = {}) {
  const existing = new Set((Array.isArray(existingBookmarks) ? existingBookmarks : [])
    .map((bookmark) => `${bookmark.groupId || ''}|${bookmarkImportDedupeKey(bookmark.url)}`))
  const planned = []
  let duplicates = 0

  for (const entry of Array.isArray(entries) ? entries : []) {
    const folderName = preserveFolders && entry.folderPath?.length
      ? entry.folderPath.join(' / ').slice(0, 80)
      : ''
    const knownFolderId = folderName ? folderGroupIds[folderName.toLocaleLowerCase('zh-CN')] : ''
    const groupKey = knownFolderId
      ? `id:${knownFolderId}`
      : (folderName ? `folder:${folderName}` : `id:${targetGroupId}`)
    const dedupeKey = bookmarkImportDedupeKey(entry.url)
    const existingKey = groupKey.startsWith('id:') ? groupKey.slice(3) : groupKey
    if (!dedupeKey || existing.has(`${existingKey}|${dedupeKey}`)) {
      duplicates += 1
      continue
    }
    existing.add(`${existingKey}|${dedupeKey}`)
    planned.push({ ...entry, folderName, targetGroupId })
  }

  return { planned, duplicates }
}
