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
import {
  MIGRATION_ADVISORY_LOCK_SQL,
  MIGRATION_ADVISORY_UNLOCK_SQL,
  runMigrations
} from '../src/db/index.js'

const TEST_RATE_LIMIT_SECRET = 'test-only-rate-limit-secret-with-32-characters'

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
    secret: TEST_RATE_LIMIT_SECRET,
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
  assert.match(calls[0].text, /\)::integer/)
  assert.doesNotMatch(calls[0].text, /request_count \+ 1/)
  assert.deepEqual(calls[0].params.slice(0, 1), ['auth_login'])
  assert.match(calls[0].params[1], /^[0-9a-f]{64}$/)
  assert.equal(calls[0].params.includes(rawKey), false)
  assert.equal(JSON.stringify(calls[0].params).includes('198.51.100.27'), false)
  assert.equal(JSON.stringify(calls[0].params).includes('alice'), false)
  assert.equal(calls[0].params[2], 60_000)
  assert.equal(CONSUME_RATE_LIMIT_SQL.includes(rawKey), false)
})

test('persistent limiter requires an explicit secret in every environment and fails closed on database errors', async () => {
  assert.equal(
    validatePersistentRateLimitConfiguration({
      secret: TEST_RATE_LIMIT_SECRET
    }),
    true
  )
  assert.throws(
    () => validatePersistentRateLimitConfiguration({
      secret: ''
    }),
    (error) => error instanceof RateLimitUnavailableError
  )
  assert.throws(
    () => validatePersistentRateLimitConfiguration({
      secret: 'short'
    }),
    (error) => error instanceof RateLimitUnavailableError
  )

  await assert.rejects(
    consumePersistentRateLimit('login:198.51.100.27', {
      scope: 'auth_login',
      limit: 1,
      windowMs: 60_000,
      secret: '',
      queryFn: async () => ({ rows: [] })
    }),
    (error) => error instanceof RateLimitUnavailableError
  )

  await assert.rejects(
    consumePersistentRateLimit('user:example', {
      scope: 'ai_requests',
      limit: 1,
      windowMs: 60_000,
      secret: TEST_RATE_LIMIT_SECRET,
      queryFn: async () => {
        throw new Error('database offline')
      }
    }),
    (error) => error instanceof RateLimitUnavailableError
  )
})

test('persistent limiter marks only the first request beyond the threshold', async () => {
  let count = 3
  const consume = () => consumePersistentRateLimit('login:198.51.100.27', {
    scope: 'auth_login',
    limit: 3,
    windowMs: 60_000,
    secret: TEST_RATE_LIMIT_SECRET,
    queryFn: async () => ({
      rows: [{
        request_count: count,
        retry_after_seconds: 60,
        window_expires_at: '2026-08-01T00:01:00.000Z'
      }]
    }),
    cleanupEvery: Number.MAX_SAFE_INTEGER
  })

  const atLimit = await consume()
  assert.equal(atLimit.allowed, true)
  assert.equal(atLimit.firstDenied, false)

  count = 4
  const firstDenied = await consume()
  assert.equal(firstDenied.allowed, false)
  assert.equal(firstDenied.firstDenied, true)

  count = 5
  const laterDenied = await consume()
  assert.equal(laterDenied.allowed, false)
  assert.equal(laterDenied.firstDenied, false)
})

test('persistent limiter rejects limits that cannot represent the first denial', async () => {
  await assert.rejects(
    consumePersistentRateLimit('login:198.51.100.27', {
      scope: 'auth_login',
      limit: 2_147_483_647,
      windowMs: 60_000,
      secret: TEST_RATE_LIMIT_SECRET,
      queryFn: async () => {
        throw new Error('query must not run for an invalid limit')
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
    outcome: 'failure',
    fingerprintSecret: TEST_RATE_LIMIT_SECRET
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

test('migration runner serializes replicas with one session advisory lock', async () => {
  const calls = []
  let releasedWith
  const client = {
    async query(text, params = []) {
      calls.push({ text, params })
      if (text === 'SELECT 1 FROM schema_migrations WHERE name = $1') {
        return { rowCount: 0, rows: [] }
      }
      return { rowCount: 1, rows: [] }
    },
    release(error) {
      releasedWith = error
    }
  }

  await runMigrations({
    poolInstance: {
      async connect() {
        return client
      }
    },
    fileSystem: {
      async readdir() {
        return [{ name: '016_security_controls.sql', isFile: () => true }]
      },
      async readFile() {
        return 'SELECT 16;'
      }
    },
    migrationsDir: '/test/migrations'
  })

  const statements = calls.map((call) => call.text)
  assert.equal(statements[0], MIGRATION_ADVISORY_LOCK_SQL)
  assert.ok(statements.indexOf('BEGIN') > 0)
  assert.ok(statements.indexOf('SELECT 16;') > statements.indexOf('BEGIN'))
  assert.ok(
    statements.indexOf('INSERT INTO schema_migrations (name) VALUES ($1)')
    > statements.indexOf('SELECT 16;')
  )
  assert.ok(
    statements.indexOf('COMMIT')
    > statements.indexOf('INSERT INTO schema_migrations (name) VALUES ($1)')
  )
  assert.equal(statements.at(-1), MIGRATION_ADVISORY_UNLOCK_SQL)
  assert.equal(releasedWith, undefined)
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
    secret: TEST_RATE_LIMIT_SECRET,
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
    secret: TEST_RATE_LIMIT_SECRET,
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
    headers: {},
    header(name, value) {
      this.headers[name] = value
      return this
    },
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
  assert.equal(reply.headers['Cache-Control'], 'private, no-store')
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
  assert.match(authRoute, /if \(!rateLimited\?\.firstDenied\) return false/)
  assert.match(authRoute, /auditFirstRateLimitDenial\([\s\S]*'auth\.login'/)
  assert.match(authRoute, /auditFirstRateLimitDenial\([\s\S]*'auth\.recovery'/)
  assert.match(authPlugin, /await consumeAuthenticatedWriteRateLimit\(request\)/)
  assert.match(authPlugin, /applyRateLimitUnavailableReply\(reply, error\)/)
  assert.match(authPlugin, /reply\.send\(\{[\s\S]*Security rate limiting is temporarily unavailable/)
})

test('server and container configuration require explicit production security settings', async () => {
  const [server, limiter, dockerfile, compose, envExample] = await Promise.all([
    readSource('../src/server.js'),
    readSource('../src/lib/persistentRateLimit.js'),
    readSource('../Dockerfile'),
    readSource('../../docker-compose.backend.yml'),
    readSource('../.env.example')
  ])

  const validationIndex = server.indexOf('validatePersistentRateLimitConfiguration()')
  const migrationIndex = server.indexOf('await runMigrations()')
  assert.ok(validationIndex >= 0)
  assert.ok(migrationIndex > validationIndex)
  assert.doesNotMatch(limiter, /development-only|DEFAULT_DEVELOPMENT_SECRET|nodeEnv/)
  assert.match(dockerfile, /^ENV NODE_ENV=production$/m)
  assert.match(
    compose,
    /nav-api:[\s\S]*?environment:\s*\n\s+NODE_ENV: production/
  )
  assert.match(envExample, /^NODE_ENV=production$/m)
  assert.match(envExample, /^NAV_RATE_LIMIT_KEY_SECRET=$/m)
})

test('migration verification binds 016 constraints to their owning tables', async () => {
  const verifier = await readSource('../src/db/verifyMigrations.js')

  assert.match(verifier, /conrelid = 'rate_limit_buckets'::regclass/)
  assert.match(verifier, /contype = 'p'/)
  assert.match(verifier, /\['scope', 'key_digest'\]/)
  assert.match(verifier, /conrelid = 'security_events'::regclass/)
  assert.match(verifier, /confrelid = 'users'::regclass/)
  assert.match(verifier, /confdeltype !== 'n'/)
  assert.match(verifier, /security_events_actor_user_id_fkey/)
  assert.match(verifier, /security_events_subject_user_id_fkey/)
})

test('sensitive admin audit responses disable shared and browser caches', async () => {
  const route = await readSource('../src/routes/securityEvents.js')
  assert.match(route, /Cache-Control', 'private, no-store'/)
})

test('logout and Telegram configuration commit business changes with their audit events', async () => {
  const [authRoute, telegramRoute, telegram, userSettings] = await Promise.all([
    readSource('../src/routes/auth.js'),
    readSource('../src/routes/adminTelegram.js'),
    readSource('../src/lib/telegram.js'),
    readSource('../src/lib/userSettings.js')
  ])
  const logoutRoute = authRoute.slice(
    authRoute.indexOf("fastify.post('/auth/logout'"),
    authRoute.indexOf("fastify.get('/auth/sessions'")
  )
  const telegramConfigRoute = telegramRoute.slice(
    telegramRoute.indexOf("fastify.put('/admin/telegram-config'"),
    telegramRoute.indexOf("fastify.post('/admin/telegram-config/test'")
  )

  assert.match(logoutRoute, /withTransaction\(async \(client\)/)
  assert.match(logoutRoute, /DELETE FROM sessions[^']+RETURNING id/)
  assert.match(logoutRoute, /recordSecurityEvent\(\{\s*client,/)
  assert.match(logoutRoute, /affectedCount: deletedSession\.rowCount \|\| 0/)
  assert.match(telegramConfigRoute, /withTransaction\(async \(client\)/)
  assert.match(telegramConfigRoute, /saveAdminTelegramConfig\([\s\S]*\{ client \}/)
  assert.match(telegramConfigRoute, /recordSecurityEvent\(\{\s*client,/)
  assert.match(telegram, /saveAdminTelegramConfig\(userId, config, options = \{\}\)/)
  assert.match(userSettings, /setUserSettingValue\(userId, key, value, \{ client \} = \{\}\)/)
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
    assert.equal(response.headers['cache-control'], 'private, no-store')
  } finally {
    await app.close()
  }
})
