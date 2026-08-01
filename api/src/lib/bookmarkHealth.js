import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

export const BOOKMARK_HEALTH_MAX_REDIRECTS = 3
export const BOOKMARK_HEALTH_REQUEST_TIMEOUT_MS = 8_000
export const BOOKMARK_HEALTH_RATE_LIMIT = 6
export const BOOKMARK_HEALTH_RATE_WINDOW_MS = 60_000

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const HEAD_FALLBACK_STATUSES = new Set([405, 501])
const UNSUPPORTED_ERROR_CODES = new Set([
  'invalid_url',
  'unsupported_protocol',
  'credentials_not_allowed',
  'unsupported_port',
  'unsafe_target'
])
const BLOCKED_HOST_SUFFIXES = Object.freeze([
  '.arpa',
  '.example',
  '.home',
  '.internal',
  '.invalid',
  '.lan',
  '.local',
  '.localhost',
  '.onion',
  '.test'
])
const healthRateLimitEntries = new Map()
let healthRateLimitOperations = 0

export function consumeBookmarkHealthRateLimit(userId, {
  now = Date.now()
} = {}) {
  const key = String(userId || '').trim().toLowerCase() || 'unknown'
  const existing = healthRateLimitEntries.get(key)

  healthRateLimitOperations += 1
  if (healthRateLimitOperations % 64 === 0) {
    for (const [entryKey, entry] of healthRateLimitEntries) {
      if (entry.resetAt <= now) healthRateLimitEntries.delete(entryKey)
    }
  }

  if (!existing || existing.resetAt <= now) {
    healthRateLimitEntries.set(key, {
      count: 1,
      resetAt: now + BOOKMARK_HEALTH_RATE_WINDOW_MS
    })
    while (healthRateLimitEntries.size > 10_000) {
      healthRateLimitEntries.delete(healthRateLimitEntries.keys().next().value)
    }
    return { allowed: true, retryAfterSeconds: 0 }
  }

  if (existing.count >= BOOKMARK_HEALTH_RATE_LIMIT) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    }
  }

  existing.count += 1
  return { allowed: true, retryAfterSeconds: 0 }
}

export function resetBookmarkHealthRateLimitForTests() {
  healthRateLimitEntries.clear()
  healthRateLimitOperations = 0
}

class BookmarkHealthProbeError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function fail(code) {
  throw new BookmarkHealthProbeError(code)
}

function isBlockedIpv4(address) {
  const parts = String(address || '').split('.').map(Number)
  if (
    parts.length !== 4
    || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true
  }

  const [a, b, c] = parts
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  )
}

function expandIpv6(address) {
  let normalized = String(address || '').toLowerCase().split('%')[0]
  const mappedIpv4 = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)

  if (mappedIpv4) {
    const bytes = mappedIpv4[2].split('.').map(Number)
    if (bytes.length !== 4 || bytes.some((value) => value < 0 || value > 255)) {
      return null
    }
    normalized = `${mappedIpv4[1]}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`
  }

  const halves = normalized.split('::')
  if (halves.length > 2) return null

  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length

  if ((halves.length === 1 && missing !== 0) || missing < 0) return null

  const groups = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...right
  ]

  if (groups.length !== 8) return null

  const values = groups.map((group) => Number.parseInt(group || '0', 16))
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff)) {
    return null
  }

  return values
}

function isBlockedIpv6(address) {
  const groups = expandIpv6(address)
  if (!groups) return true

  const [first, second] = groups

  // Only globally routable unicast space is eligible. This also excludes
  // loopback, link-local, ULA, multicast, IPv4-mapped and NAT64 well-known ranges.
  if ((first & 0xe000) !== 0x2000) return true

  // Exclude special-purpose, documentation and transition ranges within 2000::/3.
  return (
    (first === 0x2001 && second <= 0x01ff)
    || (first === 0x2001 && second === 0x0db8)
    || first === 0x2002
    || first === 0x3fff
  )
}

export function isPublicBookmarkAddress(address) {
  const normalized = String(address || '').replace(/^\[|\]$/g, '').split('%')[0]
  const family = net.isIP(normalized)
  if (family === 4) return !isBlockedIpv4(normalized)
  if (family === 6) return !isBlockedIpv6(normalized)
  return false
}

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

function isUnsafeHostname(hostname) {
  if (!hostname || hostname.length > 253) return true
  if (hostname === 'localhost' || !hostname.includes('.')) return true
  return BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
}

function parseBookmarkTarget(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    fail('invalid_url')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    fail('unsupported_protocol')
  }
  if (url.username || url.password) {
    fail('credentials_not_allowed')
  }
  if (url.href.length > 4096) {
    fail('invalid_url')
  }

  const expectedPort = url.protocol === 'https:' ? '443' : '80'
  const effectivePort = url.port || expectedPort
  if (effectivePort !== expectedPort) {
    fail('unsupported_port')
  }

  url.hash = ''
  return url
}

function normalizeDnsAddresses(records) {
  return (Array.isArray(records) ? records : [])
    .map((record) => ({
      address: String(record?.address || ''),
      family: Number(record?.family) || net.isIP(String(record?.address || ''))
    }))
    .filter(({ address, family }) => address && (family === 4 || family === 6))
}

export async function resolveSafeBookmarkTarget(
  value,
  { lookupImpl = dns.lookup } = {}
) {
  const url = parseBookmarkTarget(value)
  const hostname = normalizeHostname(url.hostname)
  const literalFamily = net.isIP(hostname)

  if (literalFamily) {
    if (!isPublicBookmarkAddress(hostname)) fail('unsafe_target')
    return {
      url,
      addresses: [{ address: hostname, family: literalFamily }]
    }
  }

  if (isUnsafeHostname(hostname)) fail('unsafe_target')

  let addresses
  try {
    addresses = normalizeDnsAddresses(await lookupImpl(hostname, {
      all: true,
      verbatim: true
    }))
  } catch {
    fail('dns_error')
  }

  if (!addresses.length) fail('dns_error')
  if (addresses.some(({ address }) => !isPublicBookmarkAddress(address))) {
    fail('unsafe_target')
  }

  addresses.sort((left, right) => left.family - right.family)
  return { url, addresses }
}

export function requestPinnedBookmarkTarget({
  url,
  address,
  family,
  method,
  timeoutMs = BOOKMARK_HEALTH_REQUEST_TIMEOUT_MS
}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    let absoluteTimeoutHandle
    const headers = {
      Accept: '*/*',
      Connection: 'close',
      'User-Agent': 'DomoNAV-LinkHealth/1.0'
    }
    if (method === 'GET') {
      headers.Range = 'bytes=0-0'
    }

    const request = transport.request(url, {
      method,
      headers,
      agent: false,
      autoSelectFamily: false,
      lookup(_hostname, _options, callback) {
        callback(null, address, family)
      }
    }, (response) => {
      const statusCode = Number(response.statusCode || 0)
      const location = Array.isArray(response.headers.location)
        ? response.headers.location[0]
        : response.headers.location

      clearTimeout(absoluteTimeoutHandle)
      response.destroy()
      resolve({ statusCode, location: String(location || '') })
    })

    absoluteTimeoutHandle = setTimeout(() => {
      const error = new Error('timeout')
      error.code = 'ETIMEDOUT'
      request.destroy(error)
    }, Math.max(1, timeoutMs))
    request.setTimeout(timeoutMs, () => {
      const error = new Error('timeout')
      error.code = 'ETIMEDOUT'
      request.destroy(error)
    })
    request.on('error', (error) => {
      clearTimeout(absoluteTimeoutHandle)
      reject(error)
    })
    request.end()
  })
}

function classifyRequestError(error) {
  const code = String(error?.code || '').toUpperCase()
  if (
    code === 'TIMEOUT'
    || code === 'ETIMEDOUT'
    || code === 'ESOCKETTIMEDOUT'
    || code === 'ERR_SOCKET_CONNECTION_TIMEOUT'
  ) {
    return 'timeout'
  }
  if (
    code.includes('CERT')
    || code.includes('TLS')
    || code.includes('SSL')
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  ) {
    return 'tls_error'
  }
  return 'connection_error'
}

async function requestSafeHop(target, method, requestImpl, deadline, nowImpl) {
  let lastError = null

  for (const { address, family } of target.addresses) {
    const remainingMs = deadline - nowImpl()
    if (remainingMs <= 0) fail('timeout')

    let deadlineHandle
    try {
      return await Promise.race([
        Promise.resolve(requestImpl({
          url: target.url,
          address,
          family,
          method,
          timeoutMs: remainingMs
        })),
        new Promise((_, reject) => {
          deadlineHandle = setTimeout(
            () => reject(new BookmarkHealthProbeError('timeout')),
            Math.max(1, remainingMs)
          )
        })
      ])
    } catch (error) {
      lastError = error
    } finally {
      if (deadlineHandle) clearTimeout(deadlineHandle)
    }
  }

  fail(classifyRequestError(lastError))
}

async function resolveWithDeadline(value, lookupImpl, deadline, nowImpl) {
  const remainingMs = deadline - nowImpl()
  if (remainingMs <= 0) fail('timeout')

  let timeoutHandle
  try {
    return await Promise.race([
      resolveSafeBookmarkTarget(value, { lookupImpl }),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new BookmarkHealthProbeError('timeout')),
          remainingMs
        )
      })
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

function resultFromHttpStatus(statusCode, redirected) {
  if (statusCode >= 200 && statusCode < 400) {
    return {
      outcome: redirected ? 'redirected' : 'healthy',
      statusCode,
      errorCode: null
    }
  }
  if (statusCode === 401 || statusCode === 403) {
    return { outcome: 'protected', statusCode, errorCode: null }
  }
  if (statusCode === 429) {
    return { outcome: 'throttled', statusCode, errorCode: null }
  }
  return { outcome: 'failure', statusCode, errorCode: 'http_error' }
}

export async function probeBookmarkUrl(value, {
  lookupImpl = dns.lookup,
  requestImpl = requestPinnedBookmarkTarget,
  timeoutMs = BOOKMARK_HEALTH_REQUEST_TIMEOUT_MS,
  maxRedirects = BOOKMARK_HEALTH_MAX_REDIRECTS,
  nowImpl = Date.now
} = {}) {
  let currentValue = value
  let redirects = 0
  const deadline = nowImpl() + timeoutMs

  try {
    while (true) {
      if (deadline <= nowImpl()) fail('timeout')
      const target = await resolveWithDeadline(
        currentValue,
        lookupImpl,
        deadline,
        nowImpl
      )
      let response = await requestSafeHop(target, 'HEAD', requestImpl, deadline, nowImpl)

      if (HEAD_FALLBACK_STATUSES.has(response.statusCode)) {
        response = await requestSafeHop(target, 'GET', requestImpl, deadline, nowImpl)
      }

      if (REDIRECT_STATUSES.has(response.statusCode) && response.location) {
        if (redirects >= maxRedirects) {
          return {
            outcome: 'failure',
            statusCode: response.statusCode,
            errorCode: 'too_many_redirects'
          }
        }

        try {
          currentValue = new URL(response.location, target.url).toString()
        } catch {
          return {
            outcome: 'failure',
            statusCode: response.statusCode,
            errorCode: 'invalid_redirect'
          }
        }
        redirects += 1
        continue
      }

      if (response.statusCode >= 300 && response.statusCode < 400) {
        return {
          outcome: 'failure',
          statusCode: response.statusCode,
          errorCode: 'invalid_redirect'
        }
      }

      return resultFromHttpStatus(response.statusCode, redirects > 0)
    }
  } catch (error) {
    const errorCode = error instanceof BookmarkHealthProbeError
      ? error.code
      : classifyRequestError(error)
    return {
      outcome: UNSUPPORTED_ERROR_CODES.has(errorCode) ? 'unsupported' : 'failure',
      statusCode: null,
      errorCode
    }
  }
}

export function buildBookmarkHealthState(probe, previousFailureCount = 0) {
  const currentFailures = Number.isSafeInteger(Number(previousFailureCount))
    ? Math.max(0, Number(previousFailureCount))
    : 0
  const statusCode = Number.isInteger(probe?.statusCode)
    && probe.statusCode >= 100
    && probe.statusCode <= 599
    ? probe.statusCode
    : null

  if (probe?.outcome === 'failure') {
    const failureCount = currentFailures + 1
    return {
      healthStatus: failureCount >= 2 ? 'broken' : 'suspect',
      healthHttpStatus: statusCode,
      healthFailureCount: failureCount,
      healthErrorCode: probe.errorCode || 'connection_error'
    }
  }

  if (probe?.outcome === 'unsupported') {
    return {
      healthStatus: 'unsupported',
      healthHttpStatus: null,
      healthFailureCount: 0,
      healthErrorCode: probe.errorCode || 'unsafe_target'
    }
  }

  const reachableStatuses = new Set([
    'healthy',
    'redirected',
    'protected',
    'throttled'
  ])

  return {
    healthStatus: reachableStatuses.has(probe?.outcome) ? probe.outcome : 'suspect',
    healthHttpStatus: statusCode,
    healthFailureCount: 0,
    healthErrorCode: null
  }
}
