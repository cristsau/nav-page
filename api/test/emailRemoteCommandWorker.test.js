import test from 'node:test'
import assert from 'node:assert/strict'
import { executeEmailRemoteCommand } from '../src/lib/emailRemoteCommandWorker.js'

const IDS = Object.freeze({
  user: '11111111-1111-1111-1111-111111111111',
  account: '22222222-2222-2222-2222-222222222222',
  location: '33333333-3333-3333-3333-333333333333',
  folder: '44444444-4444-4444-4444-444444444444',
  message: '55555555-5555-5555-5555-555555555555',
  command: '66666666-6666-6666-6666-666666666666'
})

function job(overrides = {}) {
  return {
    id: IDS.command,
    user_id: IDS.user,
    account_id: IDS.account,
    source_location_id: IDS.location,
    source_folder_id: IDS.folder,
    source_message_id: IDS.message,
    message_id: IDS.message,
    source_key: 'mxroute',
    owner_username: 'owner-a',
    source_folder_path: 'INBOX',
    source_special_use: 'inbox',
    action: 'mark_read',
    status: 'running',
    expected_uid_validity: '22',
    expected_uid: '9',
    expected_modseq: '33',
    expected_seen: false,
    expected_flagged: false,
    expected_deleted: false,
    seen: false,
    answered: false,
    flagged: false,
    draft: false,
    deleted: false,
    keywords: [],
    expunged_at: null,
    internal_date: '2026-08-28T00:00:00.000Z',
    size_bytes: 42,
    attempt_count: 1,
    max_attempts: 5,
    ...overrides
  }
}

function fakePool(context) {
  const calls = []
  const query = async (text, params = []) => {
    calls.push({ text, params })
    if (/FROM email_remote_commands AS command/.test(text)) {
      return { rowCount: 1, rows: [context] }
    }
    if (/SET remote_mutation_started_at = NOW/.test(text)) return { rowCount: 1, rows: [] }
    if (/UPDATE email_folder_messages/.test(text)) return { rowCount: 1, rows: [] }
    if (/SET status = 'succeeded'/.test(text)) return { rowCount: 1, rows: [{ id: IDS.command }] }
    if (/INSERT INTO security_events/.test(text)) {
      return { rowCount: 1, rows: [{ id: '77777777-7777-7777-7777-777777777777' }] }
    }
    if (/SELECT pg_notify/.test(text)) return { rowCount: 1, rows: [] }
    if (/SET status = \$2/.test(text)) return { rowCount: 1, rows: [] }
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rowCount: 0, rows: [] }
    throw new Error(`Unexpected query: ${text}`)
  }
  return {
    calls,
    query,
    async connect() { return { query, release() {} } }
  }
}

function remoteMessage({ seen = false, modseq = 33n } = {}) {
  return {
    uid: 9,
    modseq,
    flags: new Set(seen ? ['\\Seen'] : [])
  }
}

test('flag command mutates only after concurrency checks and succeeds only after remote verification', async () => {
  const context = job()
  const pool = fakePool(context)
  const fetches = [remoteMessage(), remoteMessage({ seen: true, modseq: 34n })]
  let changed = 0
  const imap = {
    mailbox: { uidValidity: 22n },
    async getMailboxLock(path) {
      assert.equal(path, 'INBOX')
      return { release() {} }
    },
    async fetchOne() { return fetches.shift() },
    async messageFlagsAdd(uid, flags, options) {
      changed += 1
      assert.equal(String(uid), '9')
      assert.deepEqual(flags, ['\\Seen'])
      assert.equal(options.uid, true)
      assert.equal(options.unchangedSince, 33n)
      return true
    }
  }
  const status = await executeEmailRemoteCommand({
    poolInstance: pool,
    imap,
    claimedJob: { id: IDS.command },
    runtimeConfig: { emailSourceKey: 'mxroute', emailOwnerUsername: 'owner-a' }
  })
  assert.equal(status, 'succeeded')
  assert.equal(changed, 1)
  const mutationIndex = pool.calls.findIndex((call) => /remote_mutation_started_at/.test(call.text))
  const successIndex = pool.calls.findIndex((call) => /status = 'succeeded'/.test(call.text))
  assert.ok(mutationIndex >= 0 && successIndex > mutationIndex)
  assert.equal(pool.calls.some((call) => /SELECT pg_notify/.test(call.text)), true)
})

test('stale MODSEQ becomes a conflict and never calls a remote mutation', async () => {
  const context = job()
  const pool = fakePool(context)
  let changed = 0
  const imap = {
    mailbox: { uidValidity: 22n },
    async getMailboxLock() { return { release() {} } },
    async fetchOne() { return remoteMessage({ modseq: 34n }) },
    async messageFlagsAdd() { changed += 1 }
  }
  const status = await executeEmailRemoteCommand({
    poolInstance: pool,
    imap,
    claimedJob: { id: IDS.command },
    runtimeConfig: { emailSourceKey: 'mxroute', emailOwnerUsername: 'owner-a' }
  })
  assert.equal(status, 'conflict')
  assert.equal(changed, 0)
  const failed = pool.calls.find((call) => /SET status = \$2/.test(call.text))
  assert.equal(failed.params[1], 'conflict')
  assert.equal(failed.params[3], 'REMOTE_STATE_CHANGED')
})
