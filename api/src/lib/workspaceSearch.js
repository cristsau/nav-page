export const WORKSPACE_SEARCH_QUERY_MAX_LENGTH = 200
export const WORKSPACE_SEARCH_DEFAULT_LIMIT = 16
export const WORKSPACE_SEARCH_MAX_LIMIT = 50

const TRGM_CAPABILITY_TTL_MS = 10 * 60 * 1000
let trgmCapability = null

function normalizeInlineText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`*_>#~[\]()!-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeWorkspaceSearchQuery(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .slice(0, WORKSPACE_SEARCH_QUERY_MAX_LENGTH)
}

export function escapeLikePattern(value) {
  return String(value ?? '').replace(/[\\%_]/g, '\\$&')
}

export function parseExactNoteNumberId(value) {
  const normalized = String(value ?? '').trim()
  if (!/^#?\d{1,15}$/.test(normalized)) return null
  const parsed = Number(normalized.replace(/^#/, ''))
  return Number.isSafeInteger(parsed) && parsed >= 1000 ? parsed : null
}

export function normalizeWorkspaceSearchLimit(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return WORKSPACE_SEARCH_DEFAULT_LIMIT
  }
  return Math.min(parsed, WORKSPACE_SEARCH_MAX_LIMIT)
}

export function makeWorkspaceSearchSnippet(value, queryText, maxLength = 180) {
  const text = normalizeInlineText(value)
  if (!text) return ''

  const term = normalizeWorkspaceSearchQuery(queryText)
  const normalized = text.normalize('NFKC').toLocaleLowerCase('zh-CN')
  const matchIndex = term ? normalized.indexOf(term) : -1
  const start = matchIndex > 64 ? Math.max(0, matchIndex - 48) : 0
  const body = text.slice(start, start + maxLength)
  return `${start > 0 ? '…' : ''}${body}${start + maxLength < text.length ? '…' : ''}`
}

export function sanitizeWorkspaceResultUrl(value) {
  try {
    const parsed = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function workspaceSearchSql({ fuzzy = false } = {}) {
  const bookmarkFuzzyScore = fuzzy
    ? `+ CASE
        WHEN LOWER(bookmark.title) % $2
          THEN ROUND(similarity(LOWER(bookmark.title), $2) * 220)::INTEGER
        WHEN LOWER(bookmark.description) % $2
          THEN ROUND(similarity(LOWER(bookmark.description), $2) * 100)::INTEGER
        ELSE 0
      END`
    : ''
  const noteFuzzyScore = fuzzy
    ? `+ CASE
        WHEN LOWER(note.title) % $2
          THEN ROUND(similarity(LOWER(note.title), $2) * 220)::INTEGER
        WHEN LOWER(note.content) % $2
          THEN ROUND(similarity(LOWER(note.content), $2) * 100)::INTEGER
        ELSE 0
      END`
    : ''
  const bookmarkFuzzyWhere = fuzzy
    ? `OR LOWER(bookmark.title) % $2
       OR LOWER(bookmark.description) % $2`
    : ''
  const noteFuzzyWhere = fuzzy
    ? `OR LOWER(note.title) % $2
       OR LOWER(note.content) % $2`
    : ''
  const bookmarkFuzzyReason = fuzzy
    ? `CASE
        WHEN NOT (
          LOWER(bookmark.title) LIKE $3 ESCAPE E'\\\\'
          OR LOWER(bookmark.description) LIKE $3 ESCAPE E'\\\\'
        ) AND (
          LOWER(bookmark.title) % $2
          OR LOWER(bookmark.description) % $2
        ) THEN '相近文字'
      END,`
    : ''
  const noteFuzzyReason = fuzzy
    ? `CASE
        WHEN NOT (
          LOWER(note.title) LIKE $3 ESCAPE E'\\\\'
          OR LOWER(note.content) LIKE $3 ESCAPE E'\\\\'
        ) AND (
          LOWER(note.title) % $2
          OR LOWER(note.content) % $2
        ) THEN '相近文字'
      END,`
    : ''

  return `
    WITH bookmark_matches AS (
      SELECT
        bookmark.id::text AS id,
        'bookmark'::text AS kind,
        '导航'::text AS kind_label,
        bookmark.title,
        bookmark.url AS subtitle,
        COALESCE(NULLIF(bookmark.description, ''), tag_match.tag_text, bookmark.url) AS snippet_source,
        bookmark.url AS raw_href,
        NULL::text AS number_id,
        bookmark.updated_at,
        (
          CASE
            WHEN LOWER(bookmark.title) = $2 THEN 1000
            WHEN LOWER(bookmark.title) LIKE $6 ESCAPE E'\\\\' THEN 850
            WHEN LOWER(bookmark.title) LIKE $3 ESCAPE E'\\\\' THEN 700
            ELSE 0
          END
          + CASE
              WHEN COALESCE(tag_match.exact_match, FALSE) THEN 620
              WHEN COALESCE(tag_match.prefix_match, FALSE) THEN 500
              WHEN COALESCE(tag_match.contains_match, FALSE) THEN 400
              ELSE 0
            END
          + CASE
              WHEN LOWER(bookmark.url) = $2 THEN 360
              WHEN LOWER(bookmark.url) LIKE $3 ESCAPE E'\\\\' THEN 250
              ELSE 0
            END
          + CASE
              WHEN LOWER(bookmark.description) LIKE $3 ESCAPE E'\\\\' THEN 220
              ELSE 0
            END
          + CASE WHEN LOWER(bookmark.id::text) = $2 THEN 900 ELSE 0 END
          ${bookmarkFuzzyScore}
        )::DOUBLE PRECISION AS score,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN LOWER(bookmark.id::text) = $2 THEN 'ID 精确匹配' END,
          CASE WHEN LOWER(bookmark.title) = $2 THEN '标题精确匹配' END,
          CASE WHEN LOWER(bookmark.title) <> $2 AND LOWER(bookmark.title) LIKE $6 ESCAPE E'\\\\' THEN '标题开头' END,
          CASE WHEN LOWER(bookmark.title) NOT LIKE $6 ESCAPE E'\\\\' AND LOWER(bookmark.title) LIKE $3 ESCAPE E'\\\\' THEN '标题包含' END,
          CASE WHEN COALESCE(tag_match.exact_match, FALSE) THEN '标签精确匹配' END,
          CASE WHEN NOT COALESCE(tag_match.exact_match, FALSE) AND COALESCE(tag_match.contains_match, FALSE) THEN '标签包含' END,
          CASE WHEN LOWER(bookmark.url) LIKE $3 ESCAPE E'\\\\' THEN '网址包含' END,
          CASE WHEN LOWER(bookmark.description) LIKE $3 ESCAPE E'\\\\' THEN '描述包含' END,
          ${bookmarkFuzzyReason}
          NULL
        ], NULL)::TEXT[] AS match_reasons
      FROM nav_bookmarks AS bookmark
      LEFT JOIN LATERAL (
        SELECT
          BOOL_OR(LOWER(tag) = $2) AS exact_match,
          BOOL_OR(LOWER(tag) LIKE $6 ESCAPE E'\\\\') AS prefix_match,
          BOOL_OR(LOWER(tag) LIKE $3 ESCAPE E'\\\\') AS contains_match,
          STRING_AGG(tag, ' · ' ORDER BY tag) AS tag_text
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(bookmark.tags) = 'array' THEN bookmark.tags
            ELSE '[]'::jsonb
          END
        ) AS tag
      ) AS tag_match ON TRUE
      WHERE bookmark.user_id = $1
        AND (
          LOWER(bookmark.id::text) = $2
          OR LOWER(bookmark.title) LIKE $3 ESCAPE E'\\\\'
          OR LOWER(bookmark.url) LIKE $3 ESCAPE E'\\\\'
          OR LOWER(bookmark.description) LIKE $3 ESCAPE E'\\\\'
          OR COALESCE(tag_match.contains_match, FALSE)
          ${bookmarkFuzzyWhere}
        )
    ), note_matches AS (
      SELECT
        note.id::text AS id,
        'note'::text AS kind,
        CASE WHEN note.type = 'diary' THEN '日记' ELSE '备忘录' END AS kind_label,
        note.title,
        CONCAT_WS(' · ', '#' || note.number_id::text, tag_match.tag_text) AS subtitle,
        note.content AS snippet_source,
        '/whisper?note=' || note.id::text AS raw_href,
        note.number_id::text AS number_id,
        note.updated_at,
        (
          CASE WHEN $4::BIGINT IS NOT NULL AND note.number_id = $4 THEN 1400 ELSE 0 END
          + CASE
              WHEN LOWER(note.id::text) = $2 THEN 900
              WHEN LOWER(note.title) = $2 THEN 1000
              WHEN LOWER(note.title) LIKE $6 ESCAPE E'\\\\' THEN 850
              WHEN LOWER(note.title) LIKE $3 ESCAPE E'\\\\' THEN 700
              ELSE 0
            END
          + CASE
              WHEN COALESCE(tag_match.exact_match, FALSE) THEN 620
              WHEN COALESCE(tag_match.prefix_match, FALSE) THEN 500
              WHEN COALESCE(tag_match.contains_match, FALSE) THEN 400
              ELSE 0
            END
          + CASE WHEN LOWER(note.content) LIKE $3 ESCAPE E'\\\\' THEN 240 ELSE 0 END
          ${noteFuzzyScore}
        )::DOUBLE PRECISION AS score,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN $4::BIGINT IS NOT NULL AND note.number_id = $4 THEN '数字 ID 精确匹配' END,
          CASE WHEN LOWER(note.id::text) = $2 THEN 'ID 精确匹配' END,
          CASE WHEN LOWER(note.title) = $2 THEN '标题精确匹配' END,
          CASE WHEN LOWER(note.title) <> $2 AND LOWER(note.title) LIKE $6 ESCAPE E'\\\\' THEN '标题开头' END,
          CASE WHEN LOWER(note.title) NOT LIKE $6 ESCAPE E'\\\\' AND LOWER(note.title) LIKE $3 ESCAPE E'\\\\' THEN '标题包含' END,
          CASE WHEN COALESCE(tag_match.exact_match, FALSE) THEN '标签精确匹配' END,
          CASE WHEN NOT COALESCE(tag_match.exact_match, FALSE) AND COALESCE(tag_match.contains_match, FALSE) THEN '标签包含' END,
          CASE WHEN LOWER(note.content) LIKE $3 ESCAPE E'\\\\' THEN '正文包含' END,
          ${noteFuzzyReason}
          NULL
        ], NULL)::TEXT[] AS match_reasons
      FROM notes AS note
      LEFT JOIN LATERAL (
        SELECT
          BOOL_OR(LOWER(tag) = $2) AS exact_match,
          BOOL_OR(LOWER(tag) LIKE $6 ESCAPE E'\\\\') AS prefix_match,
          BOOL_OR(LOWER(tag) LIKE $3 ESCAPE E'\\\\') AS contains_match,
          STRING_AGG(tag, ' · ' ORDER BY tag) AS tag_text
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(note.tags) = 'array' THEN note.tags
            ELSE '[]'::jsonb
          END
        ) AS tag
      ) AS tag_match ON TRUE
      WHERE note.user_id = $1
        AND note.encrypted = FALSE
        AND (
          ($4::BIGINT IS NOT NULL AND note.number_id = $4)
          OR LOWER(note.id::text) = $2
          OR LOWER(note.title) LIKE $3 ESCAPE E'\\\\'
          OR LOWER(note.content) LIKE $3 ESCAPE E'\\\\'
          OR COALESCE(tag_match.contains_match, FALSE)
          ${noteFuzzyWhere}
        )
    )
    SELECT *
    FROM (
      SELECT * FROM bookmark_matches
      UNION ALL
      SELECT * FROM note_matches
    ) AS matches
    ORDER BY score DESC, updated_at DESC, kind ASC, id ASC
    LIMIT $5
  `
}

export function buildWorkspaceSearchSql(options = {}) {
  return workspaceSearchSql(options)
}

function isPgTrgmRuntimeError(error) {
  return new Set(['42704', '42883', '0A000']).has(String(error?.code || ''))
    || /pg_trgm|similarity|operator does not exist/i.test(String(error?.message || ''))
}

export async function detectWorkspaceTrigramSupport(
  queryFn,
  { now = Date.now(), force = false } = {}
) {
  if (
    !force
    && trgmCapability
    && now - trgmCapability.checkedAt < TRGM_CAPABILITY_TTL_MS
  ) {
    return trgmCapability.enabled
  }

  if (typeof queryFn !== 'function') {
    throw new TypeError('queryFn is required')
  }

  try {
    const result = await queryFn(`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'
      ) AS enabled
    `)
    trgmCapability = {
      enabled: result.rows[0]?.enabled === true,
      checkedAt: now
    }
  } catch {
    trgmCapability = { enabled: false, checkedAt: now }
  }

  return trgmCapability.enabled
}

export function resetWorkspaceSearchCapabilityCache() {
  trgmCapability = null
}

function mapWorkspaceSearchRow(row, queryText) {
  const kind = row.kind === 'bookmark' ? 'bookmark' : 'note'
  const href = kind === 'bookmark'
    ? sanitizeWorkspaceResultUrl(row.raw_href)
    : `/whisper?note=${encodeURIComponent(String(row.id || ''))}`

  return {
    id: String(row.id || ''),
    kind,
    kindLabel: String(row.kind_label || (kind === 'bookmark' ? '导航' : '备忘录')),
    numberId: row.number_id ? String(row.number_id) : '',
    title: String(row.title || (kind === 'bookmark' ? '未命名导航' : '无标题')),
    subtitle: String(row.subtitle || ''),
    snippet: makeWorkspaceSearchSnippet(row.snippet_source, queryText),
    href,
    score: Number(row.score || 0),
    matchReasons: Array.isArray(row.match_reasons)
      ? row.match_reasons.map(String).filter(Boolean).slice(0, 6)
      : [],
    updatedAt: row.updated_at || null
  }
}

export async function searchWorkspaceForUser({
  userId,
  search,
  limit,
  queryFn
}) {
  const queryText = normalizeWorkspaceSearchQuery(search)
  const resultLimit = normalizeWorkspaceSearchLimit(limit)
  if (!queryText) {
    return {
      query: '',
      results: [],
      bookmarks: [],
      notes: [],
      total: 0,
      fuzzyEnabled: false
    }
  }

  if (typeof queryFn !== 'function') {
    throw new TypeError('queryFn is required')
  }

  const escaped = escapeLikePattern(queryText)
  const params = [
    userId,
    queryText,
    `%${escaped}%`,
    parseExactNoteNumberId(queryText),
    resultLimit,
    `${escaped}%`
  ]
  let fuzzyEnabled = queryText.length >= 2
    && await detectWorkspaceTrigramSupport(queryFn)
  let result

  try {
    result = await queryFn(buildWorkspaceSearchSql({ fuzzy: fuzzyEnabled }), params)
  } catch (error) {
    if (!fuzzyEnabled || !isPgTrgmRuntimeError(error)) throw error
    fuzzyEnabled = false
    trgmCapability = { enabled: false, checkedAt: Date.now() }
    result = await queryFn(buildWorkspaceSearchSql({ fuzzy: false }), params)
  }

  const results = result.rows.map((row) => mapWorkspaceSearchRow(row, queryText))
  const bookmarks = results.filter((item) => item.kind === 'bookmark')
  const notes = results.filter((item) => item.kind === 'note')

  return {
    query: queryText,
    results,
    bookmarks,
    notes,
    total: results.length,
    fuzzyEnabled
  }
}
