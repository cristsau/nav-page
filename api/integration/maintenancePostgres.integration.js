import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

const EXPECTED_DATABASE_NAME = 'nav_maintenance_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEDIA_JOB = 'media_delete_retry'
const POLICY = Object.freeze({
  intervalSeconds: 3_600,
  batchSize: 10,
  maxAttempts: 3,
  baseBackoffSeconds: 60,
  maxBackoffSeconds: 240
})

function assertIsolatedDatabaseTarget() {
  assert.equal(
    process.env.NODE_ENV,
    'test',
    'PostgreSQL maintenance integration tests require NODE_ENV=test'
  )
  assert.equal(
    process.env.NAV_MAINTENANCE_INTEGRATION_TEST,
    'true',
    'PostgreSQL maintenance integration tests require NAV_MAINTENANCE_INTEGRATION_TEST=true'
  )

  let databaseUrl
  try {
    databaseUrl = new URL(String(process.env.DATABASE_URL || ''))
  } catch {
    assert.fail('PostgreSQL maintenance integration tests require a valid DATABASE_URL')
  }

  assert.ok(
    ['postgres:', 'postgresql:'].includes(databaseUrl.protocol),
    'DATABASE_URL must use PostgreSQL'
  )
  assert.ok(
    ALLOWED_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase()),
    'maintenance integration fixtures are restricted to localhost or 127.0.0.1'
  )
  assert.equal(
    decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, '')),
    EXPECTED_DATABASE_NAME,
    `maintenance integration fixtures require database ${EXPECTED_DATABASE_NAME}`
  )
  for (const redirectParameter of ['database', 'dbname', 'host', 'hostaddr', 'service']) {
    assert.equal(
      databaseUrl.searchParams.has(redirectParameter),
      false,
      `DATABASE_URL must not override its target through ${redirectParameter}`
    )
  }
}

// Fail closed before importing the application database pool.
assertIsolatedDatabaseTarget()

let pool
let retryPendingMediaDeletions
let createMaintenanceJobObserver
let MAINTENANCE_JOB_NAMES
let RECORD_MAINTENANCE_FAILURE_SQL
let MEDIA_DELETE_RETRY_LOCK_SQL
let MEDIA_DELETE_RETRY_UNLOCK_SQL
let originalFetch

function fixtureUuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function createBarrier(parties) {
  let arrived = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })

  return async () => {
    arrived += 1
    if (arrived === parties) release()
    await gate
  }
}

async function resetMaintenanceStatus() {
  await pool.query('DELETE FROM maintenance_job_status')
  await pool.query(
    `
      INSERT INTO maintenance_job_status (job_name)
      VALUES ('security_event_retention'), ('media_delete_retry')
    `
  )
}

async function resetDatabase() {
  await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE')
  await resetMaintenanceStatus()
  await pool.query(
    `
      INSERT INTO users (id, username, password_hash, role, status, approved_at)
      VALUES ($1, 'maintenance-integration', 'not-a-real-password-hash', 'user', 'approved', NOW())
    `,
    [USER_ID]
  )
}

async function maintenanceState() {
  const { rows } = await pool.query(
    `
      SELECT
        job_name,
        last_started_at,
        last_succeeded_at,
        last_failed_at,
        last_duration_ms::integer AS last_duration_ms,
        last_outcome,
        last_result,
        consecutive_failures,
        last_error_code,
        alert_open,
        last_alert_at,
        last_notification_kind,
        last_notification_status,
        last_notification_error_code
      FROM maintenance_job_status
      WHERE job_name = $1
    `,
    [MEDIA_JOB]
  )
  assert.equal(rows.length, 1)
  return rows[0]
}

function observer(notifyFn, overrides = {}) {
  return createMaintenanceJobObserver({
    jobName: MAINTENANCE_JOB_NAMES.MEDIA_DELETE_RETRY,
    jobLabel: '图床删除失败重试',
    poolInstance: pool,
    alertsEnabled: true,
    failureThreshold: 2,
    alertCooldownSeconds: 300,
    notifyFn,
    ...overrides
  })
}

function failurePayload(finishedAt, code = 'UPSTREAM_UNAVAILABLE') {
  const finished = new Date(finishedAt)
  return {
    error: Object.assign(new Error('private detail must not persist'), { code }),
    result: {
      processed: 1,
      failed: 1,
      remaining: 2,
      deferred: 1,
      privateUrl: 'https://must-not-persist.invalid'
    },
    startedAt: new Date(finished.getTime() - 500),
    finishedAt: finished,
    durationMs: 500
  }
}

before(async () => {
  originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    assert.fail('maintenance integration tests must never make a real network request')
  }

  const [databaseModule, retryModule, statusModule] = await Promise.all([
    import('../src/db/index.js'),
    import('../src/lib/mediaDeleteRetry.js'),
    import('../src/lib/maintenanceJobStatus.js')
  ])
  pool = databaseModule.pool
  retryPendingMediaDeletions = retryModule.retryPendingMediaDeletions
  MEDIA_DELETE_RETRY_LOCK_SQL = retryModule.MEDIA_DELETE_RETRY_LOCK_SQL
  MEDIA_DELETE_RETRY_UNLOCK_SQL = retryModule.MEDIA_DELETE_RETRY_UNLOCK_SQL
  createMaintenanceJobObserver = statusModule.createMaintenanceJobObserver
  MAINTENANCE_JOB_NAMES = statusModule.MAINTENANCE_JOB_NAMES
  RECORD_MAINTENANCE_FAILURE_SQL = statusModule.RECORD_MAINTENANCE_FAILURE_SQL

  const target = await pool.query(
    `
      SELECT
        current_database() AS database_name,
        current_setting('server_version_num')::integer AS server_version_num,
        to_regclass('media_assets') IS NOT NULL AS media_assets_ready,
        to_regclass('maintenance_job_status') IS NOT NULL AS maintenance_status_ready
    `
  )
  assert.equal(target.rows[0]?.database_name, EXPECTED_DATABASE_NAME)
  assert.ok(
    target.rows[0]?.server_version_num >= 160000
      && target.rows[0]?.server_version_num < 170000,
    'maintenance integration exercise requires PostgreSQL 16'
  )
  assert.equal(target.rows[0]?.media_assets_ready, true, 'migration 014 must be applied')
  assert.equal(target.rows[0]?.maintenance_status_ready, true, 'migration 018 must be applied')
})

beforeEach(resetDatabase)

after(async () => {
  globalThis.fetch = originalFetch
  await pool.end()
})

test('real PostgreSQL selects only due media retries and classifies deferred and exhausted backlog', async () => {
  const eligibleFirst = fixtureUuid(1)
  const eligibleAfterBackoff = fixtureUuid(2)
  const deferred = fixtureUuid(3)
  const exhausted = fixtureUuid(4)

  await pool.query(
    `
      INSERT INTO media_assets (
        id, user_id, upstream_id, url, name, mime, size,
        source, retention, state, delete_attempts,
        delete_requested_at, last_delete_attempt_at
      ) VALUES
        ($1, $7, 'nav-notes/test/eligible-first.webp', 'https://pic.integration.test/file/eligible-first.webp', 'eligible-first.webp', 'image/webp', 101, 'note', 'auto', 'delete_pending', 0, NOW() - INTERVAL '10 minutes', NULL),
        ($2, $7, 'nav-notes/test/eligible-backoff.webp', 'https://pic.integration.test/file/eligible-backoff.webp', 'eligible-backoff.webp', 'image/webp', 102, 'note', 'auto', 'delete_failed', 2, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '130 seconds'),
        ($3, $7, 'nav-notes/test/deferred.webp', 'https://pic.integration.test/file/deferred.webp', 'deferred.webp', 'image/webp', 103, 'note', 'auto', 'delete_failed', 2, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '30 seconds'),
        ($4, $7, 'nav-notes/test/exhausted.webp', 'https://pic.integration.test/file/exhausted.webp', 'exhausted.webp', 'image/webp', 104, 'note', 'auto', 'delete_failed', 3, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes'),
        ($5, $7, 'nav-notes/test/kept.webp', 'https://pic.integration.test/file/kept.webp', 'kept.webp', 'image/webp', 105, 'note', 'keep', 'delete_failed', 0, NOW() - INTERVAL '10 minutes', NULL),
        ($6, $7, 'nav-notes/test/active.webp', 'https://pic.integration.test/file/active.webp', 'active.webp', 'image/webp', 106, 'note', 'auto', 'active', 0, NULL, NULL)
    `,
    [
      eligibleFirst,
      eligibleAfterBackoff,
      deferred,
      exhausted,
      fixtureUuid(5),
      fixtureUuid(6),
      USER_ID
    ]
  )

  const attempted = []
  const result = await retryPendingMediaDeletions({
    poolInstance: pool,
    policy: POLICY,
    async retryFn({ id }) {
      attempted.push(id)
      if (id === eligibleFirst) {
        await pool.query(
          "UPDATE media_assets SET state = 'deleted', deleted_at = NOW(), last_delete_attempt_at = NOW() WHERE id = $1",
          [id]
        )
        return { state: 'deleted' }
      }
      assert.equal(id, eligibleAfterBackoff)
      await pool.query(
        "UPDATE media_assets SET state = 'delete_failed', last_delete_attempt_at = NOW() WHERE id = $1",
        [id]
      )
      return { state: 'delete_failed' }
    }
  })

  assert.deepEqual(new Set(attempted), new Set([eligibleFirst, eligibleAfterBackoff]))
  assert.deepEqual(result, {
    processed: 2,
    deleted: 1,
    failed: 1,
    referenced: 0,
    notPending: 0,
    errors: 0,
    remaining: 3,
    eligible: 0,
    deferred: 2,
    exhausted: 1,
    skipped: null
  })

  const { rows } = await pool.query(
    `
      SELECT id, state, delete_attempts
      FROM media_assets
      WHERE id = ANY($1::uuid[])
      ORDER BY id
    `,
    [[eligibleFirst, eligibleAfterBackoff, deferred, exhausted]]
  )
  assert.deepEqual(rows.map((row) => row.state), [
    'deleted',
    'delete_failed',
    'delete_failed',
    'delete_failed'
  ])
})

test('a real second PostgreSQL connection skips while the advisory lock is held', async () => {
  const lockHolder = await pool.connect()
  let lockAcquired = false
  let retryCalls = 0

  try {
    const lock = await lockHolder.query(MEDIA_DELETE_RETRY_LOCK_SQL)
    lockAcquired = lock.rows[0]?.acquired === true
    assert.equal(lockAcquired, true)

    const result = await retryPendingMediaDeletions({
      poolInstance: pool,
      policy: POLICY,
      async retryFn() {
        retryCalls += 1
        return { state: 'deleted' }
      }
    })

    assert.equal(result.skipped, 'already-running')
    assert.equal(result.processed, 0)
    assert.equal(retryCalls, 0)
  } finally {
    if (lockAcquired) {
      const unlocked = await lockHolder.query(MEDIA_DELETE_RETRY_UNLOCK_SQL)
      assert.equal(unlocked.rows[0]?.released, true)
    }
    lockHolder.release()
  }
})

test('failure threshold and cooldown are reserved atomically in PostgreSQL', async () => {
  const notifications = []
  const jobObserver = observer(async (payload) => {
    notifications.push(payload)
    return { skipped: false, sent: 1, failed: 0 }
  })

  await jobObserver.failed(failurePayload('2026-08-23T00:00:01.000Z'))
  let state = await maintenanceState()
  assert.equal(state.consecutive_failures, 1)
  assert.equal(state.alert_open, false)
  assert.equal(state.last_alert_at, null)
  assert.equal(notifications.length, 0)

  await jobObserver.failed(failurePayload('2026-08-23T00:01:01.000Z'))
  state = await maintenanceState()
  assert.equal(state.consecutive_failures, 2)
  assert.equal(state.alert_open, true)
  assert.equal(state.last_alert_at.toISOString(), '2026-08-23T00:01:01.000Z')
  assert.equal(notifications.length, 1)

  await jobObserver.failed(failurePayload('2026-08-23T00:02:01.000Z'))
  state = await maintenanceState()
  assert.equal(state.consecutive_failures, 3)
  assert.equal(state.last_alert_at.toISOString(), '2026-08-23T00:01:01.000Z')
  assert.equal(notifications.length, 1, 'cooldown must suppress a duplicate notification')

  await jobObserver.failed(failurePayload('2026-08-23T00:07:02.000Z'))
  state = await maintenanceState()
  assert.equal(state.consecutive_failures, 4)
  assert.equal(state.last_alert_at.toISOString(), '2026-08-23T00:07:02.000Z')
  assert.equal(state.last_notification_kind, 'failure')
  assert.equal(state.last_notification_status, 'sent')
  assert.equal(notifications.length, 2)
  assert.deepEqual(state.last_result, {
    processed: 1,
    deleted: 0,
    failed: 1,
    referenced: 0,
    notPending: 0,
    errors: 0,
    remaining: 2,
    eligible: 0,
    deferred: 1,
    exhausted: 0
  })
})

test('two PostgreSQL connections crossing the threshold concurrently produce one notification sender', async () => {
  const firstClient = await pool.connect()
  const secondClient = await pool.connect()
  const beforeFailureStatement = createBarrier(2)
  let notificationCalls = 0

  function clientPool(client) {
    return {
      async query(text, params) {
        if (text === RECORD_MAINTENANCE_FAILURE_SQL) {
          await beforeFailureStatement()
        }
        return client.query(text, params)
      }
    }
  }

  try {
    const notifyFn = async () => {
      notificationCalls += 1
      return { skipped: false, sent: 1, failed: 0 }
    }
    const firstObserver = createMaintenanceJobObserver({
      jobName: MAINTENANCE_JOB_NAMES.MEDIA_DELETE_RETRY,
      jobLabel: '图床删除失败重试',
      poolInstance: clientPool(firstClient),
      alertsEnabled: true,
      failureThreshold: 1,
      alertCooldownSeconds: 300,
      notifyFn
    })
    const secondObserver = createMaintenanceJobObserver({
      jobName: MAINTENANCE_JOB_NAMES.MEDIA_DELETE_RETRY,
      jobLabel: '图床删除失败重试',
      poolInstance: clientPool(secondClient),
      alertsEnabled: true,
      failureThreshold: 1,
      alertCooldownSeconds: 300,
      notifyFn
    })
    const concurrentFailureAt = '2026-08-23T00:20:01.000Z'

    await Promise.all([
      firstObserver.failed(failurePayload(concurrentFailureAt, 'CONCURRENT_FAILURE')),
      secondObserver.failed(failurePayload(concurrentFailureAt, 'CONCURRENT_FAILURE'))
    ])

    const state = await maintenanceState()
    assert.equal(notificationCalls, 1)
    assert.equal(state.consecutive_failures, 2)
    assert.equal(state.alert_open, true)
    assert.equal(state.last_alert_at.toISOString(), concurrentFailureAt)
    assert.equal(state.last_notification_kind, 'failure')
    assert.equal(state.last_notification_status, 'sent')
  } finally {
    firstClient.release()
    secondClient.release()
  }
})

test('undelivered alerts follow the bounded attempt policy, release the reservation, and allow a later run', async () => {
  const scenarios = [
    {
      name: 'failed result',
      expectedAttempts: 1,
      expectedStatus: 'failed',
      deliver() { return { skipped: false, sent: 0, failed: 1 } }
    },
    {
      name: 'skipped result',
      expectedAttempts: 1,
      expectedStatus: 'skipped',
      deliver() { return { skipped: true, sent: 0, failed: 0 } }
    },
    {
      name: 'thrown error',
      expectedAttempts: 1,
      expectedStatus: 'failed',
      deliver() {
        throw Object.assign(new Error('private Telegram detail'), { code: 'ECONNRESET' })
      }
    }
  ]

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index]
    await resetMaintenanceStatus()
    const previousAlertAt = new Date(`2026-08-23T0${index}:00:00.000Z`)
    const reservedAt = new Date(`2026-08-23T0${index}:10:00.000Z`)
    await pool.query(
      `
        UPDATE maintenance_job_status
        SET consecutive_failures = 2,
            last_outcome = 'failed',
            alert_open = TRUE,
            last_alert_at = $2,
            last_error_code = 'PREVIOUS_FAILURE'
        WHERE job_name = $1
      `,
      [MEDIA_JOB, previousAlertAt]
    )

    let zeroDelivery = true
    let deliveryCalls = 0
    const jobObserver = observer(async () => {
      deliveryCalls += 1
      if (zeroDelivery) return scenario.deliver()
      return { skipped: false, sent: 1, failed: 0 }
    }, { failureThreshold: 1 })

    await jobObserver.failed(failurePayload(reservedAt, 'DELIVERY_TEST_FAILURE'))
    let state = await maintenanceState()
    assert.equal(
      deliveryCalls,
      scenario.expectedAttempts,
      `${scenario.name} must use its bounded delivery attempt policy`
    )
    assert.equal(state.alert_open, true)
    assert.equal(
      state.last_alert_at.toISOString(),
      previousAlertAt.toISOString(),
      `${scenario.name} must release only the new cooldown reservation`
    )
    assert.equal(state.last_notification_kind, 'failure')
    assert.equal(state.last_notification_status, scenario.expectedStatus)
    if (scenario.name === 'thrown error') {
      assert.equal(state.last_notification_error_code, 'ECONNRESET')
    }

    zeroDelivery = false
    const immediateRetryAt = new Date(reservedAt.getTime() + 1_000)
    await jobObserver.failed(failurePayload(immediateRetryAt, 'DELIVERY_TEST_FAILURE'))
    state = await maintenanceState()
    assert.equal(
      deliveryCalls,
      scenario.expectedAttempts + 1,
      `${scenario.name} must not impose cooldown after zero delivery`
    )
    assert.equal(state.alert_open, true)
    assert.equal(state.last_alert_at.toISOString(), immediateRetryAt.toISOString())
    assert.equal(state.last_notification_status, 'sent')
  }
})

test('a successful run closes an open alert and records recovery delivery', async () => {
  await pool.query(
    `
      UPDATE maintenance_job_status
      SET consecutive_failures = 4,
          last_outcome = 'failed',
          last_failed_at = '2026-08-23T04:00:00.000Z',
          last_error_code = 'UPSTREAM_UNAVAILABLE',
          alert_open = TRUE,
          last_alert_at = '2026-08-23T04:00:00.000Z'
      WHERE job_name = $1
    `,
    [MEDIA_JOB]
  )
  const notifications = []
  const jobObserver = observer(async (payload) => {
    notifications.push(payload)
    return { skipped: false, sent: 1, failed: 0 }
  })

  await jobObserver.succeeded({
    result: {
      processed: 1,
      deleted: 1,
      remaining: 0,
      secret: 'must-not-persist'
    },
    startedAt: new Date('2026-08-23T04:05:00.000Z'),
    finishedAt: new Date('2026-08-23T04:05:01.000Z'),
    durationMs: 1_000
  })

  const state = await maintenanceState()
  assert.equal(state.last_outcome, 'succeeded')
  assert.equal(state.last_succeeded_at.toISOString(), '2026-08-23T04:05:01.000Z')
  assert.equal(state.last_duration_ms, 1_000)
  assert.equal(state.consecutive_failures, 0)
  assert.equal(state.last_error_code, null)
  assert.equal(state.alert_open, false)
  assert.equal(state.last_notification_kind, 'recovery')
  assert.equal(state.last_notification_status, 'sent')
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].kind, 'recovery')
  assert.deepEqual(state.last_result, {
    processed: 1,
    deleted: 1,
    failed: 0,
    referenced: 0,
    notPending: 0,
    errors: 0,
    remaining: 0,
    eligible: 0,
    deferred: 0,
    exhausted: 0
  })
})
