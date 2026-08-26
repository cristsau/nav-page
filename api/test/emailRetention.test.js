import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  DELETE_EXCESS_EMAIL_MESSAGES_SQL,
  DELETE_SCRUBBED_LEGACY_MAIL_OUTBOX_SQL,
  DELETE_SCRUBBED_MAIL_OUTBOX_SQL,
  EMAIL_CACHE_RETENTION_LOCK_SQL,
  EMAIL_CACHE_RETENTION_UNLOCK_SQL,
  EMAIL_RETENTION_CAPABILITIES_SQL,
  pruneEmailCache,
  startEmailCacheRetention,
  validateEmailRetentionPolicy
} from '../src/lib/emailRetention.js'
import {
  MAINTENANCE_JOB_NAMES,
  summarizeMaintenanceResult
} from '../src/lib/maintenanceJobStatus.js'

const validPolicy = Object.freeze({
  retentionDays: 180,
  maxMessagesPerAccount: 5_000,
  batchSize: 200,
  maxDeletesPerRun: 200,
  outboxRetentionDays: 30,
  intervalSeconds: 21_600
})

test('email retention policy is strictly bounded', () => {
  assert.deepEqual(validateEmailRetentionPolicy(validPolicy), validPolicy)
  assert.throws(
    () => validateEmailRetentionPolicy({ ...validPolicy, maxDeletesPerRun: 201 }),
    /maxDeletesPerRun/
  )
  assert.throws(
    () => validateEmailRetentionPolicy({ ...validPolicy, intervalSeconds: 299 }),
    /intervalSeconds/
  )
  assert.throws(
    () => validateEmailRetentionPolicy({
      ...validPolicy,
      batchSize: 200,
      maxDeletesPerRun: 100
    }),
    /batchSize must not exceed/
  )
})

function createClient(handler) {
  const queries = []
  const releases = []
  return {
    queries,
    releases,
    async query(sql, params = []) {
      queries.push({ sql, params })
      return handler(sql, params)
    },
    release(error) {
      releases.push(error)
    }
  }
}

test('email retention uses one advisory-lock session and never exceeds the run cap', async () => {
  const client = createClient((sql, params) => {
    if (sql === EMAIL_CACHE_RETENTION_LOCK_SQL) return { rows: [{ acquired: true }] }
    if (sql === EMAIL_RETENTION_CAPABILITIES_SQL) {
      return { rows: [{ email_drafts_exists: true, mail_outbox_payload_exists: true }] }
    }
    if (sql.includes('DELETE FROM email_drafts')) return { rowCount: 2, rows: [] }
    if (sql === DELETE_SCRUBBED_MAIL_OUTBOX_SQL) return { rowCount: 3, rows: [] }
    if (sql === DELETE_EXCESS_EMAIL_MESSAGES_SQL) {
      assert.equal(params[2], 195)
      return {
        rowCount: 2,
        rows: [
          { account_id: 'account-a', cached_bytes: '1000' },
          { account_id: 'account-b', cached_bytes: '2000' }
        ]
      }
    }
    if (sql.includes('cached_messages')) {
      return { rows: [{ cached_messages: '4980', cached_bytes: '456789' }] }
    }
    if (sql.includes('accounts_over_quota')) {
      return { rows: [{ accounts_over_quota: 0 }] }
    }
    if (sql === EMAIL_CACHE_RETENTION_UNLOCK_SQL) return { rows: [{ released: true }] }
    throw new Error(`Unexpected query: ${sql}`)
  })

  const result = await pruneEmailCache({
    poolInstance: { async connect() { return client } },
    policy: validPolicy
  })

  assert.deepEqual(result, {
    messagesDeleted: 2,
    messageBytesDeleted: 3000,
    draftsDeleted: 2,
    outboxDeleted: 3,
    accountsTouched: 2,
    accountsOverQuota: 0,
    cachedMessages: 4980,
    cachedBytes: 456789,
    batches: 3,
    skipped: null
  })
  assert.ok(
    result.messagesDeleted + result.draftsDeleted + result.outboxDeleted
      <= validPolicy.maxDeletesPerRun
  )
  assert.equal(client.queries[0].sql, EMAIL_CACHE_RETENTION_LOCK_SQL)
  assert.equal(client.queries.at(-1).sql, EMAIL_CACHE_RETENTION_UNLOCK_SQL)
  assert.deepEqual(client.releases, [undefined])
})

test('email retention dynamically skips drafts and supports the pre-036 outbox', async () => {
  const client = createClient((sql) => {
    if (sql === EMAIL_CACHE_RETENTION_LOCK_SQL) return { rows: [{ acquired: true }] }
    if (sql === EMAIL_RETENTION_CAPABILITIES_SQL) {
      return { rows: [{ email_drafts_exists: false, mail_outbox_payload_exists: false }] }
    }
    if (sql === DELETE_SCRUBBED_LEGACY_MAIL_OUTBOX_SQL) {
      assert.doesNotMatch(sql, /payload_encrypted/)
      return { rowCount: 0, rows: [] }
    }
    if (sql === DELETE_EXCESS_EMAIL_MESSAGES_SQL) return { rowCount: 0, rows: [] }
    if (sql.includes('cached_messages')) {
      return { rows: [{ cached_messages: 0, cached_bytes: 0 }] }
    }
    if (sql.includes('accounts_over_quota')) {
      return { rows: [{ accounts_over_quota: 0 }] }
    }
    if (sql === EMAIL_CACHE_RETENTION_UNLOCK_SQL) return { rows: [{ released: true }] }
    throw new Error(`Unexpected query: ${sql}`)
  })

  const result = await pruneEmailCache({
    poolInstance: { async connect() { return client } },
    policy: validPolicy
  })
  assert.equal(result.draftsDeleted, 0)
  assert.equal(result.outboxDeleted, 0)
  assert.equal(client.queries.some(({ sql }) => sql.includes('DELETE FROM email_drafts')), false)
})

test('email retention skips concurrent work and releases the unused session', async () => {
  const client = createClient((sql) => {
    assert.equal(sql, EMAIL_CACHE_RETENTION_LOCK_SQL)
    return { rows: [{ acquired: false }] }
  })
  const result = await pruneEmailCache({
    poolInstance: { async connect() { return client } },
    policy: validPolicy
  })
  assert.equal(result.skipped, 'already-running')
  assert.equal(result.messagesDeleted, 0)
  assert.equal(client.queries.length, 1)
  assert.deepEqual(client.releases, [undefined])
})

test('email retention SQL protects flagged/draft cache and cannot mutate IMAP', () => {
  assert.match(DELETE_EXCESS_EMAIL_MESSAGES_SQL, /flagged = TRUE/)
  assert.match(DELETE_EXCESS_EMAIL_MESSAGES_SQL, /folder_message\.draft = TRUE/)
  assert.match(DELETE_EXCESS_EMAIL_MESSAGES_SQL, /FOR UPDATE OF message SKIP LOCKED/)
  assert.doesNotMatch(
    DELETE_EXCESS_EMAIL_MESSAGES_SQL,
    /\bIMAP\b|\bEXPUNGE\b|\bUID\s+STORE\b/i
  )
})

test('worker scheduler reports bounded retention results and stops cleanly', async () => {
  let timeoutCallback = null
  let intervalCallback = null
  const cleared = []
  const timerApi = {
    setTimeout(callback) {
      timeoutCallback = callback
      return { unref() {} }
    },
    clearTimeout(handle) { cleared.push(handle) },
    setInterval(callback) {
      intervalCallback = callback
      return { unref() {} }
    },
    clearInterval(handle) { cleared.push(handle) }
  }
  const observations = []
  const stop = startEmailCacheRetention({
    enabled: true,
    policy: validPolicy,
    poolInstance: {},
    logger: {},
    observer: {
      async succeeded(payload) { observations.push(payload) }
    },
    pruneFn: async () => ({
      messagesDeleted: 1,
      messageBytesDeleted: 100,
      draftsDeleted: 0,
      outboxDeleted: 0
    }),
    timerApi,
    clock: (() => {
      const values = [1_000, 1_250]
      return () => values.shift() ?? 1_250
    })()
  })
  assert.equal(typeof timeoutCallback, 'function')
  timeoutCallback()
  assert.equal(typeof intervalCallback, 'function')
  await new Promise((resolve) => setImmediate(resolve))
  await stop()
  assert.equal(observations.length, 1)
  assert.equal(observations[0].durationMs, 250)
  assert.equal(cleared.length, 2)
})

test('maintenance summary and runtime wiring expose only bounded cache counters', async () => {
  assert.deepEqual(
    summarizeMaintenanceResult(MAINTENANCE_JOB_NAMES.EMAIL_CACHE_RETENTION, {
      messagesDeleted: 2,
      messageBytesDeleted: 3000,
      draftsDeleted: 1,
      outboxDeleted: 1,
      accountsTouched: 1,
      accountsOverQuota: 0,
      cachedMessages: 100,
      cachedBytes: 20000,
      batches: 3,
      subject: 'must-not-persist'
    }),
    {
      messagesDeleted: 2,
      messageBytesDeleted: 3000,
      draftsDeleted: 1,
      outboxDeleted: 1,
      accountsTouched: 1,
      accountsOverQuota: 0,
      cachedMessages: 100,
      cachedBytes: 20000,
      batches: 3
    }
  )

  const [runtime, config, database] = await Promise.all([
    fs.readFile(new URL('../src/lib/emailRuntimeController.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/config.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/db/index.js', import.meta.url), 'utf8')
  ])
  assert.match(runtime, /workerRuntimeEnabled[\s\S]+startEmailCacheRetention/)
  assert.match(runtime, /MAINTENANCE_JOB_NAMES\.EMAIL_CACHE_RETENTION/)
  assert.match(config, /emailRuntimeRole === 'worker' \? 2 : 6/)
  assert.match(config, /NAV_EMAIL_CACHE_RETENTION_MAX_DELETES_PER_RUN/)
  assert.match(database, /max: config\.databasePoolMax/)
})
