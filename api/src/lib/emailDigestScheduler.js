import { createNotification } from './notifications.js'

const LOCK_SQL = `SELECT pg_try_advisory_lock(hashtext(current_database()), hashtext('nav_email_digest')) AS acquired`
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtext(current_database()), hashtext('nav_email_digest')) AS released`

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function validateEmailDigestPolicy(policy = {}) {
  const hours = [...new Set((policy.hours || []).map(Number).filter((value) => Number.isSafeInteger(value) && value >= 0 && value <= 23))]
  return {
    intervalSeconds: boundedInteger(policy.intervalSeconds, 60, 30, 3600),
    hours: hours.length ? hours.sort((a, b) => a - b) : [12, 20],
    timeZone: String(policy.timeZone || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    batchSize: boundedInteger(policy.batchSize, 50, 1, 100)
  }
}

export function digestClock(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour)
  }
}

export async function generateEmailDigests({ poolInstance, policy, now = new Date() }) {
  const validated = validateEmailDigestPolicy(policy)
  const clock = digestClock(now, validated.timeZone)
  if (!validated.hours.includes(clock.hour)) {
    return { generated: 0, emails: 0, remaining: 0, skipped: 'outside-window' }
  }
  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null
  try {
    const lock = await client.query(LOCK_SQL)
    lockAcquired = lock.rows[0]?.acquired === true
    if (!lockAcquired) return { generated: 0, emails: 0, remaining: 0, skipped: 'already-running' }

    const users = await client.query(
      `SELECT DISTINCT user_id FROM email_events
       WHERE COALESCE(notification_action, CASE WHEN tier = 2 THEN 'digest' ELSE 'silent' END) = 'digest'
         AND digested_at IS NULL AND duplicate_of IS NULL
       ORDER BY user_id`
    )
    const summary = { generated: 0, emails: 0, remaining: 0, skipped: null }
    for (const user of users.rows) {
      const events = await client.query(
        `SELECT id FROM email_events
         WHERE user_id = $1
           AND COALESCE(notification_action, CASE WHEN tier = 2 THEN 'digest' ELSE 'silent' END) = 'digest'
           AND digested_at IS NULL AND duplicate_of IS NULL
         ORDER BY received_at ASC, id ASC LIMIT $2`,
        [user.user_id, validated.batchSize]
      )
      const ids = events.rows.map((row) => String(row.id))
      if (!ids.length) continue
      const digestKey = `${clock.date}-${clock.hour}-${ids[0]}`
      await client.query('BEGIN')
      try {
        await createNotification({
          userId: user.user_id,
          eventType: 'email.digest',
          title: '今日邮件摘要',
          summary: `有 ${ids.length} 封邮件建议今天核对；完整内容仅在登录后显示。`,
          sourceType: 'email_digest',
          sourceId: digestKey,
          actionUrl: '/assistant?view=email',
          // A busy mailbox may need more than one bounded batch during the
          // same hour. Including the first event keeps every batch idempotent
          // without silently marking later events as digested by an old row.
          dedupeKey: `email-digest:${digestKey}`,
          sensitive: true,
          pushEnabled: true,
          metadata: { emailEventIds: ids, digestDate: clock.date, digestHour: clock.hour },
          queryFn: client.query.bind(client)
        })
        await client.query(
          `UPDATE email_events SET digested_at = NOW(), updated_at = NOW()
           WHERE user_id = $1 AND id = ANY($2::uuid[])`,
          [user.user_id, ids]
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
      summary.generated += 1
      summary.emails += ids.length
    }
    const remaining = await client.query(
      `SELECT COUNT(*)::integer AS count FROM email_events
       WHERE COALESCE(notification_action, CASE WHEN tier = 2 THEN 'digest' ELSE 'silent' END) = 'digest'
         AND digested_at IS NULL AND duplicate_of IS NULL`
    )
    summary.remaining = Number(remaining.rows[0]?.count || 0)
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
    logger?.warn?.({ err: error }, 'email digest status could not be recorded')
  }
}

export function startEmailDigestScheduler({
  enabled,
  policy,
  poolInstance,
  logger,
  observer,
  digestFn = generateEmailDigests,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateEmailDigestPolicy(policy)
  let stopped = false
  let timer = null
  let activeRun = null
  const run = () => {
    if (stopped || activeRun) return activeRun
    const startedAtMs = clock()
    activeRun = Promise.resolve()
      .then(() => digestFn({ poolInstance, policy: validated, now: new Date(startedAtMs) }))
      .then(async (result) => {
        const finishedAtMs = clock()
        if (!result?.skipped) {
          await notifyObserver(observer, 'succeeded', {
            result,
            startedAt: new Date(startedAtMs),
            finishedAt: new Date(finishedAtMs),
            durationMs: Math.max(0, finishedAtMs - startedAtMs)
          }, logger)
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
        logger?.error?.({ err: error }, 'email digest generation failed')
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
