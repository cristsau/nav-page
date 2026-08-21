import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import Fastify from 'fastify'
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
import { hashPassword } from '../src/lib/auth.js'
import { enforceAiRateLimit } from '../src/lib/aiRateLimit.js'
import securityEventRoutes, {
  validateSecurityEventQuery
} from '../src/routes/securityEvents.js'
import { validateSecurityEventDeletion } from '../src/lib/securityEventDeletion.js'
import { isTrustedProxyAddress } from '../src/lib/requestRateLimit.js'
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

async function resolveInjectedClientIp({ remoteAddress, forwardedFor, trustedAddresses }) {
  const app = Fastify({
    trustProxy: (address) => isTrustedProxyAddress(address, trustedAddresses)
  })
  app.get('/client-ip', async (request) => ({
    ip: request.ip,
    ips: request.ips
  }))

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/client-ip',
      remoteAddress,
      headers: forwardedFor
        ? { 'x-forwarded-for': forwardedFor }
        : {}
    })
    assert.equal(response.statusCode, 200)
    return response.json()
  } finally {
    await app.close()
  }
}

test('trusted proxy resolution handles the explicit multi-hop chain', async () => {
  const navWebAddress = '172.22.0.8'
  const fixedOuterProxyAddress = '203.0.113.9'
  const result = await resolveInjectedClientIp({
    remoteAddress: navWebAddress,
    forwardedFor: `198.51.100.27, ${fixedOuterProxyAddress}`,
    trustedAddresses: [navWebAddress, fixedOuterProxyAddress]
  })

  assert.equal(result.ip, '198.51.100.27')
  assert.equal(result.ips.includes('198.51.100.27'), true)
  assert.equal(result.ips.includes(fixedOuterProxyAddress), true)
  assert.equal(result.ips.includes(navWebAddress), true)
})

test('untrusted peers stop forged XFF chains and broad proxy ranges stay rejected', async () => {
  const navWebAddress = '172.22.0.8'
  const realUntrustedClient = '192.0.2.44'
  const throughNavWeb = await resolveInjectedClientIp({
    remoteAddress: navWebAddress,
    forwardedFor: `198.51.100.66, ${realUntrustedClient}`,
    trustedAddresses: [navWebAddress]
  })
  const direct = await resolveInjectedClientIp({
    remoteAddress: realUntrustedClient,
    forwardedFor: '198.51.100.66',
    trustedAddresses: [navWebAddress]
  })

  assert.equal(throughNavWeb.ip, realUntrustedClient)
  assert.equal(direct.ip, realUntrustedClient)
  assert.equal(isTrustedProxyAddress('172.22.0.99', [navWebAddress]), false)
  assert.equal(isTrustedProxyAddress('172.22.0.99', ['172.22.0.0/16']), false)
})

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
  for (const limit of [2_147_483_646, 2_147_483_647]) {
    await assert.rejects(
      consumePersistentRateLimit('login:198.51.100.27', {
        scope: 'auth_login',
        limit,
        windowMs: 60_000,
        secret: TEST_RATE_LIMIT_SECRET,
        queryFn: async () => {
          throw new Error('query must not run for an invalid limit')
        }
      }),
      (error) => error instanceof RateLimitUnavailableError
    )
  }
})

test('persistent limiter preserves one first-denial transition at its supported upper bound', async () => {
  const counts = [
    2_147_483_645,
    2_147_483_646,
    2_147_483_647,
    2_147_483_647
  ]
  const outcomes = []

  for (const requestCount of counts) {
    outcomes.push(await consumePersistentRateLimit('login:198.51.100.27', {
      scope: 'auth_login',
      limit: 2_147_483_645,
      windowMs: 60_000,
      secret: TEST_RATE_LIMIT_SECRET,
      queryFn: async () => ({
        rows: [{
          request_count: requestCount,
          retry_after_seconds: 60,
          window_expires_at: '2026-08-01T00:01:00.000Z'
        }]
      }),
      cleanupEvery: Number.MAX_SAFE_INTEGER
    }))
  }

  assert.deepEqual(
    outcomes.map(({ allowed, firstDenied }) => ({ allowed, firstDenied })),
    [
      { allowed: true, firstDenied: false },
      { allowed: false, firstDenied: true },
      { allowed: false, firstDenied: false },
      { allowed: false, firstDenied: false }
    ]
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

test('security event deletion validates a bounded unique BIGINT selection and current password', () => {
  assert.deepEqual(validateSecurityEventDeletion({
    currentPassword: 'current-secret',
    eventIds: ['2', 3, '2']
  }), {
    valid: true,
    currentPassword: 'current-secret',
    eventIds: ['2', '3']
  })
  assert.deepEqual(validateSecurityEventDeletion({ eventIds: ['1'] }), {
    valid: false,
    error: 'Current password is required'
  })
  assert.deepEqual(validateSecurityEventDeletion({
    currentPassword: 'current-secret',
    eventIds: ['0']
  }), {
    valid: false,
    error: 'Invalid security event ID'
  })
  assert.equal(validateSecurityEventDeletion({
    currentPassword: 'current-secret',
    eventIds: Array.from({ length: 101 }, (_, index) => String(index + 1))
  }).valid, false)
})

test('admin security-event route parameterizes validated filters and pagination', async () => {
  let handler
  const calls = []
  const fastify = {
    get(path, routeHandler) {
      assert.equal(path, '/admin/security-events')
      handler = routeHandler
    },
    post() {},
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

test('admin security-event deletion verifies the password, deletes selected IDs, and records the action', async () => {
  let handler
  const calls = []
  const passwordHash = await hashPassword('current-secret')
  const fastify = {
    get() {},
    post(path, routeHandler) {
      assert.equal(path, '/admin/security-events/delete')
      handler = routeHandler
    },
    async requireAdmin(request, reply) {
      if (request.currentUser?.role !== 'admin') {
        reply.code(403)
        throw new Error('Admin access required')
      }
    }
  }
  const client = {
    async query(text, params) {
      calls.push({ text, params })
      if (/SELECT password_hash/.test(text)) {
        return { rows: [{ password_hash: passwordHash }], rowCount: 1 }
      }
      if (/DELETE FROM security_events/.test(text)) {
        return { rows: [{ id: '4' }, { id: '5' }], rowCount: 2 }
      }
      if (/INSERT INTO security_events/.test(text)) {
        return {
          rows: [{ id: '6', created_at: '2026-08-20T00:00:00.000Z' }],
          rowCount: 1
        }
      }
      throw new Error('Unexpected query')
    }
  }

  await securityEventRoutes(fastify, {
    queryFn: async () => ({ rows: [] }),
    transactionFn: async (callback) => callback(client)
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
    currentUser: { id: '8a6db381-01a5-4731-ae8d-b5c3b49c2be1', role: 'admin' },
    body: {
      currentPassword: 'current-secret',
      eventIds: ['4', '5']
    },
    headers: {},
    log: { error() {} }
  }, reply)

  assert.equal(reply.statusCode, 200)
  assert.equal(reply.headers['Cache-Control'], 'private, no-store')
  assert.deepEqual(response, { ok: true, deletedCount: 2 })
  const deleteCall = calls.find((call) => /DELETE FROM security_events/.test(call.text))
  assert.deepEqual(deleteCall.params, [['4', '5']])
  const auditCall = calls.find((call) => /INSERT INTO security_events/.test(call.text))
  assert.equal(auditCall.params[0], 'admin.security_events.delete')
  assert.equal(auditCall.params[6], 2)
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
  assert.equal(
    (verifier.match(/attribute\.attname::text/g) || []).length,
    2
  )
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
