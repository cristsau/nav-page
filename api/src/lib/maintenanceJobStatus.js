export const MAINTENANCE_JOB_NAMES = Object.freeze({
  SECURITY_EVENT_RETENTION: 'security_event_retention',
  MEDIA_DELETE_RETRY: 'media_delete_retry',
  AI_USAGE_RETENTION: 'ai_usage_retention',
  NOTE_REMINDER_GENERATION: 'note_reminder_generation',
  BOOKMARK_HEALTH_CHECK: 'bookmark_health_check',
  SEARCH_EMBEDDING_INDEX: 'search_embedding_index',
  WEB_PUSH_DELIVERY: 'web_push_delivery'
})

const KNOWN_JOB_NAMES = new Set(Object.values(MAINTENANCE_JOB_NAMES))

export const RECORD_MAINTENANCE_SUCCESS_SQL = `
  WITH previous AS (
    SELECT job_name, alert_open
    FROM maintenance_job_status
    WHERE job_name = $1
    FOR UPDATE
  ), updated AS (
    UPDATE maintenance_job_status AS status
    SET last_started_at = $2,
        last_succeeded_at = $3,
        last_duration_ms = $4,
        last_outcome = 'succeeded',
        last_result = $5::jsonb,
        consecutive_failures = 0,
        last_error_code = NULL,
        alert_open = FALSE,
        updated_at = NOW()
    FROM previous
    WHERE status.job_name = previous.job_name
    RETURNING status.*, previous.alert_open AS was_alert_open
  )
  SELECT * FROM updated
`

export const RECORD_MAINTENANCE_FAILURE_SQL = `
  WITH previous AS (
    SELECT
      job_name,
      consecutive_failures,
      alert_open,
      last_alert_at
    FROM maintenance_job_status
    WHERE job_name = $1
    FOR UPDATE
  ), decision AS (
    SELECT
      *,
      consecutive_failures + 1 AS next_failure_count,
      $6::boolean
        AND consecutive_failures + 1 >= $7::integer
        AND (
          last_alert_at IS NULL
          OR last_alert_at <= $3::timestamptz - ($8::integer * INTERVAL '1 second')
        ) AS should_notify
    FROM previous
  ), updated AS (
    UPDATE maintenance_job_status AS status
    SET last_started_at = $2,
        last_failed_at = $3,
        last_duration_ms = $4,
        last_outcome = 'failed',
        last_result = $9::jsonb,
        consecutive_failures = decision.next_failure_count,
        last_error_code = $5,
        alert_open = status.alert_open OR decision.should_notify,
        last_alert_at = CASE
          WHEN decision.should_notify THEN $3
          ELSE status.last_alert_at
        END,
        updated_at = NOW()
    FROM decision
    WHERE status.job_name = decision.job_name
    RETURNING
      status.*,
      decision.should_notify,
      decision.last_alert_at AS previous_alert_at
  )
  SELECT * FROM updated
`

export const RECORD_MAINTENANCE_PROGRESS_SQL = `
  UPDATE maintenance_job_status
  SET last_started_at = $2,
      last_duration_ms = $3,
      last_result = $4::jsonb,
      updated_at = NOW()
  WHERE job_name = $1
`

export const RECORD_MAINTENANCE_NOTIFICATION_SQL = `
  UPDATE maintenance_job_status
  SET last_notification_kind = $2,
      last_notification_status = $3,
      last_notification_at = $4,
      last_notification_error_code = $5,
      updated_at = NOW()
  WHERE job_name = $1
`

export const RELEASE_MAINTENANCE_ALERT_RESERVATION_SQL = `
  UPDATE maintenance_job_status
  SET last_alert_at = $3,
      updated_at = NOW()
  WHERE job_name = $1
    AND last_alert_at = $2
`

const RESULT_FIELDS = Object.freeze({
  [MAINTENANCE_JOB_NAMES.SECURITY_EVENT_RETENTION]: [
    'deletedCount',
    'batches'
  ],
  [MAINTENANCE_JOB_NAMES.MEDIA_DELETE_RETRY]: [
    'processed',
    'deleted',
    'failed',
    'referenced',
    'notPending',
    'errors',
    'remaining',
    'eligible',
    'deferred',
    'exhausted'
  ],
  [MAINTENANCE_JOB_NAMES.AI_USAGE_RETENTION]: [
    'deletedCount',
    'batches'
  ],
  [MAINTENANCE_JOB_NAMES.NOTE_REMINDER_GENERATION]: [
    'generated'
  ],
  [MAINTENANCE_JOB_NAMES.BOOKMARK_HEALTH_CHECK]: [
    'checked',
    'broken',
    'suspect',
    'unsupported',
    'reachable'
  ],
  [MAINTENANCE_JOB_NAMES.SEARCH_EMBEDDING_INDEX]: [
    'indexed',
    'processed',
    'remaining'
  ],
  [MAINTENANCE_JOB_NAMES.WEB_PUSH_DELIVERY]: [
    'processed',
    'delivered',
    'failed',
    'disabled',
    'remaining'
  ]
})

function boundedInteger(value, name, { minimum, maximum }) {
  const parsed = Number(value)
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}
function validateJobName(jobName) {
  if (!KNOWN_JOB_NAMES.has(jobName)) {
    throw new TypeError('Unsupported maintenance job')
  }
  return jobName
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid maintenance timestamp')
  return date
}

function normalizeDuration(value) {
  return boundedInteger(Math.max(0, Math.round(Number(value) || 0)), 'durationMs', {
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER
  })
}

export function sanitizeMaintenanceErrorCode(error) {
  const source = String(error?.code || error?.name || 'UNEXPECTED_ERROR')
    .trim()
    .toUpperCase()
  const normalized = source
    .replace(/[^A-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return normalized || 'UNEXPECTED_ERROR'
}

export function summarizeMaintenanceResult(jobName, result = {}) {
  const fields = RESULT_FIELDS[validateJobName(jobName)]
  return Object.fromEntries(fields.map((field) => {
    const value = Number(result?.[field] || 0)
    return [field, Number.isSafeInteger(value) && value >= 0 ? value : 0]
  }))
}

function maintenanceNotificationStatus(result) {
  if (result?.skipped) return 'skipped'
  const sent = Number(result?.sent || 0)
  const failed = Number(result?.failed || 0)
  if (sent > 0 && failed > 0) return 'partial'
  if (sent > 0) return 'sent'
  return failed > 0 ? 'failed' : 'skipped'
}

async function recordNotification({
  poolInstance,
  jobName,
  kind,
  status,
  occurredAt,
  errorCode = null
}) {
  await poolInstance.query(RECORD_MAINTENANCE_NOTIFICATION_SQL, [
    jobName,
    kind,
    status,
    occurredAt,
    errorCode
  ])
}

async function notifyAndRecord({
  poolInstance,
  logger,
  notifyFn,
  jobName,
  jobLabel,
  kind,
  occurredAt,
  consecutiveFailures,
  errorCode
}) {
  let status = 'skipped'
  let notificationErrorCode = null
  const payload = {
    jobName,
    jobLabel,
    kind,
    occurredAt,
    consecutiveFailures,
    errorCode
  }

  // Deliver at most once per worker cycle. A transport failure is ambiguous:
  // Telegram may have accepted the message before the response was lost, and
  // the notifier aggregates such failures across administrator targets. An
  // immediate retry could therefore produce duplicates. Undelivered attempts
  // release only the cooldown reservation below, allowing a later worker cycle
  // to try again while preserving the open alert.
  try {
    const result = typeof notifyFn === 'function'
      ? await notifyFn(payload)
      : { skipped: true, sent: 0, failed: 0 }
    status = maintenanceNotificationStatus(result)
    notificationErrorCode = status === 'failed'
      ? 'NOTIFICATION_DELIVERY_FAILED'
      : null
  } catch (error) {
    status = 'failed'
    notificationErrorCode = sanitizeMaintenanceErrorCode(error)
    logger?.warn?.(
      { err: error, jobName, notificationKind: kind },
      'maintenance notification delivery failed'
    )
  }

  try {
    await recordNotification({
      poolInstance,
      jobName,
      kind,
      status,
      occurredAt: new Date(),
      errorCode: notificationErrorCode
    })
  } catch (error) {
    logger?.warn?.(
      { err: error, jobName, notificationKind: kind },
      'maintenance notification status could not be recorded'
    )
  }

  return { status, errorCode: notificationErrorCode }
}

export function createMaintenanceJobObserver({
  jobName,
  jobLabel,
  poolInstance,
  logger,
  alertsEnabled,
  failureThreshold,
  alertCooldownSeconds,
  notifyFn
}) {
  validateJobName(jobName)
  if (typeof poolInstance?.query !== 'function') {
    throw new TypeError('poolInstance.query is required')
  }

  const threshold = boundedInteger(failureThreshold, 'failureThreshold', {
    minimum: 1,
    maximum: 20
  })
  const cooldownSeconds = boundedInteger(
    alertCooldownSeconds,
    'alertCooldownSeconds',
    { minimum: 300, maximum: 7 * 24 * 60 * 60 }
  )

  return {
    async deferred({ result, startedAt, durationMs }) {
      if (result?.skipped) return
      const started = normalizeTimestamp(startedAt)
      const summary = summarizeMaintenanceResult(jobName, result)
      await poolInstance.query(RECORD_MAINTENANCE_PROGRESS_SQL, [
        jobName,
        started,
        normalizeDuration(durationMs),
        JSON.stringify(summary)
      ])
    },

    async succeeded({ result, startedAt, finishedAt, durationMs }) {
      if (result?.skipped) return
      const started = normalizeTimestamp(startedAt)
      const finished = normalizeTimestamp(finishedAt)
      const summary = summarizeMaintenanceResult(jobName, result)
      const { rows } = await poolInstance.query(RECORD_MAINTENANCE_SUCCESS_SQL, [
        jobName,
        started,
        finished,
        normalizeDuration(durationMs),
        JSON.stringify(summary)
      ])
      const state = rows[0]
      if (alertsEnabled && state?.was_alert_open === true) {
        await notifyAndRecord({
          poolInstance,
          logger,
          notifyFn,
          jobName,
          jobLabel,
          kind: 'recovery',
          occurredAt: finished,
          consecutiveFailures: 0,
          errorCode: null
        })
      }
    },

    async failed({ error, result, startedAt, finishedAt, durationMs }) {
      const started = normalizeTimestamp(startedAt)
      const finished = normalizeTimestamp(finishedAt)
      const errorCode = sanitizeMaintenanceErrorCode(error)
      const { rows } = await poolInstance.query(RECORD_MAINTENANCE_FAILURE_SQL, [
        jobName,
        started,
        finished,
        normalizeDuration(durationMs),
        errorCode,
        Boolean(alertsEnabled),
        threshold,
        cooldownSeconds,
        JSON.stringify(summarizeMaintenanceResult(jobName, result))
      ])
      const state = rows[0]
      if (state?.should_notify === true) {
        const delivery = await notifyAndRecord({
          poolInstance,
          logger,
          notifyFn,
          jobName,
          jobLabel,
          kind: 'failure',
          occurredAt: finished,
          consecutiveFailures: Number(state.consecutive_failures || 0),
          errorCode
        })

        if (delivery.status === 'failed' || delivery.status === 'skipped') {
          await poolInstance.query(RELEASE_MAINTENANCE_ALERT_RESERVATION_SQL, [
            jobName,
            finished,
            state.previous_alert_at || null
          ])
        }
      }
    }
  }
}
