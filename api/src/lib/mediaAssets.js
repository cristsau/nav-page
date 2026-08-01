import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { getImgBedOrigin } from './noteAttachments.js'

const MEDIA_SOURCES = new Set(['note', 'library', 'reconciled'])
const MEDIA_RETENTIONS = new Set(['auto', 'keep'])
const MEDIA_STATES = new Set([
  'active',
  'orphan',
  'delete_pending',
  'delete_failed',
  'missing',
  'deleted'
])
const MEDIA_DELETE_DISPOSITIONS = new Set([
  'source_deleted',
  'detached',
  'legacy_detached',
  'already_missing'
])
const MEDIA_DELETE_BOOLEAN_FIELDS = [
  'sourceDeleted',
  'detached',
  'legacy',
  'alreadyMissing',
  'cacheInvalidated',
  'cachePurgeConfigured',
  'cachePurgeAttempted',
  'cachePurgeSucceeded',
  'localCacheInvalidated'
]

function createHttpError(message, statusCode, code = '') {
  const error = new Error(message)
  error.statusCode = statusCode
  if (code) error.code = code
  return error
}

function invalidMediaDeletionOutcome() {
  return createHttpError(
    'Image provider returned an invalid deletion outcome',
    502,
    'invalid_media_delete_outcome'
  )
}

export function normalizeMediaDeletionOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidMediaDeletionOutcome()
  }
  if (MEDIA_DELETE_BOOLEAN_FIELDS.some((field) => typeof value[field] !== 'boolean')) {
    throw invalidMediaDeletionOutcome()
  }

  const inferredDisposition = value.sourceDeleted
    ? 'source_deleted'
    : value.detached
      ? value.legacy ? 'legacy_detached' : 'detached'
      : value.alreadyMissing
        ? 'already_missing'
        : ''
  const disposition = String(value.disposition || inferredDisposition).trim().toLowerCase()
  const dispositionMatches = (
    (disposition === 'source_deleted'
      && value.sourceDeleted
      && !value.detached
      && !value.legacy
      && !value.alreadyMissing)
    || (disposition === 'detached'
      && !value.sourceDeleted
      && value.detached
      && !value.legacy
      && !value.alreadyMissing)
    || (disposition === 'legacy_detached'
      && !value.sourceDeleted
      && value.detached
      && value.legacy
      && !value.alreadyMissing)
    || (disposition === 'already_missing'
      && !value.sourceDeleted
      && !value.detached
      && !value.legacy
      && value.alreadyMissing)
  )
  const cacheMatches = (
    (!value.cachePurgeAttempted || value.cachePurgeConfigured)
    && (!value.cachePurgeSucceeded || (
      value.cachePurgeConfigured
      && value.cachePurgeAttempted
      && value.cacheInvalidated
    ))
    && value.cacheInvalidated === (
      value.cachePurgeSucceeded || value.localCacheInvalidated
    )
  )
  if (!MEDIA_DELETE_DISPOSITIONS.has(disposition) || !dispositionMatches || !cacheMatches) {
    throw invalidMediaDeletionOutcome()
  }

  return {
    disposition,
    sourceDeleted: value.sourceDeleted,
    detached: value.detached,
    legacy: value.legacy,
    alreadyMissing: value.alreadyMissing,
    cacheInvalidated: value.cacheInvalidated,
    cachePurgeConfigured: value.cachePurgeConfigured,
    cachePurgeAttempted: value.cachePurgeAttempted,
    cachePurgeSucceeded: value.cachePurgeSucceeded,
    localCacheInvalidated: value.localCacheInvalidated
  }
}

function mediaDeletionOutcomeFromRecord(record) {
  if (!record?.deletion_disposition) return null
  try {
    return normalizeMediaDeletionOutcome({
      disposition: record.deletion_disposition,
      sourceDeleted: record.deletion_source_deleted,
      detached: record.deletion_detached,
      legacy: record.deletion_legacy,
      alreadyMissing: record.deletion_already_missing,
      cacheInvalidated: record.deletion_cache_invalidated,
      cachePurgeConfigured: record.deletion_cache_purge_configured,
      cachePurgeAttempted: record.deletion_cache_purge_attempted,
      cachePurgeSucceeded: record.deletion_cache_purge_succeeded,
      localCacheInvalidated: record.deletion_local_cache_invalidated
    })
  } catch {
    return null
  }
}

export function normalizeMediaSource(value, fallback = 'reconciled') {
  const normalized = String(value || '').trim().toLowerCase()
  return MEDIA_SOURCES.has(normalized) ? normalized : fallback
}

export function normalizeMediaRetention(value, fallback = 'auto') {
  const normalized = String(value || '').trim().toLowerCase()
  return MEDIA_RETENTIONS.has(normalized) ? normalized : fallback
}

export function normalizeMediaState(value, fallback = 'active') {
  const normalized = String(value || '').trim().toLowerCase()
  return MEDIA_STATES.has(normalized) ? normalized : fallback
}

function normalizeUploadFolderPrefix(value) {
  const normalized = String(value || 'nav-notes')
    .split('/')
    .map((segment) => segment
      .trim()
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48))
    .filter(Boolean)
    .slice(0, 4)
    .join('/')

  return normalized || 'nav-notes'
}

export function createMediaUserPartition(userId) {
  return createHash('sha256')
    .update(String(userId || ''))
    .digest('hex')
    .slice(0, 12)
}

export function createMediaUserPrefix(userId) {
  return `${normalizeUploadFolderPrefix(config.imgBedUploadFolder)}/${createMediaUserPartition(userId)}/`
}

export function normalizeUpstreamId(value) {
  const input = String(value || '').trim().replaceAll('\\', '/')
  if (!input || input.startsWith('/') || input.length > 1024 || input.includes('\u0000')) {
    return ''
  }

  const segments = input.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return ''
  }

  return segments.join('/')
}

export function encodeUpstreamPath(upstreamId) {
  const normalized = normalizeUpstreamId(upstreamId)
  return normalized
    ? normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    : ''
}

export function upstreamIdFromMediaUrl(value, expectedOrigin = getImgBedOrigin(config.imgBedBaseUrl)) {
  try {
    const url = new URL(String(value || '').trim())
    if (
      !expectedOrigin
      || url.origin !== expectedOrigin
      || url.protocol !== 'https:'
      || url.username
      || url.password
      || !url.pathname.startsWith('/file/')
      || url.search
      || url.hash
    ) {
      return ''
    }

    const encodedPath = url.pathname.slice('/file/'.length)
    const decoded = encodedPath
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
    return normalizeUpstreamId(decoded)
  } catch {
    return ''
  }
}

export function mediaUrlFromUpstreamId(upstreamId, expectedOrigin = getImgBedOrigin(config.imgBedBaseUrl)) {
  const encodedPath = encodeUpstreamPath(upstreamId)
  return expectedOrigin && encodedPath
    ? new URL(`/file/${encodedPath}`, expectedOrigin).toString()
    : ''
}

export function assertMediaBelongsToUser(userId, { upstreamId = '', url = '' } = {}) {
  const normalizedUpstreamId = normalizeUpstreamId(
    upstreamId || upstreamIdFromMediaUrl(url)
  )
  if (!normalizedUpstreamId || !normalizedUpstreamId.startsWith(createMediaUserPrefix(userId))) {
    throw createHttpError('Media not found', 404, 'media_not_found')
  }
  return normalizedUpstreamId
}

function uniqueAttachmentUrls(attachments) {
  return [...new Set(
    (Array.isArray(attachments) ? attachments : [])
      .map((attachment) => String(attachment?.url || '').trim())
      .filter(Boolean)
  )].sort()
}

function normalizeAssetInput(userId, attachment, {
  source = 'reconciled',
  retention = 'auto',
  state = 'active'
} = {}) {
  const url = String(attachment?.url || '').trim()
  const upstreamId = assertMediaBelongsToUser(userId, { url })
  const name = String(attachment?.name || upstreamId.split('/').pop() || 'image')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255) || 'image'
  const mime = String(attachment?.mime || '').trim().toLowerCase()
  const size = Number(attachment?.size)

  if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    throw createHttpError('Invalid media type', 400, 'invalid_media')
  }
  if (!Number.isSafeInteger(size) || size < 1) {
    throw createHttpError('Invalid media size', 400, 'invalid_media')
  }

  return {
    id: String(attachment?.id || '').trim() || null,
    upstreamId,
    url,
    name,
    mime,
    size,
    source: normalizeMediaSource(source),
    retention: normalizeMediaRetention(retention),
    state: normalizeMediaState(state)
  }
}

export async function registerMediaAsset(client, userId, attachment, options = {}) {
  const asset = normalizeAssetInput(userId, attachment, options)
  const result = await client.query(
    `
      INSERT INTO media_assets (
        id,
        user_id,
        upstream_id,
        url,
        name,
        mime,
        size,
        source,
        retention,
        state,
        created_at,
        updated_at
      ) VALUES (
        COALESCE($1::uuid, gen_random_uuid()),
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        COALESCE($11::timestamptz, NOW()),
        NOW()
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `,
    [
      asset.id,
      userId,
      asset.upstreamId,
      asset.url,
      asset.name,
      asset.mime,
      asset.size,
      asset.source,
      asset.retention,
      asset.state,
      attachment?.createdAt || null
    ]
  )

  if (result.rows.length) return result.rows[0]

  const existing = await client.query(
    `
      SELECT *
      FROM media_assets
      WHERE user_id = $1
        AND url = $2
      LIMIT 1
    `,
    [userId, asset.url]
  )
  if (!existing.rows.length) {
    throw createHttpError('Media not found', 404, 'media_not_found')
  }

  return existing.rows[0]
}

export async function lockMediaAssetsForAttachments(client, userId, attachments, options = {}) {
  const { allowMissing = false, ...registrationOptions } = options
  const byUrl = new Map(
    (Array.isArray(attachments) ? attachments : [])
      .map((attachment) => [String(attachment?.url || '').trim(), attachment])
      .filter(([url]) => url)
  )
  const rows = []

  for (const url of [...byUrl.keys()].sort()) {
    const attachment = byUrl.get(url)
    await registerMediaAsset(client, userId, attachment, registrationOptions)
    const result = await client.query(
      `
        SELECT *
        FROM media_assets
        WHERE user_id = $1
          AND url = $2
        FOR UPDATE
      `,
      [userId, url]
    )
    const blockedStates = allowMissing ? ['deleted'] : ['deleted', 'missing']
    if (!result.rows.length || blockedStates.includes(result.rows[0].state)) {
      throw createHttpError('Media not found', 404, 'media_not_found')
    }
    rows.push(result.rows[0])
  }

  return rows
}

export async function activateReferencedMediaAssets(client, userId, attachments, options = {}) {
  const rows = await lockMediaAssetsForAttachments(client, userId, attachments, options)
  if (!rows.length) return []

  const ids = rows.map((row) => row.id)
  const activatableIds = options.allowMissing
    ? rows.filter((row) => row.state !== 'missing').map((row) => row.id)
    : ids
  if (activatableIds.length) await client.query(
    `
      UPDATE media_assets
      SET state = 'active',
          delete_requested_at = NULL,
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
          deleted_at = NULL,
          updated_at = NOW()
      WHERE user_id = $1
        AND id = ANY($2::uuid[])
    `,
    [userId, activatableIds]
  )
  return ids
}

export async function markUnreferencedAutoAssetsForDeletion(client, userId, attachments) {
  const urls = uniqueAttachmentUrls(attachments)
  const ids = []

  for (const url of urls) {
    const result = await client.query(
      `
        SELECT a.id, a.retention
        FROM media_assets a
        WHERE a.user_id = $1
          AND a.url = $2
        FOR UPDATE
      `,
      [userId, url]
    )
    if (!result.rows.length || result.rows[0].retention !== 'auto') continue

    const references = await client.query(
      `
        SELECT COUNT(*)::integer AS count
        FROM notes n
        CROSS JOIN LATERAL jsonb_array_elements(n.attachments) attachment
        WHERE n.user_id = $1
          AND attachment->>'url' = $2
      `,
      [userId, url]
    )
    if (Number(references.rows[0]?.count || 0) > 0) continue

    await client.query(
      `
        UPDATE media_assets
        SET state = 'delete_pending',
            delete_requested_at = COALESCE(delete_requested_at, NOW()),
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
      `,
      [result.rows[0].id, userId]
    )
    ids.push(result.rows[0].id)
  }

  return ids
}

export async function syncNoteMediaReferences(client, userId, previousAttachments, nextAttachments) {
  const previousByUrl = new Map(
    (Array.isArray(previousAttachments) ? previousAttachments : [])
      .map((attachment) => [String(attachment?.url || '').trim(), attachment])
      .filter(([url]) => url)
  )
  const nextByUrl = new Map(
    (Array.isArray(nextAttachments) ? nextAttachments : [])
      .map((attachment) => [String(attachment?.url || '').trim(), attachment])
      .filter(([url]) => url)
  )
  const allAttachments = [...new Map(
    [...previousByUrl, ...nextByUrl]
  ).values()]

  await lockMediaAssetsForAttachments(client, userId, allAttachments, {
    source: 'reconciled',
    retention: 'auto'
  })
  await activateReferencedMediaAssets(client, userId, [...nextByUrl.values()], {
    source: 'reconciled',
    retention: 'auto'
  })

  const removed = [...previousByUrl]
    .filter(([url]) => !nextByUrl.has(url))
    .map(([, attachment]) => attachment)
  return { removed }
}

export async function countMediaReferences(client, userId, url) {
  const result = await client.query(
    `
      SELECT COUNT(*)::integer AS count
      FROM notes n
      CROSS JOIN LATERAL jsonb_array_elements(n.attachments) attachment
      WHERE n.user_id = $1
        AND attachment->>'url' = $2
    `,
    [userId, url]
  )
  return Number(result.rows[0]?.count || 0)
}

export async function attemptMediaAssetDeletion(
  userId,
  assetId,
  deleteUpstream,
  transactionRunner = null,
  { requireAuto = false, requirePending = false } = {}
) {
  const runTransaction = transactionRunner || (
    await import('../db/index.js')
  ).withTransaction
  return runTransaction(async (client) => {
    const result = await client.query(
      `
        SELECT *
        FROM media_assets
        WHERE id = $1
          AND user_id = $2
        FOR UPDATE
      `,
      [assetId, userId]
    )
    if (!result.rows.length) {
      throw createHttpError('Media not found', 404, 'media_not_found')
    }

    const asset = result.rows[0]
    if (asset.state === 'deleted') {
      return {
        state: 'deleted',
        asset,
        deletion: mediaDeletionOutcomeFromRecord(asset)
      }
    }
    if (
      (requireAuto && asset.retention !== 'auto')
      || (
        requirePending
        && !['delete_pending', 'delete_failed'].includes(asset.state)
      )
    ) {
      return { state: 'not_pending', asset }
    }

    const referenceCount = await countMediaReferences(client, userId, asset.url)
    if (referenceCount > 0) {
      await client.query(
        `
          UPDATE media_assets
          SET state = 'active',
              delete_requested_at = NULL,
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
        `,
        [asset.id]
      )
      return { state: 'referenced', asset, referenceCount }
    }

    await client.query(
      `
        UPDATE media_assets
        SET state = 'delete_pending',
            delete_requested_at = COALESCE(delete_requested_at, NOW()),
            delete_attempts = delete_attempts + 1,
            last_delete_attempt_at = NOW(),
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
      `,
      [asset.id]
    )

    try {
      const deletion = normalizeMediaDeletionOutcome(
        await deleteUpstream(asset.upstream_id, userId)
      )
      const deleted = await client.query(
        `
          UPDATE media_assets
          SET state = 'deleted',
              deleted_at = NOW(),
              last_delete_error = '',
              deletion_disposition = $2,
              deletion_source_deleted = $3,
              deletion_detached = $4,
              deletion_legacy = $5,
              deletion_already_missing = $6,
              deletion_cache_invalidated = $7,
              deletion_cache_purge_configured = $8,
              deletion_cache_purge_attempted = $9,
              deletion_cache_purge_succeeded = $10,
              deletion_local_cache_invalidated = $11,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [
          asset.id,
          deletion.disposition,
          deletion.sourceDeleted,
          deletion.detached,
          deletion.legacy,
          deletion.alreadyMissing,
          deletion.cacheInvalidated,
          deletion.cachePurgeConfigured,
          deletion.cachePurgeAttempted,
          deletion.cachePurgeSucceeded,
          deletion.localCacheInvalidated
        ]
      )
      return {
        state: 'deleted',
        asset: deleted.rows[0],
        referenceCount: 0,
        deletion
      }
    } catch (error) {
      const safeError = String(error?.code || error?.name || 'upstream_delete_failed')
        .replace(/[^a-z0-9_.:-]/gi, '')
        .slice(0, 120) || 'upstream_delete_failed'
      const failed = await client.query(
        `
          UPDATE media_assets
          SET state = 'delete_failed',
              last_delete_error = $2,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [asset.id, safeError]
      )
      return { state: 'delete_failed', asset: failed.rows[0], referenceCount: 0 }
    }
  })
}

export function mapMediaAsset(record) {
  if (!record) return null
  const references = Array.isArray(record.references) ? record.references : []
  return {
    id: record.id,
    url: record.url,
    name: record.name,
    mime: record.mime,
    size: Number(record.size || 0),
    source: record.source,
    retention: record.retention,
    state: record.state,
    referenceCount: Number(record.reference_count ?? references.length ?? 0),
    references,
    deleteAttempts: Number(record.delete_attempts || 0),
    lastDeleteError: record.last_delete_error || '',
    deletion: mediaDeletionOutcomeFromRecord(record),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    deletedAt: record.deleted_at || null
  }
}
