import { createHash, randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import { config } from '../config.js'
import { query } from '../db/index.js'
import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'
import { assertSafeOutboundHost } from './outboundEndpoints.js'
import { decryptEmailPayload, encryptEmailPayload } from './emailCrypto.js'
import {
  hashUserMailPayload,
  normalizeEmailAddress,
  normalizeUserMailPayload
} from './emailUserMail.js'

const MESSAGE_TYPE_PATTERN = /^[a-z0-9_.-]+$/
const LOCK_SQL = `SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext('nav_mail_delivery')) AS acquired`
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('nav_mail_delivery')) AS released`

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
  if (!String(runtimeConfig.smtpPasswordFile || '').trim()) {
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
    && runtimeConfig.smtpPasswordFile
    && runtimeConfig.smtpFromAddress
  )
  if (!baseConfigured) {
    return { configured: false, enabled: runtimeConfig.mailDeliveryEnabled, transport: 'smtp-tls' }
  }
  try {
    validateSmtpConfig(runtimeConfig)
    await readSecretImpl(runtimeConfig.smtpPasswordFile, { label: 'SMTP password', maxBytes: 4096 })
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
  expectedContentHash,
  queryFn = query,
  encryptPayloadFn = encryptEmailPayload,
  outboxId = randomUUID()
}) {
  const normalized = normalizeUserMailPayload(payload)
  const contentHash = hashUserMailPayload(normalized)
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

async function createSmtpTransport(runtimeConfig = config, readSecretImpl = readOwnerSecretFile) {
  validateSmtpConfig(runtimeConfig)
  const password = await readSecretImpl(runtimeConfig.smtpPasswordFile, {
    label: 'SMTP password',
    maxBytes: 4096
  })
  return nodemailer.createTransport({
    host: runtimeConfig.smtpHost,
    port: Number(runtimeConfig.smtpPort),
    secure: true,
    auth: {
      user: normalizeEmailAddress(runtimeConfig.smtpUsername),
      pass: password
    },
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
  transportFactory = createSmtpTransport
}) {
  const validated = validateMailDeliveryPolicy(policy)
  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null
  let transport = null
  try {
    const lock = await client.query(LOCK_SQL)
    lockAcquired = lock.rows[0]?.acquired === true
    if (!lockAcquired) return { processed: 0, sent: 0, failed: 0, remaining: 0, skipped: 'already-running' }

    const ambiguousDeliveries = await client.query(
      `UPDATE mail_outbox
       SET status = 'expired',
           recipient = CASE WHEN sensitive THEN 'redacted@invalid.local' ELSE recipient END,
           subject = CASE WHEN sensitive THEN '[投递状态不确定，内容已清除]' ELSE subject END,
           text_body = '', html_body = '', payload_encrypted = NULL,
           scrubbed_at = COALESCE(scrubbed_at, NOW()), updated_at = NOW(),
           last_error_code = 'AMBIGUOUS_DELIVERY_STATE'
       WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '15 minutes'
       RETURNING id`
    )
    if (ambiguousDeliveries.rows.length) {
      await client.query(
        `UPDATE email_drafts SET status = 'failed', updated_at = NOW()
         WHERE outbox_id = ANY($1::uuid[]) AND status = 'queued'`,
        [ambiguousDeliveries.rows.map((row) => row.id)]
      )
    }

    const expiredBeforeRun = await client.query(
      `UPDATE mail_outbox
       SET status = 'expired',
           recipient = CASE WHEN sensitive THEN 'redacted@invalid.local' ELSE recipient END,
           subject = CASE WHEN sensitive THEN '[未送达，内容已清除]' ELSE subject END,
           text_body = '', html_body = '', payload_encrypted = NULL,
           scrubbed_at = COALESCE(scrubbed_at, NOW()),
           updated_at = NOW()
       WHERE status IN ('pending', 'failed') AND attempt_count >= $1
       RETURNING id`,
      [validated.maxAttempts]
    )
    if (expiredBeforeRun.rows.length) {
      await client.query(
        `UPDATE email_drafts SET status = 'failed', updated_at = NOW()
         WHERE outbox_id = ANY($1::uuid[]) AND status = 'queued'`,
        [expiredBeforeRun.rows.map((row) => row.id)]
      )
    }

    const candidates = await client.query(
      `
        SELECT * FROM mail_outbox
        WHERE status IN ('pending', 'failed')
          AND attempt_count < $2
          AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at ASC, created_at ASC, id ASC
        LIMIT $1
      `,
      [validated.batchSize, validated.maxAttempts]
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
      try {
        let userPayload = null
        if (message.message_type === 'user.mail') {
          if (!message.user_id || !message.payload_encrypted) {
            throw new Error('Encrypted user mail payload is unavailable')
          }
          userPayload = normalizeUserMailPayload(await decryptEmailPayload(
            message.payload_encrypted,
            { context: userMailOutboxContext(message.user_id, message.id) }
          ))
          if (hashUserMailPayload(userPayload) !== message.content_hash) {
            throw new Error('Encrypted user mail payload hash mismatch')
          }
        }
        const messageId = `<domo-nav-${createHash('sha256').update(String(message.id)).digest('hex').slice(0, 32)}@nav.skrskr.net>`
        await transport.sendMail({
          from: {
            name: String(runtimeConfig.smtpFromName || 'DOMO NAV').replace(/[\r\n]/g, '').slice(0, 120),
            address: normalizeEmailAddress(runtimeConfig.smtpFromAddress)
          },
          to: userPayload?.to || normalizeEmailAddress(message.recipient),
          cc: userPayload?.cc?.length ? userPayload.cc : undefined,
          bcc: userPayload?.bcc?.length ? userPayload.bcc : undefined,
          subject: userPayload?.subject || normalizeSubject(message.subject),
          text: userPayload?.text || message.text_body || undefined,
          inReplyTo: userPayload?.inReplyTo || undefined,
          references: userPayload?.references?.length ? userPayload.references : undefined,
          messageId,
          html: userPayload ? undefined : (message.html_body || undefined),
          headers: {
            'X-DOMO-NAV-Message-Type': message.message_type,
            'X-DOMO-NAV-Id': createHash('sha256').update(String(message.id)).digest('hex').slice(0, 24)
          }
        })
        smtpAccepted = true
        await client.query(
          `WITH delivered AS (
             UPDATE mail_outbox
             SET status = 'sent', attempt_count = attempt_count + 1,
                 last_attempt_at = NOW(), sent_at = NOW(),
                 recipient = CASE WHEN sensitive THEN 'redacted@invalid.local' ELSE recipient END,
                 subject = CASE WHEN sensitive THEN '[已发送，内容已清除]' ELSE subject END,
                 text_body = '', html_body = '', payload_encrypted = NULL,
                 scrubbed_at = NOW(), last_error_code = NULL, updated_at = NOW()
             WHERE id = $1
             RETURNING id
           )
           UPDATE email_drafts SET status = 'sent', updated_at = NOW()
           WHERE outbox_id IN (SELECT id FROM delivered)`,
          [message.id]
        )
        summary.sent += 1
      } catch (error) {
        // SMTP and PostgreSQL cannot participate in one transaction. Once the
        // remote SMTP server has accepted a message, never put it back into an
        // automatic retry path: doing so can duplicate external mail. Retry
        // only the local finalization once; if that also fails the row stays
        // in `sending` and the stale-lease guard expires it for manual review.
        if (smtpAccepted) {
          try {
            await client.query(
              `WITH delivered AS (
                 UPDATE mail_outbox
                 SET status = 'sent', attempt_count = attempt_count + 1,
                     last_attempt_at = NOW(), sent_at = COALESCE(sent_at, NOW()),
                     recipient = CASE WHEN sensitive THEN 'redacted@invalid.local' ELSE recipient END,
                     subject = CASE WHEN sensitive THEN '[已发送，内容已清除]' ELSE subject END,
                     text_body = '', html_body = '', payload_encrypted = NULL,
                     scrubbed_at = COALESCE(scrubbed_at, NOW()),
                     last_error_code = 'DELIVERY_FINALIZE_RECOVERED', updated_at = NOW()
                 WHERE id = $1 AND status = 'sending'
                 RETURNING id
               )
               UPDATE email_drafts SET status = 'sent', updated_at = NOW()
               WHERE outbox_id IN (SELECT id FROM delivered)`,
              [message.id]
            )
            summary.sent += 1
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
        const nextAttempt = Math.min(86_400, 60 * (2 ** Math.min(Number(message.attempt_count || 0), 10)))
        const willExpire = Number(message.attempt_count || 0) + 1 >= validated.maxAttempts
        await client.query(
          `WITH delivery_failure AS (
             UPDATE mail_outbox
             SET status = CASE WHEN attempt_count + 1 >= $4 THEN 'expired' ELSE 'failed' END,
               attempt_count = attempt_count + 1,
               last_attempt_at = NOW(), next_attempt_at = NOW() + ($2::integer * INTERVAL '1 second'),
               recipient = CASE
                 WHEN sensitive AND attempt_count + 1 >= $4 THEN 'redacted@invalid.local'
                 ELSE recipient
               END,
               subject = CASE
                 WHEN sensitive AND attempt_count + 1 >= $4 THEN '[未送达，内容已清除]'
                 ELSE subject
               END,
               text_body = CASE WHEN attempt_count + 1 >= $4 THEN '' ELSE text_body END,
               html_body = CASE WHEN attempt_count + 1 >= $4 THEN '' ELSE html_body END,
               payload_encrypted = CASE WHEN attempt_count + 1 >= $4 THEN NULL ELSE payload_encrypted END,
               scrubbed_at = CASE WHEN attempt_count + 1 >= $4 THEN NOW() ELSE scrubbed_at END,
               last_error_code = $3, updated_at = NOW()
             WHERE id = $1
             RETURNING id, status
           )
           UPDATE email_drafts SET status = 'failed', updated_at = NOW()
           WHERE outbox_id IN (
             SELECT id FROM delivery_failure WHERE status = 'expired'
           )`,
          [message.id, nextAttempt, sanitizeMaintenanceErrorCode(error), validated.maxAttempts]
        )
        summary.failed += 1
        if (willExpire) summary.expired += 1
      }
    }

    const remaining = await client.query(
      `SELECT COUNT(*)::integer AS count FROM mail_outbox
       WHERE status IN ('pending', 'failed') AND attempt_count < $1`,
      [validated.maxAttempts]
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
      try { await client.query(UNLOCK_SQL) } catch (error) { unlockError = error }
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
  deliveryFn = deliverMailOutbox,
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
      .then(() => deliveryFn({ poolInstance, policy: validated }))
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
