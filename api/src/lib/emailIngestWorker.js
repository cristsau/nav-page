import { config } from '../config.js'
import { startEmailIngestScheduler } from './emailIngestScheduler.js'
import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'
import { tryAcquirePostgresAdvisoryLease } from './postgresAdvisoryLease.js'

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

function lockName(runtimeConfig) {
  const sourceKey = String(runtimeConfig.emailSourceKey || 'mail').trim().toLowerCase()
  const mailbox = String(runtimeConfig.imapMailbox || 'INBOX').normalize('NFKC').trim()
  return `nav_email_ingest:${sourceKey}:${mailbox}`
}

export function startEmailIngestWorker({
  enabled,
  policy,
  poolInstance,
  runtimeConfig = config,
  logger,
  observer,
  schedulerFactory = startEmailIngestScheduler,
  leaseFactory = tryAcquirePostgresAdvisoryLease,
  timerApi = globalThis,
  random = Math.random
}) {
  if (!enabled) return async () => {}
  const retryBaseMs = boundedInteger(policy?.leaseRetrySeconds, 15, 5, 300) * 1000
  let stopped = false
  let attemptPromise = null
  let retryTimer = null
  let lease = null
  let stopScheduler = null
  let generation = 0

  const scheduleRetry = () => {
    if (stopped || retryTimer) return
    const jitterMs = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * retryBaseMs)
    retryTimer = timerApi.setTimeout(() => {
      retryTimer = null
      void attemptLeadership()
    }, retryBaseMs + jitterMs)
    retryTimer?.unref?.()
  }

  const stopLeadership = async ({ releaseLease = true } = {}) => {
    const schedulerStop = stopScheduler
    const currentLease = lease
    stopScheduler = null
    lease = null
    if (schedulerStop) {
      try { await schedulerStop() } catch (error) {
        logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'email ingest scheduler could not stop cleanly')
      }
    }
    if (releaseLease && currentLease) {
      try { await currentLease.release() } catch (error) {
        logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'email ingest advisory lease could not be released cleanly')
      }
    }
  }

  const handleLeaseLoss = (token, error) => {
    if (stopped || token !== generation) return
    logger?.error?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'email ingest advisory lease was lost')
    void stopLeadership({ releaseLease: false }).finally(scheduleRetry)
  }

  const attemptLeadership = () => {
    if (stopped || attemptPromise || lease) return attemptPromise
    const token = ++generation
    attemptPromise = Promise.resolve()
      .then(() => leaseFactory({
        poolInstance,
        name: lockName(runtimeConfig),
        onLost: (error) => handleLeaseLoss(token, error)
      }))
      .then(async (acquiredLease) => {
        if (stopped || token !== generation) {
          await acquiredLease?.release?.()
          return
        }
        if (!acquiredLease) {
          logger?.info?.({ sourceKey: runtimeConfig.emailSourceKey }, 'email ingest worker is standing by for the advisory lease')
          scheduleRetry()
          return
        }
        lease = acquiredLease
        try {
          stopScheduler = schedulerFactory({
            enabled: true,
            policy,
            poolInstance,
            runtimeConfig,
            logger,
            observer
          })
          if (typeof stopScheduler !== 'function') throw new TypeError('Email ingest scheduler must return a stop function')
          logger?.info?.({ sourceKey: runtimeConfig.emailSourceKey }, 'email ingest worker acquired the advisory lease')
        } catch (error) {
          await stopLeadership()
          throw error
        }
      })
      .catch((error) => {
        logger?.error?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'email ingest worker leadership attempt failed')
        scheduleRetry()
      })
      .finally(() => { attemptPromise = null })
    return attemptPromise
  }

  void attemptLeadership()
  return async () => {
    stopped = true
    generation += 1
    if (retryTimer) timerApi.clearTimeout(retryTimer)
    retryTimer = null
    if (attemptPromise) await attemptPromise
    await stopLeadership()
  }
}
