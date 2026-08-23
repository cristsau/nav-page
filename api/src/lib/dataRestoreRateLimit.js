import {
  consumePersistentRateLimit,
  isRateLimitUnavailableError
} from './persistentRateLimit.js'

export const DATA_RESTORE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
export const DATA_RESTORE_RATE_LIMIT_MAX_REQUESTS = 12

export async function consumeDataRestoreRateLimit(request, {
  queryFn,
  secret,
  onCleanupError
} = {}) {
  const userId = String(request?.currentUser?.id || '').trim()
  const sessionId = String(request?.session?.id || '').trim()
  if (!userId || !sessionId) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(DATA_RESTORE_RATE_LIMIT_WINDOW_MS / 1000)
    }
  }

  const effectiveQueryFn = typeof queryFn === 'function'
    ? queryFn
    : (await import('../db/index.js')).query

  return consumePersistentRateLimit(`user:${userId}:session:${sessionId}`, {
    scope: 'data_restore',
    limit: DATA_RESTORE_RATE_LIMIT_MAX_REQUESTS,
    windowMs: DATA_RESTORE_RATE_LIMIT_WINDOW_MS,
    queryFn: effectiveQueryFn,
    secret,
    onCleanupError
  })
}

export async function enforceDataRestoreRateLimit(request, reply, options = {}) {
  let result
  try {
    result = await consumeDataRestoreRateLimit(request, {
      ...options,
      onCleanupError: options.onCleanupError || ((error) => {
        request?.log?.error?.(error, 'failed to clean expired data-restore rate-limit buckets')
      })
    })
  } catch (error) {
    if (!isRateLimitUnavailableError(error)) throw error
    request?.log?.error?.(error, 'persistent data-restore rate limiter unavailable')
    reply.code(503)
    return { error: '数据恢复保护暂时不可用，请稍后再试' }
  }

  if (result.allowed) return null
  reply.header('Retry-After', String(result.retryAfterSeconds))
  reply.code(429)
  return { error: '数据恢复操作过于频繁，请稍后再试' }
}
