import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_USAGE_RETENTION_LOCK_SQL,
  AI_USAGE_RETENTION_UNLOCK_SQL,
  DELETE_EXPIRED_AI_USAGE_SQL,
  pruneExpiredAiUsage,
  validateAiUsageRetentionPolicy
} from '../src/lib/aiUsageRetention.js'

test('AI usage retention policy is bounded', () => {
  assert.deepEqual(validateAiUsageRetentionPolicy({
    retentionDays: 400,
    batchSize: 500,
    maxBatchesPerRun: 20,
    intervalSeconds: 86_400
  }), {
    retentionDays: 400,
    batchSize: 500,
    maxBatchesPerRun: 20,
    intervalSeconds: 86_400
  })
  assert.throws(() => validateAiUsageRetentionPolicy({
    retentionDays: 0,
    batchSize: 500,
    maxBatchesPerRun: 20,
    intervalSeconds: 86_400
  }))
})

test('AI usage retention is advisory-locked and deletes in bounded batches', async () => {
  const calls = []
  let deleteCalls = 0
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql === AI_USAGE_RETENTION_LOCK_SQL) return { rows: [{ acquired: true }] }
      if (sql === DELETE_EXPIRED_AI_USAGE_SQL) {
        deleteCalls += 1
        return { rowCount: deleteCalls === 1 ? 2 : 0, rows: [] }
      }
      assert.equal(sql, AI_USAGE_RETENTION_UNLOCK_SQL)
      return { rows: [{ released: true }] }
    },
    release() {}
  }
  const result = await pruneExpiredAiUsage({
    poolInstance: { async connect() { return client } },
    policy: {
      retentionDays: 400,
      batchSize: 2,
      maxBatchesPerRun: 5,
      intervalSeconds: 86_400
    }
  })
  assert.deepEqual(result, { deletedCount: 2, batches: 2, skipped: null })
  assert.deepEqual(calls[1].params, [400, 2])
  assert.match(DELETE_EXPIRED_AI_USAGE_SQL, /FOR UPDATE SKIP LOCKED/)
})
