export const SECURITY_EVENT_RETENTION_LOCK_SQL = `
  SELECT pg_try_advisory_lock(
    hashtext(current_database()),
    hashtext('nav_security_event_retention')
  ) AS acquired
`

export const SECURITY_EVENT_RETENTION_UNLOCK_SQL = `
  SELECT pg_advisory_unlock(
    hashtext(current_database()),
    hashtext('nav_security_event_retention')
  ) AS released
`

export const DELETE_EXPIRED_SECURITY_EVENTS_SQL = `
  WITH candidates AS (
    SELECT id
    FROM security_events
    WHERE created_at < CURRENT_TIMESTAMP - (
      CASE
        WHEN event_type = 'auth.login'
          AND outcome IN ('failure', 'denied')
          THEN $2::integer
        WHEN event_type IN ('auth.login', 'auth.logout')
          AND outcome = 'success'
          THEN $1::integer
        ELSE $3::integer
      END * INTERVAL '1 day'
    )
    ORDER BY created_at ASC, id ASC
    LIMIT $4
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM security_events AS event
  USING candidates
  WHERE event.id = candidates.id
`

const MAX_RETENTION_DAYS = 3_650
const MAX_BATCH_SIZE = 5_000
const MAX_BATCHES_PER_RUN = 100
const MIN_INTERVAL_SECONDS = 300
const STARTUP_DELAY_MS = 30_000

async function notifyObserver(observer, method, payload, logger) {
  try {
    await observer?.[method]?.(payload)
  } catch (error) {
    logger?.warn?.(
      { err: error, observerMethod: method },
      'security-event retention status could not be recorded'
    )
  }
}

function boundedInteger(value, name, { minimum = 1, maximum }) {
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

export function validateSecurityEventRetentionPolicy({
  routineDays,
  deniedDays,
  criticalDays,
  batchSize,
  maxBatchesPerRun,
  intervalSeconds
}) {
  const policy = {
    routineDays: boundedInteger(routineDays, 'routineDays', {
      maximum: MAX_RETENTION_DAYS
    }),
    deniedDays: boundedInteger(deniedDays, 'deniedDays', {
      maximum: MAX_RETENTION_DAYS
    }),
    criticalDays: boundedInteger(criticalDays, 'criticalDays', {
      maximum: MAX_RETENTION_DAYS
    }),
    batchSize: boundedInteger(batchSize, 'batchSize', {
      maximum: MAX_BATCH_SIZE
    }),
    maxBatchesPerRun: boundedInteger(
      maxBatchesPerRun,
      'maxBatchesPerRun',
      { maximum: MAX_BATCHES_PER_RUN }
    ),
    intervalSeconds: boundedInteger(intervalSeconds, 'intervalSeconds', {
      minimum: MIN_INTERVAL_SECONDS,
      maximum: 7 * 24 * 60 * 60
    })
  }

  if (
    policy.routineDays > policy.deniedDays
    || policy.deniedDays > policy.criticalDays
  ) {
    throw new TypeError(
      'retention days must satisfy routineDays <= deniedDays <= criticalDays'
    )
  }

  return policy
}

export async function pruneExpiredSecurityEvents({ poolInstance, policy }) {
  const validatedPolicy = validateSecurityEventRetentionPolicy(policy)
  if (typeof poolInstance?.connect !== 'function') {
    throw new TypeError('poolInstance.connect is required')
  }

  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null

  try {
    const lockResult = await client.query(SECURITY_EVENT_RETENTION_LOCK_SQL)
    lockAcquired = lockResult.rows[0]?.acquired === true
    if (!lockAcquired) {
      return { deletedCount: 0, batches: 0, skipped: 'already-running' }
    }

    let deletedCount = 0
    let batches = 0
    for (
      let batch = 0;
      batch < validatedPolicy.maxBatchesPerRun;
      batch += 1
    ) {
      const result = await client.query(
        DELETE_EXPIRED_SECURITY_EVENTS_SQL,
        [
          validatedPolicy.routineDays,
          validatedPolicy.deniedDays,
          validatedPolicy.criticalDays,
          validatedPolicy.batchSize
        ]
      )
      const deletedInBatch = Number(result.rowCount || 0)
      deletedCount += deletedInBatch
      batches += 1
      if (deletedInBatch < validatedPolicy.batchSize) break
    }

    return { deletedCount, batches, skipped: null }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let unlockError = null
    if (lockAcquired) {
      try {
        await client.query(SECURITY_EVENT_RETENTION_UNLOCK_SQL)
      } catch (error) {
        unlockError = error
      }
    }

    client.release(unlockError || undefined)
    if (!primaryError && unlockError) throw unlockError
  }
}

export function startSecurityEventRetention({
  enabled,
  policy,
  poolInstance,
  logger,
  observer,
  pruneFn = pruneExpiredSecurityEvents,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}

  const validatedPolicy = validateSecurityEventRetentionPolicy(policy)
  let stopped = false
  let timeoutHandle = null
  let intervalHandle = null
  let activeRun = null

  const run = () => {
    if (stopped || activeRun) return activeRun

    const startedAtMs = clock()

    activeRun = Promise.resolve()
      .then(() => pruneFn({ poolInstance, policy: validatedPolicy }))
      .then(async (result) => {
        const finishedAtMs = clock()
        await notifyObserver(observer, 'succeeded', {
          result,
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        if (result?.deletedCount > 0) {
          logger?.info?.(
            { deletedCount: result.deletedCount, batches: result.batches },
            'expired security events pruned'
          )
        }
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
        logger?.error?.(error, 'failed to prune expired security events')
      })
      .finally(() => {
        activeRun = null
      })

    return activeRun
  }

  const intervalMs = validatedPolicy.intervalSeconds * 1_000
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
