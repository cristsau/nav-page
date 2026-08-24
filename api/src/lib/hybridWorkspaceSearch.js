import { config } from '../config.js'
import {
  cosineSimilarity,
  embeddingModelIdentity,
  embedWorkspaceTexts
} from './localEmbeddings.js'
import {
  makeWorkspaceSearchSnippet,
  normalizeWorkspaceSearchLimit,
  normalizeWorkspaceSearchQuery,
  parseExactNoteNumberId,
  sanitizeWorkspaceResultUrl,
  searchWorkspaceForUser
} from './workspaceSearch.js'
import {
  synchronizeWorkspaceSearchDocuments,
  tokenizeWorkspaceText,
  workspaceDocumentEmbeddingText
} from './workspaceSearchIndex.js'

const BM25_K1 = 1.2
const BM25_B = 0.75
const MAX_USER_DOCUMENTS = 5_000
const INLINE_EMBEDDING_LIMIT = 16

function asArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  return value
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((item) => Number(item))
    .filter(Number.isFinite)
}

function asFrequencyMap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value || '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function asTags(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

export function calculateBm25Scores(documents, queryTokens) {
  const tokens = [...new Set(queryTokens)]
  const scores = new Map()
  if (!documents.length || !tokens.length) return scores

  const averageLength = Math.max(
    1,
    documents.reduce((total, document) => total + Number(document.document_length || 0), 0)
      / documents.length
  )

  for (const token of tokens) {
    const matchingCount = documents.reduce((count, document) => {
      const frequencies = asFrequencyMap(document.term_frequencies)
      return count + (Number(frequencies[token] || 0) > 0 ? 1 : 0)
    }, 0)
    if (!matchingCount) continue

    const idf = Math.log(
      1 + ((documents.length - matchingCount + 0.5) / (matchingCount + 0.5))
    )
    for (const document of documents) {
      const frequencies = asFrequencyMap(document.term_frequencies)
      const frequency = Number(frequencies[token] || 0)
      if (!frequency) continue
      const length = Number(document.document_length || 0)
      const denominator = frequency + BM25_K1 * (
        1 - BM25_B + BM25_B * (length / averageLength)
      )
      const contribution = idf * ((frequency * (BM25_K1 + 1)) / denominator)
      scores.set(document.id, (scores.get(document.id) || 0) + contribution)
    }
  }
  return scores
}

function normalizeScore(value, maximum) {
  const score = Number(value || 0)
  return maximum > 0 ? Math.max(0, score / maximum) : 0
}

function exactBoost(document, queryText, exactNumberId) {
  const title = normalizeWorkspaceSearchQuery(document.title)
  const sourceId = String(document.bookmark_id || document.note_id || '').toLowerCase()
  if (sourceId === queryText) return 1
  if (exactNumberId && Number(document.number_id) === exactNumberId) return 1
  if (title === queryText) return 0.95
  if (title.startsWith(queryText)) return 0.5
  if (title.includes(queryText)) return 0.25
  return 0
}

function mapHybridResult(document, queryText, scores) {
  const kind = document.kind === 'bookmark' ? 'bookmark' : 'note'
  const sourceId = String(kind === 'bookmark' ? document.bookmark_id : document.note_id)
  const reasons = []
  if (scores.exact >= 1) reasons.push(document.number_id ? 'ID 精确匹配' : '来源 ID 精确匹配')
  else if (scores.exact >= 0.95) reasons.push('标题精确匹配')
  else if (scores.exact >= 0.5) reasons.push('标题开头')
  else if (scores.exact > 0) reasons.push('标题包含')
  if (scores.bm25 > 0) reasons.push('BM25 关键词相关')
  if (scores.semantic > 0.55) reasons.push('语义相关')

  const subtitle = kind === 'bookmark'
    ? document.url
    : [document.number_id ? `#${document.number_id}` : '', ...asTags(document.tags)]
      .filter(Boolean)
      .join(' · ')

  return {
    id: sourceId,
    kind,
    kindLabel: kind === 'bookmark'
      ? '导航'
      : document.note_type === 'diary' ? '日记' : '备忘录',
    numberId: document.number_id ? String(document.number_id) : '',
    title: String(document.title || (kind === 'bookmark' ? '未命名导航' : '无标题')),
    subtitle,
    snippet: makeWorkspaceSearchSnippet(document.body || document.url, queryText),
    href: kind === 'bookmark'
      ? sanitizeWorkspaceResultUrl(document.url)
      : `/whisper?note=${encodeURIComponent(sourceId)}`,
    score: Math.round(scores.combined * 10_000) / 100,
    matchReasons: reasons.slice(0, 6),
    updatedAt: document.source_updated_at || null,
    relevance: {
      bm25: Math.round(scores.bm25 * 1_000) / 1_000,
      semantic: Math.round(scores.semantic * 1_000) / 1_000
    }
  }
}

export async function embedPendingWorkspaceDocuments({
  poolInstance,
  userId = null,
  limit = INLINE_EMBEDDING_LIMIT
}) {
  const boundedLimit = Math.max(1, Math.min(100, Number(limit) || INLINE_EMBEDDING_LIMIT))
  const modelIdentity = embeddingModelIdentity()
  const candidates = await poolInstance.query(
    `
      SELECT id, title, body, url, tags, source_hash
      FROM workspace_search_documents
      WHERE (embedding IS NULL OR embedding_model <> $3)
        AND ($1::uuid IS NULL OR user_id = $1)
      ORDER BY indexed_at ASC, id ASC
      LIMIT $2
    `,
    [userId, boundedLimit, modelIdentity]
  )
  if (!candidates.rows.length) return { processed: 0, remaining: 0 }

  const vectors = await embedWorkspaceTexts(
    candidates.rows.map((row) => workspaceDocumentEmbeddingText(row))
  )
  let processed = 0
  for (let index = 0; index < candidates.rows.length; index += 1) {
    const candidate = candidates.rows[index]
    const vector = vectors[index]
    const result = await poolInstance.query(
      `
        UPDATE workspace_search_documents
        SET embedding = $3::real[],
            embedding_model = $4,
            embedding_dimensions = $5,
            embedding_updated_at = NOW()
        WHERE id = $1
          AND source_hash = $2
          AND (embedding IS NULL OR embedding_model <> $4)
      `,
      [candidate.id, candidate.source_hash, vector, modelIdentity, vector.length]
    )
    processed += Number(result.rowCount || 0)
  }
  const remaining = await poolInstance.query(
    `
      SELECT COUNT(*)::integer AS count
      FROM workspace_search_documents
      WHERE (embedding IS NULL OR embedding_model <> $2)
        AND ($1::uuid IS NULL OR user_id = $1)
    `,
    [userId, modelIdentity]
  )
  return { processed, remaining: Number(remaining.rows[0]?.count || 0) }
}

export async function searchWorkspaceHybridForUser({
  userId,
  search,
  limit,
  poolInstance,
  queryFn,
  logger
}) {
  const queryText = normalizeWorkspaceSearchQuery(search)
  const resultLimit = normalizeWorkspaceSearchLimit(limit)
  if (!queryText) {
    return {
      query: '', results: [], bookmarks: [], notes: [], total: 0,
      fuzzyEnabled: false, bm25Enabled: config.hybridSearchEnabled,
      semanticEnabled: config.semanticSearchEnabled,
      semanticStatus: config.semanticSearchEnabled ? 'ready' : 'disabled',
      searchMode: config.semanticSearchEnabled ? 'hybrid' : 'bm25'
    }
  }

  if (!config.hybridSearchEnabled || typeof poolInstance?.query !== 'function') {
    const legacy = await searchWorkspaceForUser({ userId, search, limit, queryFn })
    return {
      ...legacy,
      bm25Enabled: false,
      semanticEnabled: false,
      semanticStatus: 'disabled',
      searchMode: 'legacy'
    }
  }

  await synchronizeWorkspaceSearchDocuments({ userId, poolInstance })
  let semanticStatus = config.semanticSearchEnabled ? 'ready' : 'disabled'
  let queryVector = null
  if (config.semanticSearchEnabled) {
    try {
      await embedPendingWorkspaceDocuments({
        poolInstance,
        userId,
        limit: INLINE_EMBEDDING_LIMIT
      })
      ;[queryVector] = await embedWorkspaceTexts([queryText])
    } catch (error) {
      semanticStatus = 'unavailable'
      logger?.warn?.({ err: error }, 'semantic search fell back to BM25')
    }
  }

  const rows = await poolInstance.query(
    `
      SELECT
        document.*,
        note.number_id,
        note.type AS note_type
      FROM workspace_search_documents AS document
      LEFT JOIN notes AS note ON note.id = document.note_id
      WHERE document.user_id = $1
      ORDER BY document.source_updated_at DESC, document.id ASC
      LIMIT $2
    `,
    [userId, MAX_USER_DOCUMENTS]
  )
  const documents = rows.rows
  const queryTokens = tokenizeWorkspaceText(queryText)
  const rawBm25 = calculateBm25Scores(documents, queryTokens)
  const maximumBm25 = Math.max(0, ...rawBm25.values())
  const exactNumberId = parseExactNoteNumberId(queryText)
  const modelIdentity = embeddingModelIdentity()

  const ranked = documents.map((document) => {
    const bm25 = normalizeScore(rawBm25.get(document.id), maximumBm25)
    const cosine = queryVector && document.embedding_model === modelIdentity
      ? cosineSimilarity(queryVector, asArray(document.embedding))
      : null
    const semantic = cosine === null ? 0 : Math.max(0, Math.min(1, cosine))
    const exact = exactBoost(document, queryText, exactNumberId)
    const combined = Math.max(exact, (
      semanticStatus === 'ready'
        ? bm25 * 0.68 + semantic * 0.32
        : bm25
    ))
    return { document, scores: { bm25, semantic, exact, combined } }
  }).filter(({ scores }) => (
    scores.combined > 0.08
    && (scores.exact > 0 || scores.bm25 > 0 || scores.semantic >= 0.35)
  ))
    .sort((left, right) => (
      right.scores.combined - left.scores.combined
      || new Date(right.document.source_updated_at) - new Date(left.document.source_updated_at)
      || String(left.document.id).localeCompare(String(right.document.id))
    ))
    .slice(0, resultLimit)

  const results = ranked.map(({ document, scores }) => (
    mapHybridResult(document, queryText, scores)
  ))
  return {
    query: queryText,
    results,
    bookmarks: results.filter((item) => item.kind === 'bookmark'),
    notes: results.filter((item) => item.kind === 'note'),
    total: results.length,
    fuzzyEnabled: false,
    bm25Enabled: true,
    semanticEnabled: config.semanticSearchEnabled,
    semanticStatus,
    searchMode: semanticStatus === 'ready' ? 'hybrid' : 'bm25'
  }
}
