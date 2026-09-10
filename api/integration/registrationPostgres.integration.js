import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

// Refuse normal app/production databases before importing configuration or connecting.
assert.equal(process.env.NODE_ENV, 'test')
assert.equal(process.env.NAV_REGISTRATION_INTEGRATION_TEST, 'true')
const target = new URL(process.env.DATABASE_URL)
assert.equal(target.protocol, 'postgres:')
assert.equal(target.hostname, '127.0.0.1')
assert.equal(target.pathname, '/nav_registration_test')
assert.equal(target.username, 'nav_registration_test')
assert.equal(target.search, '')
assert.equal(target.password, '')
assert.ok(Number(target.port) > 1024)
const expectedData = path.resolve(process.env.NAV_REGISTRATION_TEST_DATA_DIR)
assert.match(path.basename(path.dirname(expectedData)), /^nav-registration-check-[a-zA-Z0-9_-]+$/)
assert.equal(path.basename(expectedData), 'data')

const { config } = await import('../src/config.js')
const { pool, runMigrations } = await import('../src/db/index.js')
const { createApp } = await import('../src/app.js')
const { hashPassword, verifyPassword } = await import('../src/lib/auth.js')
const origins = ['https://nav.skrskr.net', 'https://nav.cristsau.cn']
const password = randomBytes(24).toString('base64url')
const proofs = new Map()
const realFetch = globalThis.fetch
let app, passwordHash, originalSql, fixedSql

function browser(origin = origins[0]) {
  const cookies = {}
  return {
    origin, cookies,
    async call(route, payload, { method = 'POST', action, proof = true } = {}) {
      if (action && proof) {
        const token = randomBytes(24).toString('base64url')
        proofs.set(token, { hostname: new URL(origin).hostname, action })
        payload = { ...payload, turnstileToken: token }
      }
      const response = await app.inject({ method, url: `/api${route}`, headers: { origin, host: new URL(origin).host }, cookies, payload })
      for (const cookie of response.cookies) cookies[cookie.name] = cookie.value
      return response
    }
  }
}

function register(client, username, email = `${username}@example.test`, options = {}) {
  return client.call('/auth/register', { username, email, password, ...options.payload }, { action: 'register', ...options })
}

async function counts() {
  return (await pool.query(`SELECT
    (SELECT COUNT(*)::integer FROM registration_requests) AS requests,
    (SELECT COUNT(*)::integer FROM users) AS users,
    (SELECT COUNT(*)::integer FROM mail_outbox) AS messages`)).rows[0]
}

async function verification(requestId) {
  const result = await pool.query("SELECT text_body FROM mail_outbox WHERE message_type='registration.verify' AND dedupe_key LIKE $1 ORDER BY created_at DESC", [`registration-verify:${requestId}:%`])
  const link = result.rows[0]?.text_body.match(/https:\/\/[^\s]+/)?.[0]
  assert.ok(link, 'Local outbox must contain the verification link')
  const url = new URL(link)
  assert.equal(url.search, '')
  assert.ok(url.hash.startsWith('#register-verify?'))
  const params = new URLSearchParams(url.hash.split('?')[1])
  assert.equal(params.get('request'), requestId)
  return params.get('token')
}

before(async () => {
  const actual = (await pool.query('SHOW data_directory')).rows[0].data_directory
  assert.equal(path.resolve(actual).toLowerCase(), expectedData.toLowerCase(), 'Refuse a database outside the newly created test cluster')
  assert.match((await pool.query('SHOW server_version')).rows[0].server_version, /^16\./)
  assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM information_schema.tables WHERE table_schema='public'")).rows[0].count, 0, 'Require an empty disposable database')
  await runMigrations()
  const column = (await pool.query("SELECT data_type,character_maximum_length FROM information_schema.columns WHERE table_name='registration_requests' AND column_name='verification_token_hash'")).rows[0]
  assert.deepEqual(column, { data_type: 'character', character_maximum_length: 64 })
  const fixtureSecret = path.join(path.dirname(expectedData), 'synthetic-smtp.txt')
  await fs.writeFile(fixtureSecret, randomBytes(32).toString('hex'), { mode: 0o600 })
  Object.assign(config, {
    apiLogLevel: 'silent', registrationEmailEnabled: true, registrationEmailVerificationMinutes: 30,
    corsOrigin: origins.join(','), publicAppOrigin: origins[0], adminEmailRecipients: [],
    mailDeliveryEnabled: true, smtpHost: 'localhost', smtpPort: 465, smtpSecure: true,
    smtpUsername: 'sender@example.test', smtpFromAddress: 'sender@example.test', smtpPasswordFile: fixtureSecret,
    smtpOauthProvider: '', turnstileEnabled: true, turnstileSiteKey: 'synthetic-site', turnstileSecretKey: 'synthetic-secret'
  })
  // Real bot-guard code; only the external provider is stubbed. No external fetch is allowed.
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
    const body = JSON.parse(options.body)
    assert.equal(body.secret, 'synthetic-secret')
    const value = proofs.get(body.response)
    proofs.delete(body.response)
    return { ok: true, async json() { return value ? { success: true, ...value, challenge_ts: new Date().toISOString() } : { success: false } } }
  }
  const source = await fs.readFile(new URL('../src/routes/auth.js', import.meta.url), 'utf8')
  fixedSql = source.match(/INSERT INTO registration_requests \([\s\S]*?created_at, updated_at, decided_at, decided_by/)?.[0]
  assert.ok(fixedSql?.includes('$1, $2, $3, $4, $5::text,'))
  originalSql = fixedSql.replace('$1, $2, $3, $4, $5::text,', '$1, $2, $3, $4, $5,')
  passwordHash = await hashPassword(password)
  app = createApp()
  app.get('/api/test-registration-db-failure', { config: { skipSession: true } }, async () => {
    await pool.query(originalSql, ['synthetic-error', passwordHash, null, 'pending', null, 30])
  })
  await app.ready()
})

beforeEach(async () => {
  await pool.query('TRUNCATE users, registration_requests, mail_outbox, rate_limit_buckets, security_events RESTART IDENTITY CASCADE')
  await pool.query("INSERT INTO users(username,password_hash,role,status) VALUES('synthetic-review-admin',$1,'admin','approved')", [passwordHash])
  config.registrationEmailEnabled = true
  config.mailDeliveryEnabled = true
  proofs.clear()
})

after(async () => {
  globalThis.fetch = realFetch
  await app?.close()
  await pool.end()
})

test('real PostgreSQL rejects the original parameter conflict and accepts the fixed query', async () => {
  const values = ['synthetic-parse', passwordHash, null, 'pending', null, 30]
  await assert.rejects(pool.query(originalSql, values), { code: '42P08', message: 'inconsistent types deduced for parameter $5' })
  assert.equal((await counts()).requests, 0)
  const inserted = await pool.query(fixedSql, values)
  assert.equal(inserted.rows[0].status, 'pending')
})

for (const [index, origin] of origins.entries()) {
  test(`registration, email proof, approval and ordinary-user login on domain ${index + 1}`, async () => {
    const user = browser(origin), admin = browser(origin)
    const username = `synthetic-flow-${index}`
    const registration = await register(user, username)
    assert.equal(registration.statusCode, 201)
    const request = registration.json().request
    assert.equal(request.status, 'email_pending')
    assert.equal((await counts()).users, 1)
    assert.equal((await counts()).messages, 1)
    assert.doesNotMatch(registration.body, /password_hash|verification_token_hash|verification_expires_at/)
    const token = await verification(request.id)
    const pending = (await pool.query('SELECT * FROM registration_requests WHERE id=$1', [request.id])).rows[0]
    assert.equal(pending.verification_token_hash, createHash('sha256').update(token).digest('hex'))
    assert.ok(pending.verification_expires_at > new Date())
    assert.equal(await verifyPassword(password, pending.password_hash), true)
    assert.equal((await user.call('/auth/login', { username, password }, { action: 'password_login' })).statusCode, 401)
    assert.equal((await admin.call(`/admin/registration-requests/${request.id}/approve`)).statusCode, 401)
    assert.equal((await user.call('/auth/register/verify', { requestId: request.id, token: 'x'.repeat(43) })).statusCode, 400)
    const verified = await user.call('/auth/register/verify', { requestId: request.id, token })
    assert.equal(verified.statusCode, 200)
    assert.equal(verified.json().request.status, 'pending')
    assert.equal((await user.call('/auth/register/verify', { requestId: request.id, token })).statusCode, 400)
    const adminLogin = await admin.call('/auth/login', { username: 'synthetic-review-admin', password }, { action: 'password_login' })
    assert.equal(adminLogin.statusCode, 200)
    const approved = await admin.call(`/admin/registration-requests/${request.id}/approve`)
    assert.equal(approved.statusCode, 200)
    assert.equal(approved.json().request.status, 'approved')
    const repeat = await admin.call(`/admin/registration-requests/${request.id}/approve`)
    assert.equal(repeat.statusCode, 200)
    assert.equal((await counts()).users, 2)
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS count FROM mail_outbox WHERE message_type='registration.approved'")).rows[0].count, 1)
    const login = await user.call('/auth/login', { username, password }, { action: 'password_login' })
    assert.equal(login.statusCode, 200)
    assert.equal(login.json().user.role, 'user')
    assert.equal(login.json().user.status, 'approved')
    assert.ok(login.cookies.some(cookie => cookie.httpOnly))
    assert.equal((await user.call('/admin/users', undefined, { method: 'GET' })).statusCode, 403)
    assert.equal((await user.call('/auth/session', undefined, { method: 'GET' })).json().user.username, username)
    assert.equal((await user.call('/auth/logout')).statusCode, 200)
    assert.equal((await user.call('/auth/session', undefined, { method: 'GET' })).json().user, null)
  })
}

test('email-disabled registration accepts null proof without weakening pending approval', async () => {
  config.registrationEmailEnabled = false
  const response = await register(browser(), 'synthetic-without-email', undefined)
  assert.equal(response.statusCode, 201)
  assert.equal(response.json().request.status, 'pending')
  const row = (await pool.query('SELECT email,verification_token_hash,verification_expires_at,verification_sent_at FROM registration_requests')).rows[0]
  assert.deepEqual(row, { email: null, verification_token_hash: null, verification_expires_at: null, verification_sent_at: null })
  assert.equal((await counts()).users, 1)
  assert.equal((await counts()).messages, 0)
})

test('concurrent duplicate registration returns one success, one conflict and one verification message', async () => {
  const user = browser()
  const responses = await Promise.all([register(user, 'synthetic-duplicate'), register(user, 'synthetic-duplicate')])
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [201, 409])
  assert.deepEqual(await counts(), { requests: 1, users: 1, messages: 1 })
  assert.equal((await register(user, 'synthetic-other-name', 'synthetic-duplicate@example.test')).statusCode, 409)
})

test('missing bot proof, weak passwords and unavailable mail cannot create registration requests', async () => {
  const user = browser()
  const missing = await register(user, 'synthetic-missing-proof', undefined, { proof: false })
  assert.equal(missing.statusCode, 403)
  assert.equal(missing.json().code, 'BOT_CHALLENGE_REQUIRED')
  assert.equal((await register(user, 'synthetic-weak', undefined, { payload: { password: 'short' } })).statusCode, 400)
  assert.equal((await register(user, 'synthetic-bad-email', 'invalid')).statusCode, 400)
  config.mailDeliveryEnabled = false
  assert.equal((await register(user, 'synthetic-no-mail')).statusCode, 503)
  assert.deepEqual(await counts(), { requests: 0, users: 1, messages: 0 })
})

test('expired verification fails and a fresh registration request can be submitted', async () => {
  const user = browser()
  const first = await register(user, 'synthetic-expired')
  assert.equal(first.statusCode, 201)
  const id = first.json().request.id, token = await verification(id)
  await pool.query("UPDATE registration_requests SET verification_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [id])
  assert.equal((await user.call('/auth/register/verify', { requestId: id, token })).statusCode, 400)
  const second = await register(user, 'synthetic-expired')
  assert.equal(second.statusCode, 201)
  assert.notEqual(second.json().request.id, id)
  assert.equal((await pool.query('SELECT status FROM registration_requests WHERE id=$1', [id])).rows[0].status, 'expired')
})

test('outbox failure removes the incomplete request, returns safe error and permits retry', async () => {
  await pool.query("ALTER TABLE mail_outbox ADD CONSTRAINT synthetic_registration_mail_failure CHECK (message_type <> 'registration.verify')")
  try {
    const failed = await register(browser(), 'synthetic-outbox-failure')
    assert.equal(failed.statusCode, 500)
    assert.deepEqual(failed.json(), { error: '服务暂时不可用，请稍后重试。' })
    assert.deepEqual(await counts(), { requests: 0, users: 1, messages: 0 })
  } finally {
    await pool.query('ALTER TABLE mail_outbox DROP CONSTRAINT synthetic_registration_mail_failure')
  }
  assert.equal((await register(browser(), 'synthetic-outbox-failure')).statusCode, 201)
})

test('the original SQL failure is sanitized by the real API error handler', async () => {
  const response = await browser().call('/test-registration-db-failure', undefined, { method: 'GET' })
  assert.equal(response.statusCode, 500)
  assert.deepEqual(response.json(), { error: '服务暂时不可用，请稍后重试。' })
  assert.deepEqual(await counts(), { requests: 0, users: 1, messages: 0 })
})
