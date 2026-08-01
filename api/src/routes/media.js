import { config } from '../config.js'
import { query, withTransaction } from '../db/index.js'
import {
  attemptMediaAssetDeletion,
  countMediaReferences,
  mapMediaAsset,
  normalizeMediaRetention,
  registerMediaAsset
} from '../lib/mediaAssets.js'
import {
  deleteImgBedUserImage,
  listImgBedUserImages
} from '../lib/imgBedLibraryClient.js'
import {
  registerImageContentTypes,
  uploadImageRequest
} from './noteImages.js'

const MEDIA_FILTERS = new Set([
  'all',
  'referenced',
  'unreferenced',
  'keep',
  'pending',
  'failed',
  'missing'
])

function createHttpError(message, statusCode, code = '') {
  const error = new Error(message)
  error.statusCode = statusCode
  if (code) error.code = code
  return error
}

function parseLimit(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 60)
    : 30
}

function encodeCursor(record) {
  if (!record) return ''
  return Buffer.from(JSON.stringify({
    createdAt: record.created_at,
    id: record.id
  })).toString('base64url')
}

function decodeCursor(value) {
  const input = String(value || '').trim()
  if (!input) return null
  try {
    const parsed = JSON.parse(Buffer.from(input, 'base64url').toString('utf8'))
    const createdAt = new Date(parsed?.createdAt)
    const id = String(parsed?.id || '')
    if (
      Number.isNaN(createdAt.getTime())
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ) {
      throw new Error('invalid')
    }
    return { createdAt: createdAt.toISOString(), id }
  } catch {
    throw createHttpError('Invalid media cursor', 400, 'invalid_media_cursor')
  }
}

function mapMediaForClient(record) {
  const media = mapMediaAsset(record)
  return {
    ...media,
    thumbnailUrl: media.url,
    width: null,
    height: null,
    status: media.state
  }
}

function mapDeletionResult(outcome) {
  const image = mapMediaForClient(outcome.asset)
  return {
    image,
    deletion: outcome.deletion || image.deletion || null
  }
}

export function buildMediaListQuery({ userId, filter, search, cursor, limit }) {
  const params = [userId]
  const conditions = ["a.state <> 'deleted'"]

  if (search) {
    params.push(`%${search}%`)
    const searchParam = `$${params.length}`
    conditions.push(`(
      a.name ILIKE ${searchParam}
      OR a.upstream_id ILIKE ${searchParam}
      OR EXISTS (
        SELECT 1
        FROM notes search_note
        WHERE search_note.user_id = a.user_id
          AND search_note.encrypted = FALSE
          AND search_note.title ILIKE ${searchParam}
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(search_note.attachments) attachment
            WHERE attachment->>'url' = a.url
          )
      )
    )`)
  }
  if (cursor) {
    params.push(cursor.createdAt)
    const cursorCreatedAtParam = `$${params.length}`
    params.push(cursor.id)
    const cursorIdParam = `$${params.length}`
    conditions.push(`(a.created_at, a.id) < (${cursorCreatedAtParam}::timestamptz, ${cursorIdParam}::uuid)`)
  }
  if (filter === 'referenced') conditions.push('refs.reference_count > 0')
  if (filter === 'unreferenced') conditions.push('refs.reference_count = 0')
  if (filter === 'keep') conditions.push("a.retention = 'keep'")
  if (filter === 'pending') conditions.push("a.state IN ('delete_pending', 'delete_failed')")
  if (filter === 'failed') conditions.push("a.state = 'delete_failed'")
  if (filter === 'missing') conditions.push("a.state = 'missing'")

  params.push(limit + 1)
  const limitParam = `$${params.length}`

  return {
    sql: `
      SELECT
        a.*,
        refs.reference_count,
        refs.references
      FROM media_assets a
      CROSS JOIN LATERAL (
        SELECT
          COUNT(*)::integer AS reference_count,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'noteId', n.id,
                'numberId', n.number_id,
                'title', CASE WHEN n.encrypted THEN '加密笔记' ELSE n.title END
              )
              ORDER BY n.updated_at DESC
            ) FILTER (WHERE n.id IS NOT NULL),
            '[]'::jsonb
          ) AS references
        FROM notes n
        WHERE n.user_id = a.user_id
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(n.attachments) attachment
            WHERE attachment->>'url' = a.url
          )
      ) refs
      WHERE a.user_id = $1
        AND ${conditions.join('\n        AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limitParam}
    `,
    params
  }
}

async function requireOwnedAsset(userId, assetId, { lock = false, client = null } = {}) {
  const runner = client || { query }
  const result = await runner.query(
    `
      SELECT *
      FROM media_assets
      WHERE id = $1
        AND user_id = $2
      ${lock ? 'FOR UPDATE' : ''}
    `,
    [assetId, userId]
  )
  if (!result.rows.length) {
    throw createHttpError('Media not found', 404, 'media_not_found')
  }
  return result.rows[0]
}

async function runDelete(userId, assetId, deletionPolicy = {}) {
  const outcome = await attemptMediaAssetDeletion(
    userId,
    assetId,
    deleteImgBedUserImage,
    null,
    deletionPolicy
  )
  if (outcome.state === 'referenced') {
    throw createHttpError('Media is still referenced by a note', 409, 'media_referenced')
  }
  if (outcome.state === 'delete_failed') {
    throw createHttpError('Image deletion failed and can be retried', 502, 'media_delete_failed')
  }
  if (outcome.state === 'not_pending') {
    throw createHttpError('Media is not awaiting automatic deletion', 409, 'media_not_pending')
  }
  return outcome
}

export default async function mediaRoutes(fastify) {
  registerImageContentTypes(fastify)

  fastify.get('/media/images', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const filterInput = String(request.query?.filter || 'all').trim().toLowerCase()
    const filter = MEDIA_FILTERS.has(filterInput) ? filterInput : 'all'
    const search = String(request.query?.q || '').trim().slice(0, 100)
    const cursor = decodeCursor(request.query?.cursor)
    const limit = parseLimit(request.query?.limit)
    const mediaListQuery = buildMediaListQuery({
      userId: request.currentUser.id,
      filter,
      search,
      cursor,
      limit
    })
    const result = await query(mediaListQuery.sql, mediaListQuery.params)
    const hasMore = result.rows.length > limit
    const page = result.rows.slice(0, limit)

    const countsResult = await query(
      `
        SELECT
          COUNT(*) FILTER (WHERE a.state <> 'deleted')::integer AS all,
          COUNT(*) FILTER (
            WHERE a.state <> 'deleted' AND EXISTS (
              SELECT 1
              FROM notes n
              WHERE n.user_id = a.user_id
                AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(n.attachments) attachment
                  WHERE attachment->>'url' = a.url
                )
            )
          )::integer AS referenced,
          COUNT(*) FILTER (
            WHERE a.state <> 'deleted' AND NOT EXISTS (
              SELECT 1
              FROM notes n
              WHERE n.user_id = a.user_id
                AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(n.attachments) attachment
                  WHERE attachment->>'url' = a.url
                )
            )
          )::integer AS unreferenced,
          COUNT(*) FILTER (WHERE a.retention = 'keep' AND a.state <> 'deleted')::integer AS keep,
          COUNT(*) FILTER (WHERE a.state IN ('delete_pending', 'delete_failed'))::integer AS pending,
          COUNT(*) FILTER (WHERE a.state = 'delete_failed')::integer AS failed,
          COUNT(*) FILTER (WHERE a.state = 'missing')::integer AS missing
        FROM media_assets a
        WHERE a.user_id = $1
      `,
      [request.currentUser.id]
    )

    return {
      images: page.map(mapMediaForClient),
      nextCursor: hasMore ? encodeCursor(page.at(-1)) : '',
      counts: countsResult.rows[0] || {}
    }
  })

  fastify.get('/media/images/:assetId/references', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const asset = await requireOwnedAsset(request.currentUser.id, request.params.assetId)
    const result = await query(
      `
        SELECT
          n.id AS "noteId",
          n.number_id AS "numberId",
          CASE WHEN n.encrypted THEN '加密笔记' ELSE n.title END AS title
        FROM notes n
        WHERE n.user_id = $1
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(n.attachments) attachment
            WHERE attachment->>'url' = $2
          )
        ORDER BY n.updated_at DESC
      `,
      [request.currentUser.id, asset.url]
    )
    return { references: result.rows }
  })

  fastify.post('/media/images', {
    bodyLimit: config.imgBedMaxImageBytes
  }, async (request, reply) => {
    await fastify.requireAuth(request, reply)
    return uploadImageRequest(request, reply, {
      source: 'library',
      retention: 'keep'
    })
  })

  fastify.patch('/media/images/:assetId/retention', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const retentionInput = String(request.body?.retention || '').trim().toLowerCase()
    const retention = normalizeMediaRetention(retentionInput, '')
    if (!retention) {
      reply.code(400)
      return { error: 'retention must be auto or keep', code: 'invalid_retention' }
    }

    const outcome = await withTransaction(async (client) => {
      const asset = await requireOwnedAsset(
        request.currentUser.id,
        request.params.assetId,
        { lock: true, client }
      )
      if (asset.state === 'deleted') {
        throw createHttpError('Media not found', 404, 'media_not_found')
      }
      const referenceCount = await countMediaReferences(client, request.currentUser.id, asset.url)
      const state = retention === 'auto' && referenceCount === 0
        ? 'delete_pending'
        : referenceCount > 0
          ? 'active'
          : asset.state === 'missing'
            ? 'missing'
            : 'orphan'
      const result = await client.query(
        `
          UPDATE media_assets
          SET retention = $3,
              state = $4,
              delete_requested_at = CASE
                WHEN $4 = 'delete_pending' THEN COALESCE(delete_requested_at, NOW())
                ELSE NULL
              END,
              last_delete_error = '',
              deletion_disposition = NULL,
              deletion_source_deleted = NULL,
              deletion_detached = NULL,
              deletion_legacy = NULL,
              deletion_already_missing = NULL,
              deletion_cache_invalidated = NULL,
              deletion_cache_purge_configured = NULL,
              deletion_cache_purge_attempted = NULL,
              deletion_cache_purge_succeeded = NULL,
              deletion_local_cache_invalidated = NULL,
              updated_at = NOW()
          WHERE id = $1
            AND user_id = $2
          RETURNING *
        `,
        [asset.id, request.currentUser.id, retention, state]
      )
      return { asset: result.rows[0], shouldDelete: state === 'delete_pending' }
    })

    if (outcome.shouldDelete) {
      const deleted = await runDelete(
        request.currentUser.id,
        request.params.assetId,
        { requireAuto: true, requirePending: true }
      )
      return mapDeletionResult(deleted)
    }
    return { image: mapMediaForClient(outcome.asset), deletion: null }
  })

  fastify.delete('/media/images/:assetId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const outcome = await runDelete(request.currentUser.id, request.params.assetId)
    return { ok: true, ...mapDeletionResult(outcome) }
  })

  fastify.post('/media/images/:assetId/retry-delete', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const outcome = await runDelete(
      request.currentUser.id,
      request.params.assetId,
      { requireAuto: true, requirePending: true }
    )
    return { ok: true, ...mapDeletionResult(outcome) }
  })

  fastify.post('/media/reconcile', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const upstreamResult = await listImgBedUserImages(request.currentUser.id)
    const upstreamFiles = upstreamResult.files
    const seenIds = upstreamFiles.map((file) => file.upstreamId)
    const result = await withTransaction(async (client) => {
      let created = 0
      for (const file of upstreamFiles) {
        const before = await client.query(
          `
            SELECT id
            FROM media_assets
            WHERE user_id = $1
              AND upstream_id = $2
            LIMIT 1
          `,
          [request.currentUser.id, file.upstreamId]
        )
        const asset = await registerMediaAsset(client, request.currentUser.id, {
          url: file.url,
          name: file.name,
          mime: file.mime,
          size: file.size,
          createdAt: file.createdAt
        }, {
          source: 'reconciled',
          retention: 'keep',
          state: 'orphan'
        })
        if (!before.rows.length) created += 1
        const referenceCount = await countMediaReferences(
          client,
          request.currentUser.id,
          file.url
        )
        await client.query(
          `
            UPDATE media_assets
            SET name = $3,
                mime = $4,
                size = $5,
                state = CASE
                  WHEN state IN ('delete_pending', 'delete_failed') THEN state
                  WHEN $6 > 0 THEN 'active'
                  ELSE 'orphan'
                END,
                missing_observations = 0,
                deletion_disposition = NULL,
                deletion_source_deleted = NULL,
                deletion_detached = NULL,
                deletion_legacy = NULL,
                deletion_already_missing = NULL,
                deletion_cache_invalidated = NULL,
                deletion_cache_purge_configured = NULL,
                deletion_cache_purge_attempted = NULL,
                deletion_cache_purge_succeeded = NULL,
                deletion_local_cache_invalidated = NULL,
                deleted_at = NULL,
                updated_at = NOW()
            WHERE id = $1
              AND user_id = $2
              AND state <> 'deleted'
          `,
          [asset.id, request.currentUser.id, file.name, file.mime, file.size, referenceCount]
        )
      }

      // A single list omission can be caused by eventual-consistency lag in
      // the image-bed index. Only declare an asset missing after two complete,
      // consecutive reconciliations fail to observe it.
      const missing = !upstreamResult.complete
        ? { rows: [{ count: 0 }] }
        : seenIds.length
        ? await client.query(
            `
              WITH observed AS (
                UPDATE media_assets
                SET missing_observations = missing_observations + 1,
                    state = CASE
                      WHEN missing_observations + 1 >= 2 THEN 'missing'
                      ELSE state
                    END,
                    updated_at = NOW()
                WHERE user_id = $1
                  AND state <> 'deleted'
                  AND NOT (upstream_id = ANY($2::text[]))
                RETURNING state
              )
              SELECT COUNT(*)::integer AS count
              FROM observed
              WHERE state = 'missing'
            `,
            [request.currentUser.id, seenIds]
          )
        : await client.query(
            `
              WITH observed AS (
                UPDATE media_assets
                SET missing_observations = missing_observations + 1,
                    state = CASE
                      WHEN missing_observations + 1 >= 2 THEN 'missing'
                      ELSE state
                    END,
                    updated_at = NOW()
                WHERE user_id = $1
                  AND state <> 'deleted'
                RETURNING state
              )
              SELECT COUNT(*)::integer AS count
              FROM observed
              WHERE state = 'missing'
            `,
            [request.currentUser.id]
          )
      return { created, missing: Number(missing.rows[0]?.count || 0) }
    })

    return {
      ok: true,
      complete: upstreamResult.complete,
      found: upstreamFiles.length,
      created: result.created,
      missing: result.missing
    }
  })
}
