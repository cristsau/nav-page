import { query } from '../db/index.js'
import {
  consumePersistentRateLimit,
  isRateLimitUnavailableError
} from './persistentRateLimit.js'

export const AI_RATE_LIMIT_WINDOW_MS = 60_000
export const AI_RATE_LIMIT_MAX_REQUESTS = 10

export async function consumeAiRateLimit(userId, {
  queryFn = query,
  onCleanupError,
  secret
} = {}) {
  const key = String(userId || '').trim()
  if (!key) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(AI_RATE_LIMIT_WINDOW_MS / 1000)
    }
  }

  return consumePersistentRateLimit(`user:${key}`, {
    scope: 'ai_requests',
    limit: AI_RATE_LIMIT_MAX_REQUESTS,
    windowMs: AI_RATE_LIMIT_WINDOW_MS,
    queryFn,
    onCleanupError,
    secret
  })
}

export async function enforceAiRateLimit(request, reply, {
  deniedError = 'AI 请求过于频繁，请稍后再试',
  queryFn = query,
  onCleanupError,
  secret
} = {}) {
  let rateLimit
  try {
    rateLimit = await consumeAiRateLimit(request?.currentUser?.id, {
      queryFn,
      secret,
      onCleanupError: onCleanupError || ((error) => {
        request?.log?.error?.(error, 'failed to clean expired AI rate-limit buckets')
      })
    })
  } catch (error) {
    if (!isRateLimitUnavailableError(error)) throw error

    request?.log?.error?.(error, 'persistent AI rate limiter unavailable')
    reply.code(503)
    return {
      error: 'AI rate limiting is temporarily unavailable'
    }
  }

  if (rateLimit.allowed) return null

  reply.header('Retry-After', String(rateLimit.retryAfterSeconds))
  reply.code(429)
  return { error: deniedError }
}
