import { createHash } from 'node:crypto'
import net from 'node:net'
import { config } from '../config.js'

const DEFAULT_MAX_KEYS = 10_000
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const PUBLIC_AUTH_LIMITS = Object.freeze({
  login: () => ({
    limit: config.authLoginRateLimitMax,
    windowMs: config.authLoginRateLimitWindowSeconds * 1000
  }),
  register: () => ({
    limit: config.authRegisterRateLimitMax,
    windowMs: config.authRegisterRateLimitWindowSeconds * 1000
  }),
  recovery: () => ({
    limit: config.authRecoveryRateLimitMax,
    windowMs: config.authRecoveryRateLimitWindowSeconds * 1000
  })
})

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase()
}

function digestIdentity(value) {
  const normalized = normalizeKey(value)
  if (!normalized) return ''

  const boundedIdentity = normalized.length > 256
    ? '__oversized_identity__'
    : normalized
  return createHash('sha256').update(boundedIdentity).digest('hex')
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function isLoopbackProxyAddress(address) {
  const normalized = normalizeKey(address)
    .replace(/^\[|\]$/g, '')
    .split('%')[0]

  if (normalized === '::1') return true

  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  const ipv4 = mappedIpv4 || normalized
  if (net.isIP(ipv4) !== 4) return false

  const firstOctet = Number(ipv4.split('.')[0])
  return firstOctet === 127
}

export function isTrustedProxyAddress(
  address,
  trustedAddresses = config.trustedProxyAddresses
) {
  if (isLoopbackProxyAddress(address)) return true

  const normalizedAddress = normalizeKey(address)
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
  const normalizedAllowlist = new Set(
    (Array.isArray(trustedAddresses) ? trustedAddresses : [])
      .map((value) => normalizeKey(value).replace(/^\[|\]$/g, '').split('%')[0])
      .filter((value) => net.isIP(value))
  )

  return net.isIP(normalizedAddress) > 0
    && normalizedAllowlist.has(normalizedAddress)
}

export function getTrustedClientIp(request) {
  const requestIp = normalizeKey(request?.ip)
  if (requestIp) return requestIp

  return normalizeKey(request?.socket?.remoteAddress || request?.raw?.socket?.remoteAddress)
    || 'unknown'
}

export function createPublicAuthRateLimitKey(kind, request, identity = '') {
  const normalizedKind = normalizeKey(kind)
  const clientIp = getTrustedClientIp(request)
  const identityDigest = digestIdentity(identity)

  return identityDigest
    ? `${normalizedKind}:${clientIp}:id:${identityDigest}`
    : `${normalizedKind}:${clientIp}`
}

export function isAuthenticatedWriteRequest(request) {
  return Boolean(
    request?.currentUser?.id
    && WRITE_METHODS.has(String(request?.method || '').toUpperCase())
  )
}

export function createRequestRateLimiter({
  now = () => Date.now(),
  maxKeys = DEFAULT_MAX_KEYS
} = {}) {
  const entries = new Map()
  let operations = 0

  function pruneExpired(currentTime) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= currentTime) {
        entries.delete(key)
      }
    }
  }

  function enforceBound() {
    const boundedMaxKeys = positiveInteger(maxKeys, DEFAULT_MAX_KEYS)
    while (entries.size > boundedMaxKeys) {
      const oldestKey = entries.keys().next().value
      if (oldestKey === undefined) break
      entries.delete(oldestKey)
    }
  }

  function consume(key, {
    limit,
    windowMs
  }) {
    const normalizedKey = normalizeKey(key) || 'unknown'
    const boundedLimit = positiveInteger(limit, 1)
    const boundedWindowMs = positiveInteger(windowMs, 60_000)
    const currentTime = now()
    const existing = entries.get(normalizedKey)

    operations += 1
    if (operations % 64 === 0) {
      pruneExpired(currentTime)
    }

    if (!existing || existing.resetAt <= currentTime) {
      const entry = {
        count: 1,
        resetAt: currentTime + boundedWindowMs
      }
      entries.delete(normalizedKey)
      entries.set(normalizedKey, entry)
      enforceBound()

      return {
        allowed: true,
        remaining: Math.max(0, boundedLimit - 1),
        retryAfterSeconds: 0,
        resetAt: entry.resetAt
      }
    }

    entries.delete(normalizedKey)
    entries.set(normalizedKey, existing)

    if (existing.count >= boundedLimit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((existing.resetAt - currentTime) / 1000)
        ),
        resetAt: existing.resetAt
      }
    }

    existing.count += 1
    return {
      allowed: true,
      remaining: Math.max(0, boundedLimit - existing.count),
      retryAfterSeconds: 0,
      resetAt: existing.resetAt
    }
  }

  return {
    consume,
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    }
  }
}

const publicAuthLimiter = createRequestRateLimiter()
const authenticatedWriteLimiter = createRequestRateLimiter()

export function consumePublicAuthRateLimit(kind, request, identity = '') {
  const resolveLimit = PUBLIC_AUTH_LIMITS[kind]
  if (!resolveLimit) {
    throw new Error('Unsupported authentication rate limit')
  }

  return publicAuthLimiter.consume(
    createPublicAuthRateLimitKey(kind, request, identity),
    resolveLimit()
  )
}

export function consumeAuthenticatedWriteRateLimit(request) {
  return authenticatedWriteLimiter.consume(
    `user:${normalizeKey(request?.currentUser?.id)}`,
    {
      limit: config.authenticatedWriteRateLimitMax,
      windowMs: config.authenticatedWriteRateLimitWindowSeconds * 1000
    }
  )
}

export function applyRateLimitReply(reply, result) {
  if (result?.allowed !== false) return false

  reply.header(
    'Retry-After',
    String(positiveInteger(result.retryAfterSeconds, 1))
  )
  reply.code(429)
  return true
}

export function resetRequestRateLimitersForTests() {
  publicAuthLimiter.clear()
  authenticatedWriteLimiter.clear()
}
