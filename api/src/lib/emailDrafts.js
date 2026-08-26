import { randomUUID } from 'node:crypto'
import { pool, query } from '../db/index.js'
import { decryptEmailPayload, encryptEmailPayload } from './emailCrypto.js'
import { enqueueUserMail } from './mailOutbox.js'
import { hashUserMailPayload, normalizeUserMailPayload } from './emailUserMail.js'

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const HASH_PATTERN = /^[0-9a-f]{64}$/

function assertUuid(value, label) {
  const normalized = String(value || '').trim()
  if (!UUID_PATTERN.test(normalized)) throw new TypeError(`${label} is invalid`)
  return normalized
}

function draftContext(userId, draftId) {
  return `draft:${assertUuid(userId, 'User id')}:${assertUuid(draftId, 'Draft id')}`
}

async function decryptDraftRow(row) {
  const payload = normalizeUserMailPayload(await decryptEmailPayload(
    row.payload_encrypted,
    { context: draftContext(row.user_id, row.id) }
  ))
  if (hashUserMailPayload(payload) !== row.content_hash) {
    throw new Error('Email draft content integrity check failed')
  }
  return {
    id: row.id,
    accountId: row.account_id,
    sourceMessageId: row.source_message_id,
    payload,
    contentHash: row.content_hash,
    status: row.status,
    outboxId: row.outbox_id,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function createEmailDraft({
  userId,
  accountId,
  sourceMessageId = null,
  payload,
  replyHeaders = null,
  expiresInDays = 30
}, {
  poolInstance = pool,
  encryptPayloadFn = encryptEmailPayload,
  draftId = randomUUID()
} = {}) {
  const ownerId = assertUuid(userId, 'User id')
  const ownedAccountId = assertUuid(accountId, 'Email account id')
  const sourceId = sourceMessageId ? assertUuid(sourceMessageId, 'Source message id') : null
  const normalized = normalizeUserMailPayload(payload, { replyHeaders: replyHeaders || {} })
  const contentHash = hashUserMailPayload(normalized)
  const id = assertUuid(draftId, 'Draft id')
  const days = Number(expiresInDays)
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new TypeError('Draft retention days are invalid')
  }
  const encrypted = await encryptPayloadFn(normalized, {
    context: draftContext(ownerId, id)
  })
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    const account = await client.query(
      'SELECT 1 FROM email_accounts WHERE id = $1 AND user_id = $2 AND enabled = TRUE',
      [ownedAccountId, ownerId]
    )
    if (!account.rowCount) throw new Error('Email account is unavailable')
    if (sourceId) {
      const source = await client.query(
        'SELECT 1 FROM email_messages WHERE id = $1 AND account_id = $2 AND user_id = $3',
        [sourceId, ownedAccountId, ownerId]
      )
      if (!source.rowCount) throw new Error('Source email message is unavailable')
    }
    const { rows } = await client.query(
      `INSERT INTO email_drafts (
         id, user_id, account_id, source_message_id,
         payload_encrypted, content_hash, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,NOW() + ($7::integer * INTERVAL '1 day'))
       RETURNING *`,
      [id, ownerId, ownedAccountId, sourceId, encrypted, contentHash, days]
    )
    await client.query('COMMIT')
    return decryptDraftRow(rows[0])
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
  }
}

export async function getEmailDraftForUser(
  userId,
  draftId,
  { queryFn = query } = {}
) {
  const ownerId = assertUuid(userId, 'User id')
  const id = assertUuid(draftId, 'Draft id')
  const { rows } = await queryFn(
    `SELECT * FROM email_drafts
     WHERE id = $1 AND user_id = $2 AND expires_at > NOW()
     LIMIT 1`,
    [id, ownerId]
  )
  return rows[0] ? decryptDraftRow(rows[0]) : null
}

export async function queueEmailDraft({
  userId,
  draftId,
  contentHash,
  confirmed
}, {
  poolInstance = pool,
  enqueueFn = enqueueUserMail
} = {}) {
  if (confirmed !== true) throw new TypeError('Explicit email send confirmation is required')
  const ownerId = assertUuid(userId, 'User id')
  const id = assertUuid(draftId, 'Draft id')
  const expectedHash = String(contentHash || '').trim().toLowerCase()
  if (!HASH_PATTERN.test(expectedHash)) throw new TypeError('Email draft hash is invalid')
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query(
      `SELECT * FROM email_drafts
       WHERE id = $1 AND user_id = $2 AND expires_at > NOW()
       FOR UPDATE`,
      [id, ownerId]
    )
    const row = selected.rows[0]
    if (!row) throw new Error('Email draft was not found or has expired')
    if (row.content_hash !== expectedHash) {
      throw new Error('Email draft changed; preview it again before sending')
    }
    if (row.status === 'queued' || row.status === 'sent') {
      await client.query('COMMIT')
      return { ...(await decryptDraftRow(row)), alreadyQueued: true }
    }
    if (row.status !== 'draft') throw new Error('Email draft can no longer be sent')
    const draft = await decryptDraftRow(row)
    const queued = await enqueueFn({
      userId: ownerId,
      accountId: row.account_id,
      sourceMessageId: row.source_message_id,
      draftId: id,
      payload: draft.payload,
      expectedContentHash: expectedHash,
      queryFn: client.query.bind(client)
    })
    const updated = await client.query(
      `UPDATE email_drafts
       SET status = 'queued', outbox_id = $3, confirmed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, ownerId, queued.id]
    )
    await client.query('COMMIT')
    return decryptDraftRow(updated.rows[0])
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
  }
}

