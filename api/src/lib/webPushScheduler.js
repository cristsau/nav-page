import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'
import { sendWebPush } from './webPush.js'

const LOCK_SQL = `
  SELECT pg_try_advisory_lock(
    hashtext(current_database()),
    hashtext('nav_web_push_delivery')
  ) AS acquired
`
const UNLOCK_SQL = `
  SELECT pg_advisory_unlock(
    hashtext(current_database()),
    hashtext('nav_web_push_delivery')
  ) AS released
`
const MIN_INTERVAL_SECONDS = 30
const MAX_INTERVAL_SECONDS = 24 * 60 * 60
const MAX_BATCH_SIZE = 500

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

export function validateWebPushPolicy({ intervalSeconds, batchSize, maxAttempts }) {
  return {
    intervalSeconds: boundedInteger(
      intervalSeconds,
      'intervalSeconds',
      MIN_INTERVAL_SECONDS,
      MAX_INTERVAL_SECONDS
    ),
    batchSize: boundedInteger(batchSize, 'batchSize', 1, MAX_BATCH_SIZE),
    maxAttempts: boundedInteger(maxAttempts, 'maxAttempts', 1, 20)
  }
}

export async function deliverDueWebPushNotifications({
  poolInstance,
  policy,
  sendFn = sendWebPush
}) {
  const validated = validateWebPushPolicy(policy)
  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null
  try {
    const lock = await client.query(LOCK_SQL)
    lockAcquired = lock.rows[0]?.acquired === true
    if (!lockAcquired) {
      return { processed: 0, delivered: 0, failed: 0, disabled: 0, remaining: 0, skipped: 'already-running' }
    }

    await client.query(
      `
        INSERT INTO note_reminder_push_deliveries (reminder_id, subscription_id)
        SELECT reminder.id, subscription.id
        FROM note_reminders AS reminder
        JOIN notes AS note
          ON note.id = reminder.note_id
         AND note.user_id = reminder.user_id
        JOIN web_push_subscriptions AS subscription
          ON subscription.user_id = reminder.user_id
         AND subscription.disabled_at IS NULL
        WHERE reminder.triggered_at <= NOW()
          AND reminder.triggered_at >= NOW() - INTERVAL '24 hours'
          AND note.type = 'memo'
          AND note.completed = FALSE
          AND note.due_at = reminder.due_at_snapshot
          AND note.remind_before_minutes = reminder.remind_before_minutes_snapshot
        ON CONFLICT (reminder_id, subscription_id) DO NOTHING
      `
    )

    await client.query(
      `
        UPDATE note_reminder_push_deliveries AS delivery
        SET status = 'expired', updated_at = NOW()
        WHERE delivery.status IN ('pending', 'failed')
          AND NOT EXISTS (
            SELECT 1
            FROM note_reminders AS reminder
            JOIN notes AS note
              ON note.id = reminder.note_id
             AND note.user_id = reminder.user_id
            JOIN web_push_subscriptions AS subscription
              ON subscription.id = delivery.subscription_id
             AND subscription.user_id = reminder.user_id
             AND subscription.disabled_at IS NULL
            WHERE reminder.id = delivery.reminder_id
              AND note.type = 'memo'
              AND note.completed = FALSE
              AND note.due_at = reminder.due_at_snapshot
              AND note.remind_before_minutes = reminder.remind_before_minutes_snapshot
          )
      `
    )

    const candidates = await client.query(
      `
        SELECT
          delivery.reminder_id,
          delivery.subscription_id,
          delivery.attempt_count,
          subscription.endpoint,
          subscription.p256dh,
          subscription.auth,
          note.id AS note_id,
          reminder.due_at_snapshot
        FROM note_reminder_push_deliveries AS delivery
        JOIN note_reminders AS reminder ON reminder.id = delivery.reminder_id
        JOIN notes AS note ON note.id = reminder.note_id
        JOIN web_push_subscriptions AS subscription
          ON subscription.id = delivery.subscription_id
        WHERE delivery.status IN ('pending', 'failed')
          AND delivery.attempt_count < $2
          AND (
            delivery.last_attempt_at IS NULL
            OR delivery.last_attempt_at <= NOW() - (
              POWER(2, LEAST(delivery.attempt_count, 8)) * INTERVAL '1 minute'
            )
          )
          AND subscription.disabled_at IS NULL
        ORDER BY delivery.updated_at ASC, delivery.reminder_id, delivery.subscription_id
        LIMIT $1
      `,
      [validated.batchSize, validated.maxAttempts]
    )

    const summary = {
      processed: 0,
      delivered: 0,
      failed: 0,
      disabled: 0,
      notificationDelivered: 0,
      remaining: 0,
      skipped: null
    }
    for (const candidate of candidates.rows) {
      summary.processed += 1
      try {
        await sendFn(candidate, {
          title: 'DOMO NAV',
          body: '你有一条新的到期提醒，登录后查看完整内容。',
          tag: 'nav-note-reminder',
          url: '/whisper',
          icon: '/icons/cristsau-mark-192-v2.png',
          badge: '/icons/cristsau-badge-96-v2.png',
          timestamp: new Date(candidate.due_at_snapshot).getTime()
        })
        await client.query(
          `
            UPDATE note_reminder_push_deliveries
            SET status = 'delivered', attempt_count = attempt_count + 1,
                last_attempt_at = NOW(), delivered_at = NOW(),
                last_error_code = NULL, updated_at = NOW()
            WHERE reminder_id = $1 AND subscription_id = $2
          `,
          [candidate.reminder_id, candidate.subscription_id]
        )
        await client.query(
          `
            UPDATE web_push_subscriptions
            SET last_success_at = NOW(), failure_count = 0, updated_at = NOW()
            WHERE id = $1
          `,
          [candidate.subscription_id]
        )
        summary.delivered += 1
      } catch (error) {
        const statusCode = Number(error?.statusCode || 0)
        const disabled = statusCode === 404 || statusCode === 410
        const errorCode = disabled
          ? `PUSH_ENDPOINT_${statusCode}`
          : sanitizeMaintenanceErrorCode(error)
        await client.query(
          `
            UPDATE note_reminder_push_deliveries
            SET status = $3, attempt_count = attempt_count + 1,
                last_attempt_at = NOW(), last_error_code = $4, updated_at = NOW()
            WHERE reminder_id = $1 AND subscription_id = $2
          `,
          [
            candidate.reminder_id,
            candidate.subscription_id,
            disabled ? 'expired' : 'failed',
            errorCode
          ]
        )
        await client.query(
          `
            UPDATE web_push_subscriptions
            SET failure_count = failure_count + 1,
                last_failure_at = NOW(),
                disabled_at = CASE WHEN $2 THEN NOW() ELSE disabled_at END,
                updated_at = NOW()
            WHERE id = $1
          `,
          [candidate.subscription_id, disabled]
        )
        summary.failed += 1
        if (disabled) summary.disabled += 1
      }
    }

    await client.query(
      `
        INSERT INTO notification_push_deliveries (notification_id, subscription_id)
        SELECT notification.id, subscription.id
        FROM notifications AS notification
        JOIN web_push_subscriptions AS subscription
          ON subscription.user_id = notification.user_id
         AND subscription.disabled_at IS NULL
        WHERE notification.push_enabled = TRUE
          AND notification.read_at IS NULL
              AND notification.source_type NOT IN ('email', 'email_digest')
          AND notification.created_at >= NOW() - INTERVAL '7 days'
          AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
        ON CONFLICT (notification_id, subscription_id) DO NOTHING
      `
    )
    await client.query(
      `
        UPDATE notification_push_deliveries AS delivery
        SET status = 'expired', updated_at = NOW()
        WHERE delivery.status IN ('pending', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM notifications AS notification
            JOIN web_push_subscriptions AS subscription
              ON subscription.id = delivery.subscription_id
             AND subscription.user_id = notification.user_id
             AND subscription.disabled_at IS NULL
            WHERE notification.id = delivery.notification_id
              AND notification.push_enabled = TRUE
              AND notification.read_at IS NULL
              AND notification.source_type NOT IN ('email', 'email_digest')
              AND (notification.expires_at IS NULL OR notification.expires_at > NOW())
          )
      `
    )
    const genericLimit = Math.max(0, validated.batchSize - candidates.rows.length)
    const genericCandidates = genericLimit
      ? await client.query(
          `
            SELECT delivery.notification_id, delivery.subscription_id,
                   delivery.attempt_count, subscription.endpoint,
                   subscription.p256dh, subscription.auth,
                   notification.action_url, notification.sensitive,
                   notification.created_at
            FROM notification_push_deliveries AS delivery
            JOIN notifications AS notification ON notification.id = delivery.notification_id
            JOIN web_push_subscriptions AS subscription ON subscription.id = delivery.subscription_id
            WHERE delivery.status IN ('pending', 'failed')
              AND delivery.attempt_count < $2
              AND (delivery.last_attempt_at IS NULL OR delivery.last_attempt_at <= NOW() - (
                POWER(2, LEAST(delivery.attempt_count, 8)) * INTERVAL '1 minute'
              ))
              AND notification.read_at IS NULL
              AND notification.source_type NOT IN ('email', 'email_digest')
              AND subscription.disabled_at IS NULL
            ORDER BY delivery.updated_at ASC, delivery.notification_id, delivery.subscription_id
            LIMIT $1
          `,
          [genericLimit, validated.maxAttempts]
        )
      : { rows: [] }

    for (const candidate of genericCandidates.rows) {
      summary.processed += 1
      try {
        await sendFn(candidate, {
          title: 'DOMO NAV',
          body: '你有一条新的重要提醒，登录后查看完整内容。',
          tag: candidate.sensitive
            ? 'nav-sensitive-notification'
            : `notification-${candidate.notification_id}`,
          url: candidate.sensitive ? '/?notifications=1' : (candidate.action_url || '/?notifications=1'),
          icon: '/icons/cristsau-mark-192-v2.png',
          badge: '/icons/cristsau-badge-96-v2.png',
          timestamp: new Date(candidate.created_at).getTime()
        })
        await client.query(
          `UPDATE notification_push_deliveries
           SET status = 'delivered', attempt_count = attempt_count + 1,
               last_attempt_at = NOW(), delivered_at = NOW(),
               last_error_code = NULL, updated_at = NOW()
           WHERE notification_id = $1 AND subscription_id = $2`,
          [candidate.notification_id, candidate.subscription_id]
        )
        await client.query(
          `UPDATE web_push_subscriptions
           SET last_success_at = NOW(), failure_count = 0, updated_at = NOW()
           WHERE id = $1`,
          [candidate.subscription_id]
        )
        summary.delivered += 1
        summary.notificationDelivered += 1
      } catch (error) {
        const statusCode = Number(error?.statusCode || 0)
        const disabled = statusCode === 404 || statusCode === 410
        const errorCode = disabled
          ? `PUSH_ENDPOINT_${statusCode}`
          : sanitizeMaintenanceErrorCode(error)
        await client.query(
          `UPDATE notification_push_deliveries
           SET status = $3, attempt_count = attempt_count + 1,
               last_attempt_at = NOW(), last_error_code = $4, updated_at = NOW()
           WHERE notification_id = $1 AND subscription_id = $2`,
          [candidate.notification_id, candidate.subscription_id, disabled ? 'expired' : 'failed', errorCode]
        )
        await client.query(
          `UPDATE web_push_subscriptions
           SET failure_count = failure_count + 1, last_failure_at = NOW(),
               disabled_at = CASE WHEN $2 THEN NOW() ELSE disabled_at END,
               updated_at = NOW() WHERE id = $1`,
          [candidate.subscription_id, disabled]
        )
        summary.failed += 1
        if (disabled) summary.disabled += 1
      }
    }

    const reminderRemaining = await client.query(
      `
        SELECT COUNT(*)::integer AS count
        FROM note_reminder_push_deliveries
        WHERE status IN ('pending', 'failed')
          AND attempt_count < $1
      `,
      [validated.maxAttempts]
    )
    const notificationRemaining = await client.query(
      `SELECT COUNT(*)::integer AS count FROM notification_push_deliveries
       WHERE status IN ('pending', 'failed') AND attempt_count < $1`,
      [validated.maxAttempts]
    )
    summary.remaining = Number(reminderRemaining.rows[0]?.count || 0)
      + Number(notificationRemaining.rows[0]?.count || 0)
    return summary
  } catch (error) {
    primaryError = error
    throw error
  } finally {
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
    logger?.warn?.({ err: error }, 'web push delivery status could not be recorded')
  }
}

export function startWebPushScheduler({
  enabled,
  policy,
  poolInstance,
  logger,
  observer,
  deliveryFn = deliverDueWebPushNotifications,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateWebPushPolicy(policy)
  let stopped = false
  let timeoutHandle = null
  let intervalHandle = null
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
        logger?.error?.(error, 'web push delivery failed')
      })
      .finally(() => { activeRun = null })
    return activeRun
  }
  const intervalMs = validated.intervalSeconds * 1_000
  timeoutHandle = timerApi.setTimeout(() => {
    void run()
    intervalHandle = timerApi.setInterval(() => void run(), intervalMs)
    intervalHandle?.unref?.()
  }, Math.min(10_000, intervalMs))
  timeoutHandle?.unref?.()
  return async () => {
    stopped = true
    if (timeoutHandle) timerApi.clearTimeout(timeoutHandle)
    if (intervalHandle) timerApi.clearInterval(intervalHandle)
    if (activeRun) await activeRun
  }
}
