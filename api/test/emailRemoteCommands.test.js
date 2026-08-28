import test from 'node:test'
import assert from 'node:assert/strict'
import {
  enqueueEmailRemoteCommand,
  serializeEmailRemoteCommand,
  undoEmailRemoteCommand
} from '../src/lib/emailRemoteCommands.js'

const USER_ID = '11111111-1111-1111-1111-111111111111'
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222'
const LOCATION_ID = '33333333-3333-3333-3333-333333333333'
const FOLDER_ID = '44444444-4444-4444-4444-444444444444'
const MESSAGE_ID = '55555555-5555-5555-5555-555555555555'
const COMMAND_ID = '66666666-6666-6666-6666-666666666666'

function commandInput(overrides = {}) {
  return {
    action: 'mark_read',
    idempotencyKey: 'command:0123456789abcdef',
    expected: {
      uidValidity: '22',
      modseq: '33',
      seen: false,
      flagged: false,
      deleted: false
    },
    ...overrides
  }
}

function fakePool(responder, { existing = null } = {}) {
  const calls = []
  const client = {
    async query(text, params = []) {
      calls.push({ text, params })
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rowCount: 0, rows: [] }
      if (/FROM email_remote_commands\s+WHERE user_id = \$1 AND idempotency_key = \$2/.test(text)) {
        return { rowCount: existing ? 1 : 0, rows: existing ? [existing] : [] }
      }
      return responder(text, params, calls)
    },
    release() { calls.push({ text: 'RELEASE', params: [] }) }
  }
  return {
    calls,
    async connect() { return client },
    async query(text, params = []) { return responder(text, params, calls) }
  }
}

function sourceRow(overrides = {}) {
  return {
    id: LOCATION_ID,
    folder_id: FOLDER_ID,
    message_id: MESSAGE_ID,
    uid_validity: '22',
    uid: '9',
    modseq: '33',
    seen: false,
    flagged: false,
    deleted: false,
    expunged_at: null,
    special_use: 'inbox',
    ...overrides
  }
}

function storedCommand(overrides = {}) {
  return {
    id: COMMAND_ID,
    user_id: USER_ID,
    account_id: ACCOUNT_ID,
    source_location_id: LOCATION_ID,
    source_folder_id: FOLDER_ID,
    action: 'mark_read',
    status: 'scheduled',
    request_hash: 'a'.repeat(64),
    attempt_count: 0,
    max_attempts: 5,
    undo_until: '2026-08-28T12:00:10.000Z',
    next_attempt_at: '2026-08-28T12:00:10.000Z',
    created_at: '2026-08-28T12:00:00.000Z',
    updated_at: '2026-08-28T12:00:00.000Z',
    ...overrides
  }
}

test('enqueue captures server-owned UID and uses an idempotent insert without mutating the mailbox', async () => {
  let requestHash = null
  const pool = fakePool((text, params) => {
    if (/FROM email_folder_messages AS location/.test(text)) {
      return { rowCount: 1, rows: [sourceRow()] }
    }
    if (/INSERT INTO email_remote_commands/.test(text)) {
      requestHash = params[8]
      return {
        rowCount: 1,
        rows: [storedCommand({ request_hash: requestHash, inserted: true })]
      }
    }
    throw new Error(`Unexpected query: ${text}`)
  })
  const result = await enqueueEmailRemoteCommand({
    poolInstance: pool,
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID,
    input: commandInput()
  })
  assert.equal(result.inserted, true)
  assert.equal(result.command.status, 'scheduled')
  const insert = pool.calls.find((call) => /INSERT INTO email_remote_commands/.test(call.text))
  assert.equal(insert.params[9], '22')
  assert.equal(insert.params[10], '9')
  assert.match(insert.text, /ON CONFLICT \(user_id, idempotency_key\)/)
  assert.equal(pool.calls.some((call) => /UPDATE email_folder_messages/.test(call.text)), false)
})

test('a reused idempotency key with another request hash is rejected and rolled back', async () => {
  const pool = fakePool((text) => {
    if (/FROM email_folder_messages AS location/.test(text)) {
      return { rowCount: 1, rows: [sourceRow()] }
    }
    if (/INSERT INTO email_remote_commands/.test(text)) {
      return { rowCount: 1, rows: [storedCommand({ request_hash: 'b'.repeat(64), inserted: false })] }
    }
    throw new Error(`Unexpected query: ${text}`)
  })
  await assert.rejects(
    enqueueEmailRemoteCommand({
      poolInstance: pool,
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      locationId: LOCATION_ID,
      input: commandInput()
    }),
    (error) => error.code === 'REMOTE_IDEMPOTENCY_CONFLICT'
  )
  assert.equal(pool.calls.some((call) => call.text === 'ROLLBACK'), true)
})

test('an idempotent retry returns the original command before touching a moved or missing source', async () => {
  let hash = null
  const firstPool = fakePool((text, params) => {
    if (/FROM email_folder_messages AS location/.test(text)) return { rowCount: 1, rows: [sourceRow()] }
    if (/INSERT INTO email_remote_commands/.test(text)) {
      hash = params[8]
      return { rowCount: 1, rows: [storedCommand({ request_hash: hash, inserted: true })] }
    }
    throw new Error(`Unexpected query: ${text}`)
  })
  await enqueueEmailRemoteCommand({
    poolInstance: firstPool,
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID,
    input: commandInput()
  })

  const existing = storedCommand({ request_hash: hash })
  const retryPool = fakePool(
    (text) => { throw new Error(`Source must not be loaded during replay: ${text}`) },
    { existing }
  )
  const replay = await enqueueEmailRemoteCommand({
    poolInstance: retryPool,
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    locationId: LOCATION_ID,
    input: commandInput()
  })
  assert.equal(replay.inserted, false)
  assert.equal(replay.command.id, COMMAND_ID)
  assert.equal(retryPool.calls.some((call) => /FROM email_folder_messages/.test(call.text)), false)
})

test('undo is allowed only while a scheduled command remains inside its short window', async () => {
  const future = new Date(Date.now() + 30_000).toISOString()
  const pool = fakePool((text) => {
    if (/SELECT \* FROM email_remote_commands/.test(text)) {
      return { rowCount: 1, rows: [storedCommand({ undo_until: future })] }
    }
    if (/UPDATE email_remote_commands/.test(text)) {
      return {
        rowCount: 1,
        rows: [storedCommand({ status: 'cancelled', completed_at: new Date().toISOString() })]
      }
    }
    throw new Error(`Unexpected query: ${text}`)
  })
  const result = await undoEmailRemoteCommand({
    poolInstance: pool,
    userId: USER_ID,
    commandId: COMMAND_ID
  })
  assert.equal(result.status, 'cancelled')
  assert.match(pool.calls.find((call) => /UPDATE email_remote_commands/.test(call.text)).text, /status = 'scheduled'/)
})

test('public command state never exposes request hashes or IMAP identities', () => {
  const publicState = serializeEmailRemoteCommand(storedCommand({
    expected_uid: '9',
    expected_uid_validity: '22',
    expected_modseq: '33',
    idempotency_key: 'secret-client-key'
  }))
  assert.equal('requestHash' in publicState, false)
  assert.equal('idempotencyKey' in publicState, false)
  assert.equal('expectedUid' in publicState, false)
})
