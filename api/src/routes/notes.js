import { query, withTransaction } from '../db/index.js'
import { mapNote, mapShare } from '../lib/notes.js'

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function normalizeTags(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : []
}

function normalizeExpireAt(value) {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString()
}

function createShareCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let output = ''

  for (let index = 0; index < length; index += 1) {
    output += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }

  return output
}

async function requireOwnedNote(userId, noteId, reply) {
  const result = await query(
    `
      SELECT *
      FROM notes
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
    `,
    [noteId, userId]
  )

  if (!result.rows.length) {
    reply.code(404)
    return null
  }

  return result.rows[0]
}

async function requireOwnedShare(userId, shareId, reply) {
  const result = await query(
    `
      SELECT *
      FROM note_shares
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
    `,
    [shareId, userId]
  )

  if (!result.rows.length) {
    reply.code(404)
    return null
  }

  return result.rows[0]
}

function buildNotesQuery(extraWhere = '', extraParams = []) {
  return {
    sql: `
      SELECT
        n.*,
        active_share.id AS share_id,
        active_share.code AS share_code,
        active_share.expire_at AS share_expire_at,
        active_share.view_count AS share_view_count
      FROM notes n
      LEFT JOIN LATERAL (
        SELECT id, code, expire_at, view_count
        FROM note_shares
        WHERE note_id = n.id
          AND (expire_at IS NULL OR expire_at > NOW())
        ORDER BY created_at DESC
        LIMIT 1
      ) active_share ON TRUE
      WHERE n.user_id = $1
      ${extraWhere}
      ORDER BY n.pinned DESC, n.updated_at DESC
    `,
    params: extraParams
  }
}

export default async function notesRoutes(fastify) {
  fastify.get('/notes', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const type = normalizeText(request.query?.type)
    const extraParams = [request.currentUser.id]
    let extraWhere = ''

    if (type) {
      extraParams.push(type)
      extraWhere = ' AND n.type = $2'
    }

    const queryConfig = buildNotesQuery(extraWhere, extraParams)
    const { rows } = await query(queryConfig.sql, queryConfig.params)

    return { notes: rows.map(mapNote) }
  })

  fastify.get('/notes/search', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const term = normalizeText(request.query?.q).toLowerCase()
    if (!term) {
      return { notes: [] }
    }

    const { rows } = await query(
      `
        SELECT
          n.*,
          active_share.id AS share_id,
          active_share.code AS share_code,
          active_share.expire_at AS share_expire_at,
          active_share.view_count AS share_view_count
        FROM notes n
        LEFT JOIN LATERAL (
          SELECT id, code, expire_at, view_count
          FROM note_shares
          WHERE note_id = n.id
            AND (expire_at IS NULL OR expire_at > NOW())
          ORDER BY created_at DESC
          LIMIT 1
        ) active_share ON TRUE
        WHERE n.user_id = $1
          AND n.encrypted = FALSE
          AND (
            LOWER(n.title) LIKE $2
            OR LOWER(n.content) LIKE $2
          )
        ORDER BY n.updated_at DESC
      `,
      [request.currentUser.id, `%${term}%`]
    )

    return { notes: rows.map(mapNote) }
  })

  fastify.get('/notes/:noteId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const { rows } = await query(
      `
        SELECT
          n.*,
          active_share.id AS share_id,
          active_share.code AS share_code,
          active_share.expire_at AS share_expire_at,
          active_share.view_count AS share_view_count
        FROM notes n
        LEFT JOIN LATERAL (
          SELECT id, code, expire_at, view_count
          FROM note_shares
          WHERE note_id = n.id
            AND (expire_at IS NULL OR expire_at > NOW())
          ORDER BY created_at DESC
          LIMIT 1
        ) active_share ON TRUE
        WHERE n.id = $1
          AND n.user_id = $2
        LIMIT 1
      `,
      [request.params.noteId, request.currentUser.id]
    )

    if (!rows.length) {
      reply.code(404)
      return { error: 'Note not found' }
    }

    return { note: mapNote(rows[0]) }
  })

  fastify.post('/notes', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const type = normalizeText(request.body?.type, 'memo') || 'memo'
    const title = normalizeText(request.body?.title)
    const content = String(request.body?.content || '')
    const encrypted = Boolean(request.body?.encrypted)
    const passwordHash = normalizeText(request.body?.password)
    const pinned = Boolean(request.body?.pinned)
    const tags = normalizeTags(request.body?.tags)

    if (!title) {
      reply.code(400)
      return { error: 'Title is required' }
    }

    const { rows } = await query(
      `
        INSERT INTO notes (
          user_id,
          type,
          title,
          content,
          encrypted,
          password_hash,
          pinned,
          tags
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING *
      `,
      [request.currentUser.id, type, title, content, encrypted, passwordHash, pinned, JSON.stringify(tags)]
    )

    reply.code(201)
    return { note: mapNote(rows[0]) }
  })

  fastify.put('/notes/:noteId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const existing = await requireOwnedNote(request.currentUser.id, request.params.noteId, reply)
    if (!existing) {
      return { error: 'Note not found' }
    }

    const type = normalizeText(request.body?.type, existing.type) || existing.type
    const title = normalizeText(request.body?.title, existing.title) || existing.title
    const content = request.body?.content === undefined ? existing.content : String(request.body.content || '')
    const encrypted = request.body?.encrypted === undefined ? existing.encrypted : Boolean(request.body.encrypted)
    const passwordHash = request.body?.password === undefined
      ? existing.password_hash
      : normalizeText(request.body.password)
    const pinned = request.body?.pinned === undefined ? existing.pinned : Boolean(request.body.pinned)
    const tags = request.body?.tags === undefined ? existing.tags : normalizeTags(request.body.tags)

    const { rows } = await query(
      `
        UPDATE notes
        SET type = $3,
            title = $4,
            content = $5,
            encrypted = $6,
            password_hash = $7,
            pinned = $8,
            tags = $9::jsonb,
            updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
        RETURNING *
      `,
      [
        request.params.noteId,
        request.currentUser.id,
        type,
        title,
        content,
        encrypted,
        passwordHash,
        pinned,
        JSON.stringify(tags)
      ]
    )

    return { note: mapNote(rows[0]) }
  })

  fastify.delete('/notes/:noteId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const existing = await requireOwnedNote(request.currentUser.id, request.params.noteId, reply)
    if (!existing) {
      return { error: 'Note not found' }
    }

    await query('DELETE FROM notes WHERE id = $1 AND user_id = $2', [
      request.params.noteId,
      request.currentUser.id
    ])

    return { ok: true }
  })

  fastify.post('/notes/:noteId/pin-toggle', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const existing = await requireOwnedNote(request.currentUser.id, request.params.noteId, reply)
    if (!existing) {
      return { error: 'Note not found' }
    }

    const { rows } = await query(
      `
        UPDATE notes
        SET pinned = NOT pinned,
            updated_at = NOW()
        WHERE id = $1
          AND user_id = $2
        RETURNING *
      `,
      [request.params.noteId, request.currentUser.id]
    )

    return { note: mapNote(rows[0]) }
  })

  fastify.get('/shares', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const noteId = normalizeText(request.query?.noteId)
    const params = [request.currentUser.id]
    let whereClause = 'WHERE user_id = $1 AND (expire_at IS NULL OR expire_at > NOW())'

    if (noteId) {
      params.push(noteId)
      whereClause += ' AND note_id = $2'
    }

    const { rows } = await query(
      `
        SELECT *
        FROM note_shares
        ${whereClause}
        ORDER BY created_at DESC
      `,
      params
    )

    return { shares: rows.map(mapShare) }
  })

  fastify.post('/notes/:noteId/shares', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const note = await requireOwnedNote(request.currentUser.id, request.params.noteId, reply)
    if (!note) {
      return { error: 'Note not found' }
    }

    const expireAt = normalizeExpireAt(request.body?.expireAt)
    const code = createShareCode()

    const { rows } = await query(
      `
        INSERT INTO note_shares (user_id, note_id, code, expire_at)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [request.currentUser.id, request.params.noteId, code, expireAt]
    )

    return { share: mapShare(rows[0]) }
  })

  fastify.delete('/shares/:shareId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const share = await requireOwnedShare(request.currentUser.id, request.params.shareId, reply)
    if (!share) {
      return { error: 'Share not found' }
    }

    await query('DELETE FROM note_shares WHERE id = $1 AND user_id = $2', [
      request.params.shareId,
      request.currentUser.id
    ])

    return { ok: true }
  })

  fastify.get('/shares/:code', async (request, reply) => {
    const code = normalizeText(request.params?.code)
    if (!code) {
      reply.code(404)
      return { error: 'Share not found' }
    }

    const result = await withTransaction(async (client) => {
      const shareResult = await client.query(
        `
          SELECT *
          FROM note_shares
          WHERE code = $1
            AND (expire_at IS NULL OR expire_at > NOW())
          LIMIT 1
        `,
        [code]
      )

      if (!shareResult.rows.length) {
        return null
      }

      const share = shareResult.rows[0]

      const noteResult = await client.query(
        `
          SELECT
            n.*,
            s.id AS share_id,
            s.code AS share_code,
            s.expire_at AS share_expire_at,
            s.view_count AS share_view_count
          FROM notes n
          JOIN note_shares s ON s.note_id = n.id
          WHERE s.id = $1
          LIMIT 1
        `,
        [share.id]
      )

      await client.query(
        'UPDATE note_shares SET view_count = view_count + 1 WHERE id = $1',
        [share.id]
      )

      const updatedShare = {
        ...share,
        view_count: share.view_count + 1
      }

      return {
        share: updatedShare,
        note: noteResult.rows[0]
      }
    })

    if (!result) {
      reply.code(404)
      return { error: 'Share not found' }
    }

    return {
      share: mapShare(result.share),
      note: mapNote(result.note)
    }
  })
}
