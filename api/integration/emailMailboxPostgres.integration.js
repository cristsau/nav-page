import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'

const EXPECTED_DATABASE_NAME = 'nav_email_mailbox_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'

function assertIsolatedDatabaseTarget() {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.NAV_EMAIL_MAILBOX_INTEGRATION_TEST, 'true')
  let databaseUrl
  try { databaseUrl = new URL(String(process.env.DATABASE_URL || '')) } catch {
    assert.fail('email mailbox integration requires a valid DATABASE_URL')
  }
  assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol))
  assert.ok(ALLOWED_DATABASE_HOSTS.has(databaseUrl.hostname.toLowerCase()))
  assert.equal(decodeURIComponent(databaseUrl.pathname.replace(/^\/+/, '')), EXPECTED_DATABASE_NAME)
  for (const key of ['database', 'dbname', 'host', 'hostaddr', 'service']) {
    assert.equal(databaseUrl.searchParams.has(key), false)
  }
}

assertIsolatedDatabaseTarget()

let pool
let persistEmailMailboxMessage
let decryptStoredMailboxMessage
let clearEmailEncryptionKeyCache
let createEmailDraft
let getEmailDraftForUser
let queueEmailDraft
let deliverMailOutbox
let updateMailboxFailureStateSql
let temporaryDirectory

before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-email-mailbox-'))
  const keyPath = path.join(temporaryDirectory, 'email-encryption-key')
  await fs.writeFile(keyPath, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600 })
  process.env.NAV_EMAIL_ENCRYPTION_KEY_FILE = keyPath
  ;({ pool } = await import('../src/db/index.js'))
  ;({ persistEmailMailboxMessage, decryptStoredMailboxMessage } = await import('../src/lib/emailMailboxStore.js'))
  ;({ clearEmailEncryptionKeyCache } = await import('../src/lib/emailCrypto.js'))
  ;({ createEmailDraft, getEmailDraftForUser, queueEmailDraft } = await import('../src/lib/emailDrafts.js'))
  ;({ deliverMailOutbox } = await import('../src/lib/mailOutbox.js'))
  ;({ UPDATE_MAILBOX_FAILURE_STATE_SQL: updateMailboxFailureStateSql } = await import('../src/lib/emailIngestScheduler.js'))
})

beforeEach(async () => {
  clearEmailEncryptionKeyCache()
  await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE')
  await pool.query(
    `INSERT INTO users (id, username, password_hash, role, status, approved_at)
     VALUES
       ($1, 'mail-owner', 'not-a-real-password', 'user', 'approved', NOW()),
       ($2, 'mail-other', 'not-a-real-password', 'user', 'approved', NOW())`,
    [OWNER_ID, OTHER_USER_ID]
  )
})

after(async () => {
  clearEmailEncryptionKeyCache?.()
  await pool?.end()
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

function mailboxFixture(overrides = {}) {
  return {
    poolInstance: pool,
    userId: OWNER_ID,
    sourceKey: 'integration-mail',
    accountLabel: 'Integration mailbox',
    capabilities: ['IDLE', 'UIDPLUS'],
    folder: {
      path: 'INBOX',
      delimiter: '/',
      specialUse: 'inbox',
      uidValidity: '100',
      uidNext: '11',
      highestModseq: '20'
    },
    message: {
      mailboxUid: 10,
      messageId: '<mailbox-integration@example.test>',
      rawHash: 'a'.repeat(64),
      sender: { name: 'Sender', address: 'sender@example.test' },
      to: [{ name: 'Owner', address: 'owner@example.test' }],
      subject: 'Encrypted subject marker',
      text: 'first line\nsecond line with plaintext marker',
      receivedAt: '2026-08-26T10:00:00.000Z',
      internalDate: '2026-08-26T10:00:00.000Z',
      size: 512,
      flags: ['\\Seen', 'custom-keyword'],
      modseq: '20',
      attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 42 }]
    },
    ...overrides
  }
}

test('canonical replay is idempotent and plaintext remains encrypted at rest', async () => {
  const first = await persistEmailMailboxMessage(mailboxFixture())
  const replay = await persistEmailMailboxMessage(mailboxFixture())

  assert.equal(first.inserted, true)
  assert.equal(replay.inserted, false)
  assert.equal(replay.message.id, first.message.id)
  assert.equal(replay.location.id, first.location.id)

  const stored = await pool.query(
    `SELECT account.source_key, message.user_id, message.envelope_encrypted,
            message.content_encrypted, location.seen, location.keywords
     FROM email_messages AS message
     JOIN email_accounts AS account ON account.id = message.account_id
     JOIN email_folder_messages AS location ON location.message_id = message.id
     WHERE message.id = $1 AND message.user_id = $2`,
    [first.message.id, OWNER_ID]
  )
  assert.equal(stored.rows.length, 1)
  const row = stored.rows[0]
  assert.equal(row.envelope_encrypted.includes(Buffer.from('Encrypted subject marker')), false)
  assert.equal(row.content_encrypted.includes(Buffer.from('plaintext marker')), false)
  assert.equal(row.seen, true)
  assert.deepEqual(row.keywords, ['custom-keyword'])

  const decrypted = await decryptStoredMailboxMessage(row, {
    userId: OWNER_ID,
    sourceKey: row.source_key
  })
  assert.equal(decrypted.envelope.subject, 'Encrypted subject marker')
  assert.equal(decrypted.content.text, 'first line\nsecond line with plaintext marker')
  assert.equal(decrypted.content.attachments[0].filename, 'invoice.pdf')
  await assert.rejects(
    decryptStoredMailboxMessage(row, { userId: OTHER_USER_ID, sourceKey: row.source_key })
  )
})

test('UIDVALIDITY reset expires old remote locations without deleting canonical messages', async () => {
  const oldMessage = await persistEmailMailboxMessage(mailboxFixture())
  const replacement = mailboxFixture({
    folder: {
      ...mailboxFixture().folder,
      uidValidity: '101',
      uidNext: '2',
      highestModseq: '1'
    },
    message: {
      ...mailboxFixture().message,
      mailboxUid: 1,
      messageId: '<replacement@example.test>',
      rawHash: 'b'.repeat(64),
      subject: 'Replacement after UIDVALIDITY reset',
      modseq: '1'
    }
  })
  const nextMessage = await persistEmailMailboxMessage(replacement)

  const locations = await pool.query(
    `SELECT message_id, uid_validity, uid, expunged_at
     FROM email_folder_messages
     WHERE folder_id = $1 AND user_id = $2
     ORDER BY uid_validity, uid`,
    [nextMessage.folder.id, OWNER_ID]
  )
  assert.equal(locations.rows.length, 2)
  assert.ok(locations.rows.find((row) => row.message_id === oldMessage.message.id)?.expunged_at)
  assert.equal(locations.rows.find((row) => row.message_id === nextMessage.message.id)?.expunged_at, null)
  assert.equal(
    Number((await pool.query('SELECT COUNT(*) FROM email_messages WHERE user_id = $1', [OWNER_ID])).rows[0].count),
    2
  )
})

test('mailbox failure state is isolated by owner when users share a source key', async () => {
  await pool.query(
    `INSERT INTO email_mailbox_state (
       source_key, user_id, last_uid, updated_at
     ) VALUES
       ('shared-source', $1, 10, NOW()),
       ('shared-source', $2, 20, NOW())`,
    [OWNER_ID, OTHER_USER_ID]
  )

  await pool.query(updateMailboxFailureStateSql, [
    'shared-source',
    'mail-owner',
    'IMAP_SYNC_FAILED'
  ])

  const states = await pool.query(
    `SELECT user_id, last_error_code
     FROM email_mailbox_state
     WHERE source_key = 'shared-source'
     ORDER BY user_id`
  )
  assert.deepEqual(states.rows, [
    { user_id: OWNER_ID, last_error_code: 'IMAP_SYNC_FAILED' },
    { user_id: OTHER_USER_ID, last_error_code: null }
  ])
})

test('composite ownership constraints reject cross-user mailbox rows and user deletion cascades', async () => {
  const saved = await persistEmailMailboxMessage(mailboxFixture())
  await assert.rejects(
    pool.query(
      `INSERT INTO email_folders (
         account_id, user_id, path, path_hash, special_use
       ) VALUES ($1, $2, 'Cross user', $3, 'archive')`,
      [saved.account.id, OTHER_USER_ID, 'b'.repeat(64)]
    ),
    (error) => error?.code === '23503'
  )

  await pool.query('DELETE FROM users WHERE id = $1', [OWNER_ID])
  for (const table of ['email_accounts', 'email_folders', 'email_messages', 'email_folder_messages']) {
    const count = await pool.query(`SELECT COUNT(*) FROM ${table} WHERE user_id = $1`, [OWNER_ID])
    assert.equal(Number(count.rows[0].count), 0)
  }
})

test('confirmed encrypted draft is delivered once, scrubbed and never sent twice', async () => {
  const saved = await persistEmailMailboxMessage(mailboxFixture())
  const draft = await createEmailDraft({
    userId: OWNER_ID,
    accountId: saved.account.id,
    sourceMessageId: saved.message.id,
    payload: {
      to: ['recipient@example.test'],
      cc: ['copy@example.test'],
      subject: 'Integration delivery subject',
      text: 'Integration delivery body marker'
    },
    replyHeaders: {
      inReplyTo: '<mailbox-integration@example.test>',
      references: ['<older@example.test>']
    }
  }, { poolInstance: pool })

  const storedDraft = await pool.query(
    `SELECT payload_encrypted, content_hash, status, confirmed_at, outbox_id
     FROM email_drafts WHERE id = $1 AND user_id = $2`,
    [draft.id, OWNER_ID]
  )
  assert.equal(storedDraft.rowCount, 1)
  assert.equal(storedDraft.rows[0].payload_encrypted.includes(Buffer.from('Integration delivery body marker')), false)
  assert.equal(storedDraft.rows[0].status, 'draft')
  assert.equal(storedDraft.rows[0].confirmed_at, null)
  assert.equal(storedDraft.rows[0].outbox_id, null)

  const reread = await getEmailDraftForUser(OWNER_ID, draft.id)
  assert.equal(reread.payload.subject, 'Integration delivery subject')
  assert.equal(reread.payload.inReplyTo, '<mailbox-integration@example.test>')
  assert.deepEqual(reread.payload.references, [
    '<older@example.test>',
    '<mailbox-integration@example.test>'
  ])
  await assert.rejects(
    queueEmailDraft({
      userId: OWNER_ID,
      draftId: draft.id,
      contentHash: draft.contentHash,
      confirmed: false
    }, { poolInstance: pool }),
    /Explicit email send confirmation is required/
  )
  await assert.rejects(
    queueEmailDraft({
      userId: OWNER_ID,
      draftId: draft.id,
      contentHash: '0'.repeat(64),
      confirmed: true
    }, { poolInstance: pool }),
    /preview it again before sending/
  )

  const queued = await queueEmailDraft({
    userId: OWNER_ID,
    draftId: draft.id,
    contentHash: draft.contentHash,
    confirmed: true
  }, { poolInstance: pool })
  assert.equal(queued.status, 'queued')
  assert.ok(queued.outboxId)
  assert.ok(queued.confirmedAt)

  const queuedOutbox = await pool.query(
    `SELECT status, recipient, subject, text_body, html_body,
            payload_encrypted, content_hash, confirmed_at
     FROM mail_outbox WHERE id = $1`,
    [queued.outboxId]
  )
  assert.equal(queuedOutbox.rows[0].status, 'pending')
  assert.equal(queuedOutbox.rows[0].recipient, 'redacted@invalid.local')
  assert.equal(queuedOutbox.rows[0].subject, '[加密用户邮件]')
  assert.equal(queuedOutbox.rows[0].text_body, '')
  assert.equal(queuedOutbox.rows[0].html_body, '')
  assert.ok(Buffer.isBuffer(queuedOutbox.rows[0].payload_encrypted))
  assert.equal(queuedOutbox.rows[0].content_hash, draft.contentHash)
  assert.ok(queuedOutbox.rows[0].confirmed_at)

  const deliveries = []
  let transportCreations = 0
  const transportFactory = async () => {
    transportCreations += 1
    return {
      async sendMail(message) { deliveries.push(message) },
      close() {}
    }
  }
  const deliveryOptions = {
    poolInstance: pool,
    policy: { batchSize: 10, maxAttempts: 3, intervalSeconds: 30 },
    runtimeConfig: {
      smtpFromAddress: 'nav@example.test',
      smtpFromName: 'DOMO NAV'
    },
    transportFactory
  }
  const firstDelivery = await deliverMailOutbox(deliveryOptions)
  assert.equal(firstDelivery.processed, 1)
  assert.equal(firstDelivery.sent, 1)
  assert.equal(deliveries.length, 1)
  assert.deepEqual(deliveries[0].to, ['recipient@example.test'])
  assert.deepEqual(deliveries[0].cc, ['copy@example.test'])
  assert.equal(deliveries[0].subject, 'Integration delivery subject')
  assert.equal(deliveries[0].text, 'Integration delivery body marker')

  const terminal = await pool.query(
    `SELECT outbox.status AS outbox_status, outbox.payload_encrypted,
            outbox.scrubbed_at, draft.status AS draft_status
     FROM mail_outbox AS outbox
     JOIN email_drafts AS draft ON draft.outbox_id = outbox.id
     WHERE outbox.id = $1`,
    [queued.outboxId]
  )
  assert.equal(terminal.rows[0].outbox_status, 'sent')
  assert.equal(terminal.rows[0].payload_encrypted, null)
  assert.ok(terminal.rows[0].scrubbed_at)
  assert.equal(terminal.rows[0].draft_status, 'sent')

  const replay = await deliverMailOutbox(deliveryOptions)
  assert.equal(replay.processed, 0)
  assert.equal(replay.sent, 0)
  assert.equal(deliveries.length, 1)
  assert.equal(transportCreations, 1)
})

test('stale sending lease expires as ambiguous without another SMTP attempt', async () => {
  const saved = await persistEmailMailboxMessage(mailboxFixture())
  const draft = await createEmailDraft({
    userId: OWNER_ID,
    accountId: saved.account.id,
    payload: {
      to: ['recipient@example.test'],
      subject: 'Ambiguous delivery subject',
      text: 'Never send this stale lease again'
    }
  }, { poolInstance: pool })
  const queued = await queueEmailDraft({
    userId: OWNER_ID,
    draftId: draft.id,
    contentHash: draft.contentHash,
    confirmed: true
  }, { poolInstance: pool })
  await pool.query(
    `UPDATE mail_outbox
     SET status = 'sending', updated_at = NOW() - INTERVAL '16 minutes'
     WHERE id = $1`,
    [queued.outboxId]
  )

  let smtpCalls = 0
  let transportCreations = 0
  const summary = await deliverMailOutbox({
    poolInstance: pool,
    policy: { batchSize: 10, maxAttempts: 3, intervalSeconds: 30 },
    runtimeConfig: {
      smtpFromAddress: 'nav@example.test',
      smtpFromName: 'DOMO NAV'
    },
    transportFactory: async () => {
      transportCreations += 1
      return {
        async sendMail() { smtpCalls += 1 },
        close() {}
      }
    }
  })

  assert.equal(summary.processed, 0)
  assert.equal(summary.sent, 0)
  assert.equal(summary.expired, 1)
  assert.equal(transportCreations, 0)
  assert.equal(smtpCalls, 0)

  const terminal = await pool.query(
    `SELECT outbox.status AS outbox_status, outbox.payload_encrypted,
            outbox.last_error_code, outbox.scrubbed_at,
            draft.status AS draft_status
     FROM mail_outbox AS outbox
     JOIN email_drafts AS draft ON draft.outbox_id = outbox.id
     WHERE outbox.id = $1`,
    [queued.outboxId]
  )
  assert.equal(terminal.rows[0].outbox_status, 'expired')
  assert.equal(terminal.rows[0].payload_encrypted, null)
  assert.equal(terminal.rows[0].last_error_code, 'AMBIGUOUS_DELIVERY_STATE')
  assert.ok(terminal.rows[0].scrubbed_at)
  assert.equal(terminal.rows[0].draft_status, 'failed')
})
