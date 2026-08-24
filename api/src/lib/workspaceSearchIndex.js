import { createHash } from 'node:crypto'

const MAX_INDEXED_TEXT_LENGTH = 24_000
const MAX_TOKEN_LENGTH = 64
const UPSERT_BATCH_SIZE = 100
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .slice(0, MAX_INDEXED_TEXT_LENGTH)
}

function indexedSourceText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_INDEXED_TEXT_LENGTH)
}

function addToken(target, value) {
  const token = String(value || '').trim().slice(0, MAX_TOKEN_LENGTH)
  if (token) target.push(token)
}

export function tokenizeWorkspaceText(value) {
  const text = normalizedText(value)
  if (!text) return []

  const tokens = []
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const segment = match[0]
    if (!CJK_PATTERN.test(segment)) {
      addToken(tokens, segment)
      continue
    }

    const characters = [...segment]
    if (characters.length <= 8) addToken(tokens, segment)
    for (let index = 0; index < characters.length; index += 1) {
      addToken(tokens, characters[index])
      if (index + 1 < characters.length) {
        addToken(tokens, `${characters[index]}${characters[index + 1]}`)
      }
      if (index + 2 < characters.length) {
        addToken(
          tokens,
          `${characters[index]}${characters[index + 1]}${characters[index + 2]}`
        )
      }
    }
  }
  return tokens
}

function normalizedTags(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item || '').normalize('NFKC').trim())
    .filter(Boolean)
    .slice(0, 50)
}

function weightedTokens({ title, tags, url, body }) {
  const frequencies = new Map()
  const add = (value, weight) => {
    for (const token of tokenizeWorkspaceText(value)) {
      frequencies.set(token, (frequencies.get(token) || 0) + weight)
    }
  }

  add(title, 5)
  add(tags.join(' '), 3)
  add(url, 2)
  add(body, 1)

  const entries = [...frequencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
  return {
    lexicalTokens: entries.map(([token]) => token),
    termFrequencies: Object.fromEntries(entries),
    documentLength: entries.reduce((total, [, count]) => total + count, 0)
  }
}

function sourceHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function buildDocument(source) {
  // Keep display values intact. Tokenization normalizes and lower-cases its own
  // input; lower-casing the stored URL would break case-sensitive paths.
  const title = indexedSourceText(source.title)
  const body = indexedSourceText(source.body)
  const url = indexedSourceText(source.url)
  const tags = normalizedTags(source.tags)
  const lexical = weightedTokens({ title, body, url, tags })
  return {
    ...source,
    title,
    body,
    url,
    tags,
    ...lexical,
    sourceHash: sourceHash({ title, body, url, tags, updatedAt: source.updatedAt })
  }
}

const UPSERT_BOOKMARK_SQL = `
  WITH source AS (
    SELECT *
    FROM jsonb_to_recordset($2::jsonb) AS record(
      id uuid,
      title text,
      body text,
      url text,
      tags jsonb,
      lexical_tokens text[],
      term_frequencies jsonb,
      document_length integer,
      source_hash char(64),
      source_updated_at timestamptz
    )
  ), upserted AS (
  INSERT INTO workspace_search_documents (
    user_id, bookmark_id, kind, title, body, url, tags,
    lexical_tokens, term_frequencies, document_length,
    source_hash, source_updated_at
  )
  SELECT
    $1, id, 'bookmark', title, body, url, tags,
    lexical_tokens, term_frequencies, document_length,
    source_hash, source_updated_at
  FROM source
  ON CONFLICT (bookmark_id) WHERE bookmark_id IS NOT NULL
  DO UPDATE SET
    user_id = EXCLUDED.user_id,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    url = EXCLUDED.url,
    tags = EXCLUDED.tags,
    lexical_tokens = EXCLUDED.lexical_tokens,
    term_frequencies = EXCLUDED.term_frequencies,
    document_length = EXCLUDED.document_length,
    source_hash = EXCLUDED.source_hash,
    source_updated_at = EXCLUDED.source_updated_at,
    indexed_at = NOW(),
    embedding = NULL,
    embedding_model = NULL,
    embedding_dimensions = NULL,
    embedding_updated_at = NULL
  WHERE workspace_search_documents.source_hash <> EXCLUDED.source_hash
  RETURNING id
  )
  SELECT COUNT(*)::integer AS count FROM upserted
`

const UPSERT_NOTE_SQL = `
  WITH source AS (
    SELECT *
    FROM jsonb_to_recordset($2::jsonb) AS record(
      id uuid,
      title text,
      body text,
      tags jsonb,
      lexical_tokens text[],
      term_frequencies jsonb,
      document_length integer,
      source_hash char(64),
      source_updated_at timestamptz
    )
  ), upserted AS (
  INSERT INTO workspace_search_documents (
    user_id, note_id, kind, title, body, url, tags,
    lexical_tokens, term_frequencies, document_length,
    source_hash, source_updated_at
  )
  SELECT
    $1, id, 'note', title, body, '', tags,
    lexical_tokens, term_frequencies, document_length,
    source_hash, source_updated_at
  FROM source
  ON CONFLICT (note_id) WHERE note_id IS NOT NULL
  DO UPDATE SET
    user_id = EXCLUDED.user_id,
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    tags = EXCLUDED.tags,
    lexical_tokens = EXCLUDED.lexical_tokens,
    term_frequencies = EXCLUDED.term_frequencies,
    document_length = EXCLUDED.document_length,
    source_hash = EXCLUDED.source_hash,
    source_updated_at = EXCLUDED.source_updated_at,
    indexed_at = NOW(),
    embedding = NULL,
    embedding_model = NULL,
    embedding_dimensions = NULL,
    embedding_updated_at = NULL
  WHERE workspace_search_documents.source_hash <> EXCLUDED.source_hash
  RETURNING id
  )
  SELECT COUNT(*)::integer AS count FROM upserted
`

function batched(values, size = UPSERT_BATCH_SIZE) {
  const batches = []
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size))
  }
  return batches
}

function serializableDocument(document) {
  return {
    id: document.id,
    title: document.title,
    body: document.body,
    url: document.url,
    tags: document.tags,
    lexical_tokens: document.lexicalTokens,
    term_frequencies: document.termFrequencies,
    document_length: document.documentLength,
    source_hash: document.sourceHash,
    source_updated_at: document.updatedAt
  }
}

async function upsertDocumentBatches(client, sql, userId, documents) {
  let changed = 0
  for (const batch of batched(documents)) {
    const result = await client.query(sql, [
      userId,
      JSON.stringify(batch.map(serializableDocument))
    ])
    changed += Number(result.rows[0]?.count || 0)
  }
  return changed
}

export function workspaceDocumentEmbeddingText(document) {
  return [
    document.title,
    Array.isArray(document.tags) ? document.tags.join(' ') : '',
    document.url,
    document.body
  ].filter(Boolean).join('\n').slice(0, MAX_INDEXED_TEXT_LENGTH)
}

export async function synchronizeWorkspaceSearchDocuments({ userId, poolInstance }) {
  if (typeof poolInstance?.connect !== 'function') {
    throw new TypeError('poolInstance.connect is required')
  }

  const client = await poolInstance.connect()
  let primaryError = null
  try {
    await client.query('BEGIN')
    await client.query(
      `
        INSERT INTO workspace_search_index_state (user_id, dirty, changed_at)
        VALUES ($1, TRUE, NOW())
        ON CONFLICT (user_id) DO NOTHING
      `,
      [userId]
    )
    const indexState = await client.query(
      `
        SELECT dirty
        FROM workspace_search_index_state
        WHERE user_id = $1
        FOR UPDATE
      `,
      [userId]
    )
    if (indexState.rows[0]?.dirty === false) {
      await client.query('COMMIT')
      return { indexed: 0, changed: 0, removed: 0, skipped: 'unchanged' }
    }
    const [bookmarks, notes] = await Promise.all([
      client.query(
        `
          SELECT id, title, url, description, tags, updated_at
          FROM nav_bookmarks
          WHERE user_id = $1
          ORDER BY id ASC
        `,
        [userId]
      ),
      client.query(
        `
          SELECT id, title, content, tags, updated_at
          FROM notes
          WHERE user_id = $1 AND encrypted = FALSE
          ORDER BY id ASC
        `,
        [userId]
      )
    ])

    const bookmarkDocuments = bookmarks.rows.map((row) => buildDocument({
        id: row.id,
        title: row.title,
        body: row.description,
        url: row.url,
        tags: row.tags,
        updatedAt: row.updated_at
      }))
    const noteDocuments = notes.rows.map((row) => buildDocument({
        id: row.id,
        title: row.title,
        body: row.content,
        url: '',
        tags: row.tags,
        updatedAt: row.updated_at
      }))
    const changed = (
      await upsertDocumentBatches(client, UPSERT_BOOKMARK_SQL, userId, bookmarkDocuments)
      + await upsertDocumentBatches(client, UPSERT_NOTE_SQL, userId, noteDocuments)
    )

    const removed = await client.query(
      `
        DELETE FROM workspace_search_documents AS document
        WHERE document.user_id = $1
          AND (
            (document.kind = 'bookmark' AND NOT EXISTS (
              SELECT 1 FROM nav_bookmarks AS bookmark
              WHERE bookmark.id = document.bookmark_id
                AND bookmark.user_id = document.user_id
            ))
            OR (document.kind = 'note' AND NOT EXISTS (
              SELECT 1 FROM notes AS note
              WHERE note.id = document.note_id
                AND note.user_id = document.user_id
                AND note.encrypted = FALSE
            ))
          )
      `,
      [userId]
    )
    await client.query(
      `
        UPDATE workspace_search_index_state
        SET dirty = FALSE, indexed_at = NOW()
        WHERE user_id = $1
      `,
      [userId]
    )
    await client.query('COMMIT')
    return {
      indexed: bookmarks.rows.length + notes.rows.length,
      changed,
      removed: Number(removed.rowCount || 0),
      skipped: null
    }
  } catch (error) {
    primaryError = error
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the primary indexing failure.
    }
    throw error
  } finally {
    client.release(primaryError || undefined)
  }
}
