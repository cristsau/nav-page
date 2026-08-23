import { randomInt } from 'node:crypto'
import { config } from '../config.js'
import { query, withTransaction } from '../db/index.js'
import {
  assertAttachmentsAllowedForEncryption,
  getImgBedOrigin,
  normalizeNoteAttachments
} from '../lib/noteAttachments.js'
import { deleteImgBedUserImage } from '../lib/imgBedLibraryClient.js'
import {
  activateReferencedMediaAssets,
  attemptMediaAssetDeletion,
  markUnreferencedAutoAssetsForDeletion,
  syncNoteMediaReferences
} from '../lib/mediaAssets.js'
import {
  mapNote,
  mapPublicNote,
  mapPublicShare,
  mapShare
} from '../lib/notes.js'
import {
  archiveNoteVersion,
  isNoteVersionId,
  mapNoteVersion,
  pruneNoteVersions
} from '../lib/noteVersions.js'

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

function normalizeNoteType(value, fallback = 'memo') {
  const type = normalizeText(value, fallback).toLowerCase()
  return ['memo', 'diary'].includes(type) ? type : fallback
}

function normalizeDateOnly(value, fallback = null) {
  const input = normalizeText(value)
  if (!input) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return fallback

  const date = new Date(`${input}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input) {
    return fallback
  }

  return input
}

const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year, month) {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return days[month - 1] || 0
}

export function normalizeOptionalTimestamp(value, fallback = null) {
  if (value === undefined) {
    return { valid: true, value: fallback }
  }

  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    return { valid: true, value: null }
  }

  if (typeof value !== 'string') {
    return { valid: false, value: null }
  }

  const input = value.trim()
  const match = input.match(ISO_TIMESTAMP_PATTERN)
  if (!match) {
    return { valid: false, value: null }
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] || 0)
  const offsetHour = Number(match[10] || 0)
  const offsetMinute = Number(match[11] || 0)
  const validCalendarTime = (
    year >= 1
    && month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth(year, month)
    && hour >= 0
    && hour <= 23
    && minute >= 0
    && minute <= 59
    && second >= 0
    && second <= 59
    && offsetHour >= 0
    && offsetHour <= 14
    && offsetMinute >= 0
    && offsetMinute <= 59
    && (offsetHour !== 14 || offsetMinute === 0)
  )

  if (!validCalendarTime) {
    return { valid: false, value: null }
  }

  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return { valid: false, value: null }
  }

  return { valid: true, value: date.toISOString() }
}

export function resolveNoteDueAt(type, value, fallback = null) {
  return type === 'memo'
    ? normalizeOptionalTimestamp(value, fallback)
    : { valid: true, value: null }
}

export function normalizeRemindBeforeMinutes(value, fallback = 0) {
  if (value === undefined) {
    return { valid: true, value: Number(fallback || 0) }
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 43_200) {
    return { valid: false, value: 0 }
  }
  return { valid: true, value: parsed }
}

function invalidDueAtResponse(reply) {
  reply.code(400)
  return {
    error: 'dueAt must be a valid ISO 8601 timestamp with timezone',
    code: 'invalid_due_at'
  }
}

function invalidRemindBeforeResponse(reply) {
  reply.code(400)
  return {
    error: 'remindBeforeMinutes must be an integer from 0 to 43200',
    code: 'invalid_remind_before_minutes'
  }
}

function timestampsMatch(left, right) {
  if (!left && !right) return true
  if (!left || !right) return false

  const leftTime = new Date(left).getTime()
  const rightTime = new Date(right).getTime()
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime
}

async function cleanupMediaAfterNoteMutation(request, assetIds) {
  const results = []
  for (const assetId of [...new Set(assetIds || [])]) {
    try {
      const outcome = await attemptMediaAssetDeletion(
        request.currentUser.id,
        assetId,
        deleteImgBedUserImage,
        null,
        { requireAuto: true, requirePending: true }
      )
      results.push({
        assetId,
        state: outcome.state,
        deletion: outcome.deletion || null
      })
    } catch (error) {
      request.log.warn({
        assetId,
        error: error?.code || error?.name || 'MediaCleanupError'
      }, 'note media cleanup could not be completed')
      results.push({ assetId, state: 'delete_failed' })
    }
  }
  return results
}

function createShareCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let output = ''

  for (let index = 0; index < length; index += 1) {
    output += alphabet.charAt(randomInt(alphabet.length))
  }

  return output
}

async function requireOwnedNote(userId, noteId, reply) {
  const result = await query(
    `
      SELECT notes.*,
             updated_at::text AS updated_at_version
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
    const numericTerm = /^#?\d{1,15}$/.test(term)
      ? Number(term.replace(/^#/, ''))
      : null
    const numberId = Number.isSafeInteger(numericTerm) ? numericTerm : null

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
            ($3::bigint IS NOT NULL AND n.number_id = $3)
            OR LOWER(n.title) LIKE $2
            OR LOWER(n.content) LIKE $2
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                CASE
                  WHEN jsonb_typeof(n.tags) = 'array' THEN n.tags
                  ELSE '[]'::jsonb
                END
              ) AS tag
              WHERE LOWER(tag) LIKE $2
            )
        )
        ORDER BY n.updated_at DESC
        LIMIT 50
      `,
      [request.currentUser.id, `%${term}%`, numberId]
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

    const type = normalizeNoteType(request.body?.type)
    const title = normalizeText(request.body?.title)
    const content = String(request.body?.content || '')
    const encrypted = Boolean(request.body?.encrypted)
    const passwordHash = normalizeText(request.body?.password)
    const pinned = Boolean(request.body?.pinned)
    const tags = normalizeTags(request.body?.tags)
    const attachments = normalizeNoteAttachments(request.body?.attachments, {
      allowedOrigin: getImgBedOrigin(config.imgBedBaseUrl),
      maxBytes: config.imgBedMaxImageBytes,
      strict: true
    })
    const entryDate = type === 'diary'
      ? normalizeDateOnly(request.body?.entryDate, new Date().toISOString().slice(0, 10))
      : null
    const mood = type === 'diary' ? normalizeText(request.body?.mood).slice(0, 40) : ''
    const dueAtResult = resolveNoteDueAt(type, request.body?.dueAt)
    const dueAt = dueAtResult.value
    const remindBeforeResult = normalizeRemindBeforeMinutes(
      request.body?.remindBeforeMinutes
    )
    const remindBeforeMinutes = type === 'memo' && dueAt
      ? remindBeforeResult.value
      : 0
    const completed = type === 'memo' && Boolean(request.body?.completed)

    if (!title) {
      reply.code(400)
      return { error: 'Title is required' }
    }

    if (!dueAtResult.valid) {
      return invalidDueAtResponse(reply)
    }
    if (!remindBeforeResult.valid) {
      return invalidRemindBeforeResponse(reply)
    }

    if (encrypted && !passwordHash) {
      reply.code(400)
      return { error: 'Encrypted notes require a password hash' }
    }

    assertAttachmentsAllowedForEncryption(encrypted, attachments)

    const { rows } = await withTransaction(async (client) => {
      await activateReferencedMediaAssets(
        client,
        request.currentUser.id,
        attachments,
        { source: 'reconciled', retention: 'auto' }
      )
      return client.query(
        `
          INSERT INTO notes (
            user_id,
            type,
            title,
            content,
            encrypted,
            password_hash,
            pinned,
            tags,
            attachments,
            entry_date,
            mood,
            due_at,
            remind_before_minutes,
            completed
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
          RETURNING *
        `,
        [
          request.currentUser.id,
          type,
          title,
          content,
          encrypted,
          passwordHash,
          pinned,
          JSON.stringify(tags),
          JSON.stringify(attachments),
          entryDate,
          mood,
          dueAt,
          remindBeforeMinutes,
          completed
        ]
      )
    })

    reply.code(201)
    return { note: mapNote(rows[0]) }
  })

  fastify.put('/notes/:noteId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const existing = await requireOwnedNote(request.currentUser.id, request.params.noteId, reply)
    if (!existing) {
      return { error: 'Note not found' }
    }

    const type = normalizeNoteType(request.body?.type, existing.type)
    const title = normalizeText(request.body?.title, existing.title) || existing.title
    const content = request.body?.content === undefined ? existing.content : String(request.body.content || '')
    const encrypted = request.body?.encrypted === undefined ? existing.encrypted : Boolean(request.body.encrypted)
    let passwordHash = request.body?.password === undefined
      ? existing.password_hash
      : normalizeText(request.body.password)
    const pinned = request.body?.pinned === undefined ? existing.pinned : Boolean(request.body.pinned)
    const tags = request.body?.tags === undefined ? existing.tags : normalizeTags(request.body.tags)
    const attachments = request.body?.attachments === undefined
      ? normalizeNoteAttachments(existing.attachments, {
          maxBytes: Number.MAX_SAFE_INTEGER
        })
      : normalizeNoteAttachments(request.body.attachments, {
          allowedOrigin: getImgBedOrigin(config.imgBedBaseUrl),
          maxBytes: config.imgBedMaxImageBytes,
          strict: true
        })
    const entryDate = type === 'diary'
      ? normalizeDateOnly(request.body?.entryDate, existing.entry_date || new Date().toISOString().slice(0, 10))
      : null
    const mood = type === 'diary'
      ? normalizeText(request.body?.mood, existing.mood).slice(0, 40)
      : ''
    const dueAtResult = resolveNoteDueAt(type, request.body?.dueAt, existing.due_at)
    const dueAt = dueAtResult.value
    const remindBeforeResult = normalizeRemindBeforeMinutes(
      request.body?.remindBeforeMinutes,
      existing.remind_before_minutes
    )
    const remindBeforeMinutes = type === 'memo' && dueAt
      ? remindBeforeResult.value
      : 0
    const expectedRevision = request.body?.revision === undefined
      ? null
      : Number(request.body.revision)
    const completed = type === 'memo'
      ? (request.body?.completed === undefined ? existing.completed : Boolean(request.body.completed))
      : false

    if (!dueAtResult.valid) {
      return invalidDueAtResponse(reply)
    }
    if (!remindBeforeResult.valid) {
      return invalidRemindBeforeResponse(reply)
    }
    if (
      expectedRevision !== null
      && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    ) {
      reply.code(400)
      return { error: 'revision must be a positive integer', code: 'invalid_revision' }
    }
    if (expectedRevision !== null && expectedRevision !== Number(existing.revision || 1)) {
      reply.code(409)
      return {
        error: 'Note changed in another session; reload and retry',
        code: 'stale_note'
      }
    }

    if (!encrypted) {
      passwordHash = ''
    } else if (!passwordHash) {
      reply.code(400)
      return { error: 'Encrypted notes require a password hash' }
    }

    assertAttachmentsAllowedForEncryption(encrypted, attachments)

    let outcome
    try {
      outcome = await withTransaction(async (client) => {
        const lockedNote = await client.query(
          `
            SELECT *, updated_at::text AS updated_at_version
            FROM notes
            WHERE id = $1
              AND user_id = $2
            FOR UPDATE
          `,
          [request.params.noteId, request.currentUser.id]
        )
        if (
          !lockedNote.rows.length
          || lockedNote.rows[0].updated_at_version !== existing.updated_at_version
          || (
            expectedRevision !== null
            && Number(lockedNote.rows[0].revision || 1) !== expectedRevision
          )
        ) {
          const error = new Error('Note changed in another session; reload and retry')
          error.code = 'stale_note'
          error.statusCode = 409
          throw error
        }

        await archiveNoteVersion(client, lockedNote.rows[0])

        const mediaSync = await syncNoteMediaReferences(
          client,
          request.currentUser.id,
          normalizeNoteAttachments(existing.attachments, {
            maxBytes: Number.MAX_SAFE_INTEGER
          }),
          attachments
        )
        const result = await client.query(
          `
            UPDATE notes
            SET type = $3,
                title = $4,
                content = $5,
                encrypted = $6,
                password_hash = $7,
                pinned = $8,
                tags = $9::jsonb,
                attachments = $10::jsonb,
                entry_date = $11,
                mood = $12,
                due_at = $13,
                remind_before_minutes = $14,
                completed = $15,
                revision = revision + 1,
                updated_at = NOW()
            WHERE id = $1
              AND user_id = $2
              AND updated_at = $16::timestamptz
              AND revision = $17::integer
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
            JSON.stringify(tags),
            JSON.stringify(attachments),
            entryDate,
            mood,
            dueAt,
            remindBeforeMinutes,
            completed,
            existing.updated_at_version,
            Number(existing.revision || 1)
          ]
        )

        if (!result.rows.length) {
          const error = new Error('Note changed in another session; reload and retry')
          error.code = 'stale_note'
          error.statusCode = 409
          throw error
        }

        const scheduleChanged = (
          type !== 'memo'
          || completed
          || !timestampsMatch(existing.due_at, dueAt)
          || Number(existing.remind_before_minutes || 0) !== remindBeforeMinutes
        )

        if (scheduleChanged) {
          await client.query(
            `
              DELETE FROM note_reminders
              WHERE note_id = $1
                AND user_id = $2
            `,
            [request.params.noteId, request.currentUser.id]
          )
        }

        if (encrypted || Boolean(lockedNote.rows[0].encrypted)) {
          await client.query(
            'DELETE FROM note_shares WHERE note_id = $1 AND user_id = $2',
            [request.params.noteId, request.currentUser.id]
          )
        }

        const cleanupIds = await markUnreferencedAutoAssetsForDeletion(
          client,
          request.currentUser.id,
          mediaSync.removed
        )
        await pruneNoteVersions(
          client,
          request.currentUser.id,
          request.params.noteId
        )
        return { note: result.rows[0], cleanupIds }
      })
    } catch (error) {
      if (error?.code === 'stale_note') {
        reply.code(409)
        return {
          error: error.message,
          code: error.code
        }
      }
      throw error
    }

    const mediaCleanup = await cleanupMediaAfterNoteMutation(
      request,
      outcome.cleanupIds
    )
    return { note: mapNote(outcome.note), mediaCleanup }
  })

  fastify.get('/notes/:noteId/versions', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const note = await requireOwnedNote(
      request.currentUser.id,
      request.params.noteId,
      reply
    )
    if (!note) {
      return { error: 'Note not found' }
    }

    const { rows } = await query(
      `
        SELECT *
        FROM note_versions
        WHERE user_id = $1
          AND note_id = $2
        ORDER BY revision DESC, created_at DESC, id DESC
        LIMIT 50
      `,
      [request.currentUser.id, request.params.noteId]
    )

    return {
      currentRevision: Number(note.revision || 1),
      versions: rows.map(mapNoteVersion)
    }
  })

  fastify.post('/notes/:noteId/versions/:versionId/restore', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    if (!isNoteVersionId(request.params.versionId)) {
      reply.code(400)
      return { error: 'Invalid version id', code: 'invalid_note_version_id' }
    }

    let restored
    try {
      restored = await withTransaction(async (client) => {
        const currentResult = await client.query(
          `
            SELECT *
            FROM notes
            WHERE id = $1
              AND user_id = $2
            FOR UPDATE
          `,
          [request.params.noteId, request.currentUser.id]
        )
        if (!currentResult.rows.length) return null

        const versionResult = await client.query(
          `
            SELECT *
            FROM note_versions
            WHERE id = $1
              AND note_id = $2
              AND user_id = $3
            LIMIT 1
          `,
          [
            request.params.versionId,
            request.params.noteId,
            request.currentUser.id
          ]
        )
        if (!versionResult.rows.length) {
          const error = new Error('Note version not found')
          error.code = 'note_version_not_found'
          error.statusCode = 404
          throw error
        }

        const current = currentResult.rows[0]
        const version = versionResult.rows[0]
        const currentAttachments = normalizeNoteAttachments(
          current.attachments,
          { maxBytes: Number.MAX_SAFE_INTEGER }
        )
        if (version.encrypted && currentAttachments.length) {
          const error = new Error('Remove current images before restoring an encrypted version')
          error.code = 'encrypted_version_has_current_attachments'
          error.statusCode = 409
          throw error
        }

        await archiveNoteVersion(client, current)
        const result = await client.query(
          `
            UPDATE notes
            SET type = $3,
                title = $4,
                content = $5,
                encrypted = $6,
                password_hash = $7,
                pinned = $8,
                tags = $9::jsonb,
                entry_date = $10,
                mood = $11,
                due_at = $12,
                remind_before_minutes = $13,
                completed = $14,
                revision = revision + 1,
                updated_at = NOW()
            WHERE id = $1
              AND user_id = $2
            RETURNING *
          `,
          [
            request.params.noteId,
            request.currentUser.id,
            version.type,
            version.title,
            version.content,
            Boolean(version.encrypted),
            String(version.password_hash || ''),
            Boolean(version.pinned),
            JSON.stringify(Array.isArray(version.tags) ? version.tags : []),
            version.entry_date || null,
            String(version.mood || ''),
            version.due_at || null,
            Number(version.remind_before_minutes || 0),
            Boolean(version.completed)
          ]
        )

        await client.query(
          'DELETE FROM note_reminders WHERE note_id = $1 AND user_id = $2',
          [request.params.noteId, request.currentUser.id]
        )
        // Restoring content must never silently reactivate an old bearer URL.
        // A fresh public share requires an explicit action after the restore.
        await client.query(
          'DELETE FROM note_shares WHERE note_id = $1 AND user_id = $2',
          [request.params.noteId, request.currentUser.id]
        )
        await pruneNoteVersions(
          client,
          request.currentUser.id,
          request.params.noteId
        )
        return result.rows[0]
      })
    } catch (error) {
      if (error?.code === 'note_version_not_found') {
        reply.code(404)
        return { error: error.message, code: error.code }
      }
      if (error?.code === 'encrypted_version_has_current_attachments') {
        reply.code(409)
        return { error: error.message, code: error.code }
      }
      throw error
    }

    if (!restored) {
      reply.code(404)
      return { error: 'Note not found' }
    }

    return { note: mapNote(restored) }
  })

  fastify.delete('/notes/:noteId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const outcome = await withTransaction(async (client) => {
      const result = await client.query(
        `
          SELECT *
          FROM notes
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE
        `,
        [request.params.noteId, request.currentUser.id]
      )
      if (!result.rows.length) return null

      const existingAttachments = normalizeNoteAttachments(
        result.rows[0].attachments,
        { maxBytes: Number.MAX_SAFE_INTEGER }
      )
      const mediaSync = await syncNoteMediaReferences(
        client,
        request.currentUser.id,
        existingAttachments,
        []
      )
      await client.query(
        'DELETE FROM notes WHERE id = $1 AND user_id = $2',
        [request.params.noteId, request.currentUser.id]
      )
      const cleanupIds = await markUnreferencedAutoAssetsForDeletion(
        client,
        request.currentUser.id,
        mediaSync.removed
      )
      return { cleanupIds }
    })

    if (!outcome) {
      reply.code(404)
      return { error: 'Note not found' }
    }

    const mediaCleanup = await cleanupMediaAfterNoteMutation(
      request,
      outcome.cleanupIds
    )
    return { ok: true, mediaCleanup }
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

    if (note.encrypted) {
      reply.code(400)
      return { error: 'Encrypted notes cannot be shared' }
    }

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

  fastify.get('/shares/:code', {
    config: {
      skipSession: true
    }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    reply.header('X-Robots-Tag', 'noindex, noarchive, nofollow')

    const code = normalizeText(request.params?.code)
    if (!code) {
      reply.code(404)
      return { error: 'Share not found' }
    }

    const result = await withTransaction(async (client) => {
      const shareResult = await client.query(
        `
          SELECT id, created_at
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
            n.title,
            n.content,
            n.tags,
            n.attachments,
            n.entry_date
          FROM notes n
          JOIN note_shares s ON s.note_id = n.id
          WHERE s.id = $1
            AND n.encrypted = FALSE
          LIMIT 1
        `,
        [share.id]
      )

      if (!noteResult.rows.length) {
        return null
      }

      await client.query(
        'UPDATE note_shares SET view_count = view_count + 1 WHERE id = $1',
        [share.id]
      )

      return {
        share,
        note: noteResult.rows[0]
      }
    })

    if (!result || !result.note) {
      reply.code(404)
      return { error: 'Share not found' }
    }

    return {
      share: mapPublicShare(result.share),
      note: mapPublicNote(result.note, {
        allowedAttachmentOrigin: getImgBedOrigin(config.imgBedBaseUrl)
      })
    }
  })
}
