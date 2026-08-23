import { withTransaction } from '../db/index.js'
import { withNavigationTransaction } from '../lib/navigationTransactions.js'
import { normalizeHttpUrl } from '../lib/urls.js'

const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024
const MAX_BOOKMARK_IMPORT_ITEMS = 1_000
const MAX_NOTE_IMPORT_ITEMS = 200
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function invalidImport(message, code = 'invalid_import') {
  const error = new Error(message)
  error.statusCode = 400
  error.code = code
  return error
}

function normalizeImportUrl(value, { optional = false } = {}) {
  const raw = normalizeText(value)
  if (!raw && optional) return ''
  try {
    const parsed = new URL(raw)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    if (parsed.username || parsed.password) return ''
    parsed.hash = ''
    return normalizeHttpUrl(parsed.toString())
  } catch {
    return ''
  }
}

function bookmarkDedupeKey(value) {
  const normalized = normalizeImportUrl(value)
  if (!normalized) return ''
  const parsed = new URL(normalized)
  parsed.hostname = parsed.hostname.toLowerCase()
  if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = ''
  }
  return parsed.href.replace(/\/$/, '')
}

export function normalizeBookmarkImportPayload(body) {
  if (!Array.isArray(body?.items) || !body.items.length || body.items.length > MAX_BOOKMARK_IMPORT_ITEMS) {
    throw invalidImport(`items must contain 1 to ${MAX_BOOKMARK_IMPORT_ITEMS} bookmarks`)
  }
  const targetGroupId = normalizeText(body.targetGroupId).toLowerCase()
  if (targetGroupId && !UUID_PATTERN.test(targetGroupId)) {
    throw invalidImport('targetGroupId must be a valid UUID', 'invalid_target_group')
  }

  return {
    targetGroupId,
    items: body.items.map((item, index) => {
      const url = normalizeImportUrl(item?.url)
      if (!url) throw invalidImport(`Bookmark ${index + 1} has an invalid URL`)
      const title = normalizeText(item?.title, new URL(url).hostname).slice(0, 200)
      if (!title) throw invalidImport(`Bookmark ${index + 1} requires a title`)
      const rawFavicon = normalizeText(item?.favicon)
      const favicon = rawFavicon ? normalizeImportUrl(rawFavicon, { optional: true }) : ''
      return {
        title,
        url,
        favicon,
        description: normalizeText(item?.description).slice(0, 500),
        folderName: normalizeText(item?.folderName).replace(/\s+/g, ' ').slice(0, 80)
      }
    })
  }
}

function normalizeDateOnly(value) {
  const input = normalizeText(value)
  if (!input) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null
  const parsed = new Date(`${input}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === input
    ? input
    : null
}

function normalizeDueAt(value) {
  if (value === null || value === undefined || normalizeText(value) === '') return null
  const input = normalizeText(value)
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(input)) return undefined
  const parsed = new Date(input)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

export function normalizeNoteImportPayload(body) {
  if (!Array.isArray(body?.notes) || !body.notes.length || body.notes.length > MAX_NOTE_IMPORT_ITEMS) {
    throw invalidImport(`notes must contain 1 to ${MAX_NOTE_IMPORT_ITEMS} entries`)
  }

  return body.notes.map((note, index) => {
    if (note?.encrypted || (Array.isArray(note?.attachments) && note.attachments.length)) {
      throw invalidImport(`Note ${index + 1} must be plain text without attachments`)
    }
    const type = note?.type === 'diary' ? 'diary' : 'memo'
    const title = normalizeText(note?.title).slice(0, 200)
    if (!title) throw invalidImport(`Note ${index + 1} requires a title`)
    const dueAt = type === 'memo' ? normalizeDueAt(note?.dueAt) : null
    if (dueAt === undefined) throw invalidImport(`Note ${index + 1} has an invalid dueAt`)
    const remindBeforeMinutes = Number(note?.remindBeforeMinutes || 0)
    if (!Number.isSafeInteger(remindBeforeMinutes) || remindBeforeMinutes < 0 || remindBeforeMinutes > 43_200) {
      throw invalidImport(`Note ${index + 1} has an invalid reminder lead`)
    }
    const entryDate = type === 'diary' ? normalizeDateOnly(note?.entryDate) : null
    if (type === 'diary' && note?.entryDate && !entryDate) {
      throw invalidImport(`Note ${index + 1} has an invalid entryDate`)
    }
    const tags = Array.isArray(note?.tags)
      ? [...new Set(note.tags.map((tag) => normalizeText(tag)).filter(Boolean))]
        .slice(0, 12)
        .map((tag) => tag.slice(0, 64))
      : []
    return {
      type,
      title,
      content: String(note?.content || ''),
      pinned: Boolean(note?.pinned),
      tags,
      entryDate,
      mood: type === 'diary' ? normalizeText(note?.mood).slice(0, 40) : '',
      dueAt,
      remindBeforeMinutes: type === 'memo' && dueAt ? remindBeforeMinutes : 0,
      completed: type === 'memo' && Boolean(note?.completed)
    }
  })
}

async function importBookmarks(client, userId, payload) {
  const groupsResult = await client.query(
    `
      SELECT *
      FROM nav_groups
      WHERE user_id = $1
      ORDER BY display_order ASC, created_at ASC, id ASC
      FOR UPDATE
    `,
    [userId]
  )
  await client.query(
    `
      SELECT id
      FROM nav_bookmarks
      WHERE user_id = $1
      ORDER BY group_id ASC, display_order ASC, created_at ASC, id ASC
      FOR UPDATE
    `,
    [userId]
  )

  const groups = [...groupsResult.rows]
  let fallbackGroup = payload.targetGroupId
    ? groups.find((group) => String(group.id).toLowerCase() === payload.targetGroupId)
    : groups[0]
  if (payload.targetGroupId && !fallbackGroup) {
    throw Object.assign(new Error('Target group not found'), {
      statusCode: 404,
      code: 'target_group_not_found'
    })
  }

  let nextGroupOrder = groups.reduce(
    (maximum, group) => Math.max(maximum, Number(group.display_order || 0) + 1),
    0
  )
  const createdGroups = []
  async function createGroup(name) {
    const result = await client.query(
      `
        INSERT INTO nav_groups (user_id, name, icon, color, display_order)
        VALUES ($1, $2, $3, '#667eea', $4)
        RETURNING *
      `,
      [userId, name, name.slice(0, 1) || 'D', nextGroupOrder]
    )
    nextGroupOrder += 1
    groups.push(result.rows[0])
    createdGroups.push(result.rows[0])
    return result.rows[0]
  }

  if (!fallbackGroup) fallbackGroup = await createGroup('导入书签')
  const groupsByName = new Map(groups.map((group) => [
    normalizeText(group.name).toLocaleLowerCase('zh-CN'),
    group
  ]))
  const existingRows = await client.query(
    'SELECT group_id, url FROM nav_bookmarks WHERE user_id = $1',
    [userId]
  )
  const dedupeKeys = new Set(existingRows.rows.map((bookmark) => (
    `${bookmark.group_id}|${bookmarkDedupeKey(bookmark.url)}`
  )))
  const nextOrderByGroup = new Map()
  const orderRows = await client.query(
    `
      SELECT group_id, COALESCE(MAX(display_order), -1) + 1 AS next_order
      FROM nav_bookmarks
      WHERE user_id = $1
      GROUP BY group_id
    `,
    [userId]
  )
  for (const row of orderRows.rows) nextOrderByGroup.set(String(row.group_id), Number(row.next_order || 0))

  const createdBookmarks = []
  let skippedDuplicates = 0
  for (const item of payload.items) {
    let group = fallbackGroup
    if (item.folderName) {
      const nameKey = item.folderName.toLocaleLowerCase('zh-CN')
      group = groupsByName.get(nameKey)
      if (!group) {
        group = await createGroup(item.folderName)
        groupsByName.set(nameKey, group)
      }
    }
    const groupId = String(group.id)
    const dedupeKey = `${groupId}|${bookmarkDedupeKey(item.url)}`
    if (dedupeKeys.has(dedupeKey)) {
      skippedDuplicates += 1
      continue
    }
    const nextOrder = nextOrderByGroup.get(groupId) || 0
    const result = await client.query(
      `
        INSERT INTO nav_bookmarks (
          user_id, group_id, title, url, favicon, description, tags, display_order
        ) VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7)
        RETURNING *
      `,
      [userId, groupId, item.title, item.url, item.favicon, item.description, nextOrder]
    )
    nextOrderByGroup.set(groupId, nextOrder + 1)
    dedupeKeys.add(dedupeKey)
    createdBookmarks.push(result.rows[0])
  }

  return {
    createdCount: createdBookmarks.length,
    createdGroupCount: createdGroups.length,
    skippedDuplicates
  }
}

export default async function productivityImportRoutes(fastify) {
  fastify.post('/imports/bookmarks', { bodyLimit: MAX_IMPORT_BODY_BYTES }, async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const payload = normalizeBookmarkImportPayload(request.body)
    const result = await withNavigationTransaction(
      request.currentUser.id,
      (client) => importBookmarks(client, request.currentUser.id, payload)
    )
    reply.code(201)
    return result
  })

  fastify.post('/imports/notes', { bodyLimit: MAX_IMPORT_BODY_BYTES }, async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const notes = normalizeNoteImportPayload(request.body)
    const inserted = await withTransaction(async (client) => {
      const rows = []
      for (const note of notes) {
        const result = await client.query(
          `
            INSERT INTO notes (
              user_id, type, title, content, encrypted, password_hash, pinned,
              tags, attachments, entry_date, mood, due_at,
              remind_before_minutes, completed
            ) VALUES (
              $1, $2, $3, $4, FALSE, '', $5,
              $6::jsonb, '[]'::jsonb, $7, $8, $9, $10, $11
            )
            RETURNING id
          `,
          [
            request.currentUser.id,
            note.type,
            note.title,
            note.content,
            note.pinned,
            JSON.stringify(note.tags),
            note.entryDate,
            note.mood,
            note.dueAt,
            note.remindBeforeMinutes,
            note.completed
          ]
        )
        rows.push(result.rows[0])
      }
      return rows
    })
    reply.code(201)
    return { createdCount: inserted.length }
  })
}
