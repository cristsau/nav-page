import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  createRecoveryCodes,
  hashPassword,
  hashRecoveryCode,
  isValidRecoveryCode,
  isValidUsername,
  shouldTouchSession,
  validateNewPassword,
  verifyPassword
} from '../src/lib/auth.js'
import {
  applyRateLimitReply,
  createPublicAuthRateLimitKey,
  createRequestRateLimiter,
  getTrustedClientIp,
  isLoopbackProxyAddress,
  isTrustedProxyAddress
} from '../src/lib/requestRateLimit.js'
import { createApp } from '../src/app.js'

async function readSource(relativeUrl) {
  const source = await fs.readFile(new URL(relativeUrl, import.meta.url), 'utf8')
  return source.replace(/\r\n?/g, '\n')
}

test('new passwords require twelve characters while legacy short password hashes still verify', async () => {
  assert.equal(MIN_PASSWORD_LENGTH, 12)
  assert.equal(validateNewPassword('short').valid, false)
  assert.equal(validateNewPassword('correct-horse-battery-staple').valid, true)

  const legacyHash = await hashPassword('old-short')
  assert.equal(await verifyPassword('old-short', legacyHash), true)
  assert.equal(await verifyPassword('wrong-password', legacyHash), false)
})

test('usernames are bounded before database and limiter use', () => {
  assert.equal(MAX_USERNAME_LENGTH, 128)
  assert.equal(isValidUsername('cristsau'), true)
  assert.equal(isValidUsername(' 用户名 '), true)
  assert.equal(isValidUsername(''), false)
  assert.equal(isValidUsername('a'.repeat(128)), true)
  assert.equal(isValidUsername('a'.repeat(129)), false)
  assert.equal(isValidUsername('name\u0000suffix'), false)

  const request = { ip: '198.51.100.27' }
  const shortKey = createPublicAuthRateLimitKey('login', request, 'alice')
  const longKey = createPublicAuthRateLimitKey(
    'login',
    request,
    'a'.repeat(1_000_000)
  )
  const anotherLongKey = createPublicAuthRateLimitKey(
    'login',
    request,
    'b'.repeat(1_000_000)
  )

  assert.ok(shortKey.length < 128)
  assert.ok(longKey.length < 128)
  assert.equal(longKey, anotherLongKey)
  assert.equal(shortKey.includes('alice'), false)
})

test('recovery codes are unique, high entropy, normalizable, and stored only as SHA-256', () => {
  const codes = createRecoveryCodes()
  assert.equal(codes.length, 8)
  assert.equal(new Set(codes).size, codes.length)

  const hashes = codes.map((code) => {
    assert.match(code, /^NAV-(?:[0-9A-F]{4}-){9}[0-9A-F]{4}$/)
    assert.equal(isValidRecoveryCode(code), true)
    assert.equal(isValidRecoveryCode(code.toLowerCase().replaceAll('-', ' ')), true)
    return hashRecoveryCode(code)
  })

  assert.equal(new Set(hashes).size, hashes.length)
  for (let index = 0; index < hashes.length; index += 1) {
    assert.match(hashes[index], /^[0-9a-f]{64}$/)
    assert.equal(hashes[index].includes(codes[index]), false)
  }
})

test('fixed-window limiter returns Retry-After, resets, and keeps bounded state', () => {
  let now = 1000
  const limiter = createRequestRateLimiter({
    now: () => now,
    maxKeys: 2
  })

  assert.equal(limiter.consume('ip:one', { limit: 2, windowMs: 10_000 }).allowed, true)
  assert.equal(limiter.consume('ip:one', { limit: 2, windowMs: 10_000 }).allowed, true)
  const denied = limiter.consume('ip:one', { limit: 2, windowMs: 10_000 })
  assert.equal(denied.allowed, false)
  assert.equal(denied.retryAfterSeconds, 10)

  const replyState = {
    statusCode: 200,
    headers: {}
  }
  const reply = {
    header(name, value) {
      replyState.headers[name] = value
      return this
    },
    code(value) {
      replyState.statusCode = value
      return this
    }
  }
  assert.equal(applyRateLimitReply(reply, denied), true)
  assert.equal(replyState.statusCode, 429)
  assert.equal(replyState.headers['Retry-After'], '10')

  limiter.consume('ip:two', { limit: 1, windowMs: 10_000 })
  limiter.consume('ip:three', { limit: 1, windowMs: 10_000 })
  assert.ok(limiter.size <= 2)

  now += 10_001
  assert.equal(limiter.consume('ip:one', { limit: 2, windowMs: 10_000 }).allowed, true)
})

test('login and recovery limits isolate usernames behind the same trusted client IP', () => {
  const limiter = createRequestRateLimiter()
  const request = { ip: '198.51.100.27' }
  const aliceLoginKey = createPublicAuthRateLimitKey(
    'login',
    request,
    ' Alice '
  )
  const aliceLoginKeyAgain = createPublicAuthRateLimitKey(
    'login',
    request,
    'alice'
  )
  const bobLoginKey = createPublicAuthRateLimitKey(
    'login',
    request,
    'bob'
  )

  assert.equal(aliceLoginKey, aliceLoginKeyAgain)
  assert.notEqual(aliceLoginKey, bobLoginKey)
  assert.equal(
    limiter.consume(aliceLoginKey, { limit: 1, windowMs: 60_000 }).allowed,
    true
  )
  assert.equal(
    limiter.consume(aliceLoginKeyAgain, { limit: 1, windowMs: 60_000 }).allowed,
    false
  )
  assert.equal(
    limiter.consume(bobLoginKey, { limit: 1, windowMs: 60_000 }).allowed,
    true
  )

  assert.notEqual(
    createPublicAuthRateLimitKey('recovery', request, 'alice'),
    createPublicAuthRateLimitKey('recovery', request, 'bob')
  )
  assert.equal(
    createPublicAuthRateLimitKey('register', request),
    'register:198.51.100.27'
  )
})

test('authentication routes apply IP and identity recovery limits before password hashing', async () => {
  const source = await readSource('../src/routes/auth.js')

  assert.match(
    source,
    /enforcePublicAuthRateLimit\(\s*'login',\s*request,\s*reply,\s*username\s*\)/
  )
  const loginRoute = source.slice(
    source.indexOf("fastify.post('/auth/login'"),
    source.indexOf("fastify.post('/auth/logout'")
  )
  assert.ok(
    loginRoute.indexOf('if (!isValidUsername(username))')
    < loginRoute.indexOf("enforcePublicAuthRateLimit(\n      'login'")
  )
  assert.match(
    source,
    /enforcePublicAuthRateLimit\(\s*'recovery',\s*request,\s*reply,\s*username\s*\)/
  )
  const recoverRoute = source.slice(source.indexOf("fastify.post('/auth/recover'"))
  const ipLimitIndex = recoverRoute.indexOf(
    "enforcePublicAuthRateLimit(\n      'recovery',\n      request,\n      reply\n    )"
  )
  const identityLimitIndex = recoverRoute.indexOf(
    "enforcePublicAuthRateLimit(\n      'recovery',\n      request,\n      reply,\n      username\n    )"
  )
  const matchCheckIndex = recoverRoute.indexOf('if (!match) return null')
  const hashIndex = recoverRoute.indexOf('await hashPassword(newPassword)')
  const usernameValidationIndex = recoverRoute.indexOf('if (!isValidUsername(username))')

  assert.ok(ipLimitIndex >= 0)
  assert.ok(usernameValidationIndex > ipLimitIndex)
  assert.ok(identityLimitIndex > usernameValidationIndex)
  assert.ok(matchCheckIndex > identityLimitIndex)
  assert.ok(hashIndex > matchCheckIndex)
  assert.match(
    source,
    /enforcePublicAuthRateLimit\('register', request, reply\)/
  )
})

test('login verifies the password and inserts the session while holding the user row lock', async () => {
  const source = await readSource('../src/routes/auth.js')
  const loginRoute = source.slice(
    source.indexOf("fastify.post('/auth/login'"),
    source.indexOf("fastify.post('/auth/logout'")
  )
  const transactionIndex = loginRoute.indexOf('withTransaction(async (client)')
  const lockIndex = loginRoute.indexOf('FOR UPDATE')
  const verifyIndex = loginRoute.indexOf('verifyPassword(password, user.password_hash)')
  const sessionIndex = loginRoute.indexOf('INSERT INTO sessions')
  const transactionEndIndex = loginRoute.indexOf("status: 'authenticated'")

  assert.ok(transactionIndex >= 0)
  assert.ok(lockIndex > transactionIndex)
  assert.ok(verifyIndex > lockIndex)
  assert.ok(sessionIndex > verifyIndex)
  assert.ok(transactionEndIndex > sessionIndex)
  assert.doesNotMatch(loginRoute, /await query\(\s*['`]UPDATE users/)
  assert.doesNotMatch(loginRoute, /await query\(\s*`[\s\S]*INSERT INTO sessions/)
})

test('only loopback reverse proxies are trusted and the resolved request IP is used', () => {
  for (const address of ['127.0.0.1', '127.10.20.30', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackProxyAddress(address), true)
  }
  for (const address of ['10.0.0.1', '192.168.1.1', '203.0.113.10', '::ffff:10.0.0.1']) {
    assert.equal(isLoopbackProxyAddress(address), false)
  }

  assert.equal(
    isTrustedProxyAddress('203.0.113.10', ['203.0.113.10']),
    true
  )
  assert.equal(
    isTrustedProxyAddress('203.0.113.11', ['203.0.113.10']),
    false
  )
  assert.equal(
    isTrustedProxyAddress('203.0.113.10', ['not-an-ip']),
    false
  )

  assert.equal(getTrustedClientIp({ ip: '203.0.113.10' }), '203.0.113.10')
})

test('session activity writes are due no more than once every five minutes', () => {
  const now = Date.parse('2026-07-31T12:00:00.000Z')

  assert.equal(
    shouldTouchSession('2026-07-31T11:55:01.000Z', { now }),
    false
  )
  assert.equal(
    shouldTouchSession('2026-07-31T11:55:00.000Z', { now }),
    true
  )
})

test('session APIs scope deletion to the owner and clear only a revoked current cookie', async () => {
  const source = await readSource('../src/routes/auth.js')

  assert.match(source, /fastify\.get\('\/auth\/sessions'/)
  assert.match(source, /fastify\.delete\('\/auth\/sessions\/:sessionId'/)
  assert.match(
    source,
    /DELETE FROM sessions[\s\S]*WHERE id = \$1[\s\S]*AND user_id = \$2[\s\S]*RETURNING id/
  )
  assert.match(source, /sessionId === request\.session\?\.id/)
  assert.match(source, /if \(revokedCurrentSession\)[\s\S]*clearSessionCookie/)
  assert.match(
    source,
    /revoke-others[\s\S]*DELETE FROM sessions[\s\S]*user_id = \$1[\s\S]*id <> \$2/
  )
  assert.match(
    source,
    /revoke-all[\s\S]*DELETE FROM sessions WHERE user_id = \$1[\s\S]*clearSessionCookie/
  )
})

test('recovery rotation verifies the password and stores hashes while showing plaintext once', async () => {
  const source = await readSource('../src/routes/auth.js')

  assert.match(
    source,
    /fastify\.post\('\/auth\/recovery-codes'[\s\S]*verifyPassword\(currentPassword, user\.password_hash\)/
  )
  assert.match(source, /const recoveryCodeHashes = recoveryCodes\.map\(hashRecoveryCode\)/)
  assert.match(
    source,
    /INSERT INTO account_recovery_codes \(user_id, code_hash\)[\s\S]*UNNEST\(\$2::text\[\]\)/
  )
  assert.match(source, /return \{[\s\S]*codes: recoveryCodes,[\s\S]*shown only once/)
  assert.doesNotMatch(
    source,
    /INSERT INTO account_recovery_codes \(user_id, recovery_code\)/
  )
})

test('recovery status exposes only aggregate active-code metadata', async () => {
  const source = await readSource('../src/routes/auth.js')

  assert.match(source, /fastify\.get\('\/auth\/recovery-codes\/status'/)
  assert.match(source, /COUNT\(\*\) FILTER[\s\S]*active_code_count/)
  assert.match(source, /MAX\(created_at\) FILTER[\s\S]*generated_at/)
  assert.match(source, /configured: activeCodeCount > 0/)
})

test('a successful recovery code use is single-use, changes the password, and revokes all sessions', async () => {
  const source = await readSource('../src/routes/auth.js')

  assert.match(source, /recovery\.used_at IS NULL/)
  assert.match(source, /recovery\.revoked_at IS NULL/)
  assert.match(source, /FOR UPDATE OF u, recovery/)
  assert.match(
    source,
    /UPDATE users[\s\S]*password_hash = \$2[\s\S]*password_changed_at = NOW\(\)/
  )
  assert.match(
    source,
    /UPDATE account_recovery_codes[\s\S]*used_at = CASE[\s\S]*revoked_at = COALESCE/
  )
  assert.match(source, /DELETE FROM sessions WHERE user_id = \$1/)
  assert.match(source, /error: PUBLIC_ACCOUNT_RECOVERY_ERROR/)
  assert.doesNotMatch(source, /request\.log\.(?:info|warn|error)\([^)]*(?:password|recoveryCode)/i)
})

test('authentication plugin throttles session writes and cleans expired rows', async () => {
  const pluginSource = await readSource('../src/plugins/auth.js')
  const appSource = await readSource('../src/app.js')

  assert.match(pluginSource, /shouldTouchSession/)
  assert.match(
    pluginSource,
    /last_seen_at <= NOW\(\) - \(\$2 \|\| ' seconds'\)::interval/
  )
  assert.match(pluginSource, /DELETE FROM sessions WHERE expires_at <= NOW\(\)/)
  assert.match(pluginSource, /consumeAuthenticatedWriteRateLimit/)
  assert.match(appSource, /trustProxy: \(address\) => isTrustedProxyAddress\(address\)/)
})

test('account recovery migration creates constrained hashes and active indexes', async () => {
  const migration = await readSource('../src/db/migrations/011_account_recovery.sql')

  assert.match(migration, /CREATE TABLE IF NOT EXISTS account_recovery_codes/)
  assert.match(migration, /code_hash TEXT NOT NULL UNIQUE/)
  assert.match(migration, /CHECK \(code_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/)
  assert.match(migration, /WHERE used_at IS NULL AND revoked_at IS NULL/)
  assert.match(migration, /idx_sessions_user_expires/)
})

test('session management and recovery-code rotation require authentication', async () => {
  const app = createApp()

  try {
    for (const request of [
      { method: 'GET', url: '/api/auth/sessions' },
      { method: 'POST', url: '/api/auth/sessions/revoke-all' },
      {
        method: 'POST',
        url: '/api/auth/recovery-codes',
        payload: { currentPassword: 'not-logged-in' }
      },
      {
        method: 'GET',
        url: '/api/auth/recovery-codes/status'
      }
    ]) {
      const response = await app.inject(request)
      assert.equal(response.statusCode, 401)
      assert.equal(response.json().error, 'Authentication required')
    }
  } finally {
    await app.close()
  }
})
