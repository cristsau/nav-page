import { embedPendingWorkspaceDocuments } from './hybridWorkspaceSearch.js'
import { synchronizeWorkspaceSearchDocuments } from './workspaceSearchIndex.js'

const LOCK_SQL = `
  SELECT pg_try_advisory_lock(
    hashtext(current_database()),
    hashtext('nav_search_embedding_index')
  ) AS acquired
`
const UNLOCK_SQL = `
  SELECT pg_advisory_unlock(
    hashtext(current_database()),
    hashtext('nav_search_embedding_index')
  ) AS released
`
const MIN_INTERVAL_SECONDS = 60
const MAX_INTERVAL_SECONDS = 24 * 60 * 60
const MAX_BATCH_SIZE = 100

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

export function validateSearchEmbeddingPolicy({ intervalSeconds, batchSize }) {
  return {
    intervalSeconds: boundedInteger(
      intervalSeconds,
      'intervalSeconds',
      MIN_INTERVAL_SECONDS,
      MAX_INTERVAL_SECONDS
    ),
    batchSize: boundedInteger(batchSize, 'batchSize', 1, MAX_BATCH_SIZE)
  }
}

export async function runSearchEmbeddingIndex({ poolInstance, policy }) {
  const validated = validateSearchEmbeddingPolicy(policy)
  const client = await poolInstance.connect()
  let lockAcquired = false
  let primaryError = null
  try {
    const lock = await client.query(LOCK_SQL)
    lockAcquired = lock.rows[0]?.acquired === true
    if (!lockAcquired) return { indexed: 0, processed: 0, remaining: 0, skipped: 'already-running' }

    const users = await client.query(
      `SELECT id FROM users WHERE status = 'approved' ORDER BY id ASC`
    )
    let indexed = 0
    for (const user of users.rows) {
      const result = await synchronizeWorkspaceSearchDocuments({
        userId: user.id,
        poolInstance
      })
      indexed += result.changed
    }
    const embedded = await embedPendingWorkspaceDocuments({
      poolInstance,
      limit: validated.batchSize
    })
    return { indexed, ...embedded, skipped: null }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let unlockError = null
    if (lockAcquired) {
      try {
        await client.query(UNLOCK_SQL)
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
    logger?.warn?.({ err: error }, 'search embedding status could not be recorded')
  }
}

export function startSearchEmbeddingScheduler({
  enabled,
  policy,
  poolInstance,
  logger,
  observer,
  runFn = runSearchEmbeddingIndex,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateSearchEmbeddingPolicy(policy)
  let stopped = false
  let timeoutHandle = null
  let intervalHandle = null
  let activeRun = null

  const run = () => {
    if (stopped || activeRun) return activeRun
    const startedAtMs = clock()
    activeRun = Promise.resolve()
      .then(() => runFn({ poolInstance, policy: validated }))
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
        logger?.error?.(error, 'search embedding index failed')
      })
      .finally(() => { activeRun = null })
    return activeRun
  }

  const intervalMs = validated.intervalSeconds * 1_000
  timeoutHandle = timerApi.setTimeout(() => {
    void run()
    intervalHandle = timerApi.setInterval(() => void run(), intervalMs)
    intervalHandle?.unref?.()
  }, Math.min(15_000, intervalMs))
  timeoutHandle?.unref?.()

  return async () => {
    stopped = true
    if (timeoutHandle) timerApi.clearTimeout(timeoutHandle)
    if (intervalHandle) timerApi.clearInterval(intervalHandle)
    if (activeRun) await activeRun
  }
}
