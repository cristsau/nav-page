import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DELETE_EXPIRED_SECURITY_EVENTS_SQL,
  SECURITY_EVENT_RETENTION_LOCK_SQL,
  SECURITY_EVENT_RETENTION_UNLOCK_SQL,
  pruneExpiredSecurityEvents,
  startSecurityEventRetention,
  validateSecurityEventRetentionPolicy
} from '../src/lib/securityEventRetention.js'

const POLICY = Object.freeze({
  routineDays: 90,
  deniedDays: 180,
  criticalDays: 365,
  intervalSeconds: 21_600,
  batchSize: 500,
  maxBatchesPerRun: 20
})

test('security-event retention policy is bounded and ordered', () => {
  assert.deepEqual(validateSecurityEventRetentionPolicy(POLICY), POLICY)
  assert.throws(
    () => validateSecurityEventRetentionPolicy({ ...POLICY, routineDays: 181 }),
    /routineDays <= deniedDays <= criticalDays/
  )
  assert.throws(
    () => validateSecurityEventRetentionPolicy({ ...POLICY, intervalSeconds: 60 }),
    /intervalSeconds must be an integer from 300/
  )
})

test('retention SQL applies three windows to one skip-locked batch', () => {
  assert.match(DELETE_EXPIRED_SECURITY_EVENTS_SQL, /outcome IN \('failure', 'denied'\)[\s\S]*THEN \$2::integer/)
  assert.match(DELETE_EXPIRED_SECURITY_EVENTS_SQL, /outcome = 'success'[\s\S]*THEN \$1::integer/)
  assert.match(DELETE_EXPIRED_SECURITY_EVENTS_SQL, /ELSE \$3::integer/)
  assert.match(DELETE_EXPIRED_SECURITY_EVENTS_SQL, /FOR UPDATE SKIP LOCKED/)
})

test('expired events are pruned in bounded batches under one advisory lock', async () => {
  const calls = []
  const rowCounts = [500, 7]
  const client = {
    async query(text, params = []) {
      calls.push({ text, params })
      if (text === SECURITY_EVENT_RETENTION_LOCK_SQL) return { rows: [{ acquired: true }] }
      if (text === SECURITY_EVENT_RETENTION_UNLOCK_SQL) return { rows: [{ released: true }] }
      return { rowCount: rowCounts.shift() }
    },
    release() {}
  }
  const result = await pruneExpiredSecurityEvents({
    poolInstance: { async connect() { return client } },
    policy: POLICY
  })

  assert.deepEqual(result, { deletedCount: 507, batches: 2, skipped: null })
  assert.equal(calls.at(-1).text, SECURITY_EVENT_RETENTION_UNLOCK_SQL)
})

test('a second replica skips retention when the advisory lock is held', async () => {
  const result = await pruneExpiredSecurityEvents({
    poolInstance: {
      async connect() {
        return {
          async query() { return { rows: [{ acquired: false }] } },
          release() {}
        }
      }
    },
    policy: POLICY
  })
  assert.deepEqual(result, { deletedCount: 0, batches: 0, skipped: 'already-running' })
})

test('disabled retention creates no timers', async () => {
  let timerCreated = false
  const stop = startSecurityEventRetention({
    enabled: false,
    policy: POLICY,
    timerApi: { setTimeout() { timerCreated = true } }
  })
  await stop()
  assert.equal(timerCreated, false)
})

test('retention scheduler prevents overlap and shutdown waits for active pruning', async () => {
  let timeoutCallback
  let intervalCallback
  let finishRun
  let runCalls = 0
  const timerApi = {
    setTimeout(callback, delay) {
      assert.equal(delay, 30_000)
      timeoutCallback = callback
      return { unref() {} }
    },
    clearTimeout() {},
    setInterval(callback, delay) {
      assert.equal(delay, 21_600_000)
      intervalCallback = callback
      return { unref() {} }
    },
    clearInterval() {}
  }
  const stop = startSecurityEventRetention({
    enabled: true,
    policy: POLICY,
    poolInstance: {},
    pruneFn: async () => {
      runCalls += 1
      return new Promise((resolve) => { finishRun = resolve })
    },
    timerApi
  })

  timeoutCallback()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(runCalls, 1)
  intervalCallback()
  await Promise.resolve()
  assert.equal(runCalls, 1)

  let stopped = false
  const stopping = stop().then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(stopped, false)
  finishRun({ deletedCount: 0, batches: 1, skipped: null })
  await stopping
  assert.equal(stopped, true)
})
