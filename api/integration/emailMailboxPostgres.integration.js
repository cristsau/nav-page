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
let temporaryDirectory

before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-email-mailbox-'))
  const keyPath = path.join(temporaryDirectory, 'email-encryption-key')
  await fs.writeFile(keyPath, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600 })
  process.env.NAV_EMAIL_ENCRYPTION_KEY_FILE = keyPath
  ;({ pool } = await import('../src/db/index.js'))
  ;({ persistEmailMailboxMessage, decryptStoredMailboxMessage } = await import('../src/lib/emailMailboxStore.js'))
  ;({ clearEmailEncryptionKeyCache } = await import('../src/lib/emailCrypto.js'))
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
