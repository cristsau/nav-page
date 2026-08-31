import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

process.env.NAV_EMAIL_INGEST_ENABLED = 'true'
process.env.NAV_EMAIL_SOURCE_KEY = 'mxroute'
process.env.NAV_EMAIL_OWNER_USERNAME = 'mail-owner'

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

test('manual sync increments a durable generation and coalesces repeated wakeups', async () => {
  const { default: emailSyncRoutes } = await import('../src/routes/emailSync.js')
  let generation = 0
  let notifyCount = 0
  let updateCount = 0
  const calls = []
  const queryFn = async (sql, parameters = []) => {
    calls.push({ sql, parameters })
    if (/SELECT account\.id/.test(sql)) {
      return {
        rows: [{
          id: ACCOUNT_ID,
          source_key: 'mxroute',
          enabled: true,
          username: 'mail-owner',
          sync_request_generation: generation,
          sync_completed_generation: 0,
          last_sync_requested_at: generation ? '2026-08-31T00:00:00.000Z' : null
        }],
        rowCount: 1
      }
    }
    if (/UPDATE email_accounts/.test(sql)) {
      updateCount += 1
      if (updateCount === 1) {
        generation += 1
        return {
          rows: [{
            sync_request_generation: generation,
            sync_completed_generation: 0,
            last_sync_requested_at: '2026-08-31T00:00:00.000Z'
          }],
          rowCount: 1
        }
      }
      return { rows: [], rowCount: 0 }
    }
    if (/SELECT pg_notify/.test(sql)) {
      notifyCount += 1
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  }

  const app = Fastify()
  app.decorate('requireAuth', async (request) => {
    request.currentUser = { id: USER_ID }
  })
  await app.register(emailSyncRoutes, { queryFn })
  try {
    const first = await app.inject({
      method: 'POST',
      url: `/email/accounts/${ACCOUNT_ID}/sync`
    })
    assert.equal(first.statusCode, 202)
    assert.match(calls[0].sql, /account\.user_id = \$2/)
    assert.deepEqual(calls[0].parameters, [ACCOUNT_ID, USER_ID])
    assert.deepEqual(first.json(), {
      queued: true,
      generation: 1,
      status: 'queued',
      accepted: true,
      coalesced: false,
      wakeDelivered: true,
      requestGeneration: 1,
      completedGeneration: 0,
      requestedAt: '2026-08-31T00:00:00.000Z'
    })

    const second = await app.inject({
      method: 'POST',
      url: `/email/accounts/${ACCOUNT_ID}/sync`
    })
    assert.equal(second.statusCode, 202)
    assert.equal(second.json().status, 'coalesced')
    assert.equal(second.json().generation, 1)
    assert.equal(second.json().wakeDelivered, null)
    assert.equal(notifyCount, 1)
  } finally {
    await app.close()
  }
})

test('sync status exposes only sanitized failure diagnostics for the owned account', async () => {
  const { default: emailSyncRoutes } = await import('../src/routes/emailSync.js')
  let responseNumber = 0
  const queryFn = async (sql, parameters = []) => {
    assert.match(sql, /account\.last_error_at, account\.last_error_code/)
    assert.match(sql, /account\.user_id = \$2/)
    assert.deepEqual(parameters, [ACCOUNT_ID, USER_ID])
    responseNumber += 1
    return {
      rows: [{
        id: ACCOUNT_ID,
        sync_request_generation: 4,
        sync_completed_generation: 3,
        last_sync_requested_at: '2026-08-31T01:00:00.000Z',
        last_sync_started_at: '2026-08-31T01:00:00.100Z',
        last_sync_completed_at: '2026-08-31T00:55:00.000Z',
        last_idle_event_at: null,
        last_error_at: '2026-08-31T01:00:02.000Z',
        last_error_code: responseNumber === 1 ? 'imap_auth_failed' : 'IMAP failed: password=secret',
        ingest_lag_messages: 2,
        last_cached_at: '2026-08-31T00:59:00.000Z',
        classification_pending: 1,
        classification_oldest_seconds: 7
      }],
      rowCount: 1
    }
  }

  const app = Fastify()
  app.decorate('requireAuth', async (request) => {
    request.currentUser = { id: USER_ID }
  })
  await app.register(emailSyncRoutes, { queryFn })
  try {
    const currentFailure = await app.inject({
      method: 'GET',
      url: `/email/accounts/${ACCOUNT_ID}/sync-status`
    })
    assert.equal(currentFailure.statusCode, 200)
    assert.equal(currentFailure.json().lastErrorCode, 'IMAP_AUTH_FAILED')
    assert.equal(currentFailure.json().lastErrorAt, '2026-08-31T01:00:02.000Z')
    assert.equal(currentFailure.json().pending, true)

    const unsafeFailure = await app.inject({
      method: 'GET',
      url: `/email/accounts/${ACCOUNT_ID}/sync-status`
    })
    assert.equal(unsafeFailure.statusCode, 200)
    assert.equal(unsafeFailure.json().lastErrorCode, null)
    assert.equal(unsafeFailure.json().lastErrorAt, null)
    assert.doesNotMatch(unsafeFailure.body, /password|secret/i)
  } finally {
    await app.close()
  }
})
