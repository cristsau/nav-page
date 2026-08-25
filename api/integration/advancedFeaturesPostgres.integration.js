import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

const EXPECTED_DATABASE_NAME = 'nav_advanced_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BOOKMARK_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NOTE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const REMINDER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const SUBSCRIPTION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

function assertIsolatedDatabaseTarget() {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.NAV_ADVANCED_FEATURES_INTEGRATION_TEST, 'true')
  const databaseUrl = new URL(String(process.env.DATABASE_URL || ''))
  assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol))
  assert.ok(ALLOWED_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase()))
  assert.equal(
    decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, '')),
    EXPECTED_DATABASE_NAME
  )
  for (const key of ['database', 'dbname', 'host', 'hostaddr', 'service']) {
    assert.equal(databaseUrl.searchParams.has(key), false)
  }
}

assertIsolatedDatabaseTarget()

let pool
let synchronizeWorkspaceSearchDocuments
let searchWorkspaceHybridForUser
let deliverDueWebPushNotifications

const richDocument = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: '恢复任务' }]
    },
    {
      type: 'taskList',
      content: [{
        type: 'taskItem',
        attrs: { checked: false },
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: '验证 PostgreSQL 数据' }]
        }]
      }]
    }
  ]
}

before(async () => {
  ;({ pool } = await import('../src/db/index.js'))
  ;({ synchronizeWorkspaceSearchDocuments } = await import('../src/lib/workspaceSearchIndex.js'))
  ;({ searchWorkspaceHybridForUser } = await import('../src/lib/hybridWorkspaceSearch.js'))
  ;({ deliverDueWebPushNotifications } = await import('../src/lib/webPushScheduler.js'))
})

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE')
  await pool.query(
    `
      INSERT INTO users (id, username, password_hash, role, status, approved_at)
      VALUES ($1, 'advanced-feature-test', 'not-a-real-password', 'user', 'approved', NOW())
    `,
    [USER_ID]
  )
})

after(async () => {
  await pool?.end()
})

test('dirty-index synchronization batches sources and BM25 finds Chinese block text', async () => {
  await pool.query(
    `
      INSERT INTO nav_groups (id, user_id, name, icon, color)
      VALUES ($1, $2, '测试', 'folder', '#5e6ad2')
    `,
    [GROUP_ID, USER_ID]
  )
  await pool.query(
    `
      INSERT INTO nav_bookmarks (
        id, user_id, group_id, title, url, description, tags
      ) VALUES (
        $1, $2, $3, 'PostgreSQL 文档', 'https://www.postgresql.org/Docs/',
        '数据库恢复参考', '["数据库","恢复"]'::jsonb
      )
    `,
    [BOOKMARK_ID, USER_ID, GROUP_ID]
  )
  await pool.query(
    `
      INSERT INTO notes (
        id, user_id, number_id, type, title, content,
        content_format, content_json, encrypted, password_hash,
        tags, attachments
      ) VALUES (
        $1, $2, 5000, 'memo', '恢复任务', '恢复任务\n验证 PostgreSQL 数据',
        'tiptap-json', $3::jsonb, FALSE, '', '["数据库"]'::jsonb, '[]'::jsonb
      )
    `,
    [NOTE_ID, USER_ID, JSON.stringify(richDocument)]
  )

  const first = await synchronizeWorkspaceSearchDocuments({
    userId: USER_ID,
    poolInstance: pool
  })
  assert.equal(first.indexed, 2)
  assert.equal(first.changed, 2)
  assert.equal(first.skipped, null)

  const second = await synchronizeWorkspaceSearchDocuments({
    userId: USER_ID,
    poolInstance: pool
  })
  assert.equal(second.skipped, 'unchanged')

  const search = await searchWorkspaceHybridForUser({
    userId: USER_ID,
    search: '数据库恢复',
    limit: 10,
    poolInstance: pool,
    queryFn: pool.query.bind(pool)
  })
  assert.equal(search.searchMode, 'bm25')
  assert.ok(search.results.some((result) => result.id === BOOKMARK_ID))
  assert.ok(search.results.some((result) => result.id === NOTE_ID))
  assert.equal(
    search.results.find((result) => result.id === BOOKMARK_ID)?.href,
    'https://www.postgresql.org/Docs/'
  )

  await pool.query(
    `UPDATE notes SET content = '恢复任务\n验证 PostgreSQL 备份链', updated_at = NOW() WHERE id = $1`,
    [NOTE_ID]
  )
  assert.equal(
    (await pool.query('SELECT dirty FROM workspace_search_index_state WHERE user_id = $1', [USER_ID])).rows[0].dirty,
    true
  )
  const refreshed = await synchronizeWorkspaceSearchDocuments({
    userId: USER_ID,
    poolInstance: pool
  })
  assert.equal(refreshed.changed, 1)
})

test('Web Push delivery persists exactly once and marks successful subscription state', async () => {
  const dueAt = '2026-08-24T10:00:00.000Z'
  await pool.query(
    `
      INSERT INTO notes (
        id, user_id, number_id, type, title, content, encrypted,
        password_hash, tags, attachments, due_at, remind_before_minutes, completed
      ) VALUES (
        $1, $2, 5001, 'memo', '检查发布机密事项', '检查发布', FALSE,
        '', '[]'::jsonb, '[]'::jsonb, $3, 0, FALSE
      )
    `,
    [NOTE_ID, USER_ID, dueAt]
  )
  await pool.query(
    `
      INSERT INTO note_reminders (
        id, user_id, note_id, due_at_snapshot, triggered_at,
        remind_before_minutes_snapshot, reminder_at_snapshot
      ) VALUES ($1, $2, $3, $4, NOW() - INTERVAL '1 minute', 0, $4)
    `,
    [REMINDER_ID, USER_ID, NOTE_ID, dueAt]
  )
  await pool.query(
    `
      INSERT INTO web_push_subscriptions (
        id, user_id, endpoint, endpoint_hash, p256dh, auth, device_label
      ) VALUES (
        $1, $2, 'https://fcm.googleapis.com/fcm/send/integration',
        repeat('a', 64), repeat('A', 88), repeat('B', 24), 'CI browser'
      )
    `,
    [SUBSCRIPTION_ID, USER_ID]
  )

  const payloads = []
  const result = await deliverDueWebPushNotifications({
    poolInstance: pool,
    policy: { intervalSeconds: 60, batchSize: 10, maxAttempts: 3 },
    async sendFn(_subscription, payload) {
      payloads.push(payload)
      return { statusCode: 201 }
    }
  })
  assert.deepEqual(
    { processed: result.processed, delivered: result.delivered, failed: result.failed },
    { processed: 1, delivered: 1, failed: 0 }
  )
  assert.equal(payloads[0].title, 'DOMO NAV')
  assert.equal(payloads[0].body, '你有一条新的到期提醒，登录后查看完整内容。')
  assert.equal(payloads[0].url, '/whisper')
  assert.doesNotMatch(JSON.stringify(payloads[0]), /检查发布|5001|dddddddd/i)
  const delivery = await pool.query(
    `SELECT status, attempt_count, delivered_at FROM note_reminder_push_deliveries`
  )
  assert.equal(delivery.rows[0].status, 'delivered')
  assert.equal(delivery.rows[0].attempt_count, 1)
  assert.ok(delivery.rows[0].delivered_at)
  assert.ok(
    (await pool.query('SELECT last_success_at FROM web_push_subscriptions WHERE id = $1', [SUBSCRIPTION_ID])).rows[0].last_success_at
  )
})

test('sensitive notification Web Push is generic and does not expose its source id', async () => {
  await pool.query(
    `INSERT INTO web_push_subscriptions (
       id, user_id, endpoint, endpoint_hash, p256dh, auth, device_label
     ) VALUES (
       $1, $2, 'https://fcm.googleapis.com/fcm/send/generic-integration',
       repeat('b', 64), repeat('A', 88), repeat('B', 24), 'CI browser'
     )`,
    [SUBSCRIPTION_ID, USER_ID]
  )
  const notificationId = '12121212-1212-4212-8212-121212121212'
  const emailEventId = '34343434-3434-4434-8434-343434343434'
  await pool.query(
    `INSERT INTO notifications (
       id, user_id, event_type, title, summary, source_type, source_id,
       action_url, dedupe_key, sensitive, push_enabled
     ) VALUES (
       $1, $2, 'email.tier1', '数据库里可见的私密标题',
       '数据库里可见的私密摘要', 'email', $3,
       $4, 'integration-sensitive-push', TRUE, TRUE
     )`,
    [notificationId, USER_ID, emailEventId, `/assistant?email=${emailEventId}`]
  )

  const payloads = []
  const result = await deliverDueWebPushNotifications({
    poolInstance: pool,
    policy: { intervalSeconds: 60, batchSize: 10, maxAttempts: 3 },
    async sendFn(_subscription, payload) {
      payloads.push(payload)
      return { statusCode: 201 }
    }
  })

  assert.equal(result.notificationDelivered, 1)
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].title, 'DOMO NAV')
  assert.equal(payloads[0].url, '/?notifications=1')
  const serialized = JSON.stringify(payloads[0])
  assert.doesNotMatch(serialized, /私密标题|私密摘要|34343434/)
})

test('database rejects rich-content privacy states that bypass the API', async () => {
  await assert.rejects(
    pool.query(
      `
        INSERT INTO notes (
          id, user_id, number_id, type, title, content,
          content_format, content_json, encrypted, password_hash, tags, attachments
        ) VALUES (
          $1, $2, 5002, 'memo', 'invalid', 'invalid',
          'plain', $3::jsonb, FALSE, '', '[]'::jsonb, '[]'::jsonb
        )
      `,
      [NOTE_ID, USER_ID, JSON.stringify(richDocument)]
    ),
    (error) => error?.code === '23514'
  )
})
