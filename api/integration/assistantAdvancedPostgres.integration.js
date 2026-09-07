import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before, beforeEach } from 'node:test'

const EXPECTED_DATABASE_NAME = 'nav_assistant_advanced_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'
const NOTE_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_NOTE_ID = '44444444-4444-4444-8444-444444444444'
const ACCOUNT_ID = '55555555-5555-4555-8555-555555555555'
const SOURCE_DATABASE_ID = '66666666-6666-4666-8666-666666666666'
const TARGET_DATABASE_ID = '77777777-7777-4777-8777-777777777777'
const RELATION_PROPERTY_ID = '88888888-8888-4888-8888-888888888888'
const TARGET_ROW_ID = '99999999-9999-4999-8999-999999999999'

const operationIds = Object.freeze({
  update: '10000000-0000-4000-8000-000000000001',
  cancel: '10000000-0000-4000-8000-000000000002',
  expire: '10000000-0000-4000-8000-000000000003',
  cas: '10000000-0000-4000-8000-000000000004',
  mail: '10000000-0000-4000-8000-000000000005',
  relation: '10000000-0000-4000-8000-000000000006',
  unicode: '10000000-0000-4000-8000-000000000007',
  stale: '10000000-0000-4000-8000-000000000008',
  context: '10000000-0000-4000-8000-000000000009',
  concurrentA: '10000000-0000-4000-8000-000000000010',
  concurrentB: '10000000-0000-4000-8000-000000000011'
})

function assertIsolatedDatabaseTarget() {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.NAV_ASSISTANT_ADVANCED_INTEGRATION_TEST, 'true')
  const databaseUrl = new URL(String(process.env.DATABASE_URL || ''))
  assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol))
  assert.ok(ALLOWED_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase()))
  assert.equal(decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, '')), EXPECTED_DATABASE_NAME)
  for (const key of ['database', 'dbname', 'host', 'hostaddr', 'service']) {
    assert.equal(databaseUrl.searchParams.has(key), false)
  }
}

assertIsolatedDatabaseTarget()

const ephemeralSecretDirectory = mkdtempSync(join(tmpdir(), 'nav-assistant-advanced-'))
if (!String(process.env.NAV_EMAIL_ENCRYPTION_KEY_FILE || '').trim()) {
  const keyPath = join(ephemeralSecretDirectory, 'email.key')
  writeFileSync(keyPath, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  process.env.NAV_EMAIL_ENCRYPTION_KEY_FILE = keyPath
}

const smtpPasswordPath = join(ephemeralSecretDirectory, 'smtp-password')
writeFileSync(smtpPasswordPath, 'integration-only-password', { mode: 0o600 })
chmodSync(smtpPasswordPath, 0o600)
Object.assign(process.env, {
  NAV_MANAGED_INTEGRATIONS_DIR: ephemeralSecretDirectory,
  NAV_MAIL_DELIVERY_ENABLED: 'true',
  NAV_EMAIL_SOURCE_KEY: 'mxroute',
  NAV_EMAIL_OWNER_USERNAME: 'advanced-owner',
  NAV_SMTP_HOST: 'smtp.example.test',
  NAV_SMTP_PORT: '465',
  NAV_SMTP_SECURE: 'true',
  NAV_SMTP_USERNAME: 'sender@example.test',
  NAV_SMTP_PASSWORD_FILE: smtpPasswordPath,
  NAV_SMTP_FROM_ADDRESS: 'sender@example.test'
})

let pool
let createEmailDraft
let proposeAssistantAdvancedOperation
let confirmAssistantAdvancedOperation
let cancelAssistantAdvancedOperation
let undoAssistantAdvancedOperation

before(async () => {
  ;({ pool } = await import('../src/db/index.js'))
  ;({ createEmailDraft } = await import('../src/lib/emailDrafts.js'))
  ;({
    proposeAssistantAdvancedOperation,
    confirmAssistantAdvancedOperation,
    cancelAssistantAdvancedOperation,
    undoAssistantAdvancedOperation
  } = await import('../src/lib/assistantAdvancedOperations.js'))
})

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE')
  await pool.query(
    `INSERT INTO users (id,username,password_hash,role,status,approved_at)
     VALUES
       ($1,'advanced-owner','not-a-real-password','user','approved',NOW()),
       ($2,'advanced-other','not-a-real-password','user','approved',NOW())`,
    [OWNER_ID, OTHER_ID]
  )
  await pool.query(
    `INSERT INTO notes (id,user_id,type,title,content,encrypted,password_hash,tags,attachments)
     VALUES
       ($1,$2,'memo','Owner note','before',FALSE,'','[]'::jsonb,'[]'::jsonb),
       ($3,$4,'memo','Other note','private',FALSE,'','[]'::jsonb,'[]'::jsonb)`,
    [NOTE_ID, OWNER_ID, OTHER_NOTE_ID, OTHER_ID]
  )
  await pool.query(
    `INSERT INTO email_accounts (id,user_id,source_key,label,enabled,capabilities,last_connected_at)
     VALUES ($1,$2,'mxroute','Owner mailbox',TRUE,'{}'::jsonb,NOW())`,
    [ACCOUNT_ID, OWNER_ID]
  )
  await pool.query(
    `INSERT INTO workspace_databases (id,user_id,name) VALUES
       ($1,$2,'Projects'),($3,$2,'People')`,
    [SOURCE_DATABASE_ID, OWNER_ID, TARGET_DATABASE_ID]
  )
  await pool.query(
    `INSERT INTO workspace_database_properties
       (id,database_id,user_id,name,type,config,display_order)
     VALUES ($1,$2,$3,'Owner','relation',$4::jsonb,0)`,
    [RELATION_PROPERTY_ID, SOURCE_DATABASE_ID, OWNER_ID, JSON.stringify({ targetDatabaseId: TARGET_DATABASE_ID, allowMultiple: true })]
  )
  await pool.query(
    `INSERT INTO workspace_database_rows (id,database_id,user_id,title,values,position)
     VALUES ($1,$2,$3,'Alice','{}'::jsonb,0)`,
    [TARGET_ROW_ID, TARGET_DATABASE_ID, OWNER_ID]
  )
})

after(async () => {
  await pool?.end()
  rmSync(ephemeralSecretDirectory, { recursive: true, force: true })
})

function proposal({ operationId, toolName, args, candidateIds, userId = OWNER_ID }) {
  return proposeAssistantAdvancedOperation({
    userId,
    operationId,
    conversationId: null,
    messageId: null,
    toolName,
    args,
    candidateIds
  })
}

test('proposal is durable, owner-scoped, and confirm replay is idempotent', async () => {
  await assert.rejects(
    proposal({
      operationId: operationIds.update,
      toolName: 'update_note',
      args: { noteId: OTHER_NOTE_ID, title: 'not allowed' },
      candidateIds: [OTHER_NOTE_ID]
    }),
    (error) => error.code === 'assistant_note_not_found'
  )

  const prepared = await proposal({
    operationId: operationIds.update,
    toolName: 'update_note',
    args: { noteId: NOTE_ID, title: 'Confirmed once' },
    candidateIds: [NOTE_ID]
  })
  assert.equal(prepared.receipt.status, 'awaiting_confirmation')
  assert.equal(
    Number((await pool.query('SELECT COUNT(*) FROM assistant_agent_operation_payloads WHERE user_id=$1 AND operation_id=$2', [OWNER_ID, operationIds.update])).rows[0].count),
    1
  )
  await assert.rejects(
    confirmAssistantAdvancedOperation({ userId: OTHER_ID, operationId: operationIds.update }),
    (error) => error.code === 'assistant_operation_not_found'
  )

  const revisionBefore = Number((await pool.query('SELECT revision FROM notes WHERE id=$1 AND user_id=$2', [NOTE_ID, OWNER_ID])).rows[0].revision)
  const first = await confirmAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.update })
  const replay = await confirmAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.update })
  assert.equal(first.receipt.status, 'succeeded')
  assert.equal(replay.receipt.replayed, true)
  const note = (await pool.query('SELECT title,revision FROM notes WHERE id=$1 AND user_id=$2', [NOTE_ID, OWNER_ID])).rows[0]
  assert.equal(note.title, 'Confirmed once')
  assert.equal(Number(note.revision), revisionBefore + 1)
})

test('proposal context IDs are explicitly bound to the authenticated owner', async () => {
  const otherConversation = '20000000-0000-4000-8000-000000000001'
  const otherMessage = '20000000-0000-4000-8000-000000000002'
  await pool.query('INSERT INTO assistant_conversations(id,user_id,title) VALUES($1,$2,\'Other\')', [otherConversation, OTHER_ID])
  await pool.query(
    `INSERT INTO assistant_messages(id,conversation_id,user_id,role,content)
     VALUES($1,$2,$3,'user','other')`,
    [otherMessage, otherConversation, OTHER_ID]
  )
  await assert.rejects(
    proposeAssistantAdvancedOperation({
      userId: OWNER_ID,
      operationId: operationIds.context,
      conversationId: otherConversation,
      messageId: otherMessage,
      toolName: 'update_note',
      args: { noteId: NOTE_ID, title: 'blocked' },
      candidateIds: [NOTE_ID]
    }),
    (error) => error.code === 'assistant_conversation_not_found'
  )
  assert.equal(Number((await pool.query('SELECT COUNT(*) FROM assistant_agent_operations WHERE user_id=$1 AND operation_id=$2', [OWNER_ID, operationIds.context])).rows[0].count), 0)
})

test('confirm rejects a stale preview before any write', async () => {
  await proposal({
    operationId: operationIds.stale,
    toolName: 'update_note',
    args: { noteId: NOTE_ID, title: 'stale assistant change' },
    candidateIds: [NOTE_ID]
  })
  await pool.query(`UPDATE notes SET content='changed after preview',revision=revision+1,updated_at=NOW() WHERE id=$1 AND user_id=$2`, [NOTE_ID, OWNER_ID])
  await assert.rejects(
    confirmAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.stale }),
    (error) => error.code === 'assistant_operation_resource_changed'
  )
  const note = (await pool.query('SELECT title,content FROM notes WHERE id=$1 AND user_id=$2', [NOTE_ID, OWNER_ID])).rows[0]
  assert.deepEqual(note, { title: 'Owner note', content: 'changed after preview' })
})

test('cancel replays and expired confirmation persists cancelled state', async () => {
  await proposal({
    operationId: operationIds.cancel,
    toolName: 'update_note',
    args: { noteId: NOTE_ID, title: 'cancel me' },
    candidateIds: [NOTE_ID]
  })
  const first = await cancelAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.cancel })
  const replay = await cancelAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.cancel })
  assert.equal(first.receipt.status, 'cancelled')
  assert.equal(replay.receipt.replayed, true)

  await proposal({
    operationId: operationIds.expire,
    toolName: 'update_note',
    args: { noteId: NOTE_ID, title: 'expired' },
    candidateIds: [NOTE_ID]
  })
  await pool.query(
    `UPDATE assistant_agent_operation_payloads
     SET created_at=NOW()-INTERVAL '2 hours',expires_at=NOW()-INTERVAL '1 hour'
     WHERE user_id=$1 AND operation_id=$2`,
    [OWNER_ID, operationIds.expire]
  )
  await assert.rejects(
    confirmAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.expire }),
    (error) => error.code === 'assistant_operation_expired'
  )
  const operation = (await pool.query('SELECT status,error_code FROM assistant_agent_operations WHERE user_id=$1 AND operation_id=$2', [OWNER_ID, operationIds.expire])).rows[0]
  assert.deepEqual(operation, { status: 'cancelled', error_code: 'assistant_operation_expired' })
})

test('undo uses an after-state CAS and never overwrites a later edit', async () => {
  await proposal({
    operationId: operationIds.cas,
    toolName: 'update_note',
    args: { noteId: NOTE_ID, title: 'assistant edit' },
    candidateIds: [NOTE_ID]
  })
  await confirmAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.cas })
  await pool.query(`UPDATE notes SET title='later user edit',revision=revision+1,updated_at=NOW() WHERE id=$1 AND user_id=$2`, [NOTE_ID, OWNER_ID])
  await assert.rejects(
    undoAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.cas }),
    (error) => error.code === 'assistant_operation_resource_changed'
  )
  assert.equal((await pool.query('SELECT title FROM notes WHERE id=$1', [NOTE_ID])).rows[0].title, 'later user edit')
  assert.equal((await pool.query('SELECT status FROM assistant_agent_operations WHERE user_id=$1 AND operation_id=$2', [OWNER_ID, operationIds.cas])).rows[0].status, 'succeeded')
})

test('mail proposals are rejected without creating operations or outbox rows', async () => {
  const draft = await createEmailDraft({
    userId: OWNER_ID,
    accountId: ACCOUNT_ID,
    payload: { to: ['retired@example.test'], cc: [], bcc: [], subject: 'Retired mailbox', text: 'Must not send' }
  })
  await assert.rejects(proposal({
    operationId: operationIds.mail,
    toolName: 'send_email_draft',
    args: { draftId: draft.id, contentHash: draft.contentHash },
    candidateIds: [draft.id]
  }), (error) => error.code === 'MAILBOX_RETIRED')
  const queued = await pool.query("SELECT COUNT(*) FROM mail_outbox WHERE user_id=$1 AND message_type='user.mail'", [OWNER_ID])
  assert.equal(Number(queued.rows[0].count), 0)
  const operation = await pool.query('SELECT COUNT(*) FROM assistant_agent_operations WHERE user_id=$1 AND operation_id=$2', [OWNER_ID, operationIds.mail])
  assert.equal(Number(operation.rows[0].count), 0)
})

test('database relation write validates owned candidates and materializes the backlink row', async () => {
  const prepared = await proposal({
    operationId: operationIds.relation,
    toolName: 'create_database_row',
    args: {
      databaseId: SOURCE_DATABASE_ID,
      title: 'Launch',
      values: { [RELATION_PROPERTY_ID]: [TARGET_ROW_ID] }
    },
    candidateIds: [SOURCE_DATABASE_ID, TARGET_ROW_ID]
  })
  assert.equal(prepared.result.proposal.database, 'Projects')
  const confirmed = await confirmAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.relation })
  assert.equal(prepared.receipt.status, 'awaiting_confirmation')
  const relation = (await pool.query(
    `SELECT source_row_id,source_database_id,source_property_id,target_row_id,target_database_id,user_id
     FROM workspace_database_relations WHERE target_row_id=$1 AND user_id=$2`,
    [TARGET_ROW_ID, OWNER_ID]
  )).rows[0]
  assert.deepEqual(relation, {
    source_row_id: confirmed.result.row.id,
    source_database_id: SOURCE_DATABASE_ID,
    source_property_id: RELATION_PROPERTY_ID,
    target_row_id: TARGET_ROW_ID,
    target_database_id: TARGET_DATABASE_ID,
    user_id: OWNER_ID
  })
})

test('concurrent database creates serialize 1024-step positions and touch the parent', async () => {
  const parentBefore = (await pool.query('SELECT updated_at FROM workspace_databases WHERE id=$1 AND user_id=$2', [SOURCE_DATABASE_ID, OWNER_ID])).rows[0].updated_at
  await Promise.all([
    proposal({
      operationId: operationIds.concurrentA,
      toolName: 'create_database_row',
      args: { databaseId: SOURCE_DATABASE_ID, title: 'Concurrent A', values: {} },
      candidateIds: [SOURCE_DATABASE_ID]
    }),
    proposal({
      operationId: operationIds.concurrentB,
      toolName: 'create_database_row',
      args: { databaseId: SOURCE_DATABASE_ID, title: 'Concurrent B', values: {} },
      candidateIds: [SOURCE_DATABASE_ID]
    })
  ])
  await Promise.all([
    confirmAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.concurrentA }),
    confirmAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.concurrentB })
  ])
  const rows = (await pool.query(
    `SELECT title,position FROM workspace_database_rows
     WHERE database_id=$1 AND user_id=$2 ORDER BY position`,
    [SOURCE_DATABASE_ID, OWNER_ID]
  )).rows
  assert.deepEqual(rows.map((row) => Number(row.position)), [1024, 2048])
  assert.equal(new Set(rows.map((row) => Number(row.position))).size, 2)
  const parentAfter = (await pool.query('SELECT updated_at FROM workspace_databases WHERE id=$1 AND user_id=$2', [SOURCE_DATABASE_ID, OWNER_ID])).rows[0].updated_at
  assert.ok(new Date(parentAfter).getTime() > new Date(parentBefore).getTime())
})

test('1 MiB snapshot constraint accepts the maximum supported multibyte note preimage', async () => {
  const multibyte = '汉'.repeat(200_000)
  await pool.query('UPDATE notes SET content=$2 WHERE id=$1 AND user_id=$3', [NOTE_ID, multibyte, OWNER_ID])
  await proposal({
    operationId: operationIds.unicode,
    toolName: 'update_note',
    args: { noteId: NOTE_ID, content: 'small replacement' },
    candidateIds: [NOTE_ID]
  })
  const confirmed = await confirmAssistantAdvancedOperation({ userId: OWNER_ID, operationId: operationIds.unicode })
  assert.equal(confirmed.receipt.status, 'succeeded')
  const snapshotBytes = Number((await pool.query(
    'SELECT octet_length(before_snapshot::text) AS bytes FROM assistant_agent_operation_payloads WHERE user_id=$1 AND operation_id=$2',
    [OWNER_ID, operationIds.unicode]
  )).rows[0].bytes)
  assert.ok(snapshotBytes > 524_288)
  assert.ok(snapshotBytes <= 1_048_576)
})
