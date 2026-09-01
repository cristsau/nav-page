import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  cancelAssistantAdvancedOperation,
  confirmAssistantAdvancedOperation,
  proposeAssistantAdvancedOperation,
  undoAssistantAdvancedOperation
} from '../src/lib/assistantAdvancedOperations.js'
import {
  selectExplicitAssistantAdvancedTool,
  selectExplicitAssistantCreateTool
} from '../src/lib/assistantAuthorization.js'
import {
  assertWorkspaceDatabaseRelationTargets,
  syncWorkspaceDatabaseRelations
} from '../src/lib/workspaceDatabases.js'

const USER_ID = '10000000-0000-4000-8000-000000000001'
const OPERATION_ID = '10000000-0000-4000-8000-000000000002'
const NOTE_ID = '10000000-0000-4000-8000-000000000003'
const GROUP_ID = '10000000-0000-4000-8000-000000000004'
const DATABASE_ID = '10000000-0000-4000-8000-000000000005'
const TARGET_DATABASE_ID = '10000000-0000-4000-8000-000000000006'
const ROW_ID = '10000000-0000-4000-8000-000000000007'
const PROPERTY_ID = '10000000-0000-4000-8000-000000000008'

function transaction(client) {
  return async (callback) => callback(client)
}

test('advanced intent deterministically exposes one mutation target and rejects ambiguous cross-target text', () => {
  assert.equal(selectExplicitAssistantAdvancedTool('请帮我删除笔记 项目草稿'), 'delete_note')
  assert.equal(selectExplicitAssistantAdvancedTool('请帮我发送邮件草稿'), 'send_email_draft')
  assert.equal(selectExplicitAssistantAdvancedTool('请帮我删除笔记并发送邮件'), '')
  assert.equal(selectExplicitAssistantAdvancedTool('可以删除笔记吗？'), '')
  assert.notEqual(selectExplicitAssistantCreateTool('请帮我删除笔记 项目草稿'), 'advanced')
  assert.notEqual(selectExplicitAssistantCreateTool('请帮我发送邮件草稿'), 'advanced')
})

test('proposal requires model UUIDs to come from this request owned candidates', async () => {
  let openedTransaction = false
  await assert.rejects(
    proposeAssistantAdvancedOperation({
      userId: USER_ID,
      operationId: OPERATION_ID,
      toolName: 'delete_note',
      args: { noteId: NOTE_ID },
      candidateIds: [],
      withTransactionFn: async () => { openedTransaction = true }
    }),
    (error) => error.code === 'assistant_candidate_required'
  )
  assert.equal(openedTransaction, false)
})

test('proposal rechecks note ownership and rejects encrypted note sharing before preview', async () => {
  const missingClient = {
    async query(sql) {
      if (sql.includes('pg_advisory')) return { rows: [] }
      return { rows: [] }
    }
  }
  await assert.rejects(
    proposeAssistantAdvancedOperation({
      userId: USER_ID, operationId: OPERATION_ID, toolName: 'delete_note',
      args: { noteId: NOTE_ID }, candidateIds: [NOTE_ID],
      withTransactionFn: transaction(missingClient)
    }),
    (error) => error.code === 'assistant_note_not_found'
  )

  const encryptedClient = {
    async query(sql) {
      if (sql.includes('pg_advisory') || sql.includes('assistant_agent_operations')) return { rows: [] }
      if (sql.includes('FROM notes')) return { rows: [{ id: NOTE_ID, title: '私密', encrypted: true }] }
      return { rows: [] }
    }
  }
  await assert.rejects(
    proposeAssistantAdvancedOperation({
      userId: USER_ID, operationId: OPERATION_ID, toolName: 'create_note_share',
      args: { noteId: NOTE_ID }, candidateIds: [NOTE_ID],
      withTransactionFn: transaction(encryptedClient)
    }),
    (error) => error.code === 'assistant_note_share_forbidden'
  )
})

test('bookmark target group is independently checked against the authenticated owner', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('pg_advisory') || sql.includes('assistant_agent_operations')) return { rows: [] }
      if (sql.includes('FROM nav_bookmarks')) return { rows: [{ id: NOTE_ID, title: 'owned' }] }
      if (sql.includes('FROM nav_groups')) return { rows: [] }
      return { rows: [] }
    }
  }
  await assert.rejects(
    proposeAssistantAdvancedOperation({
      userId: USER_ID, operationId: OPERATION_ID, toolName: 'update_bookmark',
      args: { bookmarkId: NOTE_ID, groupId: GROUP_ID },
      candidateIds: [NOTE_ID, GROUP_ID], withTransactionFn: transaction(client)
    }),
    (error) => error.code === 'assistant_group_not_found'
  )
})

test('expired confirmation persists cancellation before returning a conflict', async () => {
  const calls = []
  const client = {
    async query(sql) {
      calls.push(sql)
      if (sql.includes('SELECT o.*')) return { rows: [{
        user_id: USER_ID, operation_id: OPERATION_ID, tool_name: 'delete_note',
        status: 'awaiting_confirmation', arguments: { noteId: NOTE_ID }, preview: {},
        expires_at: '2026-01-01T00:00:00.000Z', result_summary: {}
      }] }
      if (sql.includes("status='cancelled'")) return { rows: [{ operation_id: OPERATION_ID, tool_name: 'delete_note', status: 'cancelled', result_summary: {} }] }
      return { rows: [] }
    }
  }
  await assert.rejects(
    confirmAssistantAdvancedOperation({
      userId: USER_ID, operationId: OPERATION_ID,
      withTransactionFn: transaction(client), now: () => Date.parse('2026-01-02T00:00:00Z')
    }),
    (error) => error.code === 'assistant_operation_expired' && error.details?.receipt?.status === 'cancelled'
  )
  assert.equal(calls.some((sql) => sql.includes("status='cancelled'")), true)
})

test('successful confirm and cancelled request are replay-safe', async () => {
  let executed = 0
  const succeeded = {
    async query() {
      return { rows: [{ operation_id: OPERATION_ID, tool_name: 'update_note', status: 'succeeded', result_summary: {}, expires_at: '2099-01-01T00:00:00Z' }] }
    }
  }
  const confirmed = await confirmAssistantAdvancedOperation({
    userId: USER_ID, operationId: OPERATION_ID, withTransactionFn: transaction(succeeded),
    executeConfirmedFn: async () => { executed += 1 }
  })
  assert.equal(confirmed.receipt.replayed, true)
  assert.equal(executed, 0)

  const cancelled = {
    async query() {
      return { rows: [{ operation_id: OPERATION_ID, tool_name: 'delete_note', status: 'cancelled', result_summary: {}, preview: {}, expires_at: '2099-01-01T00:00:00Z' }] }
    }
  }
  const replay = await cancelAssistantAdvancedOperation({ userId: USER_ID, operationId: OPERATION_ID, withTransactionFn: transaction(cancelled) })
  assert.equal(replay.receipt.replayed, true)
})

test('undo only marks the receipt after the guarded restore succeeds', async () => {
  let restored = 0
  const client = {
    async query(sql) {
      if (sql.includes('SELECT o.*')) return { rows: [{
        operation_id: OPERATION_ID, tool_name: 'update_note', status: 'succeeded',
        result_summary: {}, undo_until: '2099-01-01T00:00:00Z', before_snapshot: {},
        after_fingerprint: 'a'.repeat(64), preview: {}, expires_at: '2099-01-01T00:00:00Z'
      }] }
      return { rows: [{ operation_id: OPERATION_ID, tool_name: 'update_note', status: 'undone', result_summary: {} }], rowCount: 1 }
    }
  }
  const result = await undoAssistantAdvancedOperation({
    userId: USER_ID, operationId: OPERATION_ID, withTransactionFn: transaction(client),
    restoreBeforeFn: async () => { restored += 1 }, now: () => Date.parse('2026-09-01T00:00:00Z')
  })
  assert.equal(restored, 1)
  assert.equal(result.receipt.status, 'undone')
})

test('relation validation rejects cross-tenant and wrong-database rows and syncs backlinks', async () => {
  const properties = [{ id: PROPERTY_ID, name: '关联', type: 'relation', config: { targetDatabaseId: TARGET_DATABASE_ID } }]
  await assert.rejects(
    assertWorkspaceDatabaseRelationTargets({ query: async () => ({ rows: [] }) }, USER_ID, null, properties, { [PROPERTY_ID]: [ROW_ID] }),
    (error) => error.code === 'workspace_database_relation_target_invalid'
  )
  await assert.rejects(
    assertWorkspaceDatabaseRelationTargets({ query: async () => ({ rows: [{ id: ROW_ID, database_id: DATABASE_ID }] }) }, USER_ID, null, properties, { [PROPERTY_ID]: [ROW_ID] }),
    (error) => error.code === 'workspace_database_relation_target_invalid'
  )
  const valid = await assertWorkspaceDatabaseRelationTargets({ query: async () => ({ rows: [{ id: ROW_ID, database_id: TARGET_DATABASE_ID }] }) }, USER_ID, null, properties, { [PROPERTY_ID]: [ROW_ID] })
  assert.deepEqual(valid, [{ propertyId: PROPERTY_ID, targetId: ROW_ID, targetDatabaseId: TARGET_DATABASE_ID }])

  const writes = []
  await syncWorkspaceDatabaseRelations({ query: async (sql, values) => { writes.push({ sql, values }); return { rows: [], rowCount: 1 } } }, USER_ID, NOTE_ID, DATABASE_ID, valid)
  assert.equal(writes[0].sql.includes('DELETE FROM workspace_database_relations'), true)
  assert.equal(writes[1].sql.includes('INSERT INTO workspace_database_relations'), true)
})

test('migration and source keep proposals durable, mail encrypted, outbox atomic, and undo CAS guarded', async () => {
  const migration = await readFile(new URL('../src/db/migrations/046_assistant_confirmed_operations.sql', import.meta.url), 'utf8')
  const advanced = await readFile(new URL('../src/lib/assistantAdvancedOperations.js', import.meta.url), 'utf8')
  const drafts = await readFile(new URL('../src/lib/emailDrafts.js', import.meta.url), 'utf8')
  const route = await readFile(new URL('../src/routes/assistant.js', import.meta.url), 'utf8')
  assert.match(migration, /sensitive_payload BYTEA/)
  assert.match(migration, /octet_length\(sensitive_payload\) BETWEEN 32 AND 1048576/)
  assert.match(migration, /confirmation_fingerprint CHAR\(64\)/)
  assert.match(migration, /after_fingerprint CHAR\(64\)/)
  assert.match(migration, /octet_length\(before_snapshot::text\) <= 1048576/)
  assert.match(advanced, /\['create_email_draft', 'send_email_draft'\]/)
  assert.match(advanced, /encryptEmailPayload\(stored\.sensitivePayload/)
  assert.match(advanced, /stateFingerprint\(currentPrecondition\) !== row\.confirmation_fingerprint/)
  assert.match(advanced, /stateFingerprint\(current\) !== payload\.after_fingerprint/)
  assert.match(advanced, /queueEmailDraft\([\s\S]*?\{ client \}/)
  assert.match(drafts, /ownsTransaction = !transactionClient/)
  assert.match(advanced, /target: '邮件草稿'/)
  assert.match(advanced, /target: '邮件操作'/)
  assert.match(route, /selectExplicitAssistantAdvancedTool/)
  assert.doesNotMatch(route, /selectedWriteTool === '\*'/)
  assert.match(route, /const sensitiveMailOperation = isSensitiveAssistantMailWriteRequest\(question\)/)
  assert.match(route, /forceSensitive: sensitiveMailOperation/)
  assert.match(route, /selectedWriteTool && isAssistantAdvancedTool\(selectedWriteTool\)[\s\S]*?等待页面中的单独确认/)
  assert.match(route, /用户当前消息明确授权使用 \$\{selectedWriteTool\} 立即创建/)
})
