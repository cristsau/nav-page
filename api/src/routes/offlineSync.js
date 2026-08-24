import { config } from '../config.js'
import { withTransaction } from '../db/index.js'
import { getImgBedOrigin } from '../lib/noteAttachments.js'
import {
  mapComment,
  mapCollaborationNote,
  requireNoteAccess
} from '../lib/noteCollaboration.js'
import { mapNote } from '../lib/notes.js'
import {
  normalizeCommentBlockId,
  normalizeCommentBody,
  normalizeCommentSelection
} from '../lib/noteCollaboration.js'
import {
  normalizeOfflineMutation,
  offlineMutationHash,
  isUuid
} from '../lib/offlineMutations.js'
import { archiveNoteVersion, pruneNoteVersions } from '../lib/noteVersions.js'
import {
  normalizeContentFormat,
  plainTextToTiptapDocument,
  sanitizeTiptapDocument,
  tiptapDocumentText
} from '../lib/noteRichContent.js'

const MAX_BATCH = 100

function normalizeText(value, fallback = '', max = 200_000) {
  return String(value ?? fallback).trim().slice(0, max)
}

function normalizeTags(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))]
    .slice(0, 24)
}

function normalizeType(value, fallback = 'memo') {
  const type = String(value || fallback).trim().toLowerCase()
  return ['memo', 'diary'].includes(type) ? type : fallback
}

function normalizeDate(value, fallback = null) {
  if (value === undefined) return fallback
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function normalizeDateOnly(value, fallback = null) {
  if (value === undefined) return fallback
  const input = String(value || '').trim()
  if (!input) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return undefined
  const date = new Date(`${input}T00:00:00Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input
    ? undefined
    : input
}

function richContent(payload, existing = null) {
  const contentFormat = normalizeContentFormat(
    payload.contentFormat,
    existing?.content_format || 'plain'
  )
  const rawContent = payload.content === undefined
    ? String(existing?.content || '')
    : String(payload.content || '')
  if (contentFormat === 'plain') {
    return { content: rawContent, contentFormat, contentJson: null }
  }
  const source = payload.contentJson === undefined
    ? (existing?.content_json || plainTextToTiptapDocument(rawContent))
    : payload.contentJson
  const contentJson = sanitizeTiptapDocument(source, {
    allowedImageOrigin: getImgBedOrigin(config.imgBedBaseUrl)
  })
  return {
    content: tiptapDocumentText(contentJson),
    contentFormat,
    contentJson
  }
}

async function selectReceipt(client, userId, mutation) {
  const requestHash = offlineMutationHash(mutation.kind, mutation.payload)
  const { rows } = await client.query(
    `
      SELECT request_hash, response_status, response_payload
      FROM offline_mutation_receipts
      WHERE user_id = $1 AND operation_id = $2 AND expires_at > NOW()
      FOR UPDATE
    `,
    [userId, mutation.operationId]
  )
  if (!rows.length) return { requestHash, cached: null }
  if (rows[0].request_hash !== requestHash) {
    return {
      requestHash,
      cached: {
        status: 409,
        payload: {
          error: 'Operation ID was already used with different content',
          code: 'offline_operation_conflict'
        }
      }
    }
  }
  return {
    requestHash,
    cached: {
      status: Number(rows[0].response_status),
      payload: rows[0].response_payload,
      replayed: true
    }
  }
}

async function saveReceipt(client, userId, mutation, requestHash, outcome) {
  await client.query(
    `
      INSERT INTO offline_mutation_receipts (
        user_id, operation_id, mutation_kind, request_hash,
        response_status, response_payload
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (user_id, operation_id) DO NOTHING
    `,
    [
      userId,
      mutation.operationId,
      mutation.kind,
      requestHash,
      outcome.status,
      JSON.stringify(outcome.payload)
    ]
  )
}

function invalid(message, code = 'invalid_offline_mutation') {
  return { status: 400, payload: { error: message, code } }
}

function missing(message = 'Note or comment was not found') {
  return { status: 404, payload: { error: message, code: 'offline_target_not_found' } }
}

function denied(message = 'You do not have permission for this offline mutation') {
  return { status: 403, payload: { error: message, code: 'offline_access_denied' } }
}

async function mutateNoteCreate(client, user, payload) {
  if (!isUuid(payload.id)) return invalid('Offline notes require a UUID id')
  const title = normalizeText(payload.title, '', 300)
  if (!title) return invalid('Title is required')
  if (payload.encrypted) {
    return invalid(
      'Encrypted notes remain local-only while offline',
      'encrypted_offline_sync_disabled'
    )
  }
  let content
  try {
    content = richContent(payload)
  } catch (error) {
    return invalid(error.message, 'invalid_rich_content')
  }
  const type = normalizeType(payload.type)
  const dueAt = type === 'memo' ? normalizeDate(payload.dueAt) : null
  const entryDate = type === 'diary'
    ? normalizeDateOnly(payload.entryDate, new Date().toISOString().slice(0, 10))
    : null
  if (dueAt === undefined || entryDate === undefined) return invalid('Offline note date is invalid')
  const remindBeforeMinutes = type === 'memo' && dueAt
    ? Number(payload.remindBeforeMinutes || 0)
    : 0
  if (!Number.isSafeInteger(remindBeforeMinutes) || remindBeforeMinutes < 0 || remindBeforeMinutes > 43_200) {
    return invalid('remindBeforeMinutes must be an integer from 0 to 43200')
  }

  const inserted = await client.query(
    `
      INSERT INTO notes (
        id, user_id, type, title, content, content_format, content_json,
        encrypted, password_hash, pinned, tags, attachments, entry_date,
        mood, due_at, remind_before_minutes, completed
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::jsonb,
        FALSE, '', $8, $9::jsonb, '[]'::jsonb, $10,
        $11, $12, $13, $14
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `,
    [
      payload.id,
      user.id,
      type,
      title,
      content.content,
      content.contentFormat,
      content.contentJson ? JSON.stringify(content.contentJson) : null,
      Boolean(payload.pinned),
      JSON.stringify(normalizeTags(payload.tags)),
      entryDate,
      type === 'diary' ? normalizeText(payload.mood, '', 40) : '',
      dueAt,
      remindBeforeMinutes,
      type === 'memo' && Boolean(payload.completed)
    ]
  )
  if (inserted.rows.length) return { status: 201, payload: { note: mapNote(inserted.rows[0]) } }
  const existing = await client.query('SELECT * FROM notes WHERE id = $1', [payload.id])
  if (String(existing.rows[0]?.user_id || '') !== String(user.id)) return denied()
  return { status: 200, payload: { note: mapNote(existing.rows[0]), replayed: true } }
}

async function mutateNoteUpdate(client, user, payload) {
  if (!isUuid(payload.id)) return invalid('Note id is invalid')
  const replyState = { statusCode: 200, code(value) { this.statusCode = value } }
  const access = await requireNoteAccess({
    queryFn: client.query.bind(client),
    userId: user.id,
    noteId: payload.id,
    reply: replyState,
    requiredRole: 'editor',
    forUpdate: true
  })
  if (!access) return replyState.statusCode === 403 ? denied() : missing()
  if (access.encrypted) return invalid('Encrypted notes cannot use server offline sync', 'encrypted_offline_sync_disabled')
  const expectedRevision = Number(payload.revision || 0)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return invalid('A positive base revision is required')
  }
  if (expectedRevision !== Number(access.revision || 1)) {
    return {
      status: 409,
      payload: {
        error: 'Note changed on another device; review the server copy',
        code: 'offline_revision_conflict',
        serverNote: mapCollaborationNote(access)
      }
    }
  }
  let content
  try {
    content = richContent(payload, access)
  } catch (error) {
    return invalid(error.message, 'invalid_rich_content')
  }
  const type = normalizeType(payload.type, access.type)
  const dueAt = type === 'memo' ? normalizeDate(payload.dueAt, access.due_at) : null
  const entryDate = type === 'diary'
    ? normalizeDateOnly(payload.entryDate, access.entry_date)
    : null
  if (dueAt === undefined || entryDate === undefined) return invalid('Offline note date is invalid')
  const remindBeforeMinutes = type === 'memo' && dueAt
    ? Number(payload.remindBeforeMinutes ?? access.remind_before_minutes ?? 0)
    : 0
  if (!Number.isSafeInteger(remindBeforeMinutes) || remindBeforeMinutes < 0 || remindBeforeMinutes > 43_200) {
    return invalid('remindBeforeMinutes must be an integer from 0 to 43200')
  }
  await archiveNoteVersion(client, access)
  const updated = await client.query(
    `
      UPDATE notes
      SET type = $3,
          title = $4,
          content = $5,
          content_format = $6,
          content_json = $7::jsonb,
          pinned = $8,
          tags = $9::jsonb,
          entry_date = $10,
          mood = $11,
          due_at = $12,
          remind_before_minutes = $13,
          completed = $14,
          revision = revision + 1,
          updated_at = NOW()
      WHERE id = $1 AND revision = $2
      RETURNING *
    `,
    [
      payload.id,
      expectedRevision,
      type,
      normalizeText(payload.title, access.title, 300) || access.title,
      content.content,
      content.contentFormat,
      content.contentJson ? JSON.stringify(content.contentJson) : null,
      payload.pinned === undefined ? access.pinned : Boolean(payload.pinned),
      JSON.stringify(normalizeTags(payload.tags, access.tags)),
      entryDate,
      type === 'diary' ? normalizeText(payload.mood, access.mood, 40) : '',
      dueAt,
      remindBeforeMinutes,
      type === 'memo'
        ? (payload.completed === undefined ? access.completed : Boolean(payload.completed))
        : false
    ]
  )
  if (!updated.rows.length) return { status: 409, payload: { error: 'Note revision changed', code: 'offline_revision_conflict' } }
  await pruneNoteVersions(client, access.user_id, access.id)
  return { status: 200, payload: { note: mapCollaborationNote({ ...updated.rows[0], access_role: access.access_role, owner_username: access.owner_username }) } }
}

async function mutateNoteMetadata(client, user, payload) {
  if (!isUuid(payload.id)) return invalid('Note id is invalid')
  const replyState = { statusCode: 200, code(value) { this.statusCode = value } }
  const access = await requireNoteAccess({
    queryFn: client.query.bind(client),
    userId: user.id,
    noteId: payload.id,
    reply: replyState,
    requiredRole: 'editor',
    forUpdate: true
  })
  if (!access) return replyState.statusCode === 403 ? denied() : missing()
  if (access.encrypted) return invalid('Encrypted notes cannot use server offline sync', 'encrypted_offline_sync_disabled')
  const type = normalizeType(payload.type, access.type)
  const dueAt = type === 'memo' ? normalizeDate(payload.dueAt, access.due_at) : null
  const entryDate = type === 'diary'
    ? normalizeDateOnly(payload.entryDate, access.entry_date)
    : null
  if (dueAt === undefined || entryDate === undefined) return invalid('Offline note date is invalid')
  const remindBeforeMinutes = type === 'memo' && dueAt
    ? Number(payload.remindBeforeMinutes ?? access.remind_before_minutes ?? 0)
    : 0
  if (!Number.isSafeInteger(remindBeforeMinutes) || remindBeforeMinutes < 0 || remindBeforeMinutes > 43_200) {
    return invalid('remindBeforeMinutes must be an integer from 0 to 43200')
  }
  await archiveNoteVersion(client, access)
  const { rows } = await client.query(
    `
      UPDATE notes
      SET type = $2,
          title = $3,
          tags = $4::jsonb,
          entry_date = $5,
          mood = $6,
          due_at = $7,
          remind_before_minutes = $8,
          completed = $9,
          revision = revision + 1,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      payload.id,
      type,
      normalizeText(payload.title, access.title, 300) || access.title,
      JSON.stringify(normalizeTags(payload.tags, access.tags)),
      entryDate,
      type === 'diary' ? normalizeText(payload.mood, access.mood, 40) : '',
      dueAt,
      remindBeforeMinutes,
      type === 'memo'
        ? (payload.completed === undefined ? access.completed : Boolean(payload.completed))
        : false
    ]
  )
  await pruneNoteVersions(client, access.user_id, access.id)
  return {
    status: 200,
    payload: {
      note: mapCollaborationNote({
        ...rows[0],
        access_role: access.access_role,
        owner_username: access.owner_username
      })
    }
  }
}

async function mutateNoteDelete(client, user, payload) {
  if (!isUuid(payload.id)) return invalid('Note id is invalid')
  const deleted = await client.query(
    'DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING id',
    [payload.id, user.id]
  )
  return deleted.rows.length ? { status: 200, payload: { ok: true } } : missing()
}

async function getComment(client, noteId, commentId) {
  const { rows } = await client.query(
    `SELECT c.*, u.username FROM note_comments c JOIN users u ON u.id = c.user_id
     WHERE c.note_id = $1 AND c.id = $2 LIMIT 1`,
    [noteId, commentId]
  )
  return rows[0] || null
}

async function commentAccess(client, userId, noteId, role = 'commenter') {
  const replyState = { statusCode: 200, code(value) { this.statusCode = value } }
  const access = await requireNoteAccess({
    queryFn: client.query.bind(client),
    userId,
    noteId,
    reply: replyState,
    requiredRole: role,
    forUpdate: true
  })
  return { access, statusCode: replyState.statusCode }
}

async function mutateCommentCreate(client, user, payload) {
  if (!isUuid(payload.id) || !isUuid(payload.noteId)) return invalid('Comment or note id is invalid')
  const { access, statusCode } = await commentAccess(client, user.id, payload.noteId)
  if (!access) return statusCode === 403 ? denied() : missing()
  const body = normalizeCommentBody(payload.body)
  const blockId = normalizeCommentBlockId(payload.blockId)
  const selection = normalizeCommentSelection(payload.selection)
  const parentId = payload.parentId ? String(payload.parentId) : null
  if (!body || blockId === '' || selection === undefined || (parentId && !isUuid(parentId))) {
    return invalid('Comment content or anchor is invalid')
  }
  if (parentId && !(await getComment(client, payload.noteId, parentId))) return missing('Parent comment was not found')
  const inserted = await client.query(
    `
      INSERT INTO note_comments (id, note_id, user_id, parent_id, block_id, selection, body)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `,
    [payload.id, payload.noteId, user.id, parentId, blockId, selection ? JSON.stringify(selection) : null, body]
  )
  const record = inserted.rows[0] || await getComment(client, payload.noteId, payload.id)
  if (!record) return missing()
  if (String(record.user_id) !== String(user.id)) return denied()
  return { status: inserted.rows.length ? 201 : 200, payload: { comment: mapComment({ ...record, username: user.username }) } }
}

async function mutateCommentUpdate(client, user, payload) {
  if (!isUuid(payload.id) || !isUuid(payload.noteId)) return invalid('Comment or note id is invalid')
  const { access, statusCode } = await commentAccess(client, user.id, payload.noteId)
  if (!access) return statusCode === 403 ? denied() : missing()
  const comment = await getComment(client, payload.noteId, payload.id)
  if (!comment) return missing('Comment was not found')
  if (String(comment.user_id) !== String(user.id) && !['owner', 'editor'].includes(access.access_role)) return denied()
  const body = normalizeCommentBody(payload.body)
  if (!body) return invalid('Comment body is invalid')
  const { rows } = await client.query(
    `UPDATE note_comments SET body = $3, edited_at = NOW(), updated_at = NOW()
     WHERE note_id = $1 AND id = $2 RETURNING *`,
    [payload.noteId, payload.id, body]
  )
  return { status: 200, payload: { comment: mapComment({ ...rows[0], username: comment.username }) } }
}

async function mutateCommentResolve(client, user, payload) {
  if (!isUuid(payload.id) || !isUuid(payload.noteId)) return invalid('Comment or note id is invalid')
  const { access, statusCode } = await commentAccess(client, user.id, payload.noteId)
  if (!access) return statusCode === 403 ? denied() : missing()
  const comment = await getComment(client, payload.noteId, payload.id)
  if (!comment) return missing('Comment was not found')
  const resolved = payload.resolved !== false
  const { rows } = await client.query(
    `
      UPDATE note_comments
      SET status = $3,
          resolved_by = $4,
          resolved_at = $5,
          updated_at = NOW()
      WHERE note_id = $1 AND id = $2
      RETURNING *
    `,
    [payload.noteId, payload.id, resolved ? 'resolved' : 'open', resolved ? user.id : null, resolved ? new Date().toISOString() : null]
  )
  return { status: 200, payload: { comment: mapComment({ ...rows[0], username: comment.username }) } }
}

async function mutateCommentDelete(client, user, payload) {
  if (!isUuid(payload.id) || !isUuid(payload.noteId)) return invalid('Comment or note id is invalid')
  const { access, statusCode } = await commentAccess(client, user.id, payload.noteId)
  if (!access) return statusCode === 403 ? denied() : missing()
  const comment = await getComment(client, payload.noteId, payload.id)
  if (!comment) return missing('Comment was not found')
  if (String(comment.user_id) !== String(user.id) && access.access_role !== 'owner') return denied()
  await client.query('DELETE FROM note_comments WHERE note_id = $1 AND id = $2', [payload.noteId, payload.id])
  return { status: 200, payload: { ok: true } }
}

async function executeMutation(client, user, mutation) {
  if (mutation.kind === 'note.create') return mutateNoteCreate(client, user, mutation.payload)
  if (mutation.kind === 'note.update') return mutateNoteUpdate(client, user, mutation.payload)
  if (mutation.kind === 'note.metadata') return mutateNoteMetadata(client, user, mutation.payload)
  if (mutation.kind === 'note.delete') return mutateNoteDelete(client, user, mutation.payload)
  if (mutation.kind === 'comment.create') return mutateCommentCreate(client, user, mutation.payload)
  if (mutation.kind === 'comment.update') return mutateCommentUpdate(client, user, mutation.payload)
  if (mutation.kind === 'comment.resolve') return mutateCommentResolve(client, user, mutation.payload)
  if (mutation.kind === 'comment.delete') return mutateCommentDelete(client, user, mutation.payload)
  return invalid('Offline mutation kind is not supported')
}

export default async function offlineSyncRoutes(fastify) {
  fastify.post('/collaboration/sync/mutations', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const rawMutations = Array.isArray(request.body?.mutations) ? request.body.mutations : []
    if (!rawMutations.length || rawMutations.length > MAX_BATCH) {
      reply.code(400)
      return { error: `mutations must contain 1 to ${MAX_BATCH} operations`, code: 'invalid_offline_batch' }
    }
    const mutations = rawMutations.map(normalizeOfflineMutation)
    if (mutations.some((mutation) => !mutation)) {
      reply.code(400)
      return { error: 'Offline mutation envelope is invalid', code: 'invalid_offline_batch' }
    }

    const results = []
    for (const mutation of mutations) {
      const outcome = await withTransaction(async (client) => {
        const receipt = await selectReceipt(client, request.currentUser.id, mutation)
        if (receipt.cached) return receipt.cached
        const executed = await executeMutation(client, request.currentUser, mutation)
        await saveReceipt(client, request.currentUser.id, mutation, receipt.requestHash, executed)
        return executed
      })
      results.push({
        operationId: mutation.operationId,
        kind: mutation.kind,
        status: outcome.status,
        replayed: Boolean(outcome.replayed),
        ...outcome.payload
      })
    }
    reply.header('Cache-Control', 'private, no-store')
    return { results }
  })
}
