export const AI_USAGE_RETENTION_LOCK_SQL = `
  SELECT pg_try_advisory_lock(
    hashtext(current_database()),
    hashtext('nav_ai_usage_retention')
  ) AS acquired
`

export const AI_USAGE_RETENTION_UNLOCK_SQL = `
  SELECT pg_advisory_unlock(
    hashtext(current_database()),
    hashtext('nav_ai_usage_retention')
  ) AS released
`

export const DELETE_EXPIRED_AI_USAGE_SQL = `
  WITH candidates AS (
    SELECT usage_date, user_id, feature, provider, model, api_mode
    FROM ai_usage_daily
    WHERE usage_date < CURRENT_DATE - $1::integer
    ORDER BY usage_date ASC, user_id ASC, feature ASC, provider ASC, model ASC, api_mode ASC
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM ai_usage_daily AS usage
  USING candidates
  WHERE usage.usage_date = candidates.usage_date
    AND usage.user_id = candidates.user_id
    AND usage.feature = candidates.feature
    AND usage.provider = candidates.provider
    AND usage.model = candidates.model
    AND usage.api_mode = candidates.api_mode
`

const MAX_RETENTION_DAYS = 3_650
const MAX_BATCH_SIZE = 5_000
const MAX_BATCHES_PER_RUN = 100
const MIN_INTERVAL_SECONDS = 300
const STARTUP_DELAY_MS = 30_000

function boundedInteger(value, name, { minimum = 1, maximum }) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

export function validateAiUsageRetentionPolicy({
  retentionDays,
  batchSize,
  maxBatchesPerRun,
  intervalSeconds
}) {
  return {
    retentionDays: boundedInteger(retentionDays, 'retentionDays', {
      maximum: MAX_RETENTION_DAYS
    }),
    batchSize: boundedInteger(batchSize, 'batchSize', {
      maximum: MAX_BATCH_SIZE
    }),
    maxBatchesPerRun: boundedInteger(maxBatchesPerRun, 'maxBatchesPerRun', {
      maximum: MAX_BATCHES_PER_RUN
    }),
    intervalSeconds: boundedInteger(intervalSeconds, 'intervalSeconds', {
      minimum: MIN_INTERVAL_SECONDS,
      maximum: 7 * 24 * 60 * 60
    })
  }
}

export async function pruneExpiredAiUsage({ poolInstance, policy }) {
  const validated = validateAiUsageRetentionPolicy(policy)
  if (typeof poolInstance?.connect !== 'function') {
    throw new TypeError('poolInstance.connect is required')
  }

  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null

  try {
    const lockResult = await client.query(AI_USAGE_RETENTION_LOCK_SQL)
    lockAcquired = lockResult.rows[0]?.acquired === true
    if (!lockAcquired) {
      return { deletedCount: 0, batches: 0, skipped: 'already-running' }
    }

    let deletedCount = 0
    let batches = 0
    for (let batch = 0; batch < validated.maxBatchesPerRun; batch += 1) {
      const result = await client.query(DELETE_EXPIRED_AI_USAGE_SQL, [
        validated.retentionDays,
        validated.batchSize
      ])
      const deleted = Number(result.rowCount || 0)
      deletedCount += deleted
      batches += 1
      if (deleted < validated.batchSize) break
    }

    return { deletedCount, batches, skipped: null }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let unlockError = null
    if (lockAcquired) {
      try {
        await client.query(AI_USAGE_RETENTION_UNLOCK_SQL)
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
      'AI usage retention status could not be recorded'
    )
  }
}

export function startAiUsageRetention({
  enabled,
  policy,
  poolInstance,
  logger,
  observer,
  pruneFn = pruneExpiredAiUsage,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateAiUsageRetentionPolicy(policy)
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
        if (result?.deletedCount > 0) {
          logger?.info?.(
            { deletedCount: result.deletedCount, batches: result.batches },
            'expired AI usage aggregates pruned'
          )
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
        logger?.error?.(error, 'failed to prune expired AI usage aggregates')
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
