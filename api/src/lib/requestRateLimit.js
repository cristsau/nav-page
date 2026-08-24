import { createHash } from 'node:crypto'
import net from 'node:net'
import { config } from '../config.js'
import { query } from '../db/index.js'
import {
  consumePersistentRateLimit,
  isRateLimitUnavailableError
} from './persistentRateLimit.js'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const PUBLIC_AUTH_LIMITS = Object.freeze({
  login: () => ({
    limit: config.authLoginRateLimitMax,
    windowMs: config.authLoginRateLimitWindowSeconds * 1000
  }),
  passkey: () => ({
    limit: config.authPasskeyRateLimitMax,
    windowMs: config.authPasskeyRateLimitWindowSeconds * 1000
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

function logCleanupError(request, error) {
  request?.log?.error?.(error, 'failed to clean expired rate-limit buckets')
}

export async function consumePublicAuthRateLimit(kind, request, identity = '') {
  const resolveLimit = PUBLIC_AUTH_LIMITS[kind]
  if (!resolveLimit) {
    throw new Error('Unsupported authentication rate limit')
  }

  const limit = resolveLimit()
  return consumePersistentRateLimit(
    createPublicAuthRateLimitKey(kind, request, identity),
    {
      scope: `auth_${kind}`,
      ...limit,
      queryFn: query,
      onCleanupError: (error) => logCleanupError(request, error)
    }
  )
}

export async function consumeAuthenticatedWriteRateLimit(request) {
  return consumePersistentRateLimit(
    `user:${normalizeKey(request?.currentUser?.id)}`,
    {
      scope: 'authenticated_write',
      limit: config.authenticatedWriteRateLimitMax,
      windowMs: config.authenticatedWriteRateLimitWindowSeconds * 1000,
      queryFn: query,
      onCleanupError: (error) => logCleanupError(request, error)
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

export function applyRateLimitUnavailableReply(reply, error) {
  if (!isRateLimitUnavailableError(error)) return false

  reply.code(503)
  return true
}
