import { createHash } from 'node:crypto'
import nodemailer from 'nodemailer'
import { config } from '../config.js'
import { query } from '../db/index.js'
import { normalizeEmailAddress } from './emailUserMail.js'
import {
  decryptEmailSentMime,
  encryptEmailSentMime,
  EMAIL_SENT_MIME_MAX_BYTES
} from './emailSentMimeCrypto.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const ACTIVE_STATES = new Set(['prepared', 'pending', 'appending', 'reconcile', 'blocked'])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedDate(value) {
  const date = new Date(value || Date.now())
  if (Number.isNaN(date.getTime())) throw new TypeError('Email frozen MIME date is invalid')
  return date
}

function safeDisplayName(value) {
  return String(value || 'DOMO NAV').normalize('NFKC').replace(/[\r\n]/g, '').trim().slice(0, 120) || 'DOMO NAV'
}

function uniqueRecipients(payload) {
  return [...new Set([
    ...(payload?.to || []),
    ...(payload?.cc || []),
    ...(payload?.bcc || [])
  ].map(normalizeEmailAddress))]
}

export function deriveSentMessageIdentity(outboxId) {
  const digest = sha256(String(outboxId || ''))
  return {
    messageId: `<domo-nav-${digest.slice(0, 32)}@nav.skrskr.net>`,
    navId: digest.slice(0, 24)
  }
}

export function buildSmtpEnvelope(payload, runtimeConfig = config) {
  return {
    from: normalizeEmailAddress(runtimeConfig.smtpFromAddress),
    to: uniqueRecipients(payload)
  }
}

export async function freezeOutgoingMime({
  outboxId,
  payload,
  attachments = [],
  date,
  runtimeConfig = config,
  transportFactory = () => nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows'
  })
}) {
  const identity = deriveSentMessageIdentity(outboxId)
  const transport = transportFactory()
  let result
  try {
    result = await transport.sendMail({
      from: {
        name: safeDisplayName(runtimeConfig.smtpFromName),
        address: normalizeEmailAddress(runtimeConfig.smtpFromAddress)
      },
      to: payload.to,
      cc: payload.cc?.length ? payload.cc : undefined,
      // Bcc intentionally exists only in the SMTP envelope. The frozen RFC822
      // message is the exact copy written to Sent and must not expose it.
      subject: payload.subject,
      text: payload.text,
      inReplyTo: payload.inReplyTo || undefined,
      references: payload.references?.length ? payload.references : undefined,
      attachments: attachments.length ? attachments : undefined,
      date: normalizedDate(date),
      messageId: identity.messageId,
      headers: {
        'X-DOMO-NAV-Message-Type': 'user.mail',
        'X-DOMO-NAV-Id': identity.navId
      }
    })
  } finally {
    try { transport.close?.() } catch {}
  }
  const mime = Buffer.isBuffer(result?.message)
    ? Buffer.from(result.message)
    : Buffer.from(result?.message || '')
  if (!mime.length || mime.length > EMAIL_SENT_MIME_MAX_BYTES) {
    mime.fill(0)
    throw new Error('Frozen email MIME is empty or too large')
  }
  return {
    ...identity,
    envelope: buildSmtpEnvelope(payload, runtimeConfig),
    mime,
    mimeSha256: sha256(mime),
    mimeSizeBytes: mime.length
  }
}

function assertStoredJob(row, { outboxId, userId }) {
  if (!row || String(row.outbox_id) !== String(outboxId) || String(row.user_id) !== String(userId)) {
    throw new Error('Frozen Sent append job identity mismatch')
  }
  if (!ACTIVE_STATES.has(row.status)) {
    throw new Error('Frozen Sent append job is no longer sendable')
  }
  if (!row.mime_encrypted || !SHA256_PATTERN.test(String(row.mime_sha256 || ''))) {
    throw new Error('Frozen Sent append job payload is unavailable')
  }
  return row
}

export async function loadFrozenSentAppendMime(row, {
  runtimeConfig = config,
  decryptMimeFn = decryptEmailSentMime
} = {}) {
  const mime = await decryptMimeFn(
    row.mime_encrypted,
    { userId: row.user_id, outboxId: row.outbox_id },
    { runtimeConfig, expectedBytes: Number(row.mime_size_bytes) }
  )
  if (sha256(mime) !== String(row.mime_sha256)) {
    mime.fill(0)
    throw new Error('Frozen email MIME integrity check failed')
  }
  return mime
}

export async function getOrCreateFrozenSentAppend({
  client,
  message,
  payload,
  attachments = [],
  runtimeConfig = config,
  freezeMimeFn = freezeOutgoingMime,
  encryptMimeFn = encryptEmailSentMime,
  decryptMimeFn = decryptEmailSentMime
}) {
  if (!client?.query) throw new TypeError('PostgreSQL client is required')
  const existing = await client.query(
    `SELECT * FROM email_sent_append_jobs WHERE outbox_id = $1 LIMIT 1`,
    [message.id]
  )
  if (existing.rowCount) {
    const job = assertStoredJob(existing.rows[0], {
      outboxId: message.id,
      userId: message.user_id
    })
    return {
      job,
      mime: await loadFrozenSentAppendMime(job, { runtimeConfig, decryptMimeFn }),
      envelope: buildSmtpEnvelope(payload, runtimeConfig),
      created: false
    }
  }

  const frozen = await freezeMimeFn({
    outboxId: message.id,
    payload,
    attachments,
    date: message.confirmed_at || message.created_at,
    runtimeConfig
  })
  let encrypted = null
  try {
    encrypted = await encryptMimeFn(
      frozen.mime,
      { userId: message.user_id, outboxId: message.id },
      { runtimeConfig }
    )
    const inserted = await client.query(
      `INSERT INTO email_sent_append_jobs (
         outbox_id, user_id, account_id, status, message_id, nav_id,
         mime_encrypted, mime_sha256, mime_size_bytes
       ) VALUES ($1,$2,$3,'prepared',$4,$5,$6,$7,$8)
       ON CONFLICT (outbox_id) DO NOTHING
       RETURNING *`,
      [
        message.id,
        message.user_id,
        message.account_id,
        frozen.messageId,
        frozen.navId,
        encrypted,
        frozen.mimeSha256,
        frozen.mimeSizeBytes
      ]
    )
    // The one generated RFC822 source is never retained as plaintext between
    // database operations. Read back the encrypted authoritative copy for the
    // SMTP call, and clear both plaintext buffers in their respective owners.
    frozen.mime.fill(0)
    const stored = inserted.rowCount
      ? inserted.rows[0]
      : (await client.query(
          `SELECT * FROM email_sent_append_jobs WHERE outbox_id = $1 LIMIT 1`,
          [message.id]
        )).rows[0]
    const job = assertStoredJob(stored, {
      outboxId: message.id,
      userId: message.user_id
    })
    return {
      job,
      mime: await loadFrozenSentAppendMime(job, { runtimeConfig, decryptMimeFn }),
      envelope: frozen.envelope,
      created: inserted.rowCount === 1
    }
  } finally {
    if (Buffer.isBuffer(frozen.mime)) frozen.mime.fill(0)
    if (Buffer.isBuffer(encrypted)) encrypted.fill(0)
  }
}

export async function getEmailSentAppendStatus({ userId, draftId }, {
  queryFn = query
} = {}) {
  const result = await queryFn(
    `SELECT job.status, job.smtp_accepted_at, job.appended_at,
            job.sent_folder_path, job.last_error_code, job.updated_at
     FROM email_drafts AS draft
     JOIN email_sent_append_jobs AS job ON job.outbox_id = draft.outbox_id
     WHERE draft.id = $1 AND draft.user_id = $2
     LIMIT 1`,
    [draftId, userId]
  )
  if (!result.rowCount) return null
  const row = result.rows[0]
  return {
    status: row.status,
    smtpAcceptedAt: row.smtp_accepted_at,
    appendedAt: row.appended_at,
    sentFolderPath: row.sent_folder_path,
    lastErrorCode: row.last_error_code,
    updatedAt: row.updated_at
  }
}
