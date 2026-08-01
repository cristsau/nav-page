import { createHmac } from 'node:crypto'
import { config } from '../config.js'

const DEFAULT_DEVELOPMENT_SECRET = 'nav-development-only-rate-limit-key-v1'
const DEFAULT_CLEANUP_EVERY = 256
const DEFAULT_CLEANUP_BATCH_SIZE = 200
const MAX_COUNTER_VALUE = 2_147_483_647

let consumeOperations = 0
let cleanupPromise = null

export class RateLimitUnavailableError extends Error {
  constructor(message = 'Persistent rate limiting is unavailable', options = {}) {
    super(message, options)
    this.name = 'RateLimitUnavailableError'
    this.code = 'RATE_LIMIT_UNAVAILABLE'
  }
}

function normalizeText(value) {
  return String(value ?? '').trim()
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function resolveDigestSecret({
  secret = config.rateLimitKeySecret,
  nodeEnv = config.nodeEnv
} = {}) {
  const normalized = normalizeText(secret)

  if (normalized.length >= 32) {
    return normalized
  }

  if (String(nodeEnv || '').toLowerCase() === 'production') {
    throw new RateLimitUnavailableError(
      'NAV_RATE_LIMIT_KEY_SECRET must contain at least 32 characters in production'
    )
  }

  return DEFAULT_DEVELOPMENT_SECRET
}

export function validatePersistentRateLimitConfiguration(options = {}) {
  resolveDigestSecret(options)
  return true
}

export function digestSensitiveValue(namespace, value, options = {}) {
  const normalizedNamespace = normalizeText(namespace).toLowerCase()
  const normalizedValue = normalizeText(value).toLowerCase()

  if (!normalizedNamespace || !normalizedValue) return ''

  return createHmac('sha256', resolveDigestSecret(options))
    .update(`${normalizedNamespace}\u0000${normalizedValue}`)
    .digest('hex')
}

export const CONSUME_RATE_LIMIT_SQL = `
  WITH consumed AS (
    INSERT INTO rate_limit_buckets (
      scope,
      key_digest,
      window_started_at,
      window_expires_at,
      request_count,
      updated_at
    ) VALUES (
      $1,
      $2,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP + ($3::bigint * INTERVAL '1 millisecond'),
      1,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (scope, key_digest) DO UPDATE
    SET request_count = CASE
          WHEN rate_limit_buckets.window_expires_at <= CURRENT_TIMESTAMP THEN 1
          ELSE LEAST(
            rate_limit_buckets.request_count::bigint + 1,
            ${MAX_COUNTER_VALUE}
          )::integer
        END,
        window_started_at = CASE
          WHEN rate_limit_buckets.window_expires_at <= CURRENT_TIMESTAMP
            THEN CURRENT_TIMESTAMP
          ELSE rate_limit_buckets.window_started_at
        END,
        window_expires_at = CASE
          WHEN rate_limit_buckets.window_expires_at <= CURRENT_TIMESTAMP
            THEN CURRENT_TIMESTAMP + ($3::bigint * INTERVAL '1 millisecond')
          ELSE rate_limit_buckets.window_expires_at
        END,
        updated_at = CURRENT_TIMESTAMP
    RETURNING request_count, window_expires_at
  )
  SELECT
    request_count,
    window_expires_at,
    GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (window_expires_at - CURRENT_TIMESTAMP)))::integer
    ) AS retry_after_seconds
  FROM consumed
`

export const CLEANUP_RATE_LIMIT_SQL = `
  WITH expired AS (
    SELECT scope, key_digest, window_expires_at
    FROM rate_limit_buckets
    WHERE window_expires_at <= CURRENT_TIMESTAMP
    ORDER BY window_expires_at ASC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM rate_limit_buckets AS bucket
  USING expired
  WHERE bucket.scope = expired.scope
    AND bucket.key_digest = expired.key_digest
    AND bucket.window_expires_at = expired.window_expires_at
`

export async function cleanupExpiredRateLimitBuckets(queryFn, {
  batchSize = DEFAULT_CLEANUP_BATCH_SIZE
} = {}) {
  if (typeof queryFn !== 'function') {
    throw new TypeError('queryFn is required')
  }

  return queryFn(
    CLEANUP_RATE_LIMIT_SQL,
    [positiveInteger(batchSize, DEFAULT_CLEANUP_BATCH_SIZE)]
  )
}

function scheduleOpportunityCleanup(queryFn, {
  cleanupEvery = DEFAULT_CLEANUP_EVERY,
  cleanupBatchSize = DEFAULT_CLEANUP_BATCH_SIZE,
  onCleanupError
} = {}) {
  const interval = positiveInteger(cleanupEvery, DEFAULT_CLEANUP_EVERY)
  consumeOperations += 1

  if (consumeOperations % interval !== 0 || cleanupPromise) return

  cleanupPromise = cleanupExpiredRateLimitBuckets(queryFn, {
    batchSize: cleanupBatchSize
  })
    .catch((error) => {
      if (typeof onCleanupError === 'function') {
        onCleanupError(error)
      }
    })
    .finally(() => {
      cleanupPromise = null
    })
}

export async function consumePersistentRateLimit(rawKey, {
  scope,
  limit,
  windowMs,
  queryFn,
  secret,
  nodeEnv,
  cleanupEvery,
  cleanupBatchSize,
  onCleanupError
} = {}) {
  if (typeof queryFn !== 'function') {
    throw new TypeError('queryFn is required')
  }

  const normalizedScope = normalizeText(scope).toLowerCase()
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(normalizedScope)) {
    throw new TypeError('A valid rate-limit scope is required')
  }

  const normalizedKey = normalizeText(rawKey).toLowerCase() || 'unknown'
  const boundedLimit = positiveInteger(limit, 1)
  const boundedWindowMs = positiveInteger(windowMs, 60_000)
  let keyDigest

  try {
    keyDigest = digestSensitiveValue(
      `rate-limit:${normalizedScope}`,
      normalizedKey,
      { secret, nodeEnv }
    )
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) throw error
    throw new RateLimitUnavailableError(undefined, { cause: error })
  }

  let result
  try {
    result = await queryFn(
      CONSUME_RATE_LIMIT_SQL,
      [normalizedScope, keyDigest, boundedWindowMs]
    )
  } catch (error) {
    throw new RateLimitUnavailableError(undefined, { cause: error })
  }

  const row = result?.rows?.[0]
  const count = Number(row?.request_count)
  const retryAfterSeconds = positiveInteger(row?.retry_after_seconds, 1)
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new RateLimitUnavailableError('Persistent rate limiter returned an invalid result')
  }

  scheduleOpportunityCleanup(queryFn, {
    cleanupEvery,
    cleanupBatchSize,
    onCleanupError
  })

  return {
    allowed: count <= boundedLimit,
    remaining: Math.max(0, boundedLimit - count),
    retryAfterSeconds: count <= boundedLimit ? 0 : retryAfterSeconds,
    resetAt: row.window_expires_at
  }
}

export function isRateLimitUnavailableError(error) {
  return Boolean(
    error instanceof RateLimitUnavailableError
    || error?.code === 'RATE_LIMIT_UNAVAILABLE'
  )
}
