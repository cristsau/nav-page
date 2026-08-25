import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSubscription } from '../src/routes/webPush.js'
import {
  deliverDueWebPushNotifications,
  validateWebPushPolicy
} from '../src/lib/webPushScheduler.js'

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint',
  keys: {
    p256dh: 'A'.repeat(88),
    auth: 'B'.repeat(24)
  }
}

test('Web Push subscription validation allows known providers and blocks SSRF endpoints', () => {
  assert.deepEqual(normalizeSubscription(subscription), {
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth
  })
  assert.throws(
    () => normalizeSubscription({ ...subscription, endpoint: 'https://127.0.0.1/push' }),
    /provider is not allowed/
  )
  assert.throws(
    () => normalizeSubscription({ ...subscription, keys: { p256dh: 'short', auth: 'short' } }),
    /keys are invalid/
  )
})

test('Web Push policy is bounded', () => {
  assert.deepEqual(validateWebPushPolicy({ intervalSeconds: 60, batchSize: 100, maxAttempts: 6 }), {
    intervalSeconds: 60,
    batchSize: 100,
    maxAttempts: 6
  })
  assert.throws(
    () => validateWebPushPolicy({ intervalSeconds: 1, batchSize: 100, maxAttempts: 6 }),
    /intervalSeconds/
  )
})

test('encrypted reminder delivery never exposes note title and disables a gone endpoint', async () => {
  const queries = []
  const payloads = []
  const client = {
    async query(sql, params) {
      queries.push({ sql, params })
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
      if (/SELECT\s+delivery\.reminder_id/.test(sql)) {
        return { rows: [{
          reminder_id: '11111111-1111-4111-8111-111111111111',
          subscription_id: '22222222-2222-4222-8222-222222222222',
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          note_id: '33333333-3333-4333-8333-333333333333',
          number_id: 1000,
          title: 'private title',
          encrypted: true,
          due_at_snapshot: '2026-08-24T10:00:00.000Z'
        }] }
      }
      if (/SELECT COUNT\(\*\)/.test(sql)) return { rows: [{ count: 0 }] }
      if (/pg_advisory_unlock/.test(sql)) return { rows: [{ released: true }] }
      return { rows: [], rowCount: 1 }
    },
    release() {}
  }
  const result = await deliverDueWebPushNotifications({
    poolInstance: { async connect() { return client } },
    policy: { intervalSeconds: 60, batchSize: 10, maxAttempts: 3 },
    async sendFn(_candidate, payload) {
      payloads.push(payload)
      throw Object.assign(new Error('gone'), { statusCode: 410 })
    }
  })

  assert.equal(payloads[0].title, 'DOMO NAV')
  assert.equal(payloads[0].tag, 'nav-note-reminder')
  assert.doesNotMatch(
    JSON.stringify(payloads[0]),
    /private title|11111111|33333333/
  )
  assert.equal(result.disabled, 1)
  assert.equal(result.failed, 1)
  assert.ok(queries.some(({ sql, params }) => /disabled_at = CASE/.test(sql) && params?.[1] === true))
  assert.ok(queries.some(({ sql }) => /triggered_at >= NOW\(\) - INTERVAL '24 hours'/.test(sql)))
  assert.ok(queries.some(({ sql }) => /POWER\(2, LEAST\(delivery\.attempt_count, 8\)\)/.test(sql)))
})
