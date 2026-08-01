import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createApp } from '../src/app.js'
import {
  CLEANUP_RATE_LIMIT_SQL,
  CONSUME_RATE_LIMIT_SQL,
  RateLimitUnavailableError,
  cleanupExpiredRateLimitBuckets,
  consumePersistentRateLimit,
  digestSensitiveValue,
  validatePersistentRateLimitConfiguration
} from '../src/lib/persistentRateLimit.js'
import { recordSecurityEvent } from '../src/lib/securityEvents.js'
import { enforceAiRateLimit } from '../src/lib/aiRateLimit.js'
import securityEventRoutes, {
  validateSecurityEventQuery
} from '../src/routes/securityEvents.js'

async function readSource(relativeUrl) {
  const source = await fs.readFile(new URL(relativeUrl, import.meta.url), 'utf8')
  return source.replace(/\r\n?/g, '\n')
}

test('persistent limiter stores only keyed digests and uses one atomic database statement', async () => {
  const calls = []
  const rawKey = 'login:198.51.100.27:id:alice'
  const result = await consumePersistentRateLimit(rawKey, {
    scope: 'auth_login',
    limit: 3,
    windowMs: 60_000,
    secret: 'test-only-rate-limit-secret-with-32-characters',
    queryFn: async (text, params) => {
      calls.push({ text, params })
      return {
        rows: [{
          request_count: 1,
          retry_after_seconds: 60,
          window_expires_at: '2026-08-01T00:01:00.000Z'
        }]
      }
    },
    cleanupEvery: Number.MAX_SAFE_INTEGER
  })

  assert.equal(result.allowed, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].text, /ON CONFLICT \(scope, key_digest\) DO UPDATE/)
  assert.match(calls[0].text, /CURRENT_TIMESTAMP/)
  assert.match(calls[0].text, /rate_limit_buckets\.request_count::bigint \+ 1/)
  assert.deepEqual(calls[0].params.slice(0, 1), ['auth_login'])
  assert.match(calls[0].params[1], /^[0-9a-f]{64}$/)
  assert.equal(calls[0].params.includes(rawKey), false)
  assert.equal(JSON.stringify(calls[0].params).includes('198.51.100.27'), false)
  assert.equal(JSON.stringify(calls[0].params).includes('alice'), false)
  assert.equal(calls[0].params[2], 60_000)
  assert.equal(CONSUME_RATE_LIMIT_SQL.includes(rawKey), false)
})

test('persistent limiter fails closed when its production secret or database is unavailable', async () => {
  assert.throws(
    () => validatePersistentRateLimitConfiguration({
      secret: '',
      nodeEnv: 'production'
    }),
    (error) => error instanceof RateLimitUnavailableError
  )

  await assert.rejects(
    consumePersistentRateLimit('login:198.51.100.27', {
      scope: 'auth_login',
      limit: 1,
      windowMs: 60_000,
      secret: '',
      nodeEnv: 'production',
      queryFn: async () => ({ rows: [] })
    }),
    (error) => error instanceof RateLimitUnavailableError
  )

  await assert.rejects(
    consumePersistentRateLimit('user:example', {
      scope: 'ai_requests',
      limit: 1,
      windowMs: 60_000,
      secret: 'test-only-rate-limit-secret-with-32-characters',
      queryFn: async () => {
        throw new Error('database offline')
      }
    }),
    (error) => error instanceof RateLimitUnavailableError
  )
})

test('expired bucket cleanup is bounded and concurrency-safe', async () => {
  const calls = []
  await cleanupExpiredRateLimitBuckets(async (text, params) => {
    calls.push({ text, params })
    return { rowCount: 4 }
  }, { batchSize: 25 })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, CLEANUP_RATE_LIMIT_SQL)
  assert.match(calls[0].text, /LIMIT \$1/)
  assert.match(calls[0].text, /FOR UPDATE SKIP LOCKED/)
  assert.match(calls[0].text, /bucket\.window_expires_at = expired\.window_expires_at/)
  assert.deepEqual(calls[0].params, [25])
})

test('security audit accepts only structured fields and hashes request fingerprints', async () => {
  let captured
  await recordSecurityEvent({
    client: {
      async query(text, params) {
        captured = { text, params }
        return { rows: [{ id: '1', created_at: new Date().toISOString() }] }
      }
    },
    request: {
      ip: '198.51.100.27',
      headers: {
        'user-agent': 'Security Controls Test Browser'
      }
    },
    eventType: 'auth.login',
    outcome: 'failure'
  })

  assert.match(captured.text, /INSERT INTO security_events/)
  assert.match(captured.params[7], /^[0-9a-f]{64}$/)
  assert.match(captured.params[8], /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(captured.params).includes('198.51.100.27'), false)
  assert.equal(JSON.stringify(captured.params).includes('Security Controls Test Browser'), false)
  assert.notEqual(
    digestSensitiveValue(
      'security-event:client-ip',
      '198.51.100.27',
      { secret: 'first-test-secret-that-is-at-least-32-chars' }
    ),
    digestSensitiveValue(
      'security-event:client-ip',
      '198.51.100.27',
      { secret: 'second-test-secret-that-is-at-least-32-chars' }
    )
  )
})

test('security migration creates constrained shared buckets and audit events', async () => {
  const migration = await readSource('../src/db/migrations/016_security_controls.sql')

  assert.match(migration, /CREATE TABLE IF NOT EXISTS rate_limit_buckets/)
  assert.match(migration, /PRIMARY KEY \(scope, key_digest\)/)
  assert.match(migration, /key_digest ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS security_events/)
  assert.match(migration, /outcome IN \('success', 'failure', 'denied'\)/)
  assert.doesNotMatch(migration, /username|password|token|request_body|content/i)
})

test('AI limiter preserves 429 Retry-After and fails closed with 503', async () => {
  const makeReply = () => ({
    statusCode: 200,
    headers: {},
    header(name, value) {
      this.headers[name] = value
      return this
    },
    code(value) {
      this.statusCode = value
      return this
    }
  })
  const request = {
    currentUser: { id: 'user-1' },
    log: { error() {} }
  }
  const limitedReply = makeReply()
  const limited = await enforceAiRateLimit(request, limitedReply, {
    queryFn: async () => ({
      rows: [{
        request_count: 11,
        retry_after_seconds: 37,
        window_expires_at: '2026-08-01T00:01:00.000Z'
      }]
    })
  })
  assert.equal(limitedReply.statusCode, 429)
  assert.equal(limitedReply.headers['Retry-After'], '37')
  assert.match(limited.error, /AI/)

  const unavailableReply = makeReply()
  const unavailable = await enforceAiRateLimit(request, unavailableReply, {
    queryFn: async () => {
      throw new Error('database unavailable')
    }
  })
  assert.equal(unavailableReply.statusCode, 503)
  assert.equal(unavailable.error, 'AI rate limiting is temporarily unavailable')
})

test('security event query validates filters and caps pagination', () => {
  assert.deepEqual(validateSecurityEventQuery({
    page: '2',
    pageSize: '999',
    eventType: 'AUTH.LOGIN',
    outcome: 'Failure'
  }), {
    valid: true,
    page: 2,
    pageSize: 200,
    eventType: 'auth.login',
    outcome: 'failure'
  })
  assert.deepEqual(validateSecurityEventQuery({ eventType: 'unknown.event' }), {
    valid: false,
    error: 'Unsupported security event type'
  })
  assert.deepEqual(validateSecurityEventQuery({ outcome: 'unknown' }), {
    valid: false,
    error: 'Unsupported security event outcome'
  })
})

test('admin security-event route parameterizes validated filters and pagination', async () => {
  let handler
  const calls = []
  const fastify = {
    get(path, routeHandler) {
      assert.equal(path, '/admin/security-events')
      handler = routeHandler
    },
    async requireAdmin(request, reply) {
      if (request.currentUser?.role !== 'admin') {
        reply.code(403)
        throw new Error('Admin access required')
      }
    }
  }
  await securityEventRoutes(fastify, {
    queryFn: async (text, params) => {
      calls.push({ text, params })
      if (calls.length === 1) {
        return { rows: [{ total: 1 }] }
      }
      return {
        rows: [{
          id: '42',
          event_type: 'auth.login',
          outcome: 'failure',
          actor_user_id: null,
          subject_user_id: null,
          resource_type: null,
          resource_id: null,
          affected_count: null,
          client_ip_digest: 'a'.repeat(64),
          user_agent_digest: 'b'.repeat(64),
          created_at: '2026-08-01T00:00:00.000Z'
        }]
      }
    }
  })

  const reply = {
    statusCode: 200,
    code(value) {
      this.statusCode = value
      return this
    }
  }
  const response = await handler({
    currentUser: { role: 'admin' },
    query: {
      page: '2',
      pageSize: '999',
      eventType: 'auth.login',
      outcome: 'failure'
    }
  }, reply)

  assert.equal(reply.statusCode, 200)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].params, ['auth.login', 'failure'])
  assert.deepEqual(calls[1].params, ['auth.login', 'failure', 200, 200])
  assert.match(calls[0].text, /event_type = \$1/)
  assert.match(calls[0].text, /outcome = \$2/)
  assert.equal(response.pagination.total, 1)
  assert.equal(response.events[0].clientFingerprint, 'a'.repeat(16))
  assert.equal(response.events[0].userAgentFingerprint, 'b'.repeat(16))
})

test('public auth and authenticated writes await shared limits and expose fail-closed 503 handling', async () => {
  const [authRoute, authPlugin] = await Promise.all([
    readSource('../src/routes/auth.js'),
    readSource('../src/plugins/auth.js')
  ])

  assert.match(authRoute, /await consumePublicAuthRateLimit\(kind, request, identity\)/)
  assert.match(authRoute, /applyRateLimitUnavailableReply\(reply, error\)/)
  assert.match(authRoute, /Security rate limiting is temporarily unavailable/)
  assert.match(authPlugin, /await consumeAuthenticatedWriteRateLimit\(request\)/)
  assert.match(authPlugin, /applyRateLimitUnavailableReply\(reply, error\)/)
  assert.match(authPlugin, /reply\.send\(\{[\s\S]*Security rate limiting is temporarily unavailable/)
})

test('admin security-event API is authenticated and admin-only', async () => {
  const source = await readSource('../src/routes/securityEvents.js')
  assert.match(source, /fastify\.get\('\/admin\/security-events'/)
  assert.match(source, /await fastify\.requireAdmin\(request, reply\)/)
  assert.match(source, /LIMIT \$\{limitParameter\}/)
  assert.doesNotMatch(source, /ip_address|user_agent\s*,/)

  const app = createApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/security-events'
    })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'Authentication required')
  } finally {
    await app.close()
  }
})
