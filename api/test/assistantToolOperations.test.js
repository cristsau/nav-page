import test from 'node:test'
import assert from 'node:assert/strict'
import {
  executeAssistantToolOperation,
  hashAssistantToolArguments
} from '../src/lib/assistantToolOperations.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const OPERATION_ID = '00000000-0000-4000-8000-000000000002'
const RESOURCE_ID = '00000000-0000-4000-8000-000000000003'
const CREATED_AT = '2026-08-26T01:02:03.000Z'

function succeededRecord(argumentsHash) {
  return {
    user_id: USER_ID,
    operation_id: OPERATION_ID,
    conversation_id: null,
    message_id: null,
    response_message_id: null,
    tool_name: 'create_diary',
    tool_version: 1,
    risk: 'write',
    authorization_mode: 'explicit_command',
    arguments_hash: argumentsHash,
    status: 'succeeded',
    response_status: 201,
    resource_type: 'note',
    resource_id: RESOURCE_ID,
    result_summary: { created: true, deduplicated: false },
    error_code: null,
    undo_until: null,
    created_at: CREATED_AT
  }
}

test('assistant operation argument hashes are stable and tool-scoped', () => {
  const first = hashAssistantToolArguments('create_diary', 1, { b: 2, a: 1 })
  const second = hashAssistantToolArguments('create_diary', 1, { a: 1, b: 2 })
  const different = hashAssistantToolArguments('create_memo', 1, { a: 1, b: 2 })

  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(first, second)
  assert.notEqual(first, different)
})

test('write operation is transactional and returns a minimal idempotency receipt', async () => {
  const statements = []
  let insertedArgumentsHash = null
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (normalized.includes('SELECT * FROM assistant_agent_operations')) return { rows: [] }
      if (normalized.startsWith('INSERT INTO assistant_agent_operations')) {
        insertedArgumentsHash = values[8]
        return { rows: [], rowCount: 1 }
      }
      if (normalized.startsWith('SAVEPOINT') || normalized.startsWith('RELEASE SAVEPOINT')) {
        return { rows: [] }
      }
      if (normalized.startsWith('UPDATE assistant_agent_operations') && normalized.includes("status = 'succeeded'")) {
        return { rows: [succeededRecord(insertedArgumentsHash)] }
      }
      throw new Error(`Unexpected SQL: ${normalized}`)
    }
  }
  const withTransactionFn = async (callback) => callback(client)

  const output = await executeAssistantToolOperation({
    userId: USER_ID,
    operationId: OPERATION_ID,
    toolName: 'create_diary',
    authorizationMode: 'explicit_command',
    args: { title: '今日记录' },
    execute: async () => ({
      result: { note: { id: RESOURCE_ID } },
      resourceType: 'note',
      resourceId: RESOURCE_ID,
      created: true,
      deduplicated: false,
      undoable: false,
      responseStatus: 201
    }),
    buildHref: (_resourceType, resourceId) => `/whisper?note=${resourceId}`,
    withTransactionFn
  })

  assert.deepEqual(output, {
    result: { note: { id: RESOURCE_ID } },
    receipt: {
      id: OPERATION_ID,
      operationId: OPERATION_ID,
      tool: 'create_diary',
      status: 'succeeded',
      summary: { created: true, deduplicated: false },
      resourceType: 'note',
      resourceId: RESOURCE_ID,
      href: `/whisper?note=${RESOURCE_ID}`,
      createdAt: CREATED_AT,
      undoSupported: false,
      undoUntil: null,
      replayed: false
    }
  })
  assert.equal(statements.some((sql) => sql.startsWith('SAVEPOINT assistant_tool_execution')), true)
  assert.equal(statements.some((sql) => sql.startsWith('UPDATE assistant_agent_operations')), true)
  const operationInsert = statements.find((sql) => sql.startsWith('INSERT INTO assistant_agent_operations'))
  assert.match(operationInsert, /conversation_id, message_id/)
  assert.doesNotMatch(operationInsert, /response_message_id/)
})

test('replayed operations rehydrate only the same user resource', async () => {
  const args = { title: '今日记录' }
  const record = succeededRecord(hashAssistantToolArguments('create_diary', 1, args))
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (normalized.includes('SELECT * FROM assistant_agent_operations')) return { rows: [record] }
      throw new Error(`Unexpected SQL: ${normalized}`)
    }
  }
  let rehydrateInput = null

  const output = await executeAssistantToolOperation({
    userId: USER_ID,
    operationId: OPERATION_ID,
    toolName: 'create_diary',
    authorizationMode: 'explicit_command',
    args,
    execute: async () => assert.fail('replayed operation must not execute again'),
    rehydrate: async (input) => {
      rehydrateInput = input
      return { note: { id: input.resourceId } }
    },
    withTransactionFn: async (callback) => callback(client)
  })

  assert.deepEqual(rehydrateInput, {
    userId: USER_ID,
    resourceType: 'note',
    resourceId: RESOURCE_ID
  })
  assert.equal(output.receipt.replayed, true)
  assert.equal(output.receipt.undoSupported, false)
})

test('an operation id cannot be reused with different arguments', async () => {
  const record = succeededRecord('0'.repeat(64))
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (normalized.includes('SELECT * FROM assistant_agent_operations')) return { rows: [record] }
      throw new Error(`Unexpected SQL: ${normalized}`)
    }
  }

  await assert.rejects(
    executeAssistantToolOperation({
      userId: USER_ID,
      operationId: OPERATION_ID,
      toolName: 'create_diary',
      authorizationMode: 'explicit_command',
      args: { title: 'different' },
      execute: async () => ({}),
      withTransactionFn: async (callback) => callback(client)
    }),
    (error) => error.code === 'assistant_tool_operation_conflict'
  )
})
