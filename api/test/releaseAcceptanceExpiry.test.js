import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  evaluateReleaseAcceptanceMarker,
  inspectReleaseAcceptanceLoginEligibility,
  recoverExpiredReleaseAcceptanceAccounts,
  RELEASE_ACCEPTANCE_ACCOUNT_TTL_SECONDS,
  startReleaseAcceptanceAccountRecovery
} from '../src/ops/releaseAcceptanceAccount.js'

const RUN_ID = 'a'.repeat(48)
const USERNAME = `nav_release_accept_${'b'.repeat(32)}`
const USER_ID = '10000000-0000-4000-8000-000000000001'
const MARKER_KEY = `release_acceptance_account:${RUN_ID}`

function marker(overrides = {}) {
  return {
    version: 3,
    runId: RUN_ID,
    username: USERNAME,
    userId: USER_ID,
    clientIps: ['203.0.113.10'],
    expiresAt: '2026-08-23T10:30:00.000Z',
    ...overrides
  }
}

async function readSource(relativeUrl) {
  return (await readFile(new URL(relativeUrl, import.meta.url), 'utf8'))
    .replace(/\r\n?/g, '\n')
}

test('release acceptance marker uses a fixed bounded TTL and expires at the boundary', () => {
  assert.equal(RELEASE_ACCEPTANCE_ACCOUNT_TTL_SECONDS, 30 * 60)
  assert.equal(
    evaluateReleaseAcceptanceMarker(marker(), {
      now: '2026-08-23T10:29:59.999Z'
    }).expired,
    false
  )
  assert.equal(
    evaluateReleaseAcceptanceMarker(marker(), {
      now: '2026-08-23T10:30:00.000Z'
    }).expired,
    true
  )
})

test('legacy and malformed markers fail closed for authentication', async () => {
  assert.equal(
    evaluateReleaseAcceptanceMarker(marker({
      version: 2,
      expiresAt: undefined
    }), {
      now: '2026-08-23T10:00:00.000Z'
    }).expired,
    true
  )
  assert.throws(
    () => evaluateReleaseAcceptanceMarker(marker({ expiresAt: '' })),
    { code: 'INVALID_ACCEPTANCE_MARKER' }
  )

  const malformedClient = {
    async query() {
      return {
        rowCount: 1,
        rows: [{
          key: MARKER_KEY,
          value: marker({ expiresAt: '' }),
          database_now: new Date('2026-08-23T10:00:00.000Z')
        }]
      }
    }
  }
  assert.deepEqual(
    await inspectReleaseAcceptanceLoginEligibility(malformedClient, {
      userId: USER_ID,
      username: USERNAME
    }),
    { applicable: true, active: false, reason: 'invalid-marker' }
  )
})

test('login eligibility requires one exact marker key and UUID', async () => {
  const client = {
    async query(sql, params) {
      assert.match(sql, /value->>'username' = \$1/)
      assert.match(sql, /value->>'userId' = \$2/)
      assert.deepEqual(params, [USERNAME, USER_ID])
      return {
        rowCount: 1,
        rows: [{
          key: MARKER_KEY,
          value: marker(),
          database_now: new Date('2026-08-23T10:00:00.000Z')
        }]
      }
    }
  }

  assert.deepEqual(
    await inspectReleaseAcceptanceLoginEligibility(client, {
      userId: USER_ID,
      username: USERNAME
    }),
    {
      applicable: true,
      active: true,
      reason: 'active',
      expiresAt: '2026-08-23T10:30:00.000Z'
    }
  )

  const wrongKeyClient = {
    async query() {
      return {
        rowCount: 1,
        rows: [{
          key: `release_acceptance_account:${'c'.repeat(48)}`,
          value: marker(),
          database_now: new Date('2026-08-23T10:00:00.000Z')
        }]
      }
    }
  }
  assert.equal(
    (await inspectReleaseAcceptanceLoginEligibility(wrongKeyClient, {
      userId: USER_ID,
      username: USERNAME
    })).active,
    false
  )
})

test('recovery refuses malformed marker ownership without issuing a delete', async () => {
  let connectCalls = 0
  let deleteCalls = 0
  const statements = []
  const client = {
    async query(sql) {
      statements.push(sql)
      if (/^\s*SELECT key, value/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            key: MARKER_KEY,
            value: marker({ userId: 'not-a-uuid' }),
            database_now: new Date('2026-08-23T11:00:00.000Z')
          }]
        }
      }
      if (/DELETE/i.test(sql)) deleteCalls += 1
      return { rowCount: 0, rows: [] }
    },
    release() {}
  }
  const poolInstance = {
    async connect() {
      connectCalls += 1
      return client
    },
    async query() {
      throw new Error('recovery queries must use a bounded transaction')
    }
  }

  const result = await recoverExpiredReleaseAcceptanceAccounts({ poolInstance })
  assert.equal(result.cleanedCount, 0)
  assert.equal(result.failedCount, 1)
  assert.equal(connectCalls, 1)
  assert.equal(deleteCalls, 0)
  assert.ok(statements.includes("SET LOCAL lock_timeout = '5s'"))
  assert.ok(statements.includes("SET LOCAL statement_timeout = '15s'"))
})

test('periodic recovery does not overlap and stop waits for the active run', async () => {
  let intervalCallback
  let clearCalls = 0
  const timerApi = {
    setInterval(callback, intervalMs) {
      assert.equal(intervalMs, 1234)
      intervalCallback = callback
      return { unref() {} }
    },
    clearInterval() {
      clearCalls += 1
    }
  }
  let resolveRun
  let runs = 0
  const runPromise = new Promise((resolve) => { resolveRun = resolve })
  const stop = startReleaseAcceptanceAccountRecovery({
    poolInstance: {},
    timerApi,
    intervalMs: 1234,
    recoverFn: async () => {
      runs += 1
      return runPromise
    }
  })

  intervalCallback()
  intervalCallback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runs, 1)
  const stopping = stop()
  resolveRun({ cleanedCount: 0, failedCount: 0 })
  await stopping
  assert.equal(clearCalls, 1)
})

test('login, session authentication, and startup are wired fail-closed', async () => {
  const [routeSource, pluginSource, serverSource] = await Promise.all([
    readSource('../src/routes/auth.js'),
    readSource('../src/plugins/auth.js'),
    readSource('../src/server.js')
  ])
  const loginRoute = routeSource.slice(
    routeSource.indexOf("fastify.post('/auth/login'"),
    routeSource.indexOf("fastify.post('/auth/logout'")
  )
  assert.ok(
    loginRoute.indexOf('inspectReleaseAcceptanceLoginEligibility')
      < loginRoute.indexOf('INSERT INTO sessions')
  )
  assert.match(loginRoute, /if \(!eligibility\.active\)/)
  assert.match(
    routeSource,
    /Release acceptance accounts cannot change identity/
  )

  assert.ok(
    pluginSource.indexOf('inspectReleaseAcceptanceLoginEligibility')
      < pluginSource.indexOf('request.currentUser = sanitizeUser')
  )
  assert.match(
    pluginSource,
    /DELETE FROM sessions WHERE id = \$1 AND user_id = \$2/
  )

  assert.ok(
    serverSource.indexOf(
      'const initialAcceptanceRecovery = await recoverExpiredReleaseAcceptanceAccounts'
    )
      < serverSource.indexOf('await ensureAdminUser()')
  )
  assert.match(serverSource, /startReleaseAcceptanceAccountRecovery/)
})
