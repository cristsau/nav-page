import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  BOOKMARK_HEALTH_RATE_LIMIT,
  buildBookmarkHealthState,
  consumeBookmarkHealthRateLimit,
  isPublicBookmarkAddress,
  probeBookmarkUrl,
  resetBookmarkHealthRateLimitForTests,
  resolveSafeBookmarkTarget
} from '../src/lib/bookmarkHealth.js'

const PUBLIC_IPV4 = '93.184.216.34'

function publicLookup() {
  return Promise.resolve([{ address: PUBLIC_IPV4, family: 4 }])
}

test('bookmark health only allows globally routable addresses', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:93.184.216.34',
    '2001:db8::1'
  ]) {
    assert.equal(isPublicBookmarkAddress(address), false, address)
  }

  assert.equal(isPublicBookmarkAddress(PUBLIC_IPV4), true)
  assert.equal(isPublicBookmarkAddress('2606:4700:4700::1111'), true)
})

test('bookmark target validation rejects credentials, custom ports and mixed DNS', async () => {
  await assert.rejects(
    resolveSafeBookmarkTarget('https://user:secret@public.example.com/', {
      lookupImpl: publicLookup
    }),
    /credentials_not_allowed/
  )
  await assert.rejects(
    resolveSafeBookmarkTarget('https://public.example.com:8443/', {
      lookupImpl: publicLookup
    }),
    /unsupported_port/
  )
  await assert.rejects(
    resolveSafeBookmarkTarget('https://public.example.com/', {
      lookupImpl: async () => [
        { address: PUBLIC_IPV4, family: 4 },
        { address: '127.0.0.1', family: 4 }
      ]
    }),
    /unsafe_target/
  )
})

test('bookmark probe pins the request to the validated DNS address', async () => {
  const calls = []
  const result = await probeBookmarkUrl('https://public.example.com/path?value=1', {
    lookupImpl: publicLookup,
    requestImpl: async (request) => {
      calls.push(request)
      return { statusCode: 204, location: '' }
    }
  })

  assert.equal(result.outcome, 'healthy')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].address, PUBLIC_IPV4)
  assert.equal(calls[0].family, 4)
  assert.equal(calls[0].method, 'HEAD')
  assert.equal(calls[0].url.hostname, 'public.example.com')
})

test('redirects are revalidated and a redirect to private DNS is never requested', async () => {
  const calls = []
  const result = await probeBookmarkUrl('https://public.example.com/', {
    lookupImpl: async (hostname) => (
      hostname === 'private.example.com'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: PUBLIC_IPV4, family: 4 }]
    ),
    requestImpl: async (request) => {
      calls.push(request)
      return {
        statusCode: 302,
        location: 'https://private.example.com/admin'
      }
    }
  })

  assert.equal(result.outcome, 'unsupported')
  assert.equal(result.errorCode, 'unsafe_target')
  assert.equal(calls.length, 1)
})

test('HEAD falls back to a one-byte GET only for 405 or 501', async () => {
  const methods = []
  const result = await probeBookmarkUrl('https://public.example.com/', {
    lookupImpl: publicLookup,
    requestImpl: async ({ method }) => {
      methods.push(method)
      return { statusCode: method === 'HEAD' ? 405 : 200, location: '' }
    }
  })

  assert.equal(result.outcome, 'healthy')
  assert.deepEqual(methods, ['HEAD', 'GET'])
})

test('redirect responses without a Location header are failures', async () => {
  const result = await probeBookmarkUrl('https://public.example.com/', {
    lookupImpl: publicLookup,
    requestImpl: async () => ({ statusCode: 302, location: '' })
  })

  assert.equal(result.outcome, 'failure')
  assert.equal(result.errorCode, 'invalid_redirect')
  assert.equal(result.statusCode, 302)
})

test('bookmark probes enforce an absolute deadline for an unresponsive requester', async () => {
  const startedAt = Date.now()
  const result = await probeBookmarkUrl('https://public.example.com/', {
    lookupImpl: publicLookup,
    requestImpl: () => new Promise(() => {}),
    timeoutMs: 25
  })

  assert.equal(result.outcome, 'failure')
  assert.equal(result.errorCode, 'timeout')
  assert.ok(Date.now() - startedAt < 1_000)
})

test('health state requires consecutive failures and preserves reachable statuses', () => {
  const firstFailure = buildBookmarkHealthState({
    outcome: 'failure',
    statusCode: 404,
    errorCode: 'http_error'
  }, 0)
  const secondFailure = buildBookmarkHealthState({
    outcome: 'failure',
    statusCode: 404,
    errorCode: 'http_error'
  }, firstFailure.healthFailureCount)

  assert.equal(firstFailure.healthStatus, 'suspect')
  assert.equal(firstFailure.healthFailureCount, 1)
  assert.equal(secondFailure.healthStatus, 'broken')
  assert.equal(secondFailure.healthFailureCount, 2)

  assert.deepEqual(
    buildBookmarkHealthState({ outcome: 'protected', statusCode: 403 }, 5),
    {
      healthStatus: 'protected',
      healthHttpStatus: 403,
      healthFailureCount: 0,
      healthErrorCode: null
    }
  )
  assert.equal(
    buildBookmarkHealthState({ outcome: 'throttled', statusCode: 429 }, 1).healthStatus,
    'throttled'
  )
})

test('pinned request implementation never adds credentials or reads response bodies', async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL('../src/lib/bookmarkHealth.js', import.meta.url)),
    'utf8'
  )

  assert.doesNotMatch(source, /headers\.(authorization|cookie|referer)/i)
  assert.doesNotMatch(source, /['"](authorization|cookie|referer)['"]\s*:/i)
  assert.match(source, /headers\.Range = 'bytes=0-0'/)
  assert.match(source, /response\.destroy\(\)/)
  assert.match(source, /callback\(null, address, family\)/)
  assert.match(source, /absoluteTimeoutHandle = setTimeout/)
})

test('bookmark health checks have a dedicated per-user rate limit', () => {
  resetBookmarkHealthRateLimitForTests()
  for (let index = 0; index < BOOKMARK_HEALTH_RATE_LIMIT; index += 1) {
    assert.equal(
      consumeBookmarkHealthRateLimit('user-a', { now: 1_000 }).allowed,
      true
    )
  }

  const blocked = consumeBookmarkHealthRateLimit('user-a', { now: 1_000 })
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.retryAfterSeconds, 60)
  assert.equal(
    consumeBookmarkHealthRateLimit('user-b', { now: 1_000 }).allowed,
    true
  )
  assert.equal(
    consumeBookmarkHealthRateLimit('user-a', { now: 61_001 }).allowed,
    true
  )
  resetBookmarkHealthRateLimitForTests()
})
