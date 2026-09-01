import { config } from '../config.js'
import { processInboundEmail } from './emailEvents.js'
import {
  EMAIL_CLASSIFICATION_WAKE_CHANNEL,
  startEmailWakeListener
} from './emailIngestWake.js'
import { decryptStoredMailboxMessage } from './emailMailboxStore.js'
import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function validateEmailClassificationPolicy(policy = {}) {
  return {
    intervalSeconds: boundedInteger(policy.intervalSeconds, 2, 1, 300),
    batchSize: boundedInteger(policy.batchSize, 10, 1, 50),
    maxAttempts: boundedInteger(policy.maxAttempts, 5, 1, 10),
    staleRunningSeconds: boundedInteger(policy.staleRunningSeconds, 300, 60, 3600)
  }
}

function retryDelaySeconds(attemptCount) {
  return Math.min(3600, 5 * (2 ** Math.min(Math.max(0, Number(attemptCount || 1) - 1), 9)))
}

function normalizedSourceKeys(value) {
  const values = Array.isArray(value) ? value : [value]
  const keys = [...new Set(values
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => /^[a-z0-9_.-]{1,80}$/.test(item)))]
  if (!keys.length) throw new Error('Email source key is invalid')
  return keys
}

export async function claimEmailClassificationJob(poolInstance, policy, sourceKey) {
  const sourceKeys = normalizedSourceKeys(sourceKey)
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE email_classification_jobs
       SET status = CASE
             WHEN attempt_count >= LEAST(max_attempts, $3::integer) THEN 'dead_letter'
             ELSE 'retry_wait'
           END,
           max_attempts = GREATEST(attempt_count, LEAST(max_attempts, $3::integer)),
           completed_at = CASE
             WHEN attempt_count >= LEAST(max_attempts, $3::integer) THEN NOW()
             ELSE NULL
           END,
           next_attempt_at = CASE
             WHEN attempt_count >= LEAST(max_attempts, $3::integer) THEN next_attempt_at
             ELSE NOW()
           END,
           last_error_at = NOW(), last_error_code = 'EMAIL_CLASSIFIER_INTERRUPTED', updated_at = NOW()
       WHERE status = 'running'
         AND updated_at < NOW() - ($1::integer * INTERVAL '1 second')
         AND EXISTS (
           SELECT 1 FROM email_accounts AS account
           WHERE account.id = email_classification_jobs.account_id
             AND account.user_id = email_classification_jobs.user_id
              AND account.source_key = ANY($2::text[])
         )`,
      [policy.staleRunningSeconds, sourceKeys, policy.maxAttempts]
    )
    await client.query(
      `UPDATE email_classification_jobs
       SET status = 'dead_letter',
           max_attempts = GREATEST(attempt_count, LEAST(max_attempts, $2::integer)),
           completed_at = NOW(), last_error_at = NOW(),
           last_error_code = COALESCE(last_error_code, 'EMAIL_CLASSIFIER_RETRY_EXHAUSTED'),
           updated_at = NOW()
       WHERE status IN ('pending', 'retry_wait')
         AND attempt_count >= LEAST(max_attempts, $2::integer)
         AND EXISTS (
           SELECT 1 FROM email_accounts AS account
           WHERE account.id = email_classification_jobs.account_id
             AND account.user_id = email_classification_jobs.user_id
              AND account.source_key = ANY($1::text[])
         )`,
      [sourceKeys, policy.maxAttempts]
    )
    const candidate = await client.query(
      `SELECT job.id
       FROM email_classification_jobs AS job
       JOIN email_accounts AS account
         ON account.id = job.account_id AND account.user_id = job.user_id
       WHERE job.status IN ('pending', 'retry_wait')
         AND job.next_attempt_at <= NOW()
         AND job.attempt_count < LEAST(job.max_attempts, $2::integer)
         AND account.enabled = TRUE
          AND account.source_key = ANY($1::text[])
       ORDER BY job.next_attempt_at ASC, job.created_at ASC, job.id ASC
       FOR UPDATE OF job SKIP LOCKED
       LIMIT 1`,
      [sourceKeys, policy.maxAttempts]
    )
    if (!candidate.rows[0]) {
      await client.query('COMMIT')
      return null
    }
    const claimed = await client.query(
      `UPDATE email_classification_jobs
       SET status = 'running', attempt_count = attempt_count + 1,
           max_attempts = LEAST(max_attempts, $2::integer),
           started_at = COALESCE(started_at, NOW()),
           last_error_at = NULL, last_error_code = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [candidate.rows[0].id, policy.maxAttempts]
    )
    await client.query('COMMIT')
    return claimed.rows[0]
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
  }
}

async function loadClassificationContext(poolInstance, job) {
  const { rows } = await poolInstance.query(
    `SELECT job.*, account.source_key,
            message.envelope_encrypted, message.content_encrypted, message.received_at,
            location.uid AS mailbox_uid
     FROM email_classification_jobs AS job
     JOIN email_accounts AS account
       ON account.id = job.account_id AND account.user_id = job.user_id
     JOIN email_messages AS message
       ON message.id = job.email_message_id
      AND message.account_id = job.account_id
      AND message.user_id = job.user_id
     LEFT JOIN LATERAL (
       SELECT current.uid
       FROM email_folder_messages AS current
       JOIN email_folders AS folder
         ON folder.id = current.folder_id
        AND folder.account_id = current.account_id
        AND folder.user_id = current.user_id
       WHERE current.message_id = message.id
         AND current.user_id = message.user_id
         AND current.expunged_at IS NULL
       ORDER BY CASE WHEN folder.special_use = 'inbox' THEN 0 ELSE 1 END,
                current.internal_date ASC, current.id ASC
       LIMIT 1
     ) AS location ON TRUE
     WHERE job.id = $1
     LIMIT 1`,
    [job.id]
  )
  if (!rows[0]) {
    const error = new Error('Email classification source no longer exists')
    error.code = 'EMAIL_CLASSIFICATION_SOURCE_MISSING'
    throw error
  }
  return rows[0]
}

function inboundEmailFromStored(context, stored) {
  const envelope = stored?.envelope || {}
  const content = stored?.content || {}
  const sender = envelope.sender || {}
  const recipients = Array.isArray(envelope.to) ? envelope.to : []
  return {
    messageId: envelope.messageId || '',
    mailboxUid: Number(context.mailbox_uid || 0) || null,
    senderName: sender.name || '',
    senderAddress: sender.address || '',
    recipient: recipients.map((entry) => String(entry?.address || '').trim()).filter(Boolean).join(', '),
    subject: envelope.subject || '(无主题)',
    text: content.text || '',
    receivedAt: context.received_at
  }
}

async function finishClassificationJob(poolInstance, job, status, errorCode = null) {
  const terminal = status === 'succeeded' || status === 'dead_letter'
  await poolInstance.query(
    `UPDATE email_classification_jobs
     SET status = $2::varchar(16),
         completed_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
         next_attempt_at = CASE
           WHEN $2::varchar(16) = 'retry_wait' THEN NOW() + ($4::integer * INTERVAL '1 second')
           ELSE next_attempt_at
         END,
         last_error_at = CASE WHEN $5::varchar(64) IS NULL THEN NULL ELSE NOW() END,
         last_error_code = $5::varchar(64),
         updated_at = NOW()
     WHERE id = $1 AND status = 'running'`,
    [job.id, status, terminal, retryDelaySeconds(job.attempt_count), errorCode]
  )
}

export async function processEmailClassificationJobs({
  poolInstance,
  policy,
  runtimeConfig = config,
  logger,
  processFn = processInboundEmail,
  claimFn = claimEmailClassificationJob,
  loadFn = loadClassificationContext,
  decryptFn = decryptStoredMailboxMessage,
  finishFn = finishClassificationJob
}) {
  const validated = validateEmailClassificationPolicy(policy)
  const sourceKeys = normalizedSourceKeys(runtimeConfig.emailSourceKeys || runtimeConfig.emailSourceKey)
  const summary = {
    processed: 0,
    succeeded: 0,
    retried: 0,
    deadLetter: 0,
    remaining: 0,
    dueRemaining: 0,
    oldestPendingSeconds: 0
  }
  for (let index = 0; index < validated.batchSize; index += 1) {
    const job = await claimFn(poolInstance, validated, sourceKeys)
    if (!job) break
    summary.processed += 1
    try {
      const context = await loadFn(poolInstance, job)
      const stored = await decryptFn(context, {
        userId: context.user_id,
        sourceKey: context.source_key
      })
      await processFn({
        userId: context.user_id,
        sourceKey: context.source_key,
        emailMessageId: context.email_message_id,
        notificationEligible: context.notification_eligible === true,
        email: inboundEmailFromStored(context, stored),
        logger
      })
      await finishFn(poolInstance, job, 'succeeded')
      summary.succeeded += 1
    } catch (error) {
      const errorCode = sanitizeMaintenanceErrorCode(error)
      const terminal = Number(job.attempt_count) >= Math.min(Number(job.max_attempts), validated.maxAttempts)
      await finishFn(
        poolInstance,
        job,
        terminal ? 'dead_letter' : 'retry_wait',
        errorCode
      )
      if (terminal) summary.deadLetter += 1
      else summary.retried += 1
      logger?.warn?.({ classificationJobId: job.id, errorCode }, 'email classification job deferred')
    }
  }
  const pending = await poolInstance.query(
    `SELECT COUNT(*)::integer AS count,
            COUNT(*) FILTER (
              WHERE job.status IN ('pending', 'retry_wait')
                AND job.next_attempt_at <= NOW()
            )::integer AS due_count,
            COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::integer, 0) AS oldest_seconds
     FROM email_classification_jobs AS job
     WHERE job.status IN ('pending', 'retry_wait', 'running')
       AND EXISTS (
         SELECT 1 FROM email_accounts AS account
         WHERE account.id = job.account_id AND account.user_id = job.user_id
            AND account.enabled = TRUE AND account.source_key = ANY($1::text[])
       )`,
    [sourceKeys]
  )
  summary.remaining = Number(pending.rows[0]?.count || 0)
  summary.dueRemaining = Number(pending.rows[0]?.due_count || 0)
  summary.oldestPendingSeconds = Math.max(0, Number(pending.rows[0]?.oldest_seconds || 0))
  return summary
}

async function notifyObserver(observer, method, payload, logger) {
  try { await observer?.[method]?.(payload) } catch (error) {
    logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'email classification status could not be recorded')
  }
}

export function startEmailClassificationScheduler({
  enabled,
  policy,
  poolInstance,
  runtimeConfig = config,
  logger,
  observer,
  processorFn = processEmailClassificationJobs,
  wakeListenerFactory = startEmailWakeListener,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateEmailClassificationPolicy(policy)
  const sourceKeys = normalizedSourceKeys(runtimeConfig.emailSourceKeys || runtimeConfig.emailSourceKey)
  let stopped = false
  let activeRun = null
  let timer = null
  let rerunRequested = false

  const schedule = (delay = validated.intervalSeconds * 1000) => {
    if (stopped || timer) return
    timer = timerApi.setTimeout(() => {
      timer = null
      void run()
    }, delay)
    timer?.unref?.()
  }
  const run = () => {
    if (stopped) return activeRun
    if (activeRun) {
      rerunRequested = true
      return activeRun
    }
    const startedAtMs = clock()
    let continueImmediately = false
    activeRun = Promise.resolve()
      .then(() => processorFn({ poolInstance, policy: validated, runtimeConfig, logger }))
      .then(async (result) => {
        const finishedAtMs = clock()
        // Retry-wait jobs whose next_attempt_at is in the future must not turn
        // the worker into a 100 ms busy loop. The periodic timer will wake them.
        continueImmediately = Number(result?.dueRemaining || 0) > 0
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
        logger?.error?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'email classification scheduler failed')
      })
      .finally(() => {
        activeRun = null
        if (rerunRequested || continueImmediately) {
          rerunRequested = false
          schedule(100)
        } else schedule()
      })
    return activeRun
  }
  const stopWakeListener = wakeListenerFactory({
    poolInstance,
    channel: EMAIL_CLASSIFICATION_WAKE_CHANNEL,
    logger,
    timerApi,
    onWake: (payload) => {
      if (!sourceKeys.includes(payload.sourceKey)) return
      if (timer) timerApi.clearTimeout(timer)
      timer = null
      void run()
    }
  })
  void run()
  return async () => {
    stopped = true
    if (timer) timerApi.clearTimeout(timer)
    timer = null
    await stopWakeListener?.()
    if (activeRun) await activeRun
  }
}
