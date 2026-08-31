export const EMAIL_CACHE_RETENTION_LOCK_SQL = `
  SELECT pg_try_advisory_lock(
    hashtext(current_database()),
    hashtext('nav_email_cache_retention')
  ) AS acquired
`

export const EMAIL_CACHE_RETENTION_UNLOCK_SQL = `
  SELECT pg_advisory_unlock(
    hashtext(current_database()),
    hashtext('nav_email_cache_retention')
  ) AS released
`

export const EMAIL_RETENTION_CAPABILITIES_SQL = `
  SELECT
    to_regclass('email_drafts') IS NOT NULL AS email_drafts_exists,
    EXISTS (
      SELECT 1
      FROM pg_attribute
      WHERE attrelid = to_regclass('mail_outbox')
        AND attname = 'payload_encrypted'
        AND attnum > 0
        AND attisdropped = FALSE
    ) AS mail_outbox_payload_exists
`

export const DELETE_EXPIRED_EMAIL_DRAFTS_SQL = `
  WITH candidates AS (
    SELECT id
    FROM email_drafts
    WHERE status IN ('draft', 'failed', 'sent')
      AND expires_at <= CURRENT_TIMESTAMP
    ORDER BY expires_at ASC, id ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM email_drafts AS draft
  USING candidates
  WHERE draft.id = candidates.id
`

export const DELETE_SCRUBBED_MAIL_OUTBOX_SQL = `
  WITH candidates AS (
    SELECT id
    FROM mail_outbox
    WHERE status IN ('sent', 'expired')
      AND scrubbed_at IS NOT NULL
      AND payload_encrypted IS NULL
      AND updated_at < CURRENT_TIMESTAMP - ($1::integer * INTERVAL '1 day')
    ORDER BY updated_at ASC, id ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM mail_outbox AS outbox
  USING candidates
  WHERE outbox.id = candidates.id
`

export const DELETE_SCRUBBED_LEGACY_MAIL_OUTBOX_SQL = `
  WITH candidates AS (
    SELECT id
    FROM mail_outbox
    WHERE status IN ('sent', 'expired')
      AND scrubbed_at IS NOT NULL
      AND updated_at < CURRENT_TIMESTAMP - ($1::integer * INTERVAL '1 day')
    ORDER BY updated_at ASC, id ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM mail_outbox AS outbox
  USING candidates
  WHERE outbox.id = candidates.id
`

// This removes only the local encrypted cache. Cascading rows in
// email_folder_messages are local IMAP snapshots; no IMAP mutation is issued.
// A message that is currently flagged, marked as a draft, or still needed by
// the durable classification pipeline is protected even when it exceeds the
// age/count policy. Advancing the IMAP cursor is safe only while a non-terminal
// classification job cannot lose its encrypted canonical source to retention.
export const DELETE_EXCESS_EMAIL_MESSAGES_SQL = `
  WITH ranked AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY account_id
        ORDER BY received_at DESC, id DESC
      ) AS account_rank
    FROM email_messages
  ), candidates AS (
    SELECT message.id
    FROM email_messages AS message
    JOIN ranked ON ranked.id = message.id
    WHERE (
      message.received_at < CURRENT_TIMESTAMP - ($1::integer * INTERVAL '1 day')
      OR ranked.account_rank > $2::integer
    )
      AND NOT EXISTS (
        SELECT 1
        FROM email_folder_messages AS folder_message
        WHERE folder_message.message_id = message.id
          AND folder_message.expunged_at IS NULL
          AND (folder_message.flagged = TRUE OR folder_message.draft = TRUE)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM email_classification_jobs AS classification_job
        WHERE classification_job.email_message_id = message.id
          AND classification_job.account_id = message.account_id
          AND classification_job.user_id = message.user_id
          AND classification_job.status IN ('pending', 'running', 'retry_wait')
      )
    ORDER BY message.received_at ASC, message.id ASC
    LIMIT $3
    FOR UPDATE OF message SKIP LOCKED
  )
  DELETE FROM email_messages AS message
  USING candidates
  WHERE message.id = candidates.id
  RETURNING
    message.account_id,
    (
      octet_length(message.envelope_encrypted)
      + octet_length(message.content_encrypted)
    ) AS cached_bytes
`

export const EMAIL_CACHE_STATS_SQL = `
  SELECT
    COUNT(*)::bigint AS cached_messages,
    COALESCE(SUM(
      octet_length(envelope_encrypted) + octet_length(content_encrypted)
    ), 0)::bigint AS cached_bytes
  FROM email_messages
`

export const EMAIL_ACCOUNTS_OVER_QUOTA_SQL = `
  SELECT COUNT(*)::integer AS accounts_over_quota
  FROM (
    SELECT account_id
    FROM email_messages
    GROUP BY account_id
    HAVING COUNT(*) > $1::integer
  ) AS over_quota
`

const MAX_RETENTION_DAYS = 3_650
const MAX_MESSAGES_PER_ACCOUNT = 100_000
const MAX_BATCH_SIZE = 200
const MAX_DELETES_PER_RUN = 200
const MIN_INTERVAL_SECONDS = 300
const MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60
const STARTUP_DELAY_MS = 30_000

function boundedInteger(value, name, { minimum = 1, maximum }) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

export function validateEmailRetentionPolicy({
  retentionDays,
  maxMessagesPerAccount,
  batchSize,
  maxDeletesPerRun,
  outboxRetentionDays,
  intervalSeconds
}) {
  const policy = {
    retentionDays: boundedInteger(retentionDays, 'retentionDays', {
      maximum: MAX_RETENTION_DAYS
    }),
    maxMessagesPerAccount: boundedInteger(
      maxMessagesPerAccount,
      'maxMessagesPerAccount',
      { maximum: MAX_MESSAGES_PER_ACCOUNT }
    ),
    batchSize: boundedInteger(batchSize, 'batchSize', {
      maximum: MAX_BATCH_SIZE
    }),
    maxDeletesPerRun: boundedInteger(maxDeletesPerRun, 'maxDeletesPerRun', {
      maximum: MAX_DELETES_PER_RUN
    }),
    outboxRetentionDays: boundedInteger(
      outboxRetentionDays,
      'outboxRetentionDays',
      { maximum: MAX_RETENTION_DAYS }
    ),
    intervalSeconds: boundedInteger(intervalSeconds, 'intervalSeconds', {
      minimum: MIN_INTERVAL_SECONDS,
      maximum: MAX_INTERVAL_SECONDS
    })
  }
  if (policy.batchSize > policy.maxDeletesPerRun) {
    throw new TypeError('batchSize must not exceed maxDeletesPerRun')
  }
  return policy
}

function safeCount(result) {
  const value = Number(result?.rowCount || 0)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function safeBigint(value) {
  const parsed = Number(value || 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function emptyResult(skipped = null) {
  return {
    messagesDeleted: 0,
    messageBytesDeleted: 0,
    draftsDeleted: 0,
    outboxDeleted: 0,
    accountsTouched: 0,
    accountsOverQuota: 0,
    cachedMessages: 0,
    cachedBytes: 0,
    batches: 0,
    skipped
  }
}

export async function pruneEmailCache({ poolInstance, policy }) {
  const validated = validateEmailRetentionPolicy(policy)
  if (typeof poolInstance?.connect !== 'function') {
    throw new TypeError('poolInstance.connect is required')
  }

  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null

  try {
    const lock = await client.query(EMAIL_CACHE_RETENTION_LOCK_SQL)
    lockAcquired = lock.rows[0]?.acquired === true
    if (!lockAcquired) return emptyResult('already-running')

    const result = emptyResult()
    const capabilities = await client.query(EMAIL_RETENTION_CAPABILITIES_SQL)
    const capability = capabilities.rows[0] || {}
    let remaining = validated.maxDeletesPerRun

    // Reserve only a quarter of the run for each auxiliary table so a large
    // draft/outbox backlog cannot permanently starve mailbox-cache cleanup.
    const auxiliaryLimit = Math.min(
      validated.batchSize,
      Math.max(1, Math.floor(validated.maxDeletesPerRun / 4))
    )

    if (remaining > 0 && capability.email_drafts_exists === true) {
      const draftLimit = Math.min(auxiliaryLimit, remaining)
      const deleted = await client.query(DELETE_EXPIRED_EMAIL_DRAFTS_SQL, [draftLimit])
      result.draftsDeleted = safeCount(deleted)
      result.batches += 1
      remaining -= result.draftsDeleted
    }

    if (remaining > 0) {
      const outboxLimit = Math.min(auxiliaryLimit, remaining)
      const outboxSql = capability.mail_outbox_payload_exists === true
        ? DELETE_SCRUBBED_MAIL_OUTBOX_SQL
        : DELETE_SCRUBBED_LEGACY_MAIL_OUTBOX_SQL
      const deleted = await client.query(outboxSql, [
        validated.outboxRetentionDays,
        outboxLimit
      ])
      result.outboxDeleted = safeCount(deleted)
      result.batches += 1
      remaining -= result.outboxDeleted
    }

    const touchedAccounts = new Set()
    while (remaining > 0) {
      const limit = Math.min(validated.batchSize, remaining)
      const deleted = await client.query(DELETE_EXCESS_EMAIL_MESSAGES_SQL, [
        validated.retentionDays,
        validated.maxMessagesPerAccount,
        limit
      ])
      const deletedCount = safeCount(deleted)
      result.messagesDeleted += deletedCount
      result.batches += 1
      remaining -= deletedCount
      for (const row of deleted.rows || []) {
        if (row.account_id) touchedAccounts.add(String(row.account_id))
        result.messageBytesDeleted += safeBigint(row.cached_bytes)
      }
      if (deletedCount < limit) break
    }
    result.accountsTouched = touchedAccounts.size

    const [cacheStats, quotaStats] = await Promise.all([
      client.query(EMAIL_CACHE_STATS_SQL),
      client.query(EMAIL_ACCOUNTS_OVER_QUOTA_SQL, [validated.maxMessagesPerAccount])
    ])
    result.cachedMessages = safeBigint(cacheStats.rows[0]?.cached_messages)
    result.cachedBytes = safeBigint(cacheStats.rows[0]?.cached_bytes)
    result.accountsOverQuota = safeBigint(quotaStats.rows[0]?.accounts_over_quota)
    return result
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let unlockError = null
    if (lockAcquired) {
      try {
        await client.query(EMAIL_CACHE_RETENTION_UNLOCK_SQL)
      } catch (error) {
        unlockError = error
      }
    }
    client.release(unlockError || undefined)
    if (!primaryError && unlockError) throw unlockError
  }
}

async function notifyObserver(observer, method, payload, logger) {
  try {
    await observer?.[method]?.(payload)
  } catch (error) {
    logger?.warn?.(
      { err: error, observerMethod: method },
      'email cache retention status could not be recorded'
    )
  }
}

export function startEmailCacheRetention({
  enabled,
  policy,
  poolInstance,
  logger,
  observer,
  pruneFn = pruneEmailCache,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateEmailRetentionPolicy(policy)
  let stopped = false
  let timeoutHandle = null
  let intervalHandle = null
  let activeRun = null

  const run = () => {
    if (stopped || activeRun) return activeRun
    const startedAtMs = clock()
    activeRun = Promise.resolve()
      .then(() => pruneFn({ poolInstance, policy: validated }))
      .then(async (result) => {
        const finishedAtMs = clock()
        await notifyObserver(observer, 'succeeded', {
          result,
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        if (
          result?.messagesDeleted > 0
          || result?.draftsDeleted > 0
          || result?.outboxDeleted > 0
        ) {
          logger?.info?.({
            messagesDeleted: result.messagesDeleted,
            draftsDeleted: result.draftsDeleted,
            outboxDeleted: result.outboxDeleted,
            messageBytesDeleted: result.messageBytesDeleted
          }, 'expired email cache records pruned')
        }
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
        logger?.error?.({ err: error }, 'failed to prune email cache records')
      })
      .finally(() => {
        activeRun = null
      })
    return activeRun
  }

  const intervalMs = validated.intervalSeconds * 1_000
  timeoutHandle = timerApi.setTimeout(() => {
    void run()
    intervalHandle = timerApi.setInterval(() => void run(), intervalMs)
    intervalHandle?.unref?.()
  }, Math.min(STARTUP_DELAY_MS, intervalMs))
  timeoutHandle?.unref?.()

  return async () => {
    stopped = true
    if (timeoutHandle) timerApi.clearTimeout(timeoutHandle)
    if (intervalHandle) timerApi.clearInterval(intervalHandle)
    if (activeRun) await activeRun
  }
}
