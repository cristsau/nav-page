import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

const EXPECTED_DATABASE_NAME = 'nav_assistant_agent_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'
const OWNER_CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_CONVERSATION_ID = '44444444-4444-4444-8444-444444444444'
const OWNER_MESSAGE_ID = '55555555-5555-4555-8555-555555555555'
const OTHER_MESSAGE_ID = '66666666-6666-4666-8666-666666666666'
const RESPONSE_MESSAGE_ID = '77777777-7777-4777-8777-777777777777'

function assertIsolatedDatabaseTarget() {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.NAV_ASSISTANT_AGENT_INTEGRATION_TEST, 'true')

  let databaseUrl
  try {
    databaseUrl = new URL(String(process.env.DATABASE_URL || ''))
  } catch {
    assert.fail('assistant agent integration requires a valid DATABASE_URL')
  }
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
let executeAssistantToolOperation

before(async () => {
  ;({ pool } = await import('../src/db/index.js'))
  ;({ executeAssistantToolOperation } = await import('../src/lib/assistantToolOperations.js'))
})

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE')
  await pool.query(
    `
      INSERT INTO users (id, username, password_hash, role, status, approved_at)
      VALUES
        ($1, 'assistant-owner', 'not-a-real-password', 'user', 'approved', NOW()),
        ($2, 'assistant-other', 'not-a-real-password', 'user', 'approved', NOW())
    `,
    [OWNER_ID, OTHER_USER_ID]
  )
  await pool.query(
    `
      INSERT INTO assistant_conversations (id, user_id, title)
      VALUES
        ($1, $2, 'Owner conversation'),
        ($3, $4, 'Other conversation')
    `,
    [OWNER_CONVERSATION_ID, OWNER_ID, OTHER_CONVERSATION_ID, OTHER_USER_ID]
  )
  await pool.query(
    `
      INSERT INTO assistant_messages (
        id, conversation_id, user_id, role, content, sources
      ) VALUES
        ($1, $2, $3, 'user', '创建今天的日记', '[]'::jsonb),
        ($4, $5, $6, 'user', '不属于当前用户的消息', '[]'::jsonb)
    `,
    [
      OWNER_MESSAGE_ID,
      OWNER_CONVERSATION_ID,
      OWNER_ID,
      OTHER_MESSAGE_ID,
      OTHER_CONVERSATION_ID,
      OTHER_USER_ID
    ]
  )
})

after(async () => {
  await pool?.end()
})

async function executeDiaryOperation({
  operationId,
  title,
  userId = OWNER_ID,
  conversationId = OWNER_CONVERSATION_ID,
  messageId = OWNER_MESSAGE_ID,
  failAfterInsert = false,
  onExecute = null
}) {
  const args = {
    title,
    content: `${title} 正文`
  }

  return executeAssistantToolOperation({
    userId,
    operationId,
    conversationId,
    messageId,
    toolName: 'create_diary',
    authorizationMode: 'explicit_command',
    args,
    execute: async (client) => {
      onExecute?.()
      const created = await client.query(
        `
          INSERT INTO notes (
            user_id, type, title, content, encrypted,
            password_hash, tags, attachments
          ) VALUES (
            $1, 'diary', $2, $3, FALSE, '', '[]'::jsonb, '[]'::jsonb
          )
          RETURNING id, user_id, type, title, content
        `,
        [userId, args.title, args.content]
      )
      if (failAfterInsert) {
        const error = new Error('fixture failure after resource insert')
        error.code = 'assistant_fixture_failure'
        error.statusCode = 422
        throw error
      }
      return {
        result: { note: created.rows[0] },
        resourceType: 'note',
        resourceId: created.rows[0].id,
        created: true,
        deduplicated: false,
        undoable: false,
        responseStatus: 201
      }
    },
    rehydrate: async ({ userId: receiptUserId, resourceId }) => {
      const result = await pool.query(
        `
          SELECT id, user_id, type, title, content
          FROM notes
          WHERE id = $1 AND user_id = $2
        `,
        [resourceId, receiptUserId]
      )
      return result.rows.length ? { note: result.rows[0] } : null
    },
    buildHref: (_resourceType, resourceId) => `/whisper?note=${resourceId}`
  })
}

test('successful writes persist one receipt and replay the same operation without duplicate resources', async () => {
  const operationId = '88888888-8888-4888-8888-888888888888'
  let executionCount = 0
  const options = {
    operationId,
    title: 'PostgreSQL 门禁',
    onExecute: () => { executionCount += 1 }
  }

  const first = await executeDiaryOperation(options)
  const replay = await executeDiaryOperation(options)

  assert.equal(executionCount, 1)
  assert.equal(first.receipt.status, 'succeeded')
  assert.equal(first.receipt.replayed, false)
  assert.equal(first.receipt.summary.created, true)
  assert.equal(replay.receipt.replayed, true)
  assert.equal(replay.receipt.resourceId, first.receipt.resourceId)
  assert.equal(replay.result.note.id, first.result.note.id)
  assert.equal(
    Number((await pool.query('SELECT COUNT(*) FROM notes WHERE user_id = $1', [OWNER_ID])).rows[0].count),
    1
  )
  const receipt = await pool.query(
    `
      SELECT status, response_status, resource_type, resource_id, result_summary
      FROM assistant_agent_operations
      WHERE user_id = $1 AND operation_id = $2
    `,
    [OWNER_ID, operationId]
  )
  assert.equal(receipt.rows.length, 1)
  assert.equal(receipt.rows[0].status, 'succeeded')
  assert.equal(receipt.rows[0].response_status, 201)
  assert.equal(receipt.rows[0].resource_type, 'note')
  assert.equal(receipt.rows[0].resource_id, first.receipt.resourceId)
  assert.deepEqual(receipt.rows[0].result_summary, { created: true, deduplicated: false })
})

test('reusing an operation id with different arguments is rejected without a second write', async () => {
  const operationId = '99999999-9999-4999-8999-999999999999'
  await executeDiaryOperation({ operationId, title: '第一篇日记' })

  await assert.rejects(
    executeDiaryOperation({ operationId, title: '篡改后的第二篇日记' }),
    (error) => error?.code === 'assistant_tool_operation_conflict' && error?.statusCode === 409
  )
  assert.equal(
    Number((await pool.query('SELECT COUNT(*) FROM notes WHERE user_id = $1', [OWNER_ID])).rows[0].count),
    1
  )
  assert.equal(
    Number((await pool.query(
      'SELECT COUNT(*) FROM assistant_agent_operations WHERE user_id = $1 AND operation_id = $2',
      [OWNER_ID, operationId]
    )).rows[0].count),
    1
  )
})

test('failed execution rolls back the resource but commits a bounded failed receipt', async () => {
  const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

  await assert.rejects(
    executeDiaryOperation({
      operationId,
      title: '必须回滚的日记',
      failAfterInsert: true
    }),
    (error) => error?.code === 'assistant_fixture_failure' && error?.statusCode === 422
  )
  assert.equal(
    Number((await pool.query('SELECT COUNT(*) FROM notes WHERE user_id = $1', [OWNER_ID])).rows[0].count),
    0
  )
  const receipt = await pool.query(
    `
      SELECT status, response_status, resource_type, resource_id, result_summary, error_code
      FROM assistant_agent_operations
      WHERE user_id = $1 AND operation_id = $2
    `,
    [OWNER_ID, operationId]
  )
  assert.equal(receipt.rows.length, 1)
  assert.equal(receipt.rows[0].status, 'failed')
  assert.equal(receipt.rows[0].response_status, 422)
  assert.equal(receipt.rows[0].resource_type, null)
  assert.equal(receipt.rows[0].resource_id, null)
  assert.deepEqual(receipt.rows[0].result_summary, {})
  assert.equal(receipt.rows[0].error_code, 'assistant_fixture_failure')
})

test('conversation and message ownership are enforced before an operation receipt is created', async () => {
  await assert.rejects(
    executeDiaryOperation({
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: '跨用户会话',
      conversationId: OTHER_CONVERSATION_ID,
      messageId: OTHER_MESSAGE_ID
    }),
    (error) => error?.code === 'assistant_tool_conversation_not_found' && error?.statusCode === 404
  )
  await assert.rejects(
    executeDiaryOperation({
      operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: '跨用户消息',
      conversationId: OWNER_CONVERSATION_ID,
      messageId: OTHER_MESSAGE_ID
    }),
    (error) => error?.code === 'assistant_tool_message_not_found' && error?.statusCode === 404
  )
  assert.equal(
    Number((await pool.query('SELECT COUNT(*) FROM assistant_agent_operations')).rows[0].count),
    0
  )
  assert.equal(Number((await pool.query('SELECT COUNT(*) FROM notes')).rows[0].count), 0)
})

test('deleting a linked assistant response keeps the receipt and clears only response_message_id', async () => {
  const operationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  await executeDiaryOperation({ operationId, title: '保留操作回执' })
  await pool.query(
    `
      INSERT INTO assistant_messages (
        id, conversation_id, user_id, role, content, sources
      ) VALUES ($1, $2, $3, 'assistant', '日记已创建', '[]'::jsonb)
    `,
    [RESPONSE_MESSAGE_ID, OWNER_CONVERSATION_ID, OWNER_ID]
  )
  await pool.query(
    `
      UPDATE assistant_agent_operations
      SET response_message_id = $1, updated_at = NOW()
      WHERE user_id = $2 AND operation_id = $3
    `,
    [RESPONSE_MESSAGE_ID, OWNER_ID, operationId]
  )

  await pool.query('DELETE FROM assistant_messages WHERE id = $1', [RESPONSE_MESSAGE_ID])

  const receipt = await pool.query(
    `
      SELECT status, message_id, response_message_id
      FROM assistant_agent_operations
      WHERE user_id = $1 AND operation_id = $2
    `,
    [OWNER_ID, operationId]
  )
  assert.equal(receipt.rows.length, 1)
  assert.equal(receipt.rows[0].status, 'succeeded')
  assert.equal(receipt.rows[0].message_id, OWNER_MESSAGE_ID)
  assert.equal(receipt.rows[0].response_message_id, null)
})
