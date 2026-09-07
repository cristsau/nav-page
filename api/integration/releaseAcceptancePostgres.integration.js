import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'

const EXPECTED_DATABASE_NAME = 'nav_release_acceptance_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const RATE_LIMIT_SECRET = 'nav-release-acceptance-ci-secret-20260823'
const REAL_ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const REAL_USER_ID = '10000000-0000-4000-8000-000000000002'
const REAL_SESSION_ID = '20000000-0000-4000-8000-000000000001'
const EPHEMERAL_SESSION_ID = '30000000-0000-4000-8000-000000000001'
const EPHEMERAL_GROUP_ID = '40000000-0000-4000-8000-000000000001'
const EPHEMERAL_BOOKMARK_ID = '50000000-0000-4000-8000-000000000001'
const EPHEMERAL_NOTE_ID = '60000000-0000-4000-8000-000000000001'
const CLIENT_IP = '203.0.113.10'
const SECOND_CLIENT_IP = '2001:db8::10'

function assertIsolatedDatabaseTarget() {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.NAV_RELEASE_ACCEPTANCE_INTEGRATION_TEST, 'true')

  let databaseUrl
  try {
    databaseUrl = new URL(String(process.env.DATABASE_URL || ''))
  } catch {
    assert.fail('release acceptance integration requires a valid DATABASE_URL')
  }
  assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol))
  assert.ok(ALLOWED_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase()))
  assert.equal(
    decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, '')),
    EXPECTED_DATABASE_NAME
  )
  for (const key of ['database', 'dbname', 'host', 'hostaddr', 'service']) {
    assert.equal(databaseUrl.searchParams.has(key), false)
  }
}

assertIsolatedDatabaseTarget()

let pool
let withTransaction
let hashPassword
let digestSensitiveValue
let provisionReleaseAcceptanceAccount
let cleanupReleaseAcceptanceAccount
let inspectReleaseAcceptanceLoginEligibility
let recoverExpiredReleaseAcceptanceAccounts
let releaseAcceptanceAccountTtlSeconds
let app

function runId(seed) {
  return createHash('sha256').update(seed).digest('hex').slice(0, 48)
}

function username(seed) {
  return `nav_release_accept_${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

function rateDigest(scope, rawKey) {
  return digestSensitiveValue(`rate-limit:${scope}`, rawKey, {
    secret: RATE_LIMIT_SECRET
  })
}

function authLoginIdentityKey(name, ip) {
  const identityDigest = createHash('sha256').update(name).digest('hex')
  return `login:${ip}:id:${identityDigest}`
}

async function insertBucket(scope, rawKey) {
  await pool.query(
    `
      INSERT INTO rate_limit_buckets (
        scope,
        key_digest,
        window_started_at,
        window_expires_at,
        request_count
      ) VALUES ($1, $2, NOW(), NOW() + INTERVAL '1 hour', 1)
      ON CONFLICT (scope, key_digest) DO NOTHING
    `,
    [scope, rateDigest(scope, rawKey)]
  )
}

async function resetDatabase() {
  await pool.query(
    'TRUNCATE TABLE rate_limit_buckets, security_events, users, system_settings RESTART IDENTITY CASCADE'
  )
  const passwordHash = await hashPassword('real-account-password-for-ci-only')
  await pool.query(
    `
      INSERT INTO users (id, username, password_hash, role, status, approved_at)
      VALUES
        ($1, 'real-admin', $3, 'admin', 'approved', NOW()),
        ($2, 'real-user', $3, 'user', 'approved', NOW())
    `,
    [REAL_ADMIN_ID, REAL_USER_ID, passwordHash]
  )
  await pool.query(
    `
      INSERT INTO user_settings (user_id, key, value)
      VALUES ($1, 'release-acceptance-fixture', '"real"'::jsonb)
    `,
    [REAL_ADMIN_ID]
  )
  await pool.query(
    `
      INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
      VALUES ($1, $2, $3, $4, 'real-user-agent', NOW() + INTERVAL '1 day')
    `,
    [REAL_SESSION_ID, REAL_ADMIN_ID, 'a'.repeat(64), CLIENT_IP]
  )
  await pool.query(
    `
      INSERT INTO security_events (
        event_type,
        outcome,
        actor_user_id,
        subject_user_id,
        resource_type,
        resource_id,
        affected_count
      ) VALUES ('auth.login', 'success', $1, $1, 'session', $2, 1)
    `,
    [REAL_ADMIN_ID, REAL_SESSION_ID]
  )
  await insertBucket('authenticated_write', `user:${REAL_ADMIN_ID}`)
  await insertBucket('auth_login', `login:${CLIENT_IP}`)
}

async function provision(seed) {
  const password = `ephemeral-password-${seed}-with-safe-length`
  const passwordHash = await hashPassword(password)
  const input = {
    runId: runId(seed),
    username: username(seed),
    passwordHash,
    clientIps: [CLIENT_IP, SECOND_CLIENT_IP]
  }
  const result = await withTransaction((client) => (
    provisionReleaseAcceptanceAccount(client, input)
  ))
  return { ...input, ...result, password }
}

async function addEphemeralActivity(account) {
  await pool.query(
    `
      INSERT INTO user_settings (user_id, key, value)
      VALUES ($1, 'release-acceptance-fixture', '"ephemeral"'::jsonb)
    `,
    [account.userId]
  )
  await pool.query(
    `
      INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
      VALUES ($1, $2, $3, $4, 'release-acceptance', NOW() + INTERVAL '1 day')
    `,
    [EPHEMERAL_SESSION_ID, account.userId, 'b'.repeat(64), CLIENT_IP]
  )
  await pool.query(
    `
      INSERT INTO security_events (
        event_type,
        outcome,
        actor_user_id,
        subject_user_id,
        resource_type,
        resource_id,
        affected_count
      ) VALUES
        ('auth.login', 'success', $1, $1, 'session', $2, 1),
        ('auth.logout', 'success', $1, $1, 'session', $2, 1)
    `,
    [account.userId, EPHEMERAL_SESSION_ID]
  )
  await insertBucket('authenticated_write', `user:${account.userId}`)
  await insertBucket('ai_requests', `user:${account.userId}`)
  await insertBucket('data_restore', `user:${account.userId}:session:${EPHEMERAL_SESSION_ID}`)
  await insertBucket(
    'auth_login',
    authLoginIdentityKey(account.username, CLIENT_IP)
  )
  await insertBucket(
    'auth_login',
    authLoginIdentityKey(account.username, SECOND_CLIENT_IP)
  )
  await pool.query(
    `
      INSERT INTO nav_groups (id, user_id, name, icon, color)
      VALUES ($1, $2, 'Release acceptance', 'folder', '#5e6ad2')
    `,
    [EPHEMERAL_GROUP_ID, account.userId]
  )
  await pool.query(
    `
      INSERT INTO nav_bookmarks (
        id, user_id, group_id, title, url, description, tags
      ) VALUES (
        $1, $2, $3, 'Ephemeral bookmark', 'https://example.com/',
        'Release acceptance cleanup fixture', '[]'::jsonb
      )
    `,
    [EPHEMERAL_BOOKMARK_ID, account.userId, EPHEMERAL_GROUP_ID]
  )
  await pool.query(
    `
      INSERT INTO notes (
        id, user_id, number_id, type, title, content,
        encrypted, password_hash, tags, attachments
      ) VALUES (
        $1, $2, 9901, 'memo', 'Ephemeral note',
        'Release acceptance cleanup fixture', FALSE, '', '[]'::jsonb, '[]'::jsonb
      )
    `,
    [EPHEMERAL_NOTE_ID, account.userId]
  )
}

function runCli(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve(import.meta.dirname, '../src/ops/releaseAcceptanceAccountCli.js'), command],
      {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error)
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(input || {}))
  })
}

before(async () => {
  const [databaseModule, authModule, rateLimitModule, acceptanceModule, appModule] = await Promise.all([
    import('../src/db/index.js'),
    import('../src/lib/auth.js'),
    import('../src/lib/persistentRateLimit.js'),
    import('../src/ops/releaseAcceptanceAccount.js'),
    import('../src/app.js')
  ])
  pool = databaseModule.pool
  withTransaction = databaseModule.withTransaction
  hashPassword = authModule.hashPassword
  digestSensitiveValue = rateLimitModule.digestSensitiveValue
  provisionReleaseAcceptanceAccount = acceptanceModule.provisionReleaseAcceptanceAccount
  cleanupReleaseAcceptanceAccount = acceptanceModule.cleanupReleaseAcceptanceAccount
  inspectReleaseAcceptanceLoginEligibility = acceptanceModule.inspectReleaseAcceptanceLoginEligibility
  recoverExpiredReleaseAcceptanceAccounts = acceptanceModule.recoverExpiredReleaseAcceptanceAccounts
  releaseAcceptanceAccountTtlSeconds = acceptanceModule.RELEASE_ACCEPTANCE_ACCOUNT_TTL_SECONDS
  app = appModule.createApp()

  const target = await pool.query(
    `
      SELECT
        current_database() AS database_name,
        current_setting('server_version_num') AS server_version_num
    `
  )
  assert.equal(target.rows[0]?.database_name, EXPECTED_DATABASE_NAME)
  assert.match(String(target.rows[0]?.server_version_num || ''), /^16[0-9]{4}$/)
})

beforeEach(resetDatabase)

after(async () => {
  await app.close()
  await pool.end()
})

test('ephemeral administrator lifecycle preserves real accounts and shared IP buckets', async () => {
  const account = await provision('complete-lifecycle')
  await addEphemeralActivity(account)

  const cleanup = await withTransaction((client) => (
    cleanupReleaseAcceptanceAccount(client, {
      runId: account.runId,
      expectedUsername: account.username,
      expectedUserId: account.userId
    })
  ))
  assert.equal(cleanup.cleaned, true)
  assert.equal(cleanup.usersRemoved, 1)
  assert.equal(cleanup.sessionsRemoved, 1)
  assert.equal(cleanup.securityEventsRemoved, 2)
  assert.equal(cleanup.rateLimitBucketsRemoved, 5)

  const realState = await pool.query(
    `
      SELECT
        (SELECT COUNT(*) FROM users WHERE id IN ($1, $2))::integer AS users,
        (SELECT COUNT(*) FROM sessions WHERE id = $3)::integer AS sessions,
        (SELECT COUNT(*) FROM security_events WHERE actor_user_id = $1)::integer AS events,
        (SELECT COUNT(*) FROM rate_limit_buckets)::integer AS buckets,
        (SELECT COUNT(*) FROM user_settings WHERE user_id = $1)::integer AS real_settings,
        (SELECT COUNT(*) FROM user_settings WHERE user_id NOT IN ($1, $2))::integer AS ephemeral_settings,
        (SELECT COUNT(*) FROM notes WHERE user_id NOT IN ($1, $2))::integer AS ephemeral_notes,
        (SELECT COUNT(*) FROM nav_bookmarks WHERE user_id NOT IN ($1, $2))::integer AS ephemeral_bookmarks,
        (SELECT COUNT(*) FROM workspace_search_index_state WHERE user_id NOT IN ($1, $2))::integer AS ephemeral_search_states
    `,
    [REAL_ADMIN_ID, REAL_USER_ID, REAL_SESSION_ID]
  )
  assert.deepEqual(realState.rows[0], {
    users: 2,
    sessions: 1,
    events: 1,
    buckets: 2,
    real_settings: 1,
    ephemeral_settings: 0,
    ephemeral_notes: 0,
    ephemeral_bookmarks: 0,
    ephemeral_search_states: 0
  })

  const exactBuckets = await pool.query(
    `
      SELECT scope, key_digest
      FROM rate_limit_buckets
      ORDER BY scope, key_digest
    `
  )
  assert.deepEqual(
    exactBuckets.rows.map((row) => `${row.scope}:${row.key_digest}`).sort(),
    [
      `auth_login:${rateDigest('auth_login', `login:${CLIENT_IP}`)}`,
      `authenticated_write:${rateDigest('authenticated_write', `user:${REAL_ADMIN_ID}`)}`
    ].sort()
  )

  const repeated = await withTransaction((client) => (
    cleanupReleaseAcceptanceAccount(client, {
      runId: account.runId,
      expectedUsername: account.username
    })
  ))
  assert.equal(repeated.cleaned, false)
  assert.equal(repeated.markerMissing, true)
})

test('expired acceptance administrator cannot log in and is recovered by exact marker and UUID', async () => {
  const account = await provision('expired-login-recovery')
  const markerKey = `release_acceptance_account:${account.runId}`
  const markerBeforeExpiry = await pool.query(
    `
      SELECT
        value,
        EXTRACT(EPOCH FROM ((value->>'expiresAt')::timestamptz - updated_at))::integer AS ttl_seconds
      FROM system_settings
      WHERE key = $1
    `,
    [markerKey]
  )
  assert.equal(markerBeforeExpiry.rowCount, 1)
  assert.equal(markerBeforeExpiry.rows[0].value.version, 3)
  assert.equal(markerBeforeExpiry.rows[0].ttl_seconds, releaseAcceptanceAccountTtlSeconds)

  const activeLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'sec-fetch-site': 'same-origin' },
    payload: {
      username: account.username,
      password: account.password
    }
  })
  assert.equal(activeLogin.statusCode, 200)
  const sessionCookie = String(activeLogin.headers['set-cookie'] || '')
    .split(';', 1)[0]
  assert.match(sessionCookie, /^nav_session=/)

  const rename = await app.inject({
    method: 'PUT',
    url: '/api/auth/account/username',
    headers: { cookie: sessionCookie, 'sec-fetch-site': 'same-origin' },
    payload: {
      currentPassword: account.password,
      username: 'escaped-release-admin'
    }
  })
  assert.equal(rename.statusCode, 403)
  assert.equal(
    (await pool.query('SELECT username FROM users WHERE id = $1', [account.userId])).rows[0].username,
    account.username
  )

  await pool.query(
    `
      UPDATE system_settings
      SET value = jsonb_set(
            value,
            '{expiresAt}',
            to_jsonb((NOW() - INTERVAL '1 second')::timestamptz)
          ),
          updated_at = NOW()
      WHERE key = $1
    `,
    [markerKey]
  )

  const eligibility = await inspectReleaseAcceptanceLoginEligibility(pool, {
    userId: account.userId,
    username: account.username
  })
  assert.equal(eligibility.active, false)
  assert.equal(eligibility.reason, 'expired')

  const expiredSession = await app.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: { cookie: sessionCookie }
  })
  assert.equal(expiredSession.statusCode, 200)
  assert.deepEqual(expiredSession.json(), { user: null })

  const expiredLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'sec-fetch-site': 'same-origin' },
    payload: {
      username: account.username,
      password: account.password
    }
  })
  assert.equal(expiredLogin.statusCode, 401)
  assert.deepEqual(expiredLogin.json(), { error: 'Invalid username or password' })
  assert.equal(
    Number((await pool.query(
      'SELECT COUNT(*) FROM sessions WHERE user_id = $1',
      [account.userId]
    )).rows[0].count),
    0
  )

  const recovery = await recoverExpiredReleaseAcceptanceAccounts({
    poolInstance: pool
  })
  assert.equal(recovery.examinedCount, 1)
  assert.equal(recovery.cleanedCount, 1)
  assert.equal(recovery.failedCount, 0)

  const state = await pool.query(
    `
      SELECT
        (SELECT COUNT(*) FROM users WHERE id = $1)::integer AS ephemeral_users,
        (SELECT COUNT(*) FROM system_settings WHERE key = $2)::integer AS markers,
        (SELECT COUNT(*) FROM users WHERE id IN ($3, $4))::integer AS real_users
    `,
    [account.userId, markerKey, REAL_ADMIN_ID, REAL_USER_ID]
  )
  assert.deepEqual(state.rows[0], {
    ephemeral_users: 0,
    markers: 0,
    real_users: 2
  })
})

test('untracked prefix residue blocks both provision and clean reporting', async () => {
  await pool.query(
    `
      INSERT INTO users (username, password_hash, role, status, approved_at)
      VALUES ($1, $2, 'admin', 'approved', NOW())
    `,
    [username('untracked'), await hashPassword('untracked-password-with-safe-length')]
  )

  await assert.rejects(
    provision('blocked-by-residue'),
    { code: 'ACCEPTANCE_ACCOUNT_RESIDUE_PRESENT' }
  )
  await assert.rejects(
    withTransaction((client) => cleanupReleaseAcceptanceAccount(client, {
      runId: runId('unknown-run'),
      expectedUsername: username('unknown-run'),
      rateLimitSecret: RATE_LIMIT_SECRET
    })),
    { code: 'UNTRACKED_ACCEPTANCE_ACCOUNT_RESIDUE' }
  )
})

test('provisioned state cannot be reported clean after marker and account disappear', async () => {
  const account = await provision('externally-removed')
  await pool.query(
    'DELETE FROM system_settings WHERE key = $1',
    [`release_acceptance_account:${account.runId}`]
  )
  await pool.query('DELETE FROM users WHERE id = $1', [account.userId])

  await assert.rejects(
    withTransaction((client) => cleanupReleaseAcceptanceAccount(client, {
      runId: account.runId,
      expectedUsername: account.username,
      expectedUserId: account.userId,
      rateLimitSecret: RATE_LIMIT_SECRET
    })),
    { code: 'EXPECTED_ACCEPTANCE_ACCOUNT_MISSING' }
  )
})

test('marker mismatch and injected post-cleanup failure roll back every delete', async () => {
  const account = await provision('rollback-cleanup')
  await addEphemeralActivity(account)
  const markerKey = `release_acceptance_account:${account.runId}`

  await pool.query(
    `
      UPDATE system_settings
      SET value = jsonb_set(value, '{username}', to_jsonb($2::text))
      WHERE key = $1
    `,
    [markerKey, username('different-account')]
  )
  await assert.rejects(
    withTransaction((client) => cleanupReleaseAcceptanceAccount(client, {
      runId: account.runId,
      expectedUsername: account.username,
      expectedUserId: account.userId,
      rateLimitSecret: RATE_LIMIT_SECRET
    })),
    { code: 'ACCEPTANCE_MARKER_USERNAME_MISMATCH' }
  )
  assert.equal(
    Number((await pool.query('SELECT COUNT(*) FROM users WHERE id = $1', [account.userId])).rows[0].count),
    1
  )

  await pool.query(
    `
      UPDATE system_settings
      SET value = jsonb_set(value, '{username}', to_jsonb($2::text))
      WHERE key = $1
    `,
    [markerKey, account.username]
  )
  await pool.query(
    `
      UPDATE system_settings
      SET value = jsonb_set(value, '{userId}', to_jsonb($2::text))
      WHERE key = $1
    `,
    [markerKey, REAL_USER_ID]
  )
  await assert.rejects(
    withTransaction((client) => cleanupReleaseAcceptanceAccount(client, {
      runId: account.runId,
      expectedUsername: account.username,
      expectedUserId: account.userId,
      rateLimitSecret: RATE_LIMIT_SECRET
    })),
    { code: 'ACCEPTANCE_MARKER_USER_ID_MISMATCH' }
  )
  await pool.query(
    `
      UPDATE system_settings
      SET value = jsonb_set(value, '{userId}', to_jsonb($2::text))
      WHERE key = $1
    `,
    [markerKey, account.userId]
  )
  await assert.rejects(
    withTransaction(async (client) => {
      await cleanupReleaseAcceptanceAccount(client, {
        runId: account.runId,
        expectedUsername: account.username,
        expectedUserId: account.userId,
        rateLimitSecret: RATE_LIMIT_SECRET
      })
      throw new Error('injected transaction failure')
    }),
    /injected transaction failure/
  )
  const rolledBack = await pool.query(
    `
      SELECT
        (SELECT COUNT(*) FROM users WHERE id = $1)::integer AS users,
        (SELECT COUNT(*) FROM sessions WHERE user_id = $1)::integer AS sessions,
        (SELECT COUNT(*) FROM security_events WHERE actor_user_id = $1)::integer AS events,
        (SELECT COUNT(*) FROM system_settings WHERE key = $2)::integer AS markers,
        (SELECT COUNT(*) FROM notes WHERE user_id = $1)::integer AS notes,
        (SELECT COUNT(*) FROM nav_bookmarks WHERE user_id = $1)::integer AS bookmarks,
        (SELECT COUNT(*) FROM workspace_search_index_state WHERE user_id = $1)::integer AS search_states
    `,
    [account.userId, markerKey]
  )
  assert.deepEqual(rolledBack.rows[0], {
    users: 1,
    sessions: 1,
    events: 2,
    markers: 1,
    notes: 1,
    bookmarks: 1,
    search_states: 1
  })

  await withTransaction((client) => cleanupReleaseAcceptanceAccount(client, {
    runId: account.runId,
    expectedUsername: account.username,
    expectedUserId: account.userId,
    rateLimitSecret: RATE_LIMIT_SECRET
  }))
})

test('production CLI path uses configured rate-limit secret and reports database identity', async () => {
  const cliRunId = runId('cli-lifecycle')
  const cliUsername = username('cli-lifecycle')
  const provisioned = await runCli('provision', {
    runId: cliRunId,
    username: cliUsername,
    password: 'cli-ephemeral-password-with-more-than-forty-eight-characters-20260823',
    clientIps: [CLIENT_IP]
  })
  assert.equal(provisioned.code, 0, provisioned.stderr)
  assert.doesNotMatch(`${provisioned.stdout}${provisioned.stderr}`, /password|scrypt:/i)
  const provisionResult = JSON.parse(provisioned.stdout)
  assert.equal(provisionResult.ok, true)

  const status = await runCli('status')
  assert.equal(status.code, 0, status.stderr)
  const statusResult = JSON.parse(status.stdout)
  assert.equal(statusResult.databaseName, EXPECTED_DATABASE_NAME)
  assert.match(statusResult.databaseOid, /^[0-9]+$/)
  assert.match(statusResult.serverVersionNum, /^16[0-9]{4}$/)
  assert.equal(statusResult.markerCount, 1)
  assert.equal(statusResult.userCount, 1)

  const cleaned = await runCli('cleanup', {
    runId: cliRunId,
    expectedUsername: cliUsername,
    expectedUserId: provisionResult.userId
  })
  assert.equal(cleaned.code, 0, cleaned.stderr)
  assert.doesNotMatch(`${cleaned.stdout}${cleaned.stderr}`, /password|scrypt:/i)
  const cleanupResult = JSON.parse(cleaned.stdout)
  assert.equal(cleanupResult.cleaned, true)
  assert.equal(cleanupResult.usersRemoved, 1)
})

test('database advisory lock permits only one concurrent acceptance account', async () => {
  const passwordHash = await hashPassword('concurrent-password-with-safe-length')
  const candidates = ['concurrent-a', 'concurrent-b'].map((seed) => ({
    runId: runId(seed),
    username: username(seed),
    passwordHash,
    clientIps: [CLIENT_IP]
  }))
  const results = await Promise.allSettled(candidates.map((candidate) => (
    withTransaction((client) => provisionReleaseAcceptanceAccount(client, candidate))
  )))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.code,
    'ACCEPTANCE_ACCOUNT_RESIDUE_PRESENT'
  )

  const acceptedIndex = results.findIndex((result) => result.status === 'fulfilled')
  await withTransaction((client) => cleanupReleaseAcceptanceAccount(client, {
    runId: candidates[acceptedIndex].runId,
    expectedUsername: candidates[acceptedIndex].username,
    expectedUserId: results[acceptedIndex].value.userId,
    rateLimitSecret: RATE_LIMIT_SECRET
  }))
})
