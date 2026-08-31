const DEFAULT_ALERT_AFTER_MS = 60_000

function boundedCount(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}
export function createMailWorkerPoolHealthMonitor({
  alertAfterMs = DEFAULT_ALERT_AFTER_MS,
  now = () => Date.now()
} = {}) {
  const threshold = Number(alertAfterMs)
  if (!Number.isSafeInteger(threshold) || threshold < 30_000 || threshold > 600_000) {
    throw new TypeError('mail worker pool wait alert threshold must be 30000-600000ms')
  }

  let waitingSinceMs = null
  let alertOpen = false

  return {
    sample(poolInstance) {
      const sampledAtMs = Number(now())
      const waitingCount = boundedCount(poolInstance?.waitingCount)
      const totalCount = boundedCount(poolInstance?.totalCount)
      const idleCount = Math.min(totalCount, boundedCount(poolInstance?.idleCount))

      if (waitingCount === 0) waitingSinceMs = null
      else if (waitingSinceMs === null) waitingSinceMs = sampledAtMs

      const waitingDurationMs = waitingSinceMs === null
        ? 0
        : Math.max(0, sampledAtMs - waitingSinceMs)
      const alerting = waitingCount > 0 && waitingDurationMs >= threshold
      const transition = alerting && !alertOpen
        ? 'alert'
        : (!alerting && alertOpen ? 'recovery' : null)
      alertOpen = alerting

      return {
        sampledAt: new Date(sampledAtMs).toISOString(),
        totalCount,
        idleCount,
        waitingCount,
        waitingSince: waitingSinceMs === null
          ? null
          : new Date(waitingSinceMs).toISOString(),
        waitingDurationMs,
        alertAfterMs: threshold,
        alerting,
        transition
      }
    }
  }
}
