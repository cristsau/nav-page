import { query, withTransaction } from '../db/index.js'
import { config } from '../config.js'
import { archiveNoteVersion, pruneNoteVersions } from '../lib/noteVersions.js'
import {
  getImgBedOrigin,
  normalizeNoteAttachments
} from '../lib/noteAttachments.js'
import {
  markUnreferencedAutoAssetsForDeletion,
  syncNoteMediaReferences
} from '../lib/mediaAssets.js'
import {
  mapCollaborator,
  mapCollaborationNote,
  mapComment,
  mapSyncEvent,
  normalizeCollaborationRole,
  normalizeCommentBlockId,
  normalizeCommentBody,
  normalizeCommentSelection,
  requireNoteAccess
} from '../lib/noteCollaboration.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validUuid(value) {
  return UUID_PATTERN.test(String(value || '').trim())
}

function invalid(reply, message, code = 'invalid_collaboration_request') {
  reply.code(400)
  return { error: message, code }
}

function denied(reply, message = 'You do not have permission for this collaboration action') {
  if (reply.statusCode < 400) reply.code(403)
  return { error: message, code: 'collaboration_access_denied' }
}

function missing(reply, message = 'Collaborative note was not found') {
  if (reply.statusCode < 400) reply.code(404)
  return { error: message, code: 'collaboration_not_found' }
}

function normalizeMetadata(existing, body = {}) {
  const type = ['memo', 'diary'].includes(String(body.type || existing.type).trim().toLowerCase())
    ? String(body.type || existing.type).trim().toLowerCase()
    : existing.type
  const title = String(body.title ?? existing.title).trim().slice(0, 500) || existing.title
  const tags = (body.tags === undefined ? existing.tags : body.tags)
  if (!Array.isArray(tags)) return { error: '标签格式无效' }
  const normalizedTags = [...new Set(tags
    .map((tag) => String(tag || '').trim())
    .filter(Boolean))]
    .slice(0, 20)
  if (normalizedTags.some((tag) => tag.length > 64)) return { error: '标签长度不能超过 64 个字符' }

  const rawEntryDate = String(body.entryDate ?? existing.entry_date ?? '').trim()
  const entryDate = type === 'diary'
    ? (/^\d{4}-\d{2}-\d{2}$/.test(rawEntryDate) ? rawEntryDate : new Date().toISOString().slice(0, 10))
    : null
  const mood = type === 'diary'
    ? String(body.mood ?? existing.mood ?? '').trim().slice(0, 40)
    : ''
  let dueAt = null
  if (type === 'memo' && body.dueAt !== null && body.dueAt !== undefined && body.dueAt !== '') {
    const parsed = new Date(body.dueAt)
    if (Number.isNaN(parsed.getTime())) return { error: '截止时间格式无效' }
    dueAt = parsed.toISOString()
  } else if (type === 'memo' && body.dueAt === undefined && existing.due_at) {
    dueAt = new Date(existing.due_at).toISOString()
  }
  const reminder = Number(body.remindBeforeMinutes ?? existing.remind_before_minutes ?? 0)
  if (!Number.isSafeInteger(reminder) || reminder < 0 || reminder > 43200) {
    return { error: '提前提醒分钟数必须在 0 到 43200 之间' }
  }
  let attachments = normalizeNoteAttachments(existing.attachments, {
    maxBytes: Number.MAX_SAFE_INTEGER
  })
  if (body.attachments !== undefined) {
    if (existing.access_role !== 'owner') {
      return { error: '只有笔记所有者可以管理协作笔记图片' }
    }
    attachments = normalizeNoteAttachments(body.attachments, {
      allowedOrigin: getImgBedOrigin(config.imgBedBaseUrl),
      maxBytes: config.imgBedMaxImageBytes,
      strict: true
    })
  }
  return {
    value: {
      type,
      title,
      tags: normalizedTags,
      entryDate,
      mood,
      dueAt,
      remindBeforeMinutes: type === 'memo' && dueAt ? reminder : 0,
      completed: type === 'memo' ? Boolean(body.completed ?? existing.completed) : false,
      attachments
    }
  }
}

async function listAccessibleNotes(client, userId) {
  const { rows } = await client.query(
    `
      SELECT
        n.*,
        owner.username AS owner_username,
        CASE WHEN n.user_id = $1 THEN 'owner' ELSE current_member.role END AS access_role,
        (
          SELECT COUNT(*)::integer
          FROM note_collaborators member_count
          WHERE member_count.note_id = n.id
        ) AS collaborator_count,
        (
          SELECT COUNT(*)::integer
          FROM note_comments comment_count
          WHERE comment_count.note_id = n.id
            AND comment_count.status = 'open'
        ) AS open_comment_count,
        active_share.id AS share_id,
        active_share.code AS share_code,
        active_share.expire_at AS share_expire_at,
        active_share.view_count AS share_view_count
      FROM notes n
      JOIN users owner ON owner.id = n.user_id
      LEFT JOIN note_collaborators current_member
        ON current_member.note_id = n.id
       AND current_member.user_id = $1
      LEFT JOIN LATERAL (
        SELECT id, code, expire_at, view_count
        FROM note_shares
        WHERE note_id = n.id
          AND (expire_at IS NULL OR expire_at > NOW())
        ORDER BY created_at DESC
        LIMIT 1
      ) active_share ON TRUE
      WHERE n.user_id = $1 OR current_member.user_id = $1
      ORDER BY n.pinned DESC, n.updated_at DESC, n.id
    `,
    [userId]
  )
  return rows.map(mapCollaborationNote)
}

async function listMembers(client, noteId) {
  const { rows } = await client.query(
    `
      SELECT c.*, u.username
      FROM note_collaborators c
      JOIN users u ON u.id = c.user_id
      WHERE c.note_id = $1
      ORDER BY c.created_at ASC, c.user_id ASC
    `,
    [noteId]
  )
  return rows.map(mapCollaborator)
}

async function listComments(client, noteId) {
  const { rows } = await client.query(
    `
      SELECT c.*, u.username
      FROM note_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.note_id = $1
      ORDER BY c.created_at ASC, c.id ASC
    `,
    [noteId]
  )
  return rows.map(mapComment)
}

async function requireComment(client, commentId, noteId = '') {
  const params = [commentId]
  const noteFilter = noteId ? 'AND c.note_id = $2' : ''
  if (noteId) params.push(noteId)
  const { rows } = await client.query(
    `
      SELECT c.*, u.username
      FROM note_comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = $1
      ${noteFilter}
      LIMIT 1
    `,
    params
  )
  return rows[0] || null
}

export default async function collaborationRoutes(fastify) {
  fastify.get('/collaboration/notes', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    return { notes: await listAccessibleNotes({ query }, request.currentUser.id) }
  })

  fastify.get('/collaboration/notes/:noteId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (!validUuid(request.params.noteId)) return missing(reply)

    const access = await requireNoteAccess({
      queryFn: query,
      userId: request.currentUser.id,
      noteId: request.params.noteId,
      reply
    })
    if (!access) return missing(reply)

    const [members, comments] = await Promise.all([
      listMembers({ query }, request.params.noteId),
      listComments({ query }, request.params.noteId)
    ])
    return {
      note: mapCollaborationNote({
        ...access,
        collaborator_count: members.length,
        open_comment_count: comments.filter((comment) => comment.status === 'open').length
      }),
      members,
      comments
    }
  })

  fastify.patch('/collaboration/notes/:noteId/metadata', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (!validUuid(request.params.noteId)) return missing(reply)

    const result = await withTransaction(async (client) => {
      const access = await requireNoteAccess({
        queryFn: client.query.bind(client),
        userId: request.currentUser.id,
        noteId: request.params.noteId,
        reply,
        requiredRole: 'editor',
        forUpdate: true
      })
      if (!access) return { status: reply.statusCode === 403 ? 'denied' : 'missing' }
      if (access.encrypted) return { status: 'encrypted' }
      const normalized = normalizeMetadata(access, request.body)
      if (normalized.error) return { status: 'invalid', error: normalized.error }
      const metadata = normalized.value
      await archiveNoteVersion(client, access)
      const previousAttachments = normalizeNoteAttachments(access.attachments, {
        maxBytes: Number.MAX_SAFE_INTEGER
      })
      const mediaSync = await syncNoteMediaReferences(
        client,
        access.user_id,
        previousAttachments,
        metadata.attachments
      )
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
               attachments = $10::jsonb,
               revision = revision + 1,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          request.params.noteId,
          metadata.type,
          metadata.title,
          JSON.stringify(metadata.tags),
          metadata.entryDate,
          metadata.mood,
          metadata.dueAt,
          metadata.remindBeforeMinutes,
          metadata.completed,
          JSON.stringify(metadata.attachments)
        ]
      )
      await markUnreferencedAutoAssetsForDeletion(
        client,
        access.user_id,
        mediaSync.removed
      )
      await pruneNoteVersions(client, access.user_id, request.params.noteId)
      return {
        status: 'ok',
        note: mapCollaborationNote({
          ...rows[0],
          owner_username: access.owner_username,
          access_role: access.access_role,
          collaborator_count: access.collaborator_count || 0,
          open_comment_count: access.open_comment_count || 0
        })
      }
    })
    if (result.status === 'missing') return missing(reply)
    if (result.status === 'denied') return denied(reply)
    if (result.status === 'encrypted') return invalid(reply, '加密笔记不能使用服务器协作', 'encrypted_note_collaboration_disabled')
    if (result.status === 'invalid') return invalid(reply, result.error)
    return { note: result.note }
  })

  fastify.get('/collaboration/notes/:noteId/members', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const access = await requireNoteAccess({
      queryFn: query,
      userId: request.currentUser.id,
      noteId: request.params.noteId,
      reply
    })
    if (!access) return missing(reply)
    return { members: await listMembers({ query }, request.params.noteId) }
  })

  fastify.post('/collaboration/notes/:noteId/members', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const username = String(request.body?.username || '').trim()
    const role = normalizeCollaborationRole(request.body?.role)
    if (!username || username.length > 120) return invalid(reply, '请输入有效用户名')
    if (!role) return invalid(reply, '协作者角色必须是 editor、commenter 或 viewer')

    const result = await withTransaction(async (client) => {
      const access = await requireNoteAccess({
        queryFn: client.query.bind(client),
        userId: request.currentUser.id,
        noteId: request.params.noteId,
        reply,
        requiredRole: 'owner',
        forUpdate: true
      })
      if (!access) return { status: reply.statusCode === 403 ? 'denied' : 'missing' }
      if (access.encrypted) return { status: 'encrypted' }

      const target = await client.query(
        `
          SELECT id, username
          FROM users
          WHERE LOWER(username) = LOWER($1)
            AND status = 'approved'
          LIMIT 1
        `,
        [username]
      )
      if (!target.rows.length) return { status: 'unknown-user' }
      if (String(target.rows[0].id) === String(request.currentUser.id)) {
        return { status: 'owner' }
      }

      const { rows } = await client.query(
        `
          INSERT INTO note_collaborators (
            note_id, user_id, role, invited_by
          ) VALUES ($1, $2, $3, $4)
          ON CONFLICT (note_id, user_id) DO UPDATE
          SET role = EXCLUDED.role,
              invited_by = EXCLUDED.invited_by,
              updated_at = NOW()
          RETURNING *
        `,
        [request.params.noteId, target.rows[0].id, role, request.currentUser.id]
      )
      return {
        status: 'ok',
        member: mapCollaborator({ ...rows[0], username: target.rows[0].username })
      }
    })

    if (result.status === 'missing') return missing(reply)
    if (result.status === 'denied') return denied(reply)
    if (result.status === 'encrypted') return invalid(reply, '加密笔记不能启用服务器协作', 'encrypted_note_collaboration_disabled')
    if (result.status === 'unknown-user') return missing(reply, '未找到已批准的用户')
    if (result.status === 'owner') return invalid(reply, '笔记所有者无需重复添加为协作者')
    reply.code(201)
    return { member: result.member }
  })

  fastify.patch('/collaboration/notes/:noteId/members/:userId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const role = normalizeCollaborationRole(request.body?.role)
    if (!role) return invalid(reply, '协作者角色必须是 editor、commenter 或 viewer')
    if (!validUuid(request.params.userId)) return missing(reply, '协作者不存在')

    const result = await withTransaction(async (client) => {
      const access = await requireNoteAccess({
        queryFn: client.query.bind(client),
        userId: request.currentUser.id,
        noteId: request.params.noteId,
        reply,
        requiredRole: 'owner',
        forUpdate: true
      })
      if (!access) return { status: reply.statusCode === 403 ? 'denied' : 'missing' }
      const { rows } = await client.query(
        `
          UPDATE note_collaborators
          SET role = $3, invited_by = $4, updated_at = NOW()
          WHERE note_id = $1 AND user_id = $2
          RETURNING *
        `,
        [request.params.noteId, request.params.userId, role, request.currentUser.id]
      )
      if (!rows.length) return { status: 'member-missing' }
      const username = await client.query('SELECT username FROM users WHERE id = $1', [request.params.userId])
      return {
        status: 'ok',
        member: mapCollaborator({ ...rows[0], username: username.rows[0]?.username || '' })
      }
    })
    if (result.status === 'missing' || result.status === 'member-missing') return missing(reply, '协作者不存在')
    if (result.status === 'denied') return denied(reply)
    return { member: result.member }
  })

  fastify.delete('/collaboration/notes/:noteId/members/:userId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (!validUuid(request.params.userId)) return missing(reply, '协作者不存在')
    const result = await withTransaction(async (client) => {
      const access = await requireNoteAccess({
        queryFn: client.query.bind(client),
        userId: request.currentUser.id,
        noteId: request.params.noteId,
        reply,
        requiredRole: 'owner',
        forUpdate: true
      })
      if (!access) return { status: reply.statusCode === 403 ? 'denied' : 'missing' }
      const deleted = await client.query(
        'DELETE FROM note_collaborators WHERE note_id = $1 AND user_id = $2 RETURNING user_id',
        [request.params.noteId, request.params.userId]
      )
      return { status: deleted.rows.length ? 'ok' : 'member-missing' }
    })
    if (result.status === 'missing' || result.status === 'member-missing') return missing(reply, '协作者不存在')
    if (result.status === 'denied') return denied(reply)
    return { ok: true }
  })

  fastify.get('/collaboration/notes/:noteId/comments', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const access = await requireNoteAccess({
      queryFn: query,
      userId: request.currentUser.id,
      noteId: request.params.noteId,
      reply
    })
    if (!access) return missing(reply)
    return { comments: await listComments({ query }, request.params.noteId) }
  })

  fastify.post('/collaboration/notes/:noteId/comments', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const body = normalizeCommentBody(request.body?.body)
    const blockId = normalizeCommentBlockId(request.body?.blockId)
    const selection = normalizeCommentSelection(request.body?.selection)
    const parentId = request.body?.parentId ? String(request.body.parentId).trim() : null
    if (!body) return invalid(reply, '评论正文必须为 1 到 4000 个字符')
    if (blockId === '') return invalid(reply, '评论块标识过长')
    if (selection === undefined) return invalid(reply, '评论选区格式无效')
    if (parentId && !validUuid(parentId)) return invalid(reply, '父评论 ID 无效')

    const result = await withTransaction(async (client) => {
      const access = await requireNoteAccess({
        queryFn: client.query.bind(client),
        userId: request.currentUser.id,
        noteId: request.params.noteId,
        reply,
        requiredRole: 'commenter',
        forUpdate: true
      })
      if (!access) return { status: reply.statusCode === 403 ? 'denied' : 'missing' }
      if (access.encrypted) return { status: 'encrypted' }
      if (parentId) {
        const parent = await requireComment(client, parentId, request.params.noteId)
        if (!parent) return { status: 'parent-missing' }
      }
      const { rows } = await client.query(
        `
          INSERT INTO note_comments (
            note_id, user_id, parent_id, block_id, selection, body
          ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
          RETURNING *
        `,
        [
          request.params.noteId,
          request.currentUser.id,
          parentId,
          blockId,
          selection ? JSON.stringify(selection) : null,
          body
        ]
      )
      return {
        status: 'ok',
        comment: mapComment({ ...rows[0], username: request.currentUser.username })
      }
    })
    if (result.status === 'missing') return missing(reply)
    if (result.status === 'denied') return denied(reply)
    if (result.status === 'encrypted') return invalid(reply, '加密笔记不能使用服务器评论', 'encrypted_note_collaboration_disabled')
    if (result.status === 'parent-missing') return missing(reply, '父评论不存在')
    reply.code(201)
    return { comment: result.comment }
  })

  fastify.patch('/collaboration/notes/:noteId/comments/:commentId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const body = normalizeCommentBody(request.body?.body)
    if (!body) return invalid(reply, '评论正文必须为 1 到 4000 个字符')
    if (!validUuid(request.params.commentId)) return missing(reply, '评论不存在')

    const result = await withTransaction(async (client) => {
      const access = await requireNoteAccess({
        queryFn: client.query.bind(client),
        userId: request.currentUser.id,
        noteId: request.params.noteId,
        reply,
        requiredRole: 'commenter',
        forUpdate: true
      })
      if (!access) return { status: reply.statusCode === 403 ? 'denied' : 'missing' }
      const comment = await requireComment(client, request.params.commentId, request.params.noteId)
      if (!comment) return { status: 'comment-missing' }
      if (
        String(comment.user_id) !== String(request.currentUser.id)
        && !['owner', 'editor'].includes(access.access_role)
      ) return { status: 'denied' }
      const { rows } = await client.query(
        `
          UPDATE note_comments
          SET body = $3, edited_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND note_id = $2
          RETURNING *
        `,
        [request.params.commentId, request.params.noteId, body]
      )
      return {
        status: 'ok',
        comment: mapComment({ ...rows[0], username: comment.username })
      }
    })
    if (result.status === 'missing' || result.status === 'comment-missing') return missing(reply, '评论不存在')
    if (result.status === 'denied') return denied(reply)
    return { comment: result.comment }
  })

  fastify.post('/collaboration/notes/:noteId/comments/:commentId/resolve', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (!validUuid(request.params.commentId)) return missing(reply, '评论不存在')
    const resolved = request.body?.resolved !== false
    const result = await withTransaction(async (client) => {
      const access = await requireNoteAccess({
        queryFn: client.query.bind(client),
        userId: request.currentUser.id,
        noteId: request.params.noteId,
        reply,
        requiredRole: 'commenter',
        forUpdate: true
      })
      if (!access) return { status: reply.statusCode === 403 ? 'denied' : 'missing' }
      const comment = await requireComment(client, request.params.commentId, request.params.noteId)
      if (!comment) return { status: 'comment-missing' }
      const { rows } = await client.query(
        `
          UPDATE note_comments
          SET status = $3,
              resolved_by = $4,
              resolved_at = $5,
              updated_at = NOW()
          WHERE id = $1 AND note_id = $2
          RETURNING *
        `,
        [
          request.params.commentId,
          request.params.noteId,
          resolved ? 'resolved' : 'open',
          resolved ? request.currentUser.id : null,
          resolved ? new Date().toISOString() : null
        ]
      )
      return {
        status: 'ok',
        comment: mapComment({ ...rows[0], username: comment.username })
      }
    })
    if (result.status === 'missing' || result.status === 'comment-missing') return missing(reply, '评论不存在')
    if (result.status === 'denied') return denied(reply)
    return { comment: result.comment }
  })

  fastify.delete('/collaboration/notes/:noteId/comments/:commentId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (!validUuid(request.params.commentId)) return missing(reply, '评论不存在')
    const result = await withTransaction(async (client) => {
      const access = await requireNoteAccess({
        queryFn: client.query.bind(client),
        userId: request.currentUser.id,
        noteId: request.params.noteId,
        reply,
        requiredRole: 'commenter',
        forUpdate: true
      })
      if (!access) return { status: reply.statusCode === 403 ? 'denied' : 'missing' }
      const comment = await requireComment(client, request.params.commentId, request.params.noteId)
      if (!comment) return { status: 'comment-missing' }
      if (
        String(comment.user_id) !== String(request.currentUser.id)
        && access.access_role !== 'owner'
      ) return { status: 'denied' }
      await client.query(
        'DELETE FROM note_comments WHERE id = $1 AND note_id = $2',
        [request.params.commentId, request.params.noteId]
      )
      return { status: 'ok' }
    })
    if (result.status === 'missing' || result.status === 'comment-missing') return missing(reply, '评论不存在')
    if (result.status === 'denied') return denied(reply)
    return { ok: true }
  })

  fastify.get('/collaboration/sync/bootstrap', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const deviceId = String(request.query?.deviceId || '').trim()
    if (deviceId && !validUuid(deviceId)) return invalid(reply, '设备 ID 无效')

    const snapshot = await withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const notes = await listAccessibleNotes(client, request.currentUser.id)
      const noteIds = notes.map((note) => note.id)
      const members = noteIds.length
        ? (await client.query(
            `
              SELECT c.*, u.username
              FROM note_collaborators c
              JOIN users u ON u.id = c.user_id
              WHERE c.note_id = ANY($1::uuid[])
              ORDER BY c.note_id, c.created_at, c.user_id
            `,
            [noteIds]
          )).rows.map(mapCollaborator)
        : []
      const comments = noteIds.length
        ? (await client.query(
            `
              SELECT c.*, u.username
              FROM note_comments c
              JOIN users u ON u.id = c.user_id
              WHERE c.note_id = ANY($1::uuid[])
              ORDER BY c.note_id, c.created_at, c.id
            `,
            [noteIds]
          )).rows.map(mapComment)
        : []
      const cursor = Number((await client.query(
        `SELECT COALESCE(MAX(id), 0)::text AS cursor FROM note_sync_events`
      )).rows[0]?.cursor || 0)
      return { notes, members, comments, cursor }
    })

    if (deviceId) {
      await query(
        `
          INSERT INTO note_sync_devices (
            user_id, device_id, label, last_cursor, last_sync_at
          ) VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (user_id, device_id) DO UPDATE
          SET label = EXCLUDED.label,
              last_cursor = GREATEST(note_sync_devices.last_cursor, EXCLUDED.last_cursor),
              last_sync_at = NOW(),
              updated_at = NOW()
        `,
        [
          request.currentUser.id,
          deviceId,
          String(request.query?.label || '').trim().slice(0, 120),
          snapshot.cursor
        ]
      )
    }
    reply.header('Cache-Control', 'private, no-store')
    return { ...snapshot, serverTime: new Date().toISOString() }
  })

  fastify.get('/collaboration/sync/changes', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const cursor = Number(request.query?.cursor || 0)
    const limit = Math.min(500, Math.max(1, Number(request.query?.limit || 200)))
    const deviceId = String(request.query?.deviceId || '').trim()
    if (!Number.isSafeInteger(cursor) || cursor < 0) return invalid(reply, '同步游标无效')
    if (!Number.isSafeInteger(limit)) return invalid(reply, '同步批次大小无效')
    if (deviceId && !validUuid(deviceId)) return invalid(reply, '设备 ID 无效')

    const { rows } = await query(
      `
        SELECT *
        FROM note_sync_events
        WHERE id > $1
          AND audience_user_ids @> ARRAY[$2]::uuid[]
        ORDER BY id ASC
        LIMIT $3
      `,
      [cursor, request.currentUser.id, limit + 1]
    )
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const nextCursor = pageRows.length ? Number(pageRows.at(-1).id) : cursor
    if (deviceId) {
      await query(
        `
          INSERT INTO note_sync_devices (
            user_id, device_id, label, last_cursor, last_sync_at
          ) VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (user_id, device_id) DO UPDATE
          SET label = EXCLUDED.label,
              last_cursor = GREATEST(note_sync_devices.last_cursor, EXCLUDED.last_cursor),
              last_sync_at = NOW(),
              updated_at = NOW()
        `,
        [
          request.currentUser.id,
          deviceId,
          String(request.query?.label || '').trim().slice(0, 120),
          nextCursor
        ]
      )
    }
    reply.header('Cache-Control', 'private, no-store')
    return {
      events: pageRows.map(mapSyncEvent),
      cursor: nextCursor,
      hasMore,
      serverTime: new Date().toISOString()
    }
  })
}
