import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import {
  claimEmailClassificationJob,
  processEmailClassificationJobs,
  startEmailClassificationScheduler,
  validateEmailClassificationPolicy
} from '../src/lib/emailClassificationWorker.js'
import {
  EMAIL_CLASSIFICATION_WAKE_CHANNEL,
  EMAIL_INGEST_WAKE_CHANNEL,
  notifyEmailWake,
  parseEmailWakePayload,
  startEmailWakeListener
} from '../src/lib/emailIngestWake.js'
import {
  drainEmailMailboxBatches,
  mailboxBatchNotificationState
} from '../src/lib/emailIngestScheduler.js'

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

async function tick() {
  await new Promise((resolve) => setImmediate(resolve))
}

async function source(path) {
  return fs.readFile(new URL(path, import.meta.url), 'utf8')
}

test('email wake payloads are identity-only and pg_notify remains parameterized', async () => {
  assert.deepEqual(parseEmailWakePayload(JSON.stringify({
    accountId: ACCOUNT_ID.toUpperCase(),
    sourceKey: 'MXRoute'
  })), {
    accountId: ACCOUNT_ID,
    sourceKey: 'mxroute'
  })
  assert.equal(parseEmailWakePayload('{'), null)
  assert.equal(parseEmailWakePayload(JSON.stringify({
    accountId: ACCOUNT_ID,
    sourceKey: 'unsafe channel name'
  })), null)

  const calls = []
  await notifyEmailWake(async (sql, parameters) => {
    calls.push({ sql, parameters })
  }, EMAIL_INGEST_WAKE_CHANNEL, {
    accountId: ACCOUNT_ID,
    sourceKey: 'mxroute'
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sql, 'SELECT pg_notify($1, $2)')
  assert.equal(calls[0].parameters[0], EMAIL_INGEST_WAKE_CHANNEL)
  assert.deepEqual(JSON.parse(calls[0].parameters[1]), {
    accountId: ACCOUNT_ID,
    sourceKey: 'mxroute'
  })
})

test('email wake listener uses a dedicated LISTEN session and releases it on stop', async () => {
  const client = new EventEmitter()
  const statements = []
  let releases = 0
  client.query = async (sql) => {
    statements.push(sql)
    return { rows: [] }
  }
  client.release = () => { releases += 1 }
  const received = []
  const stop = startEmailWakeListener({
    poolInstance: { async connect() { return client } },
    channel: EMAIL_CLASSIFICATION_WAKE_CHANNEL,
    onWake(payload) { received.push(payload) }
  })
  await tick()
  assert.deepEqual(statements, ['LISTEN "nav_email_classification_wake"'])
  client.emit('notification', {
    channel: EMAIL_CLASSIFICATION_WAKE_CHANNEL,
    payload: JSON.stringify({ accountId: ACCOUNT_ID, sourceKey: 'mxroute' })
  })
  assert.deepEqual(received, [{ accountId: ACCOUNT_ID, sourceKey: 'mxroute' }])
  await stop()
  assert.deepEqual(statements, [
    'LISTEN "nav_email_classification_wake"',
    'UNLISTEN "nav_email_classification_wake"'
  ])
  assert.equal(releases, 1)
})

test('classification claim is transactional, source-scoped and skip-locked', async () => {
  const statements = []
  const job = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    attempt_count: 1,
    max_attempts: 5
  }
  const client = {
    async query(sql, parameters = []) {
      statements.push({ sql, parameters })
      if (/SELECT job\.id/.test(sql)) return { rows: [{ id: job.id }] }
      if (/RETURNING \*/.test(sql)) return { rows: [job] }
      return { rows: [] }
    },
    release() {}
  }
  const policy = validateEmailClassificationPolicy({
    intervalSeconds: 2,
    batchSize: 10,
    maxAttempts: 5,
    staleRunningSeconds: 300
  })
  const claimed = await claimEmailClassificationJob({
    async connect() { return client }
  }, policy, 'mxroute')
  assert.equal(claimed.id, job.id)
  assert.equal(statements[0].sql, 'BEGIN')
  assert.equal(statements.at(-1).sql, 'COMMIT')
  assert.match(statements.find(({ sql }) => /SELECT job\.id/.test(sql)).sql, /FOR UPDATE OF job SKIP LOCKED/)
  assert.equal(
    statements.filter(({ sql }) => /UPDATE email_classification_jobs/.test(sql))
      .every(({ sql }) => /account\.source_key/.test(sql) || /WHERE id = \$1/.test(sql)),
    true
  )
  const recoveryUpdates = statements
    .filter(({ sql }) => /UPDATE email_classification_jobs/.test(sql))
    .slice(0, 2)
  assert.equal(recoveryUpdates.length, 2)
  assert.equal(
    recoveryUpdates.every(({ sql }) => (
      /max_attempts = GREATEST\(attempt_count, LEAST\(max_attempts, \$[23]::integer\)\)/.test(sql)
    )),
    true,
    'lowering the runtime retry limit must not violate attempt_count <= max_attempts'
  )
})

test('future retry jobs remain observable without triggering an immediate busy loop', async () => {
  const client = {
    async query(sql) {
      if (/SELECT job\.id/.test(sql)) return { rows: [] }
      return { rows: [] }
    },
    release() {}
  }
  const poolInstance = {
    async connect() { return client },
    async query(sql) {
      assert.match(sql, /due_count/)
      return { rows: [{ count: 3, due_count: 0, oldest_seconds: 41 }] }
    }
  }
  const result = await processEmailClassificationJobs({
    poolInstance,
    policy: { batchSize: 10 },
    runtimeConfig: { emailSourceKey: 'mxroute' }
  })
  assert.equal(result.remaining, 3)
  assert.equal(result.dueRemaining, 0)
  assert.equal(result.oldestPendingSeconds, 41)

  const delays = []
  let observerResolve
  const observed = new Promise((resolve) => { observerResolve = resolve })
  const timerApi = {
    setTimeout(callback, delay) {
      delays.push(delay)
      return { callback, unref() {} }
    },
    clearTimeout() {}
  }
  const stop = startEmailClassificationScheduler({
    enabled: true,
    policy: { intervalSeconds: 2 },
    poolInstance: {},
    runtimeConfig: { emailSourceKey: 'mxroute' },
    processorFn: async () => ({ remaining: 3, dueRemaining: 0 }),
    wakeListenerFactory: () => async () => {},
    timerApi,
    observer: {
      async succeeded() { observerResolve() }
    }
  })
  await observed
  await tick()
  assert.deepEqual(delays, [2000])
  await stop()
})

test('classification failures move to durable retry_wait without losing the job', async () => {
  const job = {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    attempt_count: 1,
    max_attempts: 5
  }
  let claims = 0
  const finishes = []
  const poolInstance = {
    async query() {
      return { rows: [{ count: 1, due_count: 0, oldest_seconds: 2 }] }
    }
  }
  const expectedError = new Error('provider temporarily unavailable')
  expectedError.code = 'AI_PROVIDER_UNAVAILABLE'
  const summary = await processEmailClassificationJobs({
    poolInstance,
    policy: { batchSize: 10, maxAttempts: 5 },
    runtimeConfig: { emailSourceKey: 'mxroute' },
    claimFn: async () => (++claims === 1 ? job : null),
    loadFn: async () => ({
      user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      source_key: 'mxroute',
      email_message_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      mailbox_uid: 7,
      received_at: '2026-08-31T00:00:00.000Z'
    }),
    decryptFn: async () => ({
      envelope: {
        messageId: '<retry@example.test>',
        sender: { name: 'Retry', address: 'retry@example.test' },
        to: [{ address: 'owner@example.test' }],
        subject: 'Retry me'
      },
      content: { text: 'temporary failure' }
    }),
    processFn: async () => { throw expectedError },
    finishFn: async (...parameters) => { finishes.push(parameters) }
  })
  assert.equal(summary.processed, 1)
  assert.equal(summary.retried, 1)
  assert.equal(summary.deadLetter, 0)
  assert.equal(summary.remaining, 1)
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0][1], job)
  assert.equal(finishes[0][2], 'retry_wait')
  assert.equal(finishes[0][3], 'AI_PROVIDER_UNAVAILABLE')
})

test('classification worker preserves the durable notification eligibility decision', async () => {
  const jobs = [
    { id: '11111111-aaaa-4aaa-8aaa-111111111111', attempt_count: 1, max_attempts: 5 },
    { id: '22222222-bbbb-4bbb-8bbb-222222222222', attempt_count: 1, max_attempts: 5 }
  ]
  const payloads = []
  const finishes = []
  const summary = await processEmailClassificationJobs({
    poolInstance: {
      async query() {
        return { rows: [{ count: 0, due_count: 0, oldest_seconds: 0 }] }
      }
    },
    policy: { batchSize: 10, maxAttempts: 5 },
    runtimeConfig: { emailSourceKey: 'mxroute' },
    claimFn: async () => jobs.shift() || null,
    loadFn: async (_pool, job) => ({
      user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      source_key: 'mxroute',
      email_message_id: job.id,
      mailbox_uid: 7,
      received_at: '2026-08-31T00:00:00.000Z',
      notification_eligible: job.id.startsWith('2222')
    }),
    decryptFn: async () => ({
      envelope: {
        messageId: '<eligibility@example.test>',
        sender: { name: 'Sender', address: 'sender@example.test' },
        to: [{ address: 'owner@example.test' }],
        subject: 'Eligibility'
      },
      content: { text: 'Eligibility body' }
    }),
    processFn: async (payload) => { payloads.push(payload) },
    finishFn: async (...parameters) => { finishes.push(parameters) }
  })

  assert.equal(summary.processed, 2)
  assert.equal(summary.succeeded, 2)
  assert.deepEqual(payloads.map((payload) => payload.notificationEligible), [false, true])
  assert.deepEqual(finishes.map((parameters) => parameters[2]), ['succeeded', 'succeeded'])
})

test('backlog draining continues immediately but obeys batch and time budgets', async () => {
  let calls = 0
  const batchBounded = await drainEmailMailboxBatches({
    syncMailbox: async () => {
      calls += 1
      return {
        processed: 1,
        inserted: 1,
        classificationQueued: 1,
        remaining: 20 - calls,
        caughtUp: false
      }
    },
    policy: { drainMaxBatches: 2, drainMaxMilliseconds: 15_000 },
    clock: () => 0
  })
  assert.equal(calls, 2)
  assert.equal(batchBounded.batches, 2)
  assert.equal(batchBounded.processed, 2)
  assert.equal(batchBounded.classificationQueued, 2)
  assert.equal(batchBounded.continueImmediately, true)

  let clockCalls = 0
  let timedCalls = 0
  const timeBounded = await drainEmailMailboxBatches({
    syncMailbox: async () => {
      timedCalls += 1
      return { processed: 1, remaining: 9, caughtUp: false }
    },
    policy: { drainMaxBatches: 10, drainMaxMilliseconds: 1000 },
    clock: () => (clockCalls++ === 0 ? 0 : 1001)
  })
  assert.equal(timedCalls, 1)
  assert.equal(timeBounded.batches, 1)
  assert.equal(timeBounded.continueImmediately, true)
})

test('mailbox notification eligibility arms only after the initial catch-up batch completes', () => {
  const firstCatchUpBatch = mailboxBatchNotificationState({
    initialSyncComplete: false,
    caughtUp: true
  })
  assert.deepEqual(firstCatchUpBatch, {
    notificationEligible: false,
    nextInitialSyncComplete: true
  })

  const nextLiveBatch = mailboxBatchNotificationState({
    initialSyncComplete: firstCatchUpBatch.nextInitialSyncComplete,
    caughtUp: true
  })
  assert.deepEqual(nextLiveBatch, {
    notificationEligible: true,
    nextInitialSyncComplete: true
  })

  const uidValidityReset = mailboxBatchNotificationState({
    initialSyncComplete: false,
    caughtUp: false
  })
  assert.deepEqual(uidValidityReset, {
    notificationEligible: false,
    nextInitialSyncComplete: false
  })
})

test('ingest cursor follows durable cache and queue commit, not AI classification', async () => {
  const [scheduler, store, syncRoute] = await Promise.all([
    source('../src/lib/emailIngestScheduler.js'),
    source('../src/lib/emailMailboxStore.js'),
    source('../src/routes/emailSync.js')
  ])
  const persistAt = scheduler.indexOf('stored = await persistEmailMailboxMessage')
  const cursorAt = scheduler.indexOf('await writeMailboxState({ uid })', persistAt)
  assert.ok(persistAt > 0 && cursorAt > persistAt)
  assert.doesNotMatch(scheduler, /processInboundEmail/)
  assert.match(scheduler, /syncMailboxWithDrain/)
  assert.match(scheduler, /combined\.batches < validated\.drainMaxBatches/)
  assert.match(scheduler, /clock\(\) - drainStartedAt < validated\.drainMaxMilliseconds/)

  const jobAt = store.indexOf('INSERT INTO email_classification_jobs')
  const commitAt = store.indexOf("await client.query('COMMIT')", jobAt)
  assert.ok(jobAt > 0 && commitAt > jobAt)
  assert.doesNotMatch(store.slice(jobAt, commitAt), /subject|sender|body|content_encrypted/i)

  assert.match(syncRoute, /notifyEmailWake/)
  assert.doesNotMatch(syncRoute, /ImapFlow|imapflow|connect\(.*imap/is)
})
