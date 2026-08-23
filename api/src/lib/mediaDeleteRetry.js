export const MEDIA_DELETE_RETRY_LOCK_SQL = `
  SELECT pg_try_advisory_lock(
    hashtext(current_database()),
    hashtext('nav_media_delete_retry')
  ) AS acquired
`

export const MEDIA_DELETE_RETRY_UNLOCK_SQL = `
  SELECT pg_advisory_unlock(
    hashtext(current_database()),
    hashtext('nav_media_delete_retry')
  ) AS released
`

export const SELECT_MEDIA_DELETE_RETRY_CANDIDATES_SQL = `
  SELECT
    id,
    user_id,
    delete_attempts,
    delete_requested_at,
    last_delete_attempt_at
  FROM media_assets
  WHERE retention = 'auto'
    AND state IN ('delete_pending', 'delete_failed')
    AND delete_attempts < $1
    AND (
      last_delete_attempt_at IS NULL
      OR last_delete_attempt_at <= CURRENT_TIMESTAMP - (
        LEAST(
          $3::numeric,
          $2::numeric * POWER(
            2,
            LEAST(GREATEST(delete_attempts - 1, 0), 20)
          )
        ) * INTERVAL '1 second'
      )
    )
  ORDER BY
    COALESCE(last_delete_attempt_at, delete_requested_at, created_at) ASC,
    id ASC
  LIMIT $4
`

export const SELECT_MEDIA_DELETE_RETRY_BACKLOG_SQL = `
  SELECT
    COUNT(*)::integer AS remaining,
    COUNT(*) FILTER (
      WHERE delete_attempts >= $1
    )::integer AS exhausted,
    COUNT(*) FILTER (
      WHERE delete_attempts < $1
        AND (
          last_delete_attempt_at IS NULL
          OR last_delete_attempt_at <= CURRENT_TIMESTAMP - (
            LEAST(
              $3::numeric,
              $2::numeric * POWER(
                2,
                LEAST(GREATEST(delete_attempts - 1, 0), 20)
              )
            ) * INTERVAL '1 second'
          )
        )
    )::integer AS eligible,
    COUNT(*) FILTER (
      WHERE delete_attempts < $1
        AND last_delete_attempt_at IS NOT NULL
        AND last_delete_attempt_at > CURRENT_TIMESTAMP - (
          LEAST(
            $3::numeric,
            $2::numeric * POWER(
              2,
              LEAST(GREATEST(delete_attempts - 1, 0), 20)
            )
          ) * INTERVAL '1 second'
        )
    )::integer AS deferred
  FROM media_assets
  WHERE retention = 'auto'
    AND state IN ('delete_pending', 'delete_failed')
`

const STARTUP_DELAY_MS = 30_000

async function notifyObserver(observer, method, payload, logger) {
  try {
    await observer?.[method]?.(payload)
  } catch (error) {
    logger?.warn?.(
      { err: error, observerMethod: method },
      'media-delete retry status could not be recorded'
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

export function validateMediaDeleteRetryPolicy({
  intervalSeconds,
  batchSize,
  maxAttempts,
  baseBackoffSeconds,
  maxBackoffSeconds
}) {
  const policy = {
    intervalSeconds: boundedInteger(intervalSeconds, 'intervalSeconds', {
      minimum: 300,
      maximum: 7 * 24 * 60 * 60
    }),
    batchSize: boundedInteger(batchSize, 'batchSize', {
      maximum: 100
    }),
    maxAttempts: boundedInteger(maxAttempts, 'maxAttempts', {
      maximum: 20
    }),
    baseBackoffSeconds: boundedInteger(
      baseBackoffSeconds,
      'baseBackoffSeconds',
      { minimum: 60, maximum: 86_400 }
    ),
    maxBackoffSeconds: boundedInteger(
      maxBackoffSeconds,
      'maxBackoffSeconds',
      { minimum: 60, maximum: 7 * 24 * 60 * 60 }
    )
  }

  if (policy.baseBackoffSeconds > policy.maxBackoffSeconds) {
    throw new TypeError('baseBackoffSeconds must not exceed maxBackoffSeconds')
  }
  return policy
}

function emptyResult(overrides = {}) {
  return {
    processed: 0,
    deleted: 0,
    failed: 0,
    referenced: 0,
    notPending: 0,
    errors: 0,
    remaining: 0,
    eligible: 0,
    deferred: 0,
    exhausted: 0,
    skipped: null,
    ...overrides
  }
}

function normalizeBacklogCount(value) {
  const count = Number(value || 0)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

export function mediaDeleteRetryFailureCode(result = {}) {
  if (normalizeBacklogCount(result.errors) > 0) {
    return 'MEDIA_DELETE_RETRY_ERROR'
  }
  if (normalizeBacklogCount(result.exhausted) > 0) {
    return 'MEDIA_DELETE_RETRY_EXHAUSTED'
  }
  if (normalizeBacklogCount(result.failed) > 0) {
    return 'MEDIA_DELETE_RETRY_FAILED'
  }
  return ''
}

export async function retryPendingMediaDeletions({
  poolInstance,
  policy,
  retryFn,
  onError
}) {
  const validatedPolicy = validateMediaDeleteRetryPolicy(policy)
  if (typeof poolInstance?.connect !== 'function') {
    throw new TypeError('poolInstance.connect is required')
  }
  if (typeof retryFn !== 'function') {
    throw new TypeError('retryFn is required')
  }

  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null

  try {
    const lockResult = await client.query(MEDIA_DELETE_RETRY_LOCK_SQL)
    lockAcquired = lockResult.rows[0]?.acquired === true
    if (!lockAcquired) return emptyResult({ skipped: 'already-running' })

    const candidatesResult = await client.query(
      SELECT_MEDIA_DELETE_RETRY_CANDIDATES_SQL,
      [
        validatedPolicy.maxAttempts,
        validatedPolicy.baseBackoffSeconds,
        validatedPolicy.maxBackoffSeconds,
        validatedPolicy.batchSize
      ]
    )
    const result = emptyResult()

    for (const candidate of candidatesResult.rows) {
      result.processed += 1
      try {
        const outcome = await retryFn({
          id: candidate.id,
          userId: candidate.user_id
        })
        if (outcome?.state === 'deleted') result.deleted += 1
        else if (outcome?.state === 'delete_failed') result.failed += 1
        else if (outcome?.state === 'referenced') result.referenced += 1
        else result.notPending += 1
      } catch (error) {
        result.errors += 1
        onError?.(error, candidate)
      }
    }

    const backlogResult = await client.query(
      SELECT_MEDIA_DELETE_RETRY_BACKLOG_SQL,
      [
        validatedPolicy.maxAttempts,
        validatedPolicy.baseBackoffSeconds,
        validatedPolicy.maxBackoffSeconds
      ]
    )
    const backlog = backlogResult.rows[0] || {}
    result.remaining = normalizeBacklogCount(backlog.remaining)
    result.eligible = normalizeBacklogCount(backlog.eligible)
    result.deferred = normalizeBacklogCount(backlog.deferred)
    result.exhausted = normalizeBacklogCount(backlog.exhausted)

    return result
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let unlockError = null
    if (lockAcquired) {
      try {
        await client.query(MEDIA_DELETE_RETRY_UNLOCK_SQL)
      } catch (error) {
        unlockError = error
      }
    }

    client.release(unlockError || undefined)
    if (!primaryError && unlockError) throw unlockError
  }
}

export function startMediaDeleteRetry({
  enabled,
  policy,
  poolInstance,
  retryFn,
  logger,
  observer,
  runFn = retryPendingMediaDeletions,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}

  const validatedPolicy = validateMediaDeleteRetryPolicy(policy)
  let stopped = false
  let timeoutHandle = null
  let intervalHandle = null
  let activeRun = null

  const run = () => {
    if (stopped || activeRun) return activeRun

    const startedAtMs = clock()

    activeRun = Promise.resolve()
      .then(() => runFn({
        poolInstance,
        policy: validatedPolicy,
        retryFn,
        onError(error, candidate) {
          logger?.error?.(
            { err: error, mediaAssetId: candidate?.id },
            'media delete retry failed unexpectedly'
          )
        }
      }))
      .then(async (result) => {
        const finishedAtMs = clock()
        const observation = {
          result,
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }
        const failureCode = mediaDeleteRetryFailureCode(result)
        if (failureCode) {
          const error = Object.assign(new Error(failureCode), { code: failureCode })
          await notifyObserver(observer, 'failed', { ...observation, error }, logger)
        } else if (Number(result?.remaining || 0) > 0) {
          await notifyObserver(observer, 'deferred', observation, logger)
        } else {
          await notifyObserver(observer, 'succeeded', observation, logger)
        }
        if (
          Number(result?.processed || 0) > 0
          || Number(result?.remaining || 0) > 0
          || failureCode
        ) {
          const log = failureCode
            ? logger?.warn
            : logger?.info
          log?.call(logger, result, 'media delete retry batch finished')
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
        logger?.error?.(error, 'failed to run media delete retry batch')
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
