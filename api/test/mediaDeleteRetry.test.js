import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MEDIA_DELETE_RETRY_LOCK_SQL,
  MEDIA_DELETE_RETRY_UNLOCK_SQL,
  SELECT_MEDIA_DELETE_RETRY_CANDIDATES_SQL,
  retryPendingMediaDeletions,
  startMediaDeleteRetry,
  validateMediaDeleteRetryPolicy
} from '../src/lib/mediaDeleteRetry.js'

const POLICY = Object.freeze({
  intervalSeconds: 3_600,
  batchSize: 10,
  maxAttempts: 8,
  baseBackoffSeconds: 900,
  maxBackoffSeconds: 86_400
})

test('media retry policy is bounded and has an ordered backoff', () => {
  assert.deepEqual(validateMediaDeleteRetryPolicy(POLICY), POLICY)
  assert.throws(
    () => validateMediaDeleteRetryPolicy({ ...POLICY, intervalSeconds: 60 }),
    /intervalSeconds must be an integer from 300/
  )
  assert.throws(
    () => validateMediaDeleteRetryPolicy({
      ...POLICY,
      baseBackoffSeconds: 1_800,
      maxBackoffSeconds: 900
    }),
    /must not exceed/
  )
})

test('candidate SQL is limited to auto pending failures and exponential backoff', () => {
  assert.match(SELECT_MEDIA_DELETE_RETRY_CANDIDATES_SQL, /retention = 'auto'/)
  assert.match(SELECT_MEDIA_DELETE_RETRY_CANDIDATES_SQL, /state IN \('delete_pending', 'delete_failed'\)/)
  assert.match(SELECT_MEDIA_DELETE_RETRY_CANDIDATES_SQL, /delete_attempts < \$1/)
  assert.match(SELECT_MEDIA_DELETE_RETRY_CANDIDATES_SQL, /POWER\(/)
  assert.match(SELECT_MEDIA_DELETE_RETRY_CANDIDATES_SQL, /LIMIT \$4/)
})

test('retry worker serializes replicas and classifies every bounded outcome', async () => {
  const calls = []
  const candidates = [
    { id: 'a', user_id: 'u1' },
    { id: 'b', user_id: 'u2' },
    { id: 'c', user_id: 'u3' },
    { id: 'd', user_id: 'u4' },
    { id: 'e', user_id: 'u5' }
  ]
  const states = ['deleted', 'delete_failed', 'referenced', 'not_pending']
  const result = await retryPendingMediaDeletions({
    poolInstance: {
      async connect() {
        return {
          async query(text, params = []) {
            calls.push({ text, params })
            if (text === MEDIA_DELETE_RETRY_LOCK_SQL) return { rows: [{ acquired: true }] }
            if (text === MEDIA_DELETE_RETRY_UNLOCK_SQL) return { rows: [{ released: true }] }
            return { rows: candidates }
          },
          release() {}
        }
      }
    },
    policy: POLICY,
    async retryFn(candidate) {
      if (candidate.id === 'e') throw new Error('unexpected')
      return { state: states.shift() }
    }
  })

  assert.deepEqual(result, {
    processed: 5,
    deleted: 1,
    failed: 1,
    referenced: 1,
    notPending: 1,
    errors: 1,
    skipped: null
  })
  const selection = calls.find((call) => call.text === SELECT_MEDIA_DELETE_RETRY_CANDIDATES_SQL)
  assert.deepEqual(selection.params, [8, 900, 86_400, 10])
  assert.equal(calls.at(-1).text, MEDIA_DELETE_RETRY_UNLOCK_SQL)
})

test('a second replica skips media retry when the advisory lock is held', async () => {
  const result = await retryPendingMediaDeletions({
    poolInstance: {
      async connect() {
        return {
          async query() { return { rows: [{ acquired: false }] } },
          release() {}
        }
      }
    },
    policy: POLICY,
    async retryFn() { throw new Error('must not run') }
  })
  assert.equal(result.skipped, 'already-running')
  assert.equal(result.processed, 0)
})

test('disabled media retry creates no timers', async () => {
  let timerCreated = false
  const stop = startMediaDeleteRetry({
    enabled: false,
    policy: POLICY,
    timerApi: { setTimeout() { timerCreated = true } }
  })
  await stop()
  assert.equal(timerCreated, false)
})

test('media retry scheduler prevents overlap and shutdown waits for the active batch', async () => {
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
      assert.equal(delay, 3_600_000)
      intervalCallback = callback
      return { unref() {} }
    },
    clearInterval() {}
  }
  const stop = startMediaDeleteRetry({
    enabled: true,
    policy: POLICY,
    poolInstance: {},
    retryFn() {},
    runFn: async () => {
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
  finishRun({ processed: 0 })
  await stopping
  assert.equal(stopped, true)
})
