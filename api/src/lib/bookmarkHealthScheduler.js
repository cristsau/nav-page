import { buildBookmarkHealthState, probeBookmarkUrl } from './bookmarkHealth.js'

export const BOOKMARK_HEALTH_JOB_LOCK_SQL = `
  SELECT pg_try_advisory_lock(
    hashtext(current_database()),
    hashtext('nav_bookmark_health_check')
  ) AS acquired
`

export const BOOKMARK_HEALTH_JOB_UNLOCK_SQL = `
  SELECT pg_advisory_unlock(
    hashtext(current_database()),
    hashtext('nav_bookmark_health_check')
  ) AS released
`

const MIN_INTERVAL_SECONDS = 300
const MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60
const MAX_BATCH_SIZE = 100
const MAX_STALE_HOURS = 24 * 365
const MAX_CONCURRENCY = 6
const STARTUP_DELAY_MS = 30_000

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

export function validateBookmarkHealthSchedulerPolicy({
  intervalSeconds,
  batchSize,
  staleHours,
  concurrency
}) {
  return {
    intervalSeconds: boundedInteger(
      intervalSeconds,
      'intervalSeconds',
      MIN_INTERVAL_SECONDS,
      MAX_INTERVAL_SECONDS
    ),
    batchSize: boundedInteger(batchSize, 'batchSize', 1, MAX_BATCH_SIZE),
    staleHours: boundedInteger(staleHours, 'staleHours', 1, MAX_STALE_HOURS),
    concurrency: boundedInteger(concurrency, 'concurrency', 1, MAX_CONCURRENCY)
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    () => worker()
  ))
  return results
}

async function notifyObserver(observer, method, payload, logger) {
  try {
    await observer?.[method]?.(payload)
  } catch (error) {
    logger?.warn?.(
      { err: error, observerMethod: method },
      'bookmark health job status could not be recorded'
    )
  }
}

export async function runScheduledBookmarkHealthCheck({
  poolInstance,
  policy,
  probeFn = probeBookmarkUrl
}) {
  const validated = validateBookmarkHealthSchedulerPolicy(policy)
  if (typeof poolInstance?.connect !== 'function') {
    throw new TypeError('poolInstance.connect is required')
  }

  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null
  try {
    const lock = await client.query(BOOKMARK_HEALTH_JOB_LOCK_SQL)
    lockAcquired = lock.rows[0]?.acquired === true
    if (!lockAcquired) {
      return {
        checked: 0,
        broken: 0,
        suspect: 0,
        unsupported: 0,
        reachable: 0,
        skipped: 'already-running'
      }
    }

    const candidates = await client.query(
      `
        SELECT
          id,
          user_id,
          url,
          health_failure_count,
          health_checked_at
        FROM nav_bookmarks
        WHERE health_checked_at IS NULL
           OR health_checked_at <= NOW() - ($2::integer * INTERVAL '1 hour')
        ORDER BY health_checked_at ASC NULLS FIRST, id ASC
        LIMIT $1
      `,
      [validated.batchSize, validated.staleHours]
    )

    const probes = await mapWithConcurrency(
      candidates.rows,
      validated.concurrency,
      async (bookmark) => ({
        bookmark,
        probe: await probeFn(bookmark.url)
      })
    )

    const summary = {
      checked: 0,
      broken: 0,
      suspect: 0,
      unsupported: 0,
      reachable: 0,
      skipped: null
    }
    for (const { bookmark, probe } of probes) {
      const health = buildBookmarkHealthState(probe, bookmark.health_failure_count)
      const update = await client.query(
        `
          UPDATE nav_bookmarks
          SET health_status = $4,
              health_http_status = $5,
              health_checked_at = NOW(),
              health_failure_count = $6,
              health_error_code = $7
          WHERE id = $1
            AND user_id = $2
            AND url = $3
            AND health_checked_at IS NOT DISTINCT FROM $8::timestamptz
        `,
        [
          bookmark.id,
          bookmark.user_id,
          bookmark.url,
          health.healthStatus,
          health.healthHttpStatus,
          health.healthFailureCount,
          health.healthErrorCode,
          bookmark.health_checked_at
        ]
      )
      if (!update.rowCount) continue
      summary.checked += 1
      if (health.healthStatus === 'broken') summary.broken += 1
      else if (health.healthStatus === 'suspect') summary.suspect += 1
      else if (health.healthStatus === 'unsupported') summary.unsupported += 1
      else summary.reachable += 1
    }

    return summary
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let unlockError = null
    if (lockAcquired) {
      try {
        await client.query(BOOKMARK_HEALTH_JOB_UNLOCK_SQL)
      } catch (error) {
        unlockError = error
      }
    }
    client.release(unlockError || undefined)
    if (!primaryError && unlockError) throw unlockError
  }
}

export function startBookmarkHealthScheduler({
  enabled,
  policy,
  poolInstance,
  logger,
  observer,
  checkFn = runScheduledBookmarkHealthCheck,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateBookmarkHealthSchedulerPolicy(policy)
  let stopped = false
  let timeoutHandle = null
  let intervalHandle = null
  let activeRun = null

  const run = () => {
    if (stopped || activeRun) return activeRun
    const startedAtMs = clock()
    activeRun = Promise.resolve()
      .then(() => checkFn({ poolInstance, policy: validated }))
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
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        logger?.error?.(error, 'scheduled bookmark health check failed')
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
