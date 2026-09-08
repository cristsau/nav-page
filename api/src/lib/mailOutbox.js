import { createHash, randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import { SYSTEM_MAIL_SQL } from './mailboxRetirement.js'
import { config } from '../config.js'
import { query } from '../db/index.js'
import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'
import { resolveSmtpAuth } from './emailOauth2.js'
import { assertSafeOutboundHost } from './outboundEndpoints.js'
import { decryptEmailPayload, encryptEmailPayload } from './emailCrypto.js'
import {
  disposeLoadedEmailAttachments,
  loadOutboxEmailAttachments
} from './emailAttachmentStore.js'
import {
  freezeOutgoingMime,
  getOrCreateFrozenSentAppend
} from './emailSentMessage.js'
import {
  hashUserMailPayload,
  normalizeEmailAddress,
  normalizeUserMailAttachmentManifest,
  normalizeUserMailPayload
} from './emailUserMail.js'

const MESSAGE_TYPE_PATTERN = /^[a-z0-9_.-]+$/
const LOCK_SQL = 'SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1)) AS acquired'
const UNLOCK_SQL = 'SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1)) AS released'
const DELIVERY_SCOPE_SQL = `(
  ($2::boolean AND mail_outbox.message_type <> 'user.mail')
  OR (
    mail_outbox.message_type = 'user.mail'
    AND EXISTS (
      SELECT 1
      FROM email_accounts AS delivery_account
      JOIN users AS delivery_owner ON delivery_owner.id = delivery_account.user_id
      WHERE delivery_account.id = mail_outbox.account_id
        AND delivery_account.user_id = mail_outbox.user_id
        AND delivery_account.enabled = TRUE
        AND delivery_account.source_key = $1
        AND delivery_owner.username = $3
        AND delivery_owner.status = 'approved'
    )
  )
)`

export { normalizeEmailAddress }

function normalizeMessageType(value) {
  const type = String(value || '').trim().toLowerCase()
  if (!MESSAGE_TYPE_PATTERN.test(type) || type.length > 64) {
    throw new TypeError('Mail message type is invalid')
  }
  return type
}

function normalizeSubject(value) {
  const subject = String(value || '').normalize('NFKC').replace(/[\r\n]+/g, ' ').trim().slice(0, 240)
  if (!subject) throw new TypeError('Mail subject is required')
  return subject
}

function normalizeBody(value, maximum = 80_000) {
  return String(value ?? '').replace(/\u0000/g, '').slice(0, maximum)
}

function normalizeDedupeKey(value) {
  const key = String(value || '').normalize('NFKC').trim().slice(0, 300)
  if (!key) throw new TypeError('Mail dedupe key is required')
  return key
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function isDefinitiveSmtpRejection(error) {
  const responseCode = Number(error?.responseCode)
  if (Number.isSafeInteger(responseCode) && responseCode >= 400 && responseCode <= 599) {
    return true
  }
  const code = String(error?.code || '').trim().toUpperCase()
  const command = String(error?.command || '').trim().toUpperCase()
  // Authentication fails before the message transaction begins. Network,
  // timeout and connection-close failures remain ambiguous because the
  // remote server may have accepted DATA before the client observed them.
  return code === 'EAUTH'
    || code === 'SMTP_ALL_RECIPIENTS_REJECTED'
    || command === 'AUTH'
}

export const SMTP_DELIVERY_ERROR_CODES = Object.freeze({
  ambiguous: 'AMBIGUOUS_DELIVERY_STATE',
  partial: 'PARTIAL_RECIPIENT_REJECTION',
  allRecipientsRejected: 'SMTP_ALL_RECIPIENTS_REJECTED'
})

export function classifySmtpRecipientOutcome(result) {
  // Retain only counts for control flow. Recipient addresses must not enter
  // outbox status, maintenance logs or structured error codes.
  const acceptedCount = Array.isArray(result?.accepted) ? result.accepted.length : 0
  const rejectedCount = Array.isArray(result?.rejected) ? result.rejected.length : 0
  if (acceptedCount > 0 && rejectedCount > 0) {
    return { status: 'partial', acceptedCount, rejectedCount }
  }
  if (rejectedCount > 0) {
    return { status: 'rejected', acceptedCount, rejectedCount }
  }
  if (acceptedCount === 0) {
    return { status: 'ambiguous', acceptedCount, rejectedCount }
  }
  return { status: 'accepted', acceptedCount, rejectedCount }
}

async function scrubOutboxAttachmentsInTransaction(client, message) {
  if (!message?.user_id) return
  await client.query(
    `DELETE FROM email_attachment_chunks AS chunk
     USING email_attachment_objects AS object
     WHERE object.outbox_id = $1 AND object.user_id = $2
       AND object.state = 'claimed'
       AND chunk.attachment_id = object.id
       AND chunk.user_id = object.user_id`,
    [message.id, message.user_id]
  )
  await client.query(
    `UPDATE email_attachment_objects
     SET state = 'scrubbed', metadata_encrypted = NULL,
         scrubbed_at = NOW(), updated_at = NOW()
     WHERE outbox_id = $1 AND user_id = $2 AND state = 'claimed'`,
    [message.id, message.user_id]
  )
}

async function withOutboxTransaction(client, operation) {
  await client.query('BEGIN')
  try {
    const result = await operation()
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  }
}

async function scrubExpiredOutboxArtifactsInTransaction(client, rows, errorCode) {
  const ownedRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.id && row?.user_id)
  if (!ownedRows.length) return
  const outboxIds = ownedRows.map((row) => row.id)

  // A prepared Sent job has not been handed to the APPEND state machine yet.
  // Once SMTP delivery becomes ambiguous or the outbox is permanently
  // expired, retaining that encrypted RFC822 source would be both misleading
  // and an unbounded sensitive-data leak.
  await client.query(
    `UPDATE email_sent_append_jobs
     SET status = 'cancelled', mime_encrypted = NULL,
         last_error_code = $2, scrubbed_at = NOW(), updated_at = NOW()
     WHERE outbox_id = ANY($1::uuid[]) AND status = 'prepared'`,
    [outboxIds, errorCode]
  )

  await client.query(
    `DELETE FROM email_attachment_chunks AS chunk
     USING email_attachment_objects AS object
     WHERE object.outbox_id = ANY($1::uuid[])
       AND object.state = 'claimed'
       AND chunk.attachment_id = object.id
       AND chunk.user_id = object.user_id`,
    [outboxIds]
  )
  await client.query(
    `UPDATE email_attachment_objects
     SET state = 'scrubbed', metadata_encrypted = NULL,
         scrubbed_at = NOW(), updated_at = NOW()
     WHERE outbox_id = ANY($1::uuid[]) AND state = 'claimed'`,
    [outboxIds]
  )
  await client.query(
    `UPDATE email_drafts SET status = 'failed', updated_at = NOW()
     WHERE outbox_id = ANY($1::uuid[]) AND status = 'queued'`,
    [outboxIds]
  )
}

async function finalizeAcceptedDelivery(client, message, { sentAppendJobId = null } = {}) {
  await client.query('BEGIN')
  try {
    if (sentAppendJobId) {
      const job = await client.query(
        `UPDATE email_sent_append_jobs
         SET status = 'pending', smtp_accepted_at = COALESCE(smtp_accepted_at, NOW()),
             next_attempt_at = NOW(), last_error_code = NULL, updated_at = NOW()
         WHERE id = $1 AND outbox_id = $2 AND user_id = $3
           AND status IN ('prepared', 'pending')
         RETURNING id`,
        [sentAppendJobId, message.id, message.user_id]
      )
      if (!job.rowCount) throw new Error('Sent append job could not be activated')
    }
    const delivered = await client.query(
      `UPDATE mail_outbox
       SET status = 'sent',
           attempt_count = attempt_count + CASE WHEN status = 'sending' THEN 1 ELSE 0 END,
           last_attempt_at = NOW(), sent_at = COALESCE(sent_at, NOW()),
           recipient = CASE WHEN sensitive THEN 'redacted@invalid.local' ELSE recipient END,
           subject = CASE WHEN sensitive THEN '[已发送，内容已清除]' ELSE subject END,
           text_body = '', html_body = '', payload_encrypted = NULL,
           scrubbed_at = NOW(), last_error_code = NULL, updated_at = NOW()
       WHERE id = $1 AND status IN ('sending', 'sent')
       RETURNING id`,
      [message.id]
    )
    if (!delivered.rowCount) throw new Error('Mail outbox state could not be finalized')
    await scrubOutboxAttachmentsInTransaction(client, message)
    await client.query(
      `UPDATE email_drafts SET status = 'sent', updated_at = NOW()
       WHERE outbox_id = $1`,
      [message.id]
    )
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  }
}

async function finalizePartialDelivery(client, message, { sentAppendJobId = null } = {}) {
  await client.query('BEGIN')
  try {
    // Some recipients accepted DATA, so a whole-message retry is unsafe. The
    // already-frozen MIME may still be appended once to Sent, independently
    // of the terminal manual-review delivery state.
    if (sentAppendJobId) {
      const job = await client.query(
        `UPDATE email_sent_append_jobs
         SET status = 'pending', smtp_accepted_at = COALESCE(smtp_accepted_at, NOW()),
             next_attempt_at = NOW(), last_error_code = NULL, updated_at = NOW()
         WHERE id = $1 AND outbox_id = $2 AND user_id = $3
           AND status IN ('prepared', 'pending')
         RETURNING id`,
        [sentAppendJobId, message.id, message.user_id]
      )
      if (!job.rowCount) throw new Error('Partial delivery Sent append job could not be activated')
    }
    const delivered = await client.query(
      `UPDATE mail_outbox
       SET status = 'expired',
           attempt_count = attempt_count + CASE WHEN status = 'sending' THEN 1 ELSE 0 END,
           last_attempt_at = NOW(), sent_at = COALESCE(sent_at, NOW()),
           recipient = CASE WHEN sensitive THEN 'redacted@invalid.local' ELSE recipient END,
           subject = CASE WHEN sensitive THEN '[部分收件人拒收，内容已清除]' ELSE subject END,
           text_body = '', html_body = '', payload_encrypted = NULL,
           scrubbed_at = NOW(), last_error_code = $2, updated_at = NOW()
       WHERE id = $1
         AND (
           status = 'sending'
           OR (status = 'expired' AND last_error_code = $2)
         )
       RETURNING id`,
      [message.id, SMTP_DELIVERY_ERROR_CODES.partial]
    )
    if (!delivered.rowCount) throw new Error('Partial mail delivery state could not be finalized')
    await scrubOutboxAttachmentsInTransaction(client, message)
    await client.query(
      `UPDATE email_drafts SET status = 'failed', updated_at = NOW()
       WHERE outbox_id = $1 AND status IN ('queued', 'failed')`,
      [message.id]
    )
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  }
}

async function recordAmbiguousSmtpAttempt(client, message, sentAppendJobId) {
  await client.query('BEGIN')
  try {
    if (sentAppendJobId) {
      await client.query(
        `UPDATE email_sent_append_jobs
         SET status = 'cancelled', mime_encrypted = NULL,
             last_error_code = $2,
             scrubbed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'prepared'`,
        [sentAppendJobId, SMTP_DELIVERY_ERROR_CODES.ambiguous]
      )
    }
    await client.query(
      `UPDATE mail_outbox
       SET status = 'expired', attempt_count = attempt_count + 1,
           last_attempt_at = NOW(),
           recipient = CASE WHEN sensitive THEN 'redacted@invalid.local' ELSE recipient END,
           subject = CASE WHEN sensitive THEN '[投递状态不确定，内容已清除]' ELSE subject END,
           text_body = '', html_body = '', payload_encrypted = NULL,
           scrubbed_at = NOW(), last_error_code = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'sending'`,
      [message.id, SMTP_DELIVERY_ERROR_CODES.ambiguous]
    )
    await scrubOutboxAttachmentsInTransaction(client, message)
    await client.query(
      `UPDATE email_drafts SET status = 'failed', updated_at = NOW()
       WHERE outbox_id = $1 AND status = 'queued'`,
      [message.id]
    )
    await client.query('COMMIT')
  } catch (recordError) {
    try { await client.query('ROLLBACK') } catch {}
    throw recordError
  }
}

export function validateMailDeliveryPolicy(policy = {}) {
  return {
    intervalSeconds: boundedInteger(policy.intervalSeconds, 30, 10, 86_400),
    batchSize: boundedInteger(policy.batchSize, 25, 1, 100),
    maxAttempts: boundedInteger(policy.maxAttempts, 8, 1, 20)
  }
}

export function validateSmtpConfig(runtimeConfig = config) {
  const host = String(runtimeConfig.smtpHost || '').trim().toLowerCase()
  if (!host || host.length > 253 || /[\s\u0000-\u001F\u007F]/.test(host)) {
    throw new Error('SMTP host is invalid')
  }
  if (Number(runtimeConfig.smtpPort) !== 465 || runtimeConfig.smtpSecure !== true) {
    throw new Error('SMTP must use implicit TLS on port 465')
  }
  normalizeEmailAddress(runtimeConfig.smtpUsername)
  normalizeEmailAddress(runtimeConfig.smtpFromAddress)
  if (
    !String(runtimeConfig.smtpPasswordFile || '').trim()
    && !String(runtimeConfig.smtpOauthProvider || '').trim()
  ) {
    throw new Error('SMTP password file is not configured')
  }
  return host
}

export async function verifiedMailConfigurationStatus(
  runtimeConfig = config,
  { readSecretImpl = readOwnerSecretFile } = {}
) {
  const baseConfigured = Boolean(
    runtimeConfig.smtpHost
    && runtimeConfig.smtpUsername
    && (runtimeConfig.smtpPasswordFile || runtimeConfig.smtpOauthProvider)
    && runtimeConfig.smtpFromAddress
  )
  if (!baseConfigured) {
    return { configured: false, enabled: runtimeConfig.mailDeliveryEnabled, transport: 'smtp-tls' }
  }
  try {
    validateSmtpConfig(runtimeConfig)
    if (runtimeConfig.smtpOauthProvider) {
      await resolveSmtpAuth(runtimeConfig, { readSecretImpl })
    } else {
      await readSecretImpl(runtimeConfig.smtpPasswordFile, { label: 'SMTP password', maxBytes: 4096 })
    }
    return {
      configured: true,
      enabled: runtimeConfig.mailDeliveryEnabled,
      transport: 'smtp-tls',
      host: runtimeConfig.smtpHost,
      port: runtimeConfig.smtpPort,
      secure: runtimeConfig.smtpSecure
    }
  } catch {
    return { configured: false, enabled: runtimeConfig.mailDeliveryEnabled, transport: 'smtp-tls' }
  }
}

export async function enqueueMail({
  messageType,
  recipient,
  subject,
  textBody = '',
  htmlBody = '',
  dedupeKey,
  sensitive = true,
  queryFn = query
}) {
  const { rows } = await queryFn(
    `
      INSERT INTO mail_outbox (
        message_type, recipient, subject, text_body, html_body,
        dedupe_key, sensitive
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (dedupe_key) DO UPDATE SET updated_at = mail_outbox.updated_at
      RETURNING id, status, created_at
    `,
    [
      normalizeMessageType(messageType),
      normalizeEmailAddress(recipient),
      normalizeSubject(subject),
      normalizeBody(textBody),
      normalizeBody(htmlBody),
      normalizeDedupeKey(dedupeKey),
      Boolean(sensitive)
    ]
  )
  return rows[0]
}

function userMailOutboxContext(userId, outboxId) {
  return `outbox:${String(userId)}:${String(outboxId)}`
}

export async function enqueueUserMail({
  userId,
  accountId,
  sourceMessageId = null,
  draftId,
  payload,
  attachmentManifest = [],
  expectedContentHash,
  queryFn = query,
  encryptPayloadFn = encryptEmailPayload,
  outboxId = randomUUID()
}) {
  const normalized = normalizeUserMailPayload(payload)
  const normalizedAttachmentManifest = normalizeUserMailAttachmentManifest(attachmentManifest)
  const contentHash = hashUserMailPayload(normalized, normalizedAttachmentManifest)
  if (expectedContentHash && contentHash !== String(expectedContentHash)) {
    throw new Error('Email draft changed; preview it again before sending')
  }
  const encrypted = await encryptPayloadFn(normalized, {
    context: userMailOutboxContext(userId, outboxId)
  })
  const dedupeKey = normalizeDedupeKey(`user-mail:${userId}:${draftId}:${contentHash}`)
  const { rows } = await queryFn(
    `INSERT INTO mail_outbox (
       id, message_type, recipient, subject, text_body, html_body,
       dedupe_key, sensitive, user_id, account_id, source_message_id,
       payload_encrypted, content_hash, confirmed_at
     ) VALUES (
       $1, 'user.mail', 'redacted@invalid.local', '[加密用户邮件]', '', '',
       $2, TRUE, $3, $4, $5, $6, $7, NOW()
     )
     ON CONFLICT (dedupe_key) DO UPDATE SET updated_at = mail_outbox.updated_at
     RETURNING id, status, content_hash, confirmed_at, created_at`,
    [
      outboxId,
      dedupeKey,
      userId,
      accountId,
      sourceMessageId || null,
      encrypted,
      contentHash
    ]
  )
  return rows[0]
}

export async function createSmtpTransport(runtimeConfig = config, readSecretImpl = readOwnerSecretFile) {
  validateSmtpConfig(runtimeConfig)
  const auth = await resolveSmtpAuth(runtimeConfig, { readSecretImpl })
  return nodemailer.createTransport({
    host: runtimeConfig.smtpHost,
    port: Number(runtimeConfig.smtpPort),
    secure: true,
    auth,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }
  })
}

export async function verifySmtpConnection(
  runtimeConfig = config,
  {
    readSecretImpl = readOwnerSecretFile,
    transportFactory = createSmtpTransport,
    assertHostImpl = assertSafeOutboundHost
  } = {}
) {
  validateSmtpConfig(runtimeConfig)
  await assertHostImpl(runtimeConfig.smtpHost, { label: 'SMTP ' })
  const transport = await transportFactory(runtimeConfig, readSecretImpl)
  try {
    await transport.verify()
    return { ok: true, host: runtimeConfig.smtpHost, port: Number(runtimeConfig.smtpPort), secure: true }
  } finally {
    try { transport.close?.() } catch {}
  }
}

export async function deliverMailOutbox({
  poolInstance,
  policy,
  runtimeConfig = config,
  transportFactory = createSmtpTransport,
  systemOnly = false
}) {
  const validated = validateMailDeliveryPolicy(policy)
  const deliveryScopeSql = systemOnly ? `(${DELIVERY_SCOPE_SQL}) AND ${SYSTEM_MAIL_SQL}` : DELIVERY_SCOPE_SQL
  const sourceKey = String(runtimeConfig.emailSourceKey || config.emailSourceKey || 'mxroute').trim().toLowerCase()
  if (!/^[a-z0-9_.-]{1,80}$/.test(sourceKey)) throw new Error('Email source key is invalid')
  const primaryAccount = runtimeConfig.emailPrimaryAccount !== false
  const ownerUsername = String(runtimeConfig.emailOwnerUsername || '').trim()
  const lockName = `nav_mail_delivery:${sourceKey}`
  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null
  let transport = null
  try {
    const lock = await client.query(LOCK_SQL, [lockName])
    lockAcquired = lock.rows[0]?.acquired === true
    if (!lockAcquired) return { processed: 0, sent: 0, failed: 0, remaining: 0, skipped: 'already-running' }

    const ambiguousDeliveries = await withOutboxTransaction(client, async () => {
      const result = await client.query(
        `UPDATE mail_outbox
         SET status = 'expired',
             recipient = CASE WHEN sensitive THEN 'redacted@invalid.local' ELSE recipient END,
             subject = CASE WHEN sensitive THEN '[投递状态不确定，内容已清除]' ELSE subject END,
             text_body = '', html_body = '', payload_encrypted = NULL,
             scrubbed_at = COALESCE(scrubbed_at, NOW()), updated_at = NOW(),
             last_error_code = 'AMBIGUOUS_DELIVERY_STATE'
         WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '15 minutes'
           AND ${deliveryScopeSql}
         RETURNING id, user_id`
        , [sourceKey, primaryAccount, ownerUsername]
      )
      await scrubExpiredOutboxArtifactsInTransaction(
        client,
        result.rows,
        'AMBIGUOUS_DELIVERY_STATE'
      )
      return result
    })

    const expiredBeforeRun = await withOutboxTransaction(client, async () => {
      const result = await client.query(
        `UPDATE mail_outbox
         SET status = 'expired',
             recipient = CASE WHEN sensitive THEN 'redacted@invalid.local' ELSE recipient END,
             subject = CASE WHEN sensitive THEN '[未送达，内容已清除]' ELSE subject END,
             text_body = '', html_body = '', payload_encrypted = NULL,
             scrubbed_at = COALESCE(scrubbed_at, NOW()),
             last_error_code = 'MAX_ATTEMPTS_EXCEEDED', updated_at = NOW()
         WHERE status IN ('pending', 'failed') AND attempt_count >= $4
           AND ${deliveryScopeSql}
         RETURNING id, user_id`,
        [sourceKey, primaryAccount, ownerUsername, validated.maxAttempts]
      )
      await scrubExpiredOutboxArtifactsInTransaction(
        client,
        result.rows,
        'MAX_ATTEMPTS_EXCEEDED'
      )
      return result
    })

    const candidates = await client.query(
      `
        SELECT * FROM mail_outbox
        WHERE status IN ('pending', 'failed')
          AND attempt_count < $4
          AND next_attempt_at <= NOW()
          AND ${deliveryScopeSql}
        ORDER BY next_attempt_at ASC, created_at ASC, id ASC
        LIMIT $5
      `,
      [sourceKey, primaryAccount, ownerUsername, validated.maxAttempts, validated.batchSize]
    )
    const summary = {
      processed: 0,
      sent: 0,
      failed: 0,
      expired: expiredBeforeRun.rowCount + ambiguousDeliveries.rowCount,
      remaining: 0,
      skipped: null
    }
    if (candidates.rows.length) transport = await transportFactory(runtimeConfig)

    for (const message of candidates.rows) {
      summary.processed += 1
      const reserved = await client.query(
        `UPDATE mail_outbox SET status = 'sending', updated_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'failed') RETURNING id`,
        [message.id]
      )
      if (!reserved.rowCount) continue
      let smtpAccepted = false
      let smtpOutcome = null
      let smtpAttempted = false
      let sentAppendJob = null
      let outgoingMime = null
      let loadedAttachments = []
      try {
        let smtpResult = null
        let userPayload = null
        if (message.message_type === 'user.mail') {
          if (!message.user_id || !message.payload_encrypted) {
            throw new Error('Encrypted user mail payload is unavailable')
          }
          userPayload = normalizeUserMailPayload(await decryptEmailPayload(
            message.payload_encrypted,
            { context: userMailOutboxContext(message.user_id, message.id) }
          ))
          const attachmentBundle = await loadOutboxEmailAttachments({
            userId: message.user_id,
            outboxId: message.id
          }, { runtimeConfig })
          loadedAttachments = attachmentBundle.attachments
          if (hashUserMailPayload(userPayload, attachmentBundle.manifest) !== message.content_hash) {
            throw new Error('Encrypted user mail payload hash mismatch')
          }
          if (runtimeConfig.emailSentAppendEnabled === true) {
            const prepared = await getOrCreateFrozenSentAppend({
              client,
              message,
              payload: userPayload,
              attachments: loadedAttachments,
              runtimeConfig
            })
            sentAppendJob = prepared.job
            outgoingMime = prepared.mime
            // The RFC822 copy now owns the attachment bytes. Clear the
            // decrypted attachment buffers before the network operation.
            disposeLoadedEmailAttachments(loadedAttachments)
            loadedAttachments = []
            smtpAttempted = true
            smtpResult = await transport.sendMail({ raw: outgoingMime, envelope: prepared.envelope })
          } else {
            const frozen = await freezeOutgoingMime({
              outboxId: message.id,
              payload: userPayload,
              attachments: loadedAttachments,
              date: message.confirmed_at || message.created_at,
              runtimeConfig
            })
            outgoingMime = frozen.mime
            disposeLoadedEmailAttachments(loadedAttachments)
            loadedAttachments = []
            smtpAttempted = true
            smtpResult = await transport.sendMail({ raw: outgoingMime, envelope: frozen.envelope })
          }
        } else {
          const messageId = `<domo-nav-${createHash('sha256').update(String(message.id)).digest('hex').slice(0, 32)}@nav.skrskr.net>`
          smtpAttempted = true
          smtpResult = await transport.sendMail({
            from: {
              name: String(runtimeConfig.smtpFromName || 'DOMO NAV').replace(/[\r\n]/g, '').slice(0, 120),
              address: normalizeEmailAddress(runtimeConfig.smtpFromAddress)
            },
            to: normalizeEmailAddress(message.recipient),
            subject: normalizeSubject(message.subject),
            text: message.text_body || undefined,
            messageId,
            html: message.html_body || undefined,
            headers: {
              'X-DOMO-NAV-Message-Type': message.message_type,
              'X-DOMO-NAV-Id': createHash('sha256').update(String(message.id)).digest('hex').slice(0, 24)
            }
          })
        }
        const recipientOutcome = classifySmtpRecipientOutcome(smtpResult)
        if (recipientOutcome.status === 'rejected') {
          const rejectedError = new Error('SMTP explicitly rejected every recipient')
          rejectedError.code = SMTP_DELIVERY_ERROR_CODES.allRecipientsRejected
          rejectedError.command = 'RCPT TO'
          throw rejectedError
        }
        if (recipientOutcome.status === 'ambiguous') {
          const ambiguousError = new Error('SMTP returned no accepted or rejected recipients')
          ambiguousError.code = SMTP_DELIVERY_ERROR_CODES.ambiguous
          throw ambiguousError
        }
        smtpAccepted = true
        smtpOutcome = recipientOutcome.status
        if (smtpOutcome === 'partial') {
          await finalizePartialDelivery(client, message, {
            sentAppendJobId: sentAppendJob?.id || null
          })
          summary.failed += 1
          summary.expired += 1
          continue
        }
        await finalizeAcceptedDelivery(client, message, {
          sentAppendJobId: sentAppendJob?.id || null
        })
        summary.sent += 1
      } catch (error) {
        // SMTP and PostgreSQL cannot participate in one transaction. Once the
        // remote SMTP server has accepted a message, never put it back into an
        // automatic retry path: doing so can duplicate external mail. Retry
        // only the local finalization once; if that also fails the row stays
        // in `sending` and the stale-lease guard expires it for manual review.
        if (smtpAccepted) {
          try {
            if (smtpOutcome === 'partial') {
              await finalizePartialDelivery(client, message, {
                sentAppendJobId: sentAppendJob?.id || null
              })
              summary.failed += 1
              summary.expired += 1
            } else {
              await finalizeAcceptedDelivery(client, message, {
                sentAppendJobId: sentAppendJob?.id || null
              })
              summary.sent += 1
            }
            continue
          } catch (finalizeError) {
            const ambiguousError = new Error(
              'SMTP accepted the message but local delivery state could not be finalized',
              { cause: finalizeError }
            )
            ambiguousError.code = 'AMBIGUOUS_DELIVERY_STATE'
            throw ambiguousError
          }
        }
        // A rejected sendMail() promise is not proof that the remote SMTP
        // server rejected DATA. Never return that message to an automatic
        // retry path: a retry can duplicate externally delivered mail.
        if (smtpAttempted && !isDefinitiveSmtpRejection(error)) {
          await recordAmbiguousSmtpAttempt(client, message, sentAppendJob?.id || null)
          summary.failed += 1
          summary.expired += 1
          continue
        }
        const nextAttempt = Math.min(86_400, 60 * (2 ** Math.min(Number(message.attempt_count || 0), 10)))
        const willExpire = Number(message.attempt_count || 0) + 1 >= validated.maxAttempts
        const errorCode = sanitizeMaintenanceErrorCode(error)
        if (willExpire) {
          await withOutboxTransaction(client, async () => {
            const expired = await client.query(
              `UPDATE mail_outbox
               SET status = 'expired', attempt_count = attempt_count + 1,
                   last_attempt_at = NOW(), next_attempt_at = NOW() + ($2::integer * INTERVAL '1 second'),
                   recipient = CASE WHEN sensitive THEN 'redacted@invalid.local' ELSE recipient END,
                   subject = CASE WHEN sensitive THEN '[未送达，内容已清除]' ELSE subject END,
                   text_body = '', html_body = '', payload_encrypted = NULL,
                   scrubbed_at = NOW(), last_error_code = $3, updated_at = NOW()
               WHERE id = $1 AND status = 'sending'
               RETURNING id, user_id`,
              [message.id, nextAttempt, errorCode]
            )
            await scrubExpiredOutboxArtifactsInTransaction(
              client,
              expired.rows,
              errorCode
            )
          })
        } else {
          await client.query(
            `UPDATE mail_outbox
             SET status = 'failed', attempt_count = attempt_count + 1,
                 last_attempt_at = NOW(), next_attempt_at = NOW() + ($2::integer * INTERVAL '1 second'),
                 last_error_code = $3, updated_at = NOW()
             WHERE id = $1 AND status = 'sending'`,
            [message.id, nextAttempt, errorCode]
          )
        }
        summary.failed += 1
        if (willExpire) summary.expired += 1
      } finally {
        if (Buffer.isBuffer(outgoingMime)) outgoingMime.fill(0)
        disposeLoadedEmailAttachments(loadedAttachments)
      }
    }

    const remaining = await client.query(
      `SELECT COUNT(*)::integer AS count FROM mail_outbox
       WHERE status IN ('pending', 'failed') AND attempt_count < $4
         AND ${deliveryScopeSql}`,
      [sourceKey, primaryAccount, ownerUsername, validated.maxAttempts]
    )
    summary.remaining = Number(remaining.rows[0]?.count || 0)
    return summary
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try { transport?.close?.() } catch {}
    let unlockError = null
    if (lockAcquired) {
      try { await client.query(UNLOCK_SQL, [lockName]) } catch (error) { unlockError = error }
    }
    client.release(unlockError || undefined)
    if (!primaryError && unlockError) throw unlockError
  }
}

async function notifyObserver(observer, method, payload, logger) {
  try { await observer?.[method]?.(payload) } catch (error) {
    logger?.warn?.({ err: error }, 'mail delivery status could not be recorded')
  }
}

export function startMailDeliveryScheduler({
  enabled,
  policy,
  poolInstance,
  logger,
  observer,
  runtimeConfig = config,
  deliveryFn = deliverMailOutbox,
  systemOnly = false,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateMailDeliveryPolicy(policy)
  let stopped = false
  let timer = null
  let activeRun = null
  const run = () => {
    if (stopped || activeRun) return activeRun
    const startedAtMs = clock()
    activeRun = Promise.resolve()
      .then(() => deliveryFn({ poolInstance, policy: validated, runtimeConfig, systemOnly }))
      .then(async (result) => {
        const finishedAtMs = clock()
        await notifyObserver(observer, 'succeeded', {
          result,
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        return result
      })
      .catch(async (error) => {
        const finishedAtMs = clock()
        await notifyObserver(observer, 'failed', {
          error,
          result: {},
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        logger?.error?.({ err: error }, 'mail delivery failed')
      })
      .finally(() => { activeRun = null })
    return activeRun
  }
  const intervalMs = validated.intervalSeconds * 1000
  timer = timerApi.setInterval(() => void run(), intervalMs)
  timer?.unref?.()
  void run()
  return async () => {
    stopped = true
    if (timer) timerApi.clearInterval(timer)
    if (activeRun) await activeRun
  }
}
