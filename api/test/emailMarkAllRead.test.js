import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  enqueueEmailFolderMarkAllRead
} from '../src/lib/emailRemoteCommands.js'

function fakePool({ matched = 3, queued = 3, folderFound = true } = {}) {
  const calls = []
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (/FROM email_folders/.test(sql)) return { rows: folderFound ? [{ id: params[0] }] : [], rowCount: folderFound ? 1 : 0 }
      if (/WITH candidates AS MATERIALIZED/.test(sql)) {
        return { rows: [{ matched, queued }], rowCount: 1 }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() {}
  }
  return { calls, pool: { async connect() { return client } } }
}

const ids = {
  userId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  folderId: '33333333-3333-4333-8333-333333333333',
  idempotencyKey: 'mail-bulk-read-1234567890'
}

test('folder mark-all-read queues the bounded unread set atomically', async () => {
  const { calls, pool } = fakePool({ matched: 4, queued: 3 })
  const result = await enqueueEmailFolderMarkAllRead({ poolInstance: pool, ...ids })
  assert.deepEqual(result, { matched: 4, queued: 3, alreadyQueued: 1 })
  assert.equal(calls[0].sql, 'BEGIN')
  assert.equal(calls.at(-1).sql, 'COMMIT')
  const insert = calls.find((entry) => /INSERT INTO email_remote_commands/.test(entry.sql))
  assert.ok(insert)
  assert.match(calls[1].sql, /FOR UPDATE/)
  assert.match(insert.sql, /WITH candidates AS MATERIALIZED/)
  assert.match(insert.sql, /stats\.matched <= \$5/)
  assert.match(insert.sql, /account_id = \$2/)
  assert.match(insert.sql, /user_id = \$3/)
  assert.match(insert.sql, /seen = FALSE/)
  assert.match(insert.sql, /status IN \('scheduled', 'running', 'retry_wait'\)/)
})

test('folder mark-all-read rejects more than the single-snapshot safety limit without queuing', async () => {
  const { calls, pool } = fakePool({ matched: 5001, queued: 0 })
  await assert.rejects(
    enqueueEmailFolderMarkAllRead({ poolInstance: pool, ...ids }),
    (error) => error?.code === 'REMOTE_BULK_LIMIT_EXCEEDED' && error?.statusCode === 409
  )
  assert.equal(calls.at(-1).sql, 'ROLLBACK')
})

test('folder mark-all-read rejects an unowned folder and rolls back', async () => {
  const { calls, pool } = fakePool({ folderFound: false })
  await assert.rejects(
    enqueueEmailFolderMarkAllRead({ poolInstance: pool, ...ids }),
    (error) => error?.statusCode === 404
  )
  assert.equal(calls.at(-1).sql, 'ROLLBACK')
})

test('mail UI exposes mark-all-read in the list and store', async () => {
  const [list, view, store, api] = await Promise.all([
    fs.readFile(new URL('../../app/src/modules/mail/components/MailMessageList.vue', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../app/src/modules/mail/MailView.vue', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../app/src/modules/mail/useMailStore.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../app/src/shared/services/emailApi.js', import.meta.url), 'utf8')
  ])
  assert.match(list, /一键已读/)
  assert.match(list, /emit\('mark-all-read'\)/)
  assert.match(view, /@mark-all-read="markFolderAllRead"/)
  assert.match(store, /markActiveMailFolderAllRead/)
  assert.match(api, /folders\/\$\{requiredId\(folderId[\s\S]*mark-all-read/)
})
