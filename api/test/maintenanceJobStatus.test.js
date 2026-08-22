import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createMaintenanceJobObserver,
  MAINTENANCE_JOB_NAMES,
  RECORD_MAINTENANCE_FAILURE_SQL,
  RECORD_MAINTENANCE_NOTIFICATION_SQL,
  RECORD_MAINTENANCE_SUCCESS_SQL,
  sanitizeMaintenanceErrorCode,
  summarizeMaintenanceResult
} from '../src/lib/maintenanceJobStatus.js'

test('maintenance status keeps only bounded counters and sanitized error codes', () => {
  assert.deepEqual(
    summarizeMaintenanceResult(
      MAINTENANCE_JOB_NAMES.SECURITY_EVENT_RETENTION,
      { deletedCount: 8, batches: 2, secret: 'must-not-persist' }
    ),
    { deletedCount: 8, batches: 2 }
  )
  assert.deepEqual(
    summarizeMaintenanceResult(
      MAINTENANCE_JOB_NAMES.MEDIA_DELETE_RETRY,
      { processed: 3, deleted: 1, errors: 1, url: 'https://private.invalid' }
    ),
    {
      processed: 3,
      deleted: 1,
      failed: 0,
      referenced: 0,
      notPending: 0,
      errors: 1
    }
  )
  assert.equal(
    sanitizeMaintenanceErrorCode({ code: 'connect refused / private detail' }),
    'CONNECT_REFUSED_PRIVATE_DETAIL'
  )
  assert.equal(sanitizeMaintenanceErrorCode(new Error('private message')), 'ERROR')
})

test('a successful run persists its summary and emits one recovery notification', async () => {
  const calls = []
  const notifications = []
  const poolInstance = {
    async query(text, params) {
      calls.push({ text, params })
      if (text === RECORD_MAINTENANCE_SUCCESS_SQL) {
        return { rows: [{ was_alert_open: true }] }
      }
      assert.equal(text, RECORD_MAINTENANCE_NOTIFICATION_SQL)
      return { rowCount: 1, rows: [] }
    }
  }
  const observer = createMaintenanceJobObserver({
    jobName: MAINTENANCE_JOB_NAMES.SECURITY_EVENT_RETENTION,
    jobLabel: '安全审计定期清理',
    poolInstance,
    alertsEnabled: true,
    failureThreshold: 3,
    alertCooldownSeconds: 21_600,
    async notifyFn(payload) {
      notifications.push(payload)
      return { skipped: false, sent: 1, failed: 0 }
    }
  })

  await observer.succeeded({
    result: { deletedCount: 4, batches: 1, raw: 'not-saved' },
    startedAt: new Date('2026-08-22T01:00:00Z'),
    finishedAt: new Date('2026-08-22T01:00:01Z'),
    durationMs: 1_000
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].text, RECORD_MAINTENANCE_SUCCESS_SQL)
  assert.equal(calls[0].params[4], JSON.stringify({ deletedCount: 4, batches: 1 }))
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].kind, 'recovery')
  assert.deepEqual(calls[1].params.slice(1, 3), ['recovery', 'sent'])
})

test('a threshold failure reserves a cooldown alert and records partial delivery', async () => {
  const calls = []
  const notifications = []
  const poolInstance = {
    async query(text, params) {
      calls.push({ text, params })
      if (text === RECORD_MAINTENANCE_FAILURE_SQL) {
        return {
          rows: [{ should_notify: true, consecutive_failures: 3 }]
        }
      }
      return { rowCount: 1, rows: [] }
    }
  }
  const observer = createMaintenanceJobObserver({
    jobName: MAINTENANCE_JOB_NAMES.MEDIA_DELETE_RETRY,
    jobLabel: '图床删除失败重试',
    poolInstance,
    alertsEnabled: true,
    failureThreshold: 3,
    alertCooldownSeconds: 21_600,
    async notifyFn(payload) {
      notifications.push(payload)
      return { skipped: false, sent: 1, failed: 1 }
    }
  })

  await observer.failed({
    error: Object.assign(new Error('private upstream response'), { code: 'ECONNREFUSED' }),
    startedAt: new Date('2026-08-22T02:00:00Z'),
    finishedAt: new Date('2026-08-22T02:00:03Z'),
    durationMs: 3_000
  })

  assert.equal(calls[0].text, RECORD_MAINTENANCE_FAILURE_SQL)
  assert.deepEqual(calls[0].params.slice(4), ['ECONNREFUSED', true, 3, 21_600])
  assert.equal(notifications[0].consecutiveFailures, 3)
  assert.equal(notifications[0].errorCode, 'ECONNREFUSED')
  assert.deepEqual(calls[1].params.slice(1, 3), ['failure', 'partial'])
})

test('a replica lock skip does not overwrite the last completed state', async () => {
  let queryCalls = 0
  const observer = createMaintenanceJobObserver({
    jobName: MAINTENANCE_JOB_NAMES.MEDIA_DELETE_RETRY,
    jobLabel: '图床删除失败重试',
    poolInstance: {
      async query() {
        queryCalls += 1
        return { rows: [] }
      }
    },
    alertsEnabled: false,
    failureThreshold: 3,
    alertCooldownSeconds: 21_600
  })
  await observer.succeeded({
    result: { skipped: 'already-running' },
    startedAt: new Date(),
    finishedAt: new Date(),
    durationMs: 0
  })
  assert.equal(queryCalls, 0)
})
