import { createHash } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { config } from '../config.js'
import { decryptEmailSentMime } from './emailSentMimeCrypto.js'
import { persistEmailMailboxMessage } from './emailMailboxStore.js'
import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'
import { resolveImapAuth } from './emailOauth2.js'
import { assertSafeOutboundHost } from './outboundEndpoints.js'

const LOCK_SQL = 'SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext($1)) AS acquired'
const UNLOCK_SQL = 'SELECT pg_advisory_unlock(hashtext(current_database()), hashtext($1)) AS released'
const UINT32_MAX = 4_294_967_295

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function validateEmailSentAppendPolicy(policy = {}) {
  return {
    intervalSeconds: boundedInteger(policy.intervalSeconds, 30, 15, 3600),
    batchSize: boundedInteger(policy.batchSize, 5, 1, 25),
    reconcileDelaySeconds: boundedInteger(policy.reconcileDelaySeconds, 60, 30, 3600),
    blockedDelaySeconds: boundedInteger(policy.blockedDelaySeconds, 900, 300, 86_400),
    retentionDays: boundedInteger(policy.retentionDays, 30, 1, 365)
  }
}

function normalizedFolderPath(value) {
  const path = String(value || '').normalize('NFKC').trim()
  if (!path || path.length > 512 || /[\r\n\u0000]/.test(path)) {
    throw new Error('IMAP Sent mailbox path is invalid')
  }
  return path
}

function isSelectable(folder) {
  return !folder?.flags?.has?.('\\Noselect')
}

function isSentFolder(folder) {
  const specialUse = String(folder?.specialUse || '').trim().toLowerCase()
  return specialUse === '\\sent'
    || specialUse === 'sent'
    || folder?.flags?.has?.('\\Sent')
}

export function selectUniqueSentMailbox(folders, explicitPath = '') {
  const listed = (Array.isArray(folders) ? folders : [])
    .filter((folder) => folder?.path && isSelectable(folder))
  const configured = String(explicitPath || '').trim()
  if (configured) {
    const path = normalizedFolderPath(configured)
    const matches = listed.filter((folder) => String(folder.path) === path)
    if (matches.length !== 1) {
      const error = new Error('Configured IMAP Sent mailbox was not found uniquely')
      error.code = 'SENT_FOLDER_NOT_FOUND'
      throw error
    }
    return matches[0]
  }
  const matches = listed.filter(isSentFolder)
  if (matches.length !== 1) {
    const error = new Error(matches.length ? 'Multiple IMAP Sent mailboxes were discovered' : 'IMAP Sent mailbox was not discovered')
    error.code = matches.length ? 'SENT_FOLDER_AMBIGUOUS' : 'SENT_FOLDER_NOT_FOUND'
    throw error
  }
  return matches[0]
}

function validateRuntimeConfig(runtimeConfig) {
  if (
    !runtimeConfig.imapHost
    || !runtimeConfig.imapUsername
    || (!runtimeConfig.imapPasswordFile && !runtimeConfig.imapOauthProvider)
  ) {
    throw new Error('IMAP configuration is incomplete')
  }
  if (runtimeConfig.imapSecure !== true || Number(runtimeConfig.imapPort) !== 993) {
    throw new Error('IMAP Sent synchronization requires implicit TLS on port 993')
  }
  normalizedFolderPath(runtimeConfig.imapMailbox || 'INBOX')
}

async function createImapClient(runtimeConfig, {
  ImapClient,
  readSecretImpl,
  assertHostImpl
}) {
  validateRuntimeConfig(runtimeConfig)
  await assertHostImpl(runtimeConfig.imapHost, { label: 'IMAP ' })
  const auth = await resolveImapAuth(runtimeConfig, { readSecretImpl })
  return new ImapClient({
    host: runtimeConfig.imapHost,
    port: Number(runtimeConfig.imapPort),
    secure: true,
    auth,
    disableAutoIdle: true,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    logger: false
  })
}

function uidNumber(value) {
  const uid = Number(value)
  return Number.isSafeInteger(uid) && uid >= 1 && uid <= UINT32_MAX ? uid : null
}

function uniqueUids(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(uidNumber)
    .filter(Boolean))]
}

export async function searchSentMessageUids(client, job) {
  const byMessageId = uniqueUids(await client.search({
    header: { 'Message-ID': String(job.message_id) }
  }, { uid: true }))
  const byNavId = uniqueUids(await client.search({
    header: { 'X-DOMO-NAV-Id': String(job.nav_id) }
  }, { uid: true }))
  return uniqueUids([...byMessageId, ...byNavId])
}

function normalizedAddressList(value) {
  return (Array.isArray(value?.value) ? value.value : [])
    .map((item) => ({
      name: String(item?.name || '').normalize('NFKC').trim().slice(0, 320),
      address: String(item?.address || '').normalize('NFKC').trim().toLowerCase().slice(0, 320)
    }))
    .filter((item) => item.address)
    .slice(0, 100)
}

async function cacheAppendedMessage({
  poolInstance,
  job,
  raw,
  folder,
  uid,
  uidValidity,
  runtimeConfig,
  parseMimeFn,
  persistFn,
  logger
}) {
  let parsed
  try {
    parsed = await parseMimeFn(raw, { skipHtmlToText: true, skipTextToHtml: true })
    const from = normalizedAddressList(parsed.from)[0] || { name: '', address: '' }
    await persistFn({
      poolInstance,
      userId: job.user_id,
      sourceKey: job.source_key,
      accountLabel: job.account_label,
      capabilities: job.capabilities ? Object.keys(job.capabilities).filter((key) => job.capabilities[key]) : [],
      folder: {
        path: folder.path,
        delimiter: folder.delimiter || null,
        specialUse: 'sent',
        selectable: true,
        subscribed: folder.subscribed !== false,
        uidValidity,
        uidNext: null,
        highestModseq: null
      },
      message: {
        mailboxUid: uid,
        messageId: String(parsed.messageId || job.message_id),
        sender: from,
        to: normalizedAddressList(parsed.to),
        cc: normalizedAddressList(parsed.cc),
        bcc: [],
        subject: String(parsed.subject || '(无主题)'),
        text: String(parsed.text || ''),
        references: Array.isArray(parsed.references) ? parsed.references : [],
        inReplyTo: String(parsed.inReplyTo || ''),
        receivedAt: parsed.date || job.smtp_accepted_at,
        sentAt: parsed.date || job.smtp_accepted_at,
        internalDate: parsed.date || job.smtp_accepted_at,
        size: raw.length,
        rawHash: createHash('sha256').update(raw).digest('hex'),
        attachments: (parsed.attachments || []).map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          contentDisposition: attachment.contentDisposition,
          contentId: attachment.contentId,
          size: attachment.size
        })),
        flags: ['\\Seen']
      }
    })
  } catch (error) {
    logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error), outboxId: job.outbox_id }, 'appended Sent message could not be cached locally')
  } finally {
    for (const attachment of parsed?.attachments || []) {
      if (Buffer.isBuffer(attachment?.content)) attachment.content.fill(0)
    }
  }
}

async function finalizeAppended({ client, job, folder, uid, uidValidity }) {
  await client.query('BEGIN')
  try {
    const updated = await client.query(
      `UPDATE email_sent_append_jobs
       SET status = 'appended', mime_encrypted = NULL,
           append_attempted = TRUE,
           appended_at = NOW(), sent_folder_path = $2,
           uid_validity = $3, uid = $4,
           last_error_code = NULL, scrubbed_at = NOW(), updated_at = NOW()
       WHERE id = $1
         AND status IN ('pending', 'appending', 'reconcile', 'blocked')
       RETURNING outbox_id, user_id`,
      [job.id, folder.path, uidValidity, uid]
    )
    if (!updated.rowCount) throw new Error('Sent append job state changed before finalization')
    await client.query(
      `UPDATE mail_outbox
       SET payload_encrypted = NULL,
           scrubbed_at = COALESCE(scrubbed_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'sent'`,
      [job.outbox_id, job.user_id]
    )
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  }
}

async function markBlocked(client, job, code, delaySeconds) {
  await client.query(
    `UPDATE email_sent_append_jobs
     SET status = 'blocked', next_attempt_at = NOW() + ($2::integer * INTERVAL '1 second'),
         last_error_code = $3, updated_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'appending', 'reconcile', 'blocked')`,
    [job.id, delaySeconds, code]
  )
}

export async function processEmailSentAppendJob({
  dbClient,
  imap,
  job,
  folder,
  uidValidity,
  policy,
  runtimeConfig,
  decryptMimeFn,
  parseMimeFn,
  persistFn,
  poolInstance,
  logger,
  cacheFn = cacheAppendedMessage,
  finalizeFn = finalizeAppended
}) {
  const matches = await searchSentMessageUids(imap, job)
  if (matches.length > 1) {
    await markBlocked(dbClient, job, 'SENT_DUPLICATE_MATCH', policy.blockedDelaySeconds)
    return 'blocked'
  }
  if (matches.length === 1) {
    const raw = await decryptMimeFn(
      job.mime_encrypted,
      { userId: job.user_id, outboxId: job.outbox_id },
      { runtimeConfig, expectedBytes: Number(job.mime_size_bytes) }
    )
    try {
      await cacheFn({
        poolInstance,
        job,
        raw,
        folder,
        uid: matches[0],
        uidValidity,
        runtimeConfig,
        parseMimeFn,
        persistFn,
        logger
      })
      await finalizeFn({
        client: dbClient,
        job,
        folder,
        uid: matches[0],
        uidValidity
      })
    } finally {
      raw.fill(0)
    }
    return job.append_attempted ? 'reconciled' : 'appended'
  }

  if (job.append_attempted || job.status === 'reconcile' || job.status === 'appending') {
    await dbClient.query(
      `UPDATE email_sent_append_jobs
       SET status = 'reconcile', reconcile_count = reconcile_count + 1,
           next_attempt_at = NOW() + ($2::integer * INTERVAL '1 second'),
           last_error_code = 'SENT_APPEND_UNCONFIRMED', updated_at = NOW()
       WHERE id = $1 AND status IN ('appending', 'reconcile', 'blocked')`,
      [job.id, policy.reconcileDelaySeconds]
    )
    return 'reconcile'
  }

  const raw = await decryptMimeFn(
    job.mime_encrypted,
    { userId: job.user_id, outboxId: job.outbox_id },
    { runtimeConfig, expectedBytes: Number(job.mime_size_bytes) }
  )
  try {
    const reserved = await dbClient.query(
      `UPDATE email_sent_append_jobs
       SET status = 'appending', append_attempted = TRUE,
           append_attempt_count = append_attempt_count + 1,
           append_started_at = NOW(), last_error_code = NULL, updated_at = NOW()
       WHERE id = $1
         AND status IN ('pending', 'blocked')
         AND append_attempted = FALSE
       RETURNING id`,
      [job.id]
    )
    if (!reserved.rowCount) return 'skipped'
    let appended
    try {
      appended = await imap.append(folder.path, raw, ['\\Seen'], new Date(job.smtp_accepted_at))
    } catch (error) {
      await dbClient.query(
        `UPDATE email_sent_append_jobs
         SET status = 'reconcile',
             next_attempt_at = NOW() + ($2::integer * INTERVAL '1 second'),
             last_error_code = $3, updated_at = NOW()
         WHERE id = $1 AND status = 'appending'`,
        [job.id, policy.reconcileDelaySeconds, sanitizeMaintenanceErrorCode(error)]
      )
      return 'reconcile'
    }
    const appendedUid = uidNumber(appended?.uid)
    const appendedUidValidity = uidNumber(appended?.uidValidity) || uidValidity
    let confirmedUid = appendedUid
    if (!confirmedUid) {
      const afterAppendMatches = await searchSentMessageUids(imap, job)
      if (afterAppendMatches.length === 1) confirmedUid = afterAppendMatches[0]
      else if (afterAppendMatches.length > 1) {
        await markBlocked(dbClient, { ...job, status: 'appending' }, 'SENT_DUPLICATE_MATCH', policy.blockedDelaySeconds)
        return 'blocked'
      }
    }
    if (!confirmedUid) {
      await dbClient.query(
        `UPDATE email_sent_append_jobs
         SET status = 'reconcile',
             next_attempt_at = NOW() + ($2::integer * INTERVAL '1 second'),
             last_error_code = 'SENT_APPEND_UID_UNKNOWN', updated_at = NOW()
         WHERE id = $1 AND status = 'appending'`,
        [job.id, policy.reconcileDelaySeconds]
      )
      return 'reconcile'
    }
    await cacheFn({
      poolInstance,
      job,
      raw,
      folder,
      uid: confirmedUid,
      uidValidity: appendedUidValidity,
      runtimeConfig,
      parseMimeFn,
      persistFn,
      logger
    })
    await finalizeFn({
      client: dbClient,
      job,
      folder,
      uid: confirmedUid,
      uidValidity: appendedUidValidity
    })
    return 'appended'
  } finally {
    raw.fill(0)
  }
}

export async function processEmailSentAppendJobs({
  poolInstance,
  policy,
  runtimeConfig = config,
  ImapClient = ImapFlow,
  readSecretImpl = readOwnerSecretFile,
  assertHostImpl = assertSafeOutboundHost,
  decryptMimeFn = decryptEmailSentMime,
  parseMimeFn = simpleParser,
  persistFn = persistEmailMailboxMessage,
  logger
}) {
  const validated = validateEmailSentAppendPolicy(policy)
  const sourceKey = String(runtimeConfig.emailSourceKey || '').trim().toLowerCase()
  const ownerUsername = String(runtimeConfig.emailOwnerUsername || '').trim()
  if (!/^[a-z0-9_.-]{1,80}$/.test(sourceKey)) throw new Error('Email source key is invalid')
  if (!ownerUsername) throw new Error('Email owner username is not configured')
  const lockName = `nav_email_sent_append:${sourceKey}`
  const dbClient = await poolInstance.connect()
  let lockAcquired = false
  let imap = null
  let mailboxLock = null
  let primaryError = null
  try {
    const lock = await dbClient.query(LOCK_SQL, [lockName])
    lockAcquired = lock.rows[0]?.acquired === true
    if (!lockAcquired) return { processed: 0, appended: 0, reconciled: 0, blocked: 0, remaining: 0, skipped: 'already-running' }

    await dbClient.query(
      `UPDATE email_sent_append_jobs
       SET status = 'reconcile',
           next_attempt_at = NOW(),
           last_error_code = 'SENT_APPEND_LEASE_EXPIRED', updated_at = NOW()
       WHERE status = 'appending'
         AND updated_at < NOW() - INTERVAL '15 minutes'
         AND EXISTS (
           SELECT 1
           FROM email_accounts AS account
           JOIN users AS owner ON owner.id = account.user_id
           WHERE account.id = email_sent_append_jobs.account_id
             AND account.user_id = email_sent_append_jobs.user_id
             AND account.source_key = $1
             AND owner.username = $2
             AND owner.status = 'approved'
         )`,
      [sourceKey, ownerUsername]
    )
    await dbClient.query(
      `UPDATE email_sent_append_jobs
       SET status = 'expired', mime_encrypted = NULL,
           last_error_code = 'SENT_APPEND_RETENTION_EXPIRED',
           scrubbed_at = NOW(), updated_at = NOW()
       WHERE status IN ('pending', 'appending', 'reconcile', 'blocked')
         AND smtp_accepted_at < NOW() - ($3::integer * INTERVAL '1 day')
         AND EXISTS (
           SELECT 1
           FROM email_accounts AS account
           JOIN users AS owner ON owner.id = account.user_id
           WHERE account.id = email_sent_append_jobs.account_id
             AND account.user_id = email_sent_append_jobs.user_id
             AND account.source_key = $1
             AND owner.username = $2
             AND owner.status = 'approved'
         )`,
      [sourceKey, ownerUsername, validated.retentionDays]
    )

    const candidates = await dbClient.query(
      `SELECT job.*, account.source_key, account.label AS account_label,
              account.capabilities
       FROM email_sent_append_jobs AS job
       JOIN email_accounts AS account
         ON account.id = job.account_id AND account.user_id = job.user_id
       JOIN users AS owner ON owner.id = account.user_id
       WHERE job.status IN ('pending', 'reconcile', 'blocked')
         AND job.next_attempt_at <= NOW()
         AND account.enabled = TRUE
         AND account.source_key = $2
         AND owner.username = $3
         AND owner.status = 'approved'
       ORDER BY job.next_attempt_at ASC, job.created_at ASC, job.id ASC
       LIMIT $1`,
      [validated.batchSize, sourceKey, ownerUsername]
    )
    const summary = { processed: 0, appended: 0, reconciled: 0, blocked: 0, remaining: 0, skipped: null }
    if (!candidates.rowCount) return summary

    imap = await createImapClient(runtimeConfig, { ImapClient, readSecretImpl, assertHostImpl })
    await imap.connect()
    const folders = await imap.list()
    let folder
    try {
      folder = selectUniqueSentMailbox(folders, runtimeConfig.imapSentMailbox)
    } catch (error) {
      const code = sanitizeMaintenanceErrorCode(error)
      for (const job of candidates.rows) {
        await markBlocked(dbClient, job, code, validated.blockedDelaySeconds)
      }
      summary.blocked = candidates.rowCount
      summary.processed = candidates.rowCount
      const remaining = await dbClient.query(
        `SELECT COUNT(*)::integer AS count FROM email_sent_append_jobs AS job
         WHERE job.status IN ('pending', 'appending', 'reconcile', 'blocked')
           AND EXISTS (
             SELECT 1
             FROM email_accounts AS account
             JOIN users AS owner ON owner.id = account.user_id
             WHERE account.id = job.account_id
               AND account.user_id = job.user_id
               AND account.source_key = $1
               AND owner.username = $2
               AND owner.status = 'approved'
           )`,
        [sourceKey, ownerUsername]
      )
      summary.remaining = Number(remaining.rows[0]?.count || 0)
      return summary
    }
    mailboxLock = await imap.getMailboxLock(folder.path, { readOnly: true })
    const uidValidity = uidNumber(imap.mailbox?.uidValidity)
    if (!uidValidity) throw new Error('IMAP Sent mailbox UIDVALIDITY is invalid')

    for (const storedJob of candidates.rows) {
      summary.processed += 1
      const job = storedJob.status === 'blocked'
        ? { ...storedJob, status: storedJob.append_attempted ? 'reconcile' : 'pending' }
        : storedJob
      if (storedJob.status === 'blocked') {
        await dbClient.query(
          `UPDATE email_sent_append_jobs
           SET status = CASE WHEN append_attempted THEN 'reconcile' ELSE 'pending' END,
               next_attempt_at = NOW(), last_error_code = NULL, updated_at = NOW()
           WHERE id = $1 AND status = 'blocked'`,
          [job.id]
        )
      }
      try {
        const outcome = await processEmailSentAppendJob({
          dbClient,
          imap,
          job,
          folder,
          uidValidity,
          policy: validated,
          runtimeConfig,
          decryptMimeFn,
          parseMimeFn,
          persistFn,
          poolInstance,
          logger
        })
        if (outcome === 'appended') summary.appended += 1
        else if (outcome === 'reconciled') summary.reconciled += 1
        else if (outcome === 'blocked') summary.blocked += 1
      } catch (error) {
        await dbClient.query(
          `UPDATE email_sent_append_jobs
           SET status = CASE WHEN append_attempted THEN 'reconcile' ELSE 'pending' END,
               next_attempt_at = NOW() + ($2::integer * INTERVAL '1 second'),
               last_error_code = $3, updated_at = NOW()
           WHERE id = $1 AND status IN ('pending', 'appending', 'reconcile', 'blocked')`,
          [job.id, validated.reconcileDelaySeconds, sanitizeMaintenanceErrorCode(error)]
        )
        logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error), outboxId: job.outbox_id }, 'Sent append job deferred')
      }
    }
    const remaining = await dbClient.query(
      `SELECT COUNT(*)::integer AS count FROM email_sent_append_jobs AS job
       WHERE job.status IN ('pending', 'appending', 'reconcile', 'blocked')
         AND EXISTS (
           SELECT 1
           FROM email_accounts AS account
           JOIN users AS owner ON owner.id = account.user_id
           WHERE account.id = job.account_id
             AND account.user_id = job.user_id
             AND account.source_key = $1
             AND owner.username = $2
             AND owner.status = 'approved'
         )`,
      [sourceKey, ownerUsername]
    )
    summary.remaining = Number(remaining.rows[0]?.count || 0)
    return summary
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try { mailboxLock?.release?.() } catch {}
    if (imap) {
      try {
        if (imap.usable) await imap.logout()
        else imap.close?.()
      } catch {
        try { imap.close?.() } catch {}
      }
    }
    let unlockError = null
    if (lockAcquired) {
      try { await dbClient.query(UNLOCK_SQL, [lockName]) } catch (error) { unlockError = error }
    }
    dbClient.release(unlockError || undefined)
    if (!primaryError && unlockError) throw unlockError
  }
}

async function notifyObserver(observer, method, payload, logger) {
  try { await observer?.[method]?.(payload) } catch (error) {
    logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'Sent append status could not be recorded')
  }
}

export function startEmailSentAppendScheduler({
  enabled,
  policy,
  poolInstance,
  runtimeConfig = config,
  logger,
  observer,
  processorFn = processEmailSentAppendJobs,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateEmailSentAppendPolicy(policy)
  let stopped = false
  let activeRun = null
  let timer = null
  const run = () => {
    if (stopped || activeRun) return activeRun
    const startedAtMs = clock()
    activeRun = Promise.resolve()
      .then(() => processorFn({ poolInstance, policy: validated, runtimeConfig, logger }))
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
        logger?.error?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'Sent append scheduler failed')
      })
      .finally(() => { activeRun = null })
    return activeRun
  }
  timer = timerApi.setInterval(() => void run(), validated.intervalSeconds * 1000)
  timer?.unref?.()
  void run()
  return async () => {
    stopped = true
    if (timer) timerApi.clearInterval(timer)
    if (activeRun) await activeRun
  }
}
