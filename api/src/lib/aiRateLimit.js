export const AI_RATE_LIMIT_WINDOW_MS = 60_000
export const AI_RATE_LIMIT_MAX_REQUESTS = 10

const requestWindows = new Map()

export function consumeAiRateLimit(userId, now = Date.now()) {
  const key = String(userId || '').trim()
  if (!key) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(AI_RATE_LIMIT_WINDOW_MS / 1000)
    }
  }

  const existing = requestWindows.get(key)
  const windowRecord = !existing || now - existing.startedAt >= AI_RATE_LIMIT_WINDOW_MS
    ? { startedAt: now, count: 0 }
    : existing

  windowRecord.count += 1
  requestWindows.set(key, windowRecord)

  return {
    allowed: windowRecord.count <= AI_RATE_LIMIT_MAX_REQUESTS,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowRecord.startedAt + AI_RATE_LIMIT_WINDOW_MS - now) / 1000)
    )
  }
}

export function resetAiRateLimitForTests() {
  requestWindows.clear()
}
