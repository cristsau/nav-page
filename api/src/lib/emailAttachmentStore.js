import { createHash, randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { pool, query } from '../db/index.js'
import {
  decryptEmailPayloadWithKey,
  encryptEmailPayloadWithKey,
  loadEmailEncryptionKey
} from './emailCrypto.js'
import {
  EMAIL_ATTACHMENT_CHUNK_BYTES,
  decryptEmailAttachmentChunkWithKey,
  encryptEmailAttachmentChunkWithKey
} from './emailAttachmentCrypto.js'

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/
const MAX_FILENAME_CHARS = 255
const MAX_CONTENT_TYPE_CHARS = 160
const MAX_CONTENT_ID_CHARS = 250

export const EMAIL_ATTACHMENT_LIMITS = Object.freeze({
  maximumCount: 10,
  maximumSingleBytes: 10 * 1024 * 1024,
  maximumMessageBytes: 25 * 1024 * 1024,
  maximumUserStagedBytes: 100 * 1024 * 1024,
  chunkBytes: EMAIL_ATTACHMENT_CHUNK_BYTES
})

function attachmentError(message, statusCode = 400, code = 'EMAIL_ATTACHMENT_INVALID') {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function assertUuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) throw new TypeError(`${label} is invalid`)
  return normalized
}

function parseBoundedBytes(value, label, maximum) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > maximum) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function attachmentMetadataContext(userId, attachmentId) {
  return `attachment-metadata:${assertUuid(userId, 'User id')}:${assertUuid(attachmentId, 'Attachment id')}`
}

function normalizeFilename(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_FILENAME_CHARS) || ''
  if (!normalized || normalized === '.' || normalized === '..') {
    throw attachmentError('Email attachment filename is invalid')
  }
  return normalized
}

function normalizeContentType(value) {
  const normalized = String(value || 'application/octet-stream')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .slice(0, MAX_CONTENT_TYPE_CHARS)
  if (!MIME_TYPE_PATTERN.test(normalized)) {
    throw attachmentError('Email attachment content type is invalid')
  }
  return normalized
}

function normalizeContentId(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\s]/g, '')
    .replace(/^<|>$/g, '')
    .slice(0, MAX_CONTENT_ID_CHARS)
  if (value && !normalized) throw attachmentError('Email attachment content id is invalid')
  return normalized
}

export function normalizeEmailAttachmentMetadata(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw attachmentError('Email attachment metadata is invalid')
  }
  const disposition = String(value.disposition || 'attachment').trim().toLowerCase()
  if (!['attachment', 'inline'].includes(disposition)) {
    throw attachmentError('Email attachment disposition is invalid')
  }
  return {
    filename: normalizeFilename(value.filename ?? value.name),
    contentType: normalizeContentType(value.contentType ?? value.type),
    disposition,
    contentId: normalizeContentId(value.contentId ?? value.cid)
  }
}

function metadataDigest(metadata) {
  return sha256(Buffer.from(JSON.stringify(metadata), 'utf8'))
}

function manifestFromRow(row) {
  const manifest = {
    id: assertUuid(row.id, 'Attachment id'),
    sha256: String(row.sha256 || '').trim().toLowerCase(),
    size: parseBoundedBytes(
      row.size_bytes,
      'Email attachment size',
      EMAIL_ATTACHMENT_LIMITS.maximumSingleBytes
    ),
    ordinal: Number(row.ordinal),
    metadataDigest: String(row.metadata_digest || '').trim().toLowerCase()
  }
  if (
    !SHA256_PATTERN.test(manifest.sha256)
    || !Number.isSafeInteger(manifest.ordinal)
    || manifest.ordinal < 0
    || manifest.ordinal >= EMAIL_ATTACHMENT_LIMITS.maximumCount
    || !SHA256_PATTERN.test(manifest.metadataDigest)
  ) {
    throw new Error('Email attachment manifest is invalid')
  }
  return manifest
}

export function buildEmailAttachmentManifest(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError('Email attachment rows are invalid')
  return rows.map(manifestFromRow).sort((left, right) => left.ordinal - right.ordinal)
}

function normalizeAttachmentContent(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
  throw attachmentError('Email attachment content must be binary data')
}

function findAvailableOrdinal(rows, requestedOrdinal) {
  const occupied = new Set(rows.map((row) => Number(row.ordinal)))
  if (requestedOrdinal !== null && requestedOrdinal !== undefined) {
    const normalized = Number(requestedOrdinal)
    if (
      !Number.isSafeInteger(normalized)
      || normalized < 0
      || normalized >= EMAIL_ATTACHMENT_LIMITS.maximumCount
      || occupied.has(normalized)
    ) {
      throw attachmentError('Email attachment order is unavailable', 409, 'EMAIL_ATTACHMENT_ORDER_CONFLICT')
    }
    return normalized
  }
  for (let ordinal = 0; ordinal < EMAIL_ATTACHMENT_LIMITS.maximumCount; ordinal += 1) {
    if (!occupied.has(ordinal)) return ordinal
  }
  throw attachmentError(
    `Each email may contain at most ${EMAIL_ATTACHMENT_LIMITS.maximumCount} attachments`,
    413,
    'EMAIL_ATTACHMENT_COUNT_LIMIT'
  )
}

async function decryptAttachmentMetadata(row, key) {
  if (!row.metadata_encrypted) throw new Error('Email attachment metadata was scrubbed')
  const metadata = normalizeEmailAttachmentMetadata(decryptEmailPayloadWithKey(
    row.metadata_encrypted,
    key,
    { context: attachmentMetadataContext(row.user_id, row.id) }
  ))
  if (metadataDigest(metadata) !== String(row.metadata_digest)) {
    throw new Error('Email attachment metadata integrity check failed')
  }
  return metadata
}

export async function createDraftEmailAttachment({
  userId,
  draftId,
  metadata,
  content,
  ordinal = null
}, {
  poolInstance = pool,
  runtimeConfig = config,
  keyLoader = loadEmailEncryptionKey,
  attachmentId = randomUUID()
} = {}) {
  const ownerId = assertUuid(userId, 'User id')
  const ownedDraftId = assertUuid(draftId, 'Draft id')
  const id = assertUuid(attachmentId, 'Attachment id')
  const normalizedMetadata = normalizeEmailAttachmentMetadata(metadata)
  const plaintext = normalizeAttachmentContent(content)
  if (!plaintext.length || plaintext.length > EMAIL_ATTACHMENT_LIMITS.maximumSingleBytes) {
    plaintext.fill(0)
    throw attachmentError(
      `Each email attachment must be between 1 byte and ${EMAIL_ATTACHMENT_LIMITS.maximumSingleBytes} bytes`,
      413,
      'EMAIL_ATTACHMENT_SIZE_LIMIT'
    )
  }

  const attachmentHash = sha256(plaintext)
  const digest = metadataDigest(normalizedMetadata)
  let metadataEncrypted = null
  const chunks = []
  try {
    const key = await keyLoader(runtimeConfig)
    metadataEncrypted = encryptEmailPayloadWithKey(normalizedMetadata, key, {
      context: attachmentMetadataContext(ownerId, id)
    })
    for (let offset = 0, chunkIndex = 0; offset < plaintext.length; offset += EMAIL_ATTACHMENT_CHUNK_BYTES, chunkIndex += 1) {
      const chunk = plaintext.subarray(offset, Math.min(offset + EMAIL_ATTACHMENT_CHUNK_BYTES, plaintext.length))
      chunks.push({
        chunkIndex,
        plaintextSize: chunk.length,
        encrypted: encryptEmailAttachmentChunkWithKey(chunk, key, {
          userId: ownerId,
          attachmentId: id,
          chunkIndex
        })
      })
    }
  } finally {
    plaintext.fill(0)
  }

  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtext('email_attachment_quota'), hashtext($1::text)
       )`,
      [ownerId]
    )
    const draftResult = await client.query(
      `SELECT id FROM email_drafts
       WHERE id = $1 AND user_id = $2 AND status = 'draft' AND expires_at > NOW()
       FOR UPDATE`,
      [ownedDraftId, ownerId]
    )
    if (!draftResult.rowCount) {
      throw attachmentError(
        'Email draft is unavailable for attachments',
        409,
        'EMAIL_DRAFT_ATTACHMENT_UNAVAILABLE'
      )
    }
    const existingResult = await client.query(
      `SELECT ordinal, size_bytes
       FROM email_attachment_objects
       WHERE draft_id = $1 AND user_id = $2 AND state = 'draft'
       ORDER BY ordinal ASC
       FOR UPDATE`,
      [ownedDraftId, ownerId]
    )
    if (existingResult.rowCount >= EMAIL_ATTACHMENT_LIMITS.maximumCount) {
      throw attachmentError(
        `Each email may contain at most ${EMAIL_ATTACHMENT_LIMITS.maximumCount} attachments`,
        413,
        'EMAIL_ATTACHMENT_COUNT_LIMIT'
      )
    }
    const draftBytes = existingResult.rows.reduce(
      (total, row) => total + parseBoundedBytes(
        row.size_bytes,
        'Email attachment size',
        EMAIL_ATTACHMENT_LIMITS.maximumSingleBytes
      ),
      0
    )
    if (draftBytes + chunks.reduce((total, chunk) => total + chunk.plaintextSize, 0) > EMAIL_ATTACHMENT_LIMITS.maximumMessageBytes) {
      throw attachmentError(
        `Email attachments may total at most ${EMAIL_ATTACHMENT_LIMITS.maximumMessageBytes} bytes`,
        413,
        'EMAIL_ATTACHMENT_MESSAGE_LIMIT'
      )
    }
    const stagedResult = await client.query(
      `SELECT COALESCE(SUM(size_bytes), 0)::text AS total_bytes
       FROM email_attachment_objects
       WHERE user_id = $1 AND state IN ('draft', 'claimed')`,
      [ownerId]
    )
    const stagedBytes = parseBoundedBytes(
      stagedResult.rows[0]?.total_bytes || 0,
      'Email staged attachment bytes',
      EMAIL_ATTACHMENT_LIMITS.maximumUserStagedBytes
    )
    const sizeBytes = chunks.reduce((total, chunk) => total + chunk.plaintextSize, 0)
    if (stagedBytes + sizeBytes > EMAIL_ATTACHMENT_LIMITS.maximumUserStagedBytes) {
      throw attachmentError(
        `A user may stage at most ${EMAIL_ATTACHMENT_LIMITS.maximumUserStagedBytes} email attachment bytes`,
        413,
        'EMAIL_ATTACHMENT_USER_LIMIT'
      )
    }
    const selectedOrdinal = findAvailableOrdinal(existingResult.rows, ordinal)
    const objectResult = await client.query(
      `INSERT INTO email_attachment_objects (
         id, user_id, draft_id, state, ordinal, sha256, size_bytes,
         chunk_count, metadata_encrypted, metadata_digest
       ) VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        id,
        ownerId,
        ownedDraftId,
        selectedOrdinal,
        attachmentHash,
        sizeBytes,
        chunks.length,
        metadataEncrypted,
        digest
      ]
    )
    for (const chunk of chunks) {
      await client.query(
        `INSERT INTO email_attachment_chunks (
           attachment_id, user_id, chunk_index, plaintext_size, ciphertext_encrypted
         ) VALUES ($1,$2,$3,$4,$5)`,
        [id, ownerId, chunk.chunkIndex, chunk.plaintextSize, chunk.encrypted]
      )
    }
    await client.query('COMMIT')
    return {
      ...manifestFromRow(objectResult.rows[0]),
      ...normalizedMetadata,
      createdAt: objectResult.rows[0].created_at
    }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
  }
}

export async function listDraftEmailAttachments({ userId, draftId }, {
  queryFn = query,
  runtimeConfig = config,
  keyLoader = loadEmailEncryptionKey
} = {}) {
  const ownerId = assertUuid(userId, 'User id')
  const ownedDraftId = assertUuid(draftId, 'Draft id')
  const result = await queryFn(
    `SELECT * FROM email_attachment_objects
     WHERE draft_id = $1 AND user_id = $2 AND state IN ('draft', 'claimed')
     ORDER BY ordinal ASC, id ASC`,
    [ownedDraftId, ownerId]
  )
  if (!result.rowCount) return []
  const key = await keyLoader(runtimeConfig)
  return Promise.all(result.rows.map(async (row) => ({
    ...manifestFromRow(row),
    ...(await decryptAttachmentMetadata(row, key)),
    createdAt: row.created_at
  })))
}

export async function getDraftEmailAttachmentManifest({ userId, draftId }, {
  queryFn = query
} = {}) {
  const ownerId = assertUuid(userId, 'User id')
  const ownedDraftId = assertUuid(draftId, 'Draft id')
  const result = await queryFn(
    `SELECT * FROM email_attachment_objects
     WHERE draft_id = $1 AND user_id = $2 AND state IN ('draft', 'claimed', 'scrubbed')
     ORDER BY ordinal ASC, id ASC`,
    [ownedDraftId, ownerId]
  )
  return buildEmailAttachmentManifest(result.rows)
}

export async function deleteDraftEmailAttachment({ userId, draftId, attachmentId }, {
  poolInstance = pool
} = {}) {
  const ownerId = assertUuid(userId, 'User id')
  const ownedDraftId = assertUuid(draftId, 'Draft id')
  const id = assertUuid(attachmentId, 'Attachment id')
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    const draft = await client.query(
      `SELECT id FROM email_drafts
       WHERE id = $1 AND user_id = $2 AND status = 'draft' AND expires_at > NOW()
       FOR UPDATE`,
      [ownedDraftId, ownerId]
    )
    if (!draft.rowCount) {
      throw attachmentError(
        'Email draft is unavailable for attachment changes',
        409,
        'EMAIL_DRAFT_ATTACHMENT_UNAVAILABLE'
      )
    }
    const removed = await client.query(
      `DELETE FROM email_attachment_objects
       WHERE id = $1 AND draft_id = $2 AND user_id = $3 AND state = 'draft'
       RETURNING id`,
      [id, ownedDraftId, ownerId]
    )
    if (!removed.rowCount) {
      throw attachmentError('Email attachment was not found', 404, 'EMAIL_ATTACHMENT_NOT_FOUND')
    }
    await client.query('COMMIT')
    return { removed: true, id }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
  }
}

export async function claimDraftEmailAttachments({ userId, draftId, outboxId }, {
  queryFn = query
} = {}) {
  const ownerId = assertUuid(userId, 'User id')
  const ownedDraftId = assertUuid(draftId, 'Draft id')
  const ownedOutboxId = assertUuid(outboxId, 'Outbox id')
  const binding = await queryFn(
    `SELECT draft.id
     FROM email_drafts AS draft
     JOIN mail_outbox AS outbox
       ON outbox.id = $3
      AND outbox.user_id = $2
      AND outbox.account_id = draft.account_id
      AND outbox.message_type = 'user.mail'
     WHERE draft.id = $1 AND draft.user_id = $2
     LIMIT 1`,
    [ownedDraftId, ownerId, ownedOutboxId]
  )
  if (!binding.rowCount) {
    throw attachmentError(
      'Email draft and outbox binding is invalid',
      409,
      'EMAIL_ATTACHMENT_CLAIM_INVALID'
    )
  }
  const conflicts = await queryFn(
    `SELECT id FROM email_attachment_objects
     WHERE draft_id = $1 AND user_id = $2
       AND state = 'claimed' AND outbox_id <> $3
     LIMIT 1`,
    [ownedDraftId, ownerId, ownedOutboxId]
  )
  if (conflicts.rowCount) {
    throw attachmentError(
      'Email attachments were already claimed by another outbox message',
      409,
      'EMAIL_ATTACHMENT_ALREADY_CLAIMED'
    )
  }
  const claimed = await queryFn(
    `UPDATE email_attachment_objects
     SET state = 'claimed', outbox_id = $3, updated_at = NOW()
     WHERE draft_id = $1 AND user_id = $2
       AND (
         state = 'draft'
         OR (state = 'claimed' AND outbox_id = $3)
       )
     RETURNING *`,
    [ownedDraftId, ownerId, ownedOutboxId]
  )
  return buildEmailAttachmentManifest(claimed.rows)
}

export async function loadOutboxEmailAttachments({ userId, outboxId }, {
  queryFn = query,
  runtimeConfig = config,
  keyLoader = loadEmailEncryptionKey
} = {}) {
  const ownerId = assertUuid(userId, 'User id')
  const ownedOutboxId = assertUuid(outboxId, 'Outbox id')
  const result = await queryFn(
    `SELECT object.*, chunk.chunk_index, chunk.plaintext_size,
            chunk.ciphertext_encrypted
     FROM email_attachment_objects AS object
     LEFT JOIN email_attachment_chunks AS chunk
       ON chunk.attachment_id = object.id AND chunk.user_id = object.user_id
     WHERE object.outbox_id = $1 AND object.user_id = $2 AND object.state = 'claimed'
     ORDER BY object.ordinal ASC, object.id ASC, chunk.chunk_index ASC`,
    [ownedOutboxId, ownerId]
  )
  if (!result.rowCount) return { attachments: [], manifest: [], totalBytes: 0 }
  const grouped = new Map()
  for (const row of result.rows) {
    if (!grouped.has(row.id)) grouped.set(row.id, { row, chunks: [] })
    if (row.chunk_index !== null && row.chunk_index !== undefined) {
      grouped.get(row.id).chunks.push(row)
    }
  }
  const key = await keyLoader(runtimeConfig)
  const loaded = []
  const manifest = []
  let totalBytes = 0
  try {
    for (const { row, chunks } of grouped.values()) {
      const itemManifest = manifestFromRow(row)
      const expectedChunkCount = Number(row.chunk_count)
      if (!Number.isSafeInteger(expectedChunkCount) || chunks.length !== expectedChunkCount) {
        throw new Error('Email attachment chunk set is incomplete')
      }
      const plaintextChunks = []
      try {
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index]
          if (Number(chunk.chunk_index) !== index) {
            throw new Error('Email attachment chunk order is invalid')
          }
          plaintextChunks.push(decryptEmailAttachmentChunkWithKey(
            chunk.ciphertext_encrypted,
            key,
            {
              userId: ownerId,
              attachmentId: row.id,
              chunkIndex: index
            },
            { expectedPlaintextBytes: Number(chunk.plaintext_size) }
          ))
        }
        const content = Buffer.concat(plaintextChunks)
        if (content.length !== itemManifest.size || sha256(content) !== itemManifest.sha256) {
          content.fill(0)
          throw new Error('Email attachment content integrity check failed')
        }
        const metadata = await decryptAttachmentMetadata(row, key)
        const nodemailerAttachment = {
          filename: metadata.filename,
          contentType: metadata.contentType,
          contentDisposition: metadata.disposition,
          content
        }
        if (metadata.contentId) nodemailerAttachment.cid = metadata.contentId
        loaded.push(nodemailerAttachment)
        manifest.push(itemManifest)
        totalBytes += content.length
      } finally {
        for (const plaintextChunk of plaintextChunks) plaintextChunk.fill(0)
      }
    }
    return { attachments: loaded, manifest, totalBytes }
  } catch (error) {
    disposeLoadedEmailAttachments(loaded)
    throw error
  }
}

export function disposeLoadedEmailAttachments(attachments = []) {
  for (const attachment of attachments) {
    if (Buffer.isBuffer(attachment?.content)) attachment.content.fill(0)
  }
}

export async function scrubOutboxEmailAttachments({ userId, outboxId }, {
  poolInstance = pool
} = {}) {
  const ownerId = assertUuid(userId, 'User id')
  const ownedOutboxId = assertUuid(outboxId, 'Outbox id')
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query(
      `SELECT id, size_bytes FROM email_attachment_objects
       WHERE outbox_id = $1 AND user_id = $2 AND state = 'claimed'
       ORDER BY ordinal ASC
       FOR UPDATE`,
      [ownedOutboxId, ownerId]
    )
    if (!selected.rowCount) {
      await client.query('COMMIT')
      return { scrubbed: 0, scrubbedBytes: 0 }
    }
    const ids = selected.rows.map((row) => row.id)
    await client.query(
      `DELETE FROM email_attachment_chunks
       WHERE user_id = $1 AND attachment_id = ANY($2::uuid[])`,
      [ownerId, ids]
    )
    const updated = await client.query(
      `UPDATE email_attachment_objects
       SET state = 'scrubbed', metadata_encrypted = NULL,
           scrubbed_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND id = ANY($2::uuid[]) AND state = 'claimed'
       RETURNING id`,
      [ownerId, ids]
    )
    await client.query('COMMIT')
    return {
      scrubbed: updated.rowCount,
      scrubbedBytes: selected.rows.reduce(
        (total, row) => total + parseBoundedBytes(
          row.size_bytes,
          'Email attachment size',
          EMAIL_ATTACHMENT_LIMITS.maximumSingleBytes
        ),
        0
      )
    }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
  }
}
