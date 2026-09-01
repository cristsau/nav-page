import { randomUUID } from 'node:crypto'
import { pool, query } from '../db/index.js'
import { decryptEmailPayload, encryptEmailPayload } from './emailCrypto.js'
import {
  claimDraftEmailAttachments,
  getDraftEmailAttachmentManifest,
  listDraftEmailAttachments
} from './emailAttachmentStore.js'
import { assertEmailAccountDeliveryReady } from './emailAccountDeliveryReadiness.js'
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

async function decryptDraftPayload(row) {
  return normalizeUserMailPayload(await decryptEmailPayload(
    row.payload_encrypted,
    { context: draftContext(row.user_id, row.id) }
  ))
}

async function decryptDraftRow(row, { attachmentManifest = [], attachments = [] } = {}) {
  const payload = await decryptDraftPayload(row)
  if (hashUserMailPayload(payload, attachmentManifest) !== row.content_hash) {
    throw new Error('Email draft content integrity check failed')
  }
  return {
    id: row.id,
    accountId: row.account_id,
    sourceMessageId: row.source_message_id,
    payload,
    attachments,
    contentHash: row.content_hash,
    status: row.status,
    outboxId: row.outbox_id,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function refreshEmailDraftContentHash({ userId, draftId }, {
  poolInstance = pool
} = {}) {
  const ownerId = assertUuid(userId, 'User id')
  const id = assertUuid(draftId, 'Draft id')
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    const selected = await client.query(
      `SELECT * FROM email_drafts
       WHERE id = $1 AND user_id = $2 AND status = 'draft' AND expires_at > NOW()
       FOR UPDATE`,
      [id, ownerId]
    )
    const row = selected.rows[0]
    if (!row) throw new Error('Email draft is unavailable for attachment changes')
    const payload = await decryptDraftPayload(row)
    const attachmentManifest = await getDraftEmailAttachmentManifest(
      { userId: ownerId, draftId: id },
      { queryFn: client.query.bind(client) }
    )
    const contentHash = hashUserMailPayload(payload, attachmentManifest)
    const updated = await client.query(
      `UPDATE email_drafts SET content_hash = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, ownerId, contentHash]
    )
    const attachments = await listDraftEmailAttachments(
      { userId: ownerId, draftId: id },
      { queryFn: client.query.bind(client) }
    )
    await client.query('COMMIT')
    return decryptDraftRow(updated.rows[0], { attachmentManifest, attachments })
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
  }
}

export async function createEmailDraftInTransaction({
  userId,
  accountId,
  sourceMessageId = null,
  payload,
  replyHeaders = null,
  expiresInDays = 30
}, {
  client,
  encryptPayloadFn = encryptEmailPayload,
  draftId = randomUUID()
} = {}) {
  if (!client?.query) throw new TypeError('Email draft transaction client is required')
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
  return decryptDraftRow(rows[0])
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
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    const draft = await createEmailDraftInTransaction({
      userId,
      accountId,
      sourceMessageId,
      payload,
      replyHeaders,
      expiresInDays
    }, {
      client,
      encryptPayloadFn,
      draftId
    })
    await client.query('COMMIT')
    return draft
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
  if (!rows[0]) return null
  const attachmentManifest = await getDraftEmailAttachmentManifest(
    { userId: ownerId, draftId: id },
    { queryFn }
  )
  const attachments = await listDraftEmailAttachments(
    { userId: ownerId, draftId: id },
    { queryFn }
  )
  try {
    return await decryptDraftRow(rows[0], { attachmentManifest, attachments })
  } catch (error) {
    // Attachment rows and the draft hash are written in separate bounded
    // transactions. If a process exits between them, a still-editable draft
    // can safely repair only its derived hash from the authenticated payload
    // and constrained attachment manifest. Queued/sent drafts never self-heal.
    if (rows[0].status !== 'draft') throw error
    const payload = await decryptDraftPayload(rows[0])
    const repairedHash = hashUserMailPayload(payload, attachmentManifest)
    const repaired = await queryFn(
      `UPDATE email_drafts SET content_hash = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'draft' AND content_hash = $4
       RETURNING *`,
      [id, ownerId, repairedHash, rows[0].content_hash]
    )
    if (!repaired.rows[0]) throw error
    return decryptDraftRow(repaired.rows[0], { attachmentManifest, attachments })
  }
}

export async function queueEmailDraft({
  userId,
  draftId,
  contentHash,
  confirmed
}, {
  poolInstance = pool,
  enqueueFn = enqueueUserMail,
  assertDeliveryReadyFn = assertEmailAccountDeliveryReady,
  client: transactionClient = null
} = {}) {
  if (confirmed !== true) throw new TypeError('Explicit email send confirmation is required')
  const ownerId = assertUuid(userId, 'User id')
  const id = assertUuid(draftId, 'Draft id')
  const expectedHash = String(contentHash || '').trim().toLowerCase()
  if (!HASH_PATTERN.test(expectedHash)) throw new TypeError('Email draft hash is invalid')
  const ownsTransaction = !transactionClient
  const client = transactionClient || await poolInstance.connect()
  try {
    if (ownsTransaction) await client.query('BEGIN')
    const selected = await client.query(
      `SELECT * FROM email_drafts
       WHERE id = $1 AND user_id = $2 AND expires_at > NOW()
       FOR UPDATE`,
      [id, ownerId]
    )
    const row = selected.rows[0]
    if (!row) throw new Error('Email draft was not found or has expired')
    const attachmentManifest = await getDraftEmailAttachmentManifest(
      { userId: ownerId, draftId: id },
      { queryFn: client.query.bind(client) }
    )
    const attachments = await listDraftEmailAttachments(
      { userId: ownerId, draftId: id },
      { queryFn: client.query.bind(client) }
    )
    if (row.content_hash !== expectedHash) {
      throw new Error('Email draft changed; preview it again before sending')
    }
    if (row.status === 'queued' || row.status === 'sent') {
      if (ownsTransaction) await client.query('COMMIT')
      return {
        ...(await decryptDraftRow(row, { attachmentManifest, attachments })),
        alreadyQueued: true
      }
    }
    if (row.status !== 'draft') throw new Error('Email draft can no longer be sent')
    await assertDeliveryReadyFn({
      userId: ownerId,
      accountId: row.account_id,
      queryFn: client.query.bind(client)
    })
    const draft = await decryptDraftRow(row, { attachmentManifest, attachments })
    const queued = await enqueueFn({
      userId: ownerId,
      accountId: row.account_id,
      sourceMessageId: row.source_message_id,
      draftId: id,
      payload: draft.payload,
      attachmentManifest,
      expectedContentHash: expectedHash,
      queryFn: client.query.bind(client)
    })
    await claimDraftEmailAttachments(
      { userId: ownerId, draftId: id, outboxId: queued.id },
      { queryFn: client.query.bind(client) }
    )
    const updated = await client.query(
      `UPDATE email_drafts
       SET status = 'queued', outbox_id = $3, confirmed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, ownerId, queued.id]
    )
    if (ownsTransaction) await client.query('COMMIT')
    return decryptDraftRow(updated.rows[0], { attachmentManifest, attachments })
  } catch (error) {
    if (ownsTransaction) {
      try { await client.query('ROLLBACK') } catch {}
    }
    throw error
  } finally {
    if (ownsTransaction) client.release()
  }
}
