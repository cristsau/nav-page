import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'
import { simpleParser } from 'mailparser'
import { Pool } from 'pg'

const EXPECTED_DATABASE_NAME = 'nav_email_mailbox_test'
const ALLOWED_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost'])
const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'
const assertIntegrationDeliveryReady = async () => ({
  ready: true,
  enabled: true,
  configured: true,
  reason: 'integration_fixture'
})

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
let refreshEmailDraftContentHash
let createDraftEmailAttachment
let listDraftEmailAttachments
let deliverMailOutbox
let processEmailSentAppendJob
let decryptEmailSentMime
let updateMailboxFailureStateSql
let encryptEmailPayload
let upsertEmailNotificationRule
let listEmailNotificationRules
let previewEmailNotificationRule
let resolveEmailNotificationDecision
let updateEmailNotificationRule
let deleteEmailNotificationRule
let processInboundEmail
let processEmailClassificationJobs
let deleteExcessEmailMessagesSql
let temporaryDirectory
let minimumMailWorkerDatabasePoolSize
let normalizeDatabasePoolMax
let applyEmailFolderReconciliation
let syncDueEmailFolders
let upsertEmailFolder
let enqueueEmailFolderMarkAllRead
let materializeManagedMailAccount

before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-email-mailbox-'))
  const keyPath = path.join(temporaryDirectory, 'email-encryption-key')
  await fs.writeFile(keyPath, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600 })
  process.env.NAV_EMAIL_ENCRYPTION_KEY_FILE = keyPath
  ;({
    MINIMUM_MAIL_WORKER_DATABASE_POOL_SIZE: minimumMailWorkerDatabasePoolSize,
    normalizeDatabasePoolMax
  } = await import('../src/config.js'))
  ;({ pool } = await import('../src/db/index.js'))
  ;({
    persistEmailMailboxMessage,
    decryptStoredMailboxMessage,
    upsertEmailFolder
  } = await import('../src/lib/emailMailboxStore.js'))
  ;({ clearEmailEncryptionKeyCache, encryptEmailPayload } = await import('../src/lib/emailCrypto.js'))
  ;({
    createEmailDraft,
    getEmailDraftForUser,
    queueEmailDraft,
    refreshEmailDraftContentHash
  } = await import('../src/lib/emailDrafts.js'))
  ;({
    createDraftEmailAttachment,
    listDraftEmailAttachments
  } = await import('../src/lib/emailAttachmentStore.js'))
  ;({ deliverMailOutbox } = await import('../src/lib/mailOutbox.js'))
  ;({ processEmailSentAppendJob } = await import('../src/lib/emailSentAppend.js'))
  ;({ decryptEmailSentMime } = await import('../src/lib/emailSentMimeCrypto.js'))
  ;({ UPDATE_MAILBOX_FAILURE_STATE_SQL: updateMailboxFailureStateSql } = await import('../src/lib/emailIngestScheduler.js'))
  ;({
    applyEmailFolderReconciliation,
    syncDueEmailFolders
  } = await import('../src/lib/emailMailboxReconciliation.js'))
  ;({ processInboundEmail } = await import('../src/lib/emailEvents.js'))
  ;({ processEmailClassificationJobs } = await import('../src/lib/emailClassificationWorker.js'))
  ;({ enqueueEmailFolderMarkAllRead } = await import('../src/lib/emailRemoteCommands.js'))
  ;({ materializeManagedMailAccount } = await import('../src/lib/managedMailAccountMaterialization.js'))
  ;({ DELETE_EXCESS_EMAIL_MESSAGES_SQL: deleteExcessEmailMessagesSql } = await import('../src/lib/emailRetention.js'))
  ;({
    upsertEmailNotificationRule,
    listEmailNotificationRules,
    previewEmailNotificationRule,
    resolveEmailNotificationDecision,
    updateEmailNotificationRule,
    deleteEmailNotificationRule
  } = await import('../src/lib/emailNotificationRules.js'))
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
    notificationEligible: true,
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

async function seedUnreadFolderLocations({ accountId, folderId, count }) {
  await pool.query(
    `WITH created AS (
       INSERT INTO email_messages (
         account_id, user_id, canonical_hash, message_id_hash, thread_key_hash,
         envelope_encrypted, content_encrypted, received_at, size_bytes
       )
       SELECT
         $1, $2,
         ENCODE(DIGEST('bulk-canonical-' || value::text, 'sha256'), 'hex'),
         ENCODE(DIGEST('bulk-message-' || value::text, 'sha256'), 'hex'),
         ENCODE(DIGEST('bulk-thread-' || value::text, 'sha256'), 'hex'),
         DECODE(REPEAT('aa', 32), 'hex'), DECODE(REPEAT('bb', 32), 'hex'),
         NOW() - (value * INTERVAL '1 millisecond'), 64
       FROM GENERATE_SERIES(1, $4::integer) AS value
       RETURNING id, received_at
     ), numbered AS (
       SELECT id, received_at, ROW_NUMBER() OVER (ORDER BY received_at, id) AS ordinal
       FROM created
     )
     INSERT INTO email_folder_messages (
       folder_id, message_id, account_id, user_id, uid_validity, uid,
       seen, internal_date, size_bytes
     )
     SELECT $3, id, $1, $2, 100, 1000 + ordinal, FALSE, received_at, 64
     FROM numbered`,
    [accountId, OWNER_ID, folderId, count]
  )
}

test('folder mark-all-read serializes concurrent bulk requests', async () => {
  const stored = await persistEmailMailboxMessage(mailboxFixture({
    message: { ...mailboxFixture().message, flags: [] }
  }))
  const results = await Promise.all([
    enqueueEmailFolderMarkAllRead({
      poolInstance: pool,
      userId: OWNER_ID,
      accountId: stored.account.id,
      folderId: stored.folder.id,
      idempotencyKey: 'bulk-concurrent-first-0001'
    }),
    enqueueEmailFolderMarkAllRead({
      poolInstance: pool,
      userId: OWNER_ID,
      accountId: stored.account.id,
      folderId: stored.folder.id,
      idempotencyKey: 'bulk-concurrent-second-0002'
    })
  ])
  assert.deepEqual(results.map((result) => result.queued).sort((a, b) => a - b), [0, 1])
  assert.equal(
    Number((await pool.query(
      `SELECT COUNT(*) FROM email_remote_commands
       WHERE user_id = $1 AND account_id = $2 AND action = 'mark_read'`,
      [OWNER_ID, stored.account.id]
    )).rows[0].count),
    1
  )
})

test('folder mark-all-read accepts exactly 5000 unread locations', async () => {
  const stored = await persistEmailMailboxMessage(mailboxFixture())
  await seedUnreadFolderLocations({ accountId: stored.account.id, folderId: stored.folder.id, count: 5000 })
  const result = await enqueueEmailFolderMarkAllRead({
    poolInstance: pool,
    userId: OWNER_ID,
    accountId: stored.account.id,
    folderId: stored.folder.id,
    idempotencyKey: 'bulk-limit-exactly-5000'
  })
  assert.deepEqual(result, { matched: 5000, queued: 5000, alreadyQueued: 0 })
})

test('folder mark-all-read rejects 5001 unread locations without partial commands', async () => {
  const stored = await persistEmailMailboxMessage(mailboxFixture())
  await seedUnreadFolderLocations({ accountId: stored.account.id, folderId: stored.folder.id, count: 5001 })
  await assert.rejects(
    enqueueEmailFolderMarkAllRead({
      poolInstance: pool,
      userId: OWNER_ID,
      accountId: stored.account.id,
      folderId: stored.folder.id,
      idempotencyKey: 'bulk-limit-rejected-5001'
    }),
    (error) => error?.code === 'REMOTE_BULK_LIMIT_EXCEEDED'
  )
  assert.equal(
    Number((await pool.query(
      'SELECT COUNT(*) FROM email_remote_commands WHERE user_id = $1',
      [OWNER_ID]
    )).rows[0].count),
    0
  )
})

test('managed SMTP-only mailbox is selectable immediately without faking an IMAP connection', async () => {
  const account = await materializeManagedMailAccount({
    sourceKey: 'managed.0123456789abcdef01234567',
    label: '工作邮箱',
    config: {
      ownerUsername: 'mail-owner',
      deliveryEnabled: true,
      ingestEnabled: false
    }
  }, { queryFn: pool.query.bind(pool) })
  const persisted = await pool.query(
    `SELECT source_key, label, enabled, last_connected_at
     FROM email_accounts WHERE id = $1 AND user_id = $2`,
    [account.id, OWNER_ID]
  )
  assert.deepEqual(persisted.rows[0], {
    source_key: 'managed.0123456789abcdef01234567',
    label: '工作邮箱',
    enabled: true,
    last_connected_at: null
  })
})

test('managed mailbox materialization rejects an unknown owner without creating an account', async () => {
  await assert.rejects(
    materializeManagedMailAccount({
      sourceKey: 'managed.abcdef0123456789abcdef01',
      label: '未知归属',
      config: {
        ownerUsername: 'missing-owner',
        deliveryEnabled: true,
        ingestEnabled: false
      }
    }, { queryFn: pool.query.bind(pool) }),
    /归属用户不存在/
  )
  const count = await pool.query(
    `SELECT COUNT(*)::integer AS count FROM email_accounts
     WHERE source_key = 'managed.abcdef0123456789abcdef01'`
  )
  assert.equal(Number(count.rows[0].count), 0)
})

test('mail worker pool remains live with two mailbox runtimes and nested work', async () => {
  assert.equal(normalizeDatabasePoolMax(undefined, 'worker'), 12)
  const boundedPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: minimumMailWorkerDatabasePoolSize,
    connectionTimeoutMillis: 1_000
  })
  const clients = []
  try {
    // Two accounts retain one ingest advisory lease and one ingest LISTEN
    // session each; classification owns the fifth long-lived LISTEN session.
    for (let index = 0; index < 5; index += 1) {
      clients.push(await boundedPool.connect())
    }
    // Keep three transient slots available for a scheduler plus its nested
    // persistence work and one concurrent remote command.
    const outer = await boundedPool.connect()
    clients.push(outer)
    const nested = await boundedPool.connect()
    clients.push(nested)
    const concurrent = await boundedPool.connect()
    clients.push(concurrent)
    const result = await nested.query('SELECT 1 AS live')
    assert.equal(Number(result.rows[0]?.live), 1)
    assert.equal(boundedPool.waitingCount, 0)
  } finally {
    for (const client of clients.reverse()) client.release()
    await boundedPool.end()
  }
})

test('canonical replay is idempotent and plaintext remains encrypted at rest', async () => {
  const first = await persistEmailMailboxMessage(mailboxFixture())
  const replay = await persistEmailMailboxMessage(mailboxFixture())

  assert.equal(first.inserted, true)
  assert.equal(first.classificationQueued, true)
  assert.equal(replay.inserted, false)
  assert.equal(replay.classificationQueued, false)
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

  const jobs = await pool.query(
    `SELECT status, attempt_count, account_id, email_message_id, notification_eligible
     FROM email_classification_jobs
     WHERE user_id = $1 AND email_message_id = $2`,
    [OWNER_ID, first.message.id]
  )
  assert.equal(jobs.rows.length, 1)
  assert.equal(jobs.rows[0].status, 'pending')
  assert.equal(jobs.rows[0].attempt_count, 0)
  assert.equal(jobs.rows[0].account_id, first.account.id)
  assert.equal(jobs.rows[0].notification_eligible, true)

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

test('043 upgrades an existing pending classification job to fail-closed notification eligibility', async () => {
  const saved = await persistEmailMailboxMessage(mailboxFixture())
  const migration = await fs.readFile(
    new URL('../src/db/migrations/043_email_notification_eligibility.sql', import.meta.url),
    'utf8'
  )
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('ALTER TABLE email_classification_jobs DROP COLUMN notification_eligible')
    const legacyJob = await client.query(
      `SELECT status FROM email_classification_jobs
       WHERE user_id = $1 AND email_message_id = $2`,
      [OWNER_ID, saved.message.id]
    )
    assert.equal(legacyJob.rows[0].status, 'pending')

    await client.query(migration)
    const upgradedJob = await client.query(
      `SELECT status, notification_eligible
       FROM email_classification_jobs
       WHERE user_id = $1 AND email_message_id = $2`,
      [OWNER_ID, saved.message.id]
    )
    assert.equal(upgradedJob.rows[0].status, 'pending')
    assert.equal(upgradedJob.rows[0].notification_eligible, false)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
})

test('durable classification queue processes encrypted mail independently and exactly once', async () => {
  const saved = await persistEmailMailboxMessage(mailboxFixture({
    message: {
      ...mailboxFixture().message,
      mailboxUid: 11,
      messageId: '<classification-worker@example.test>',
      rawHash: 'b'.repeat(64),
      subject: 'Queued classification subject'
    }
  }))
  const processed = []
  const summary = await processEmailClassificationJobs({
    poolInstance: pool,
    policy: { batchSize: 10, maxAttempts: 5 },
    runtimeConfig: { emailSourceKey: 'integration-mail' },
    processFn: async (payload) => { processed.push(payload) }
  })
  assert.equal(summary.processed, 1)
  assert.equal(summary.succeeded, 1)
  assert.equal(summary.remaining, 0)
  assert.equal(summary.dueRemaining, 0)
  assert.equal(processed.length, 1)
  assert.equal(processed[0].emailMessageId, saved.message.id)
  assert.equal(processed[0].email.subject, 'Queued classification subject')
  assert.equal(processed[0].notificationEligible, true)

  const job = await pool.query(
    `SELECT status, attempt_count, completed_at, last_error_code
     FROM email_classification_jobs
     WHERE user_id = $1 AND email_message_id = $2`,
    [OWNER_ID, saved.message.id]
  )
  assert.equal(job.rows[0].status, 'succeeded')
  assert.equal(job.rows[0].attempt_count, 1)
  assert.ok(job.rows[0].completed_at)
  assert.equal(job.rows[0].last_error_code, null)

  const replay = await processEmailClassificationJobs({
    poolInstance: pool,
    policy: { batchSize: 10, maxAttempts: 5 },
    runtimeConfig: { emailSourceKey: 'integration-mail' },
    processFn: async (payload) => { processed.push(payload) }
  })
  assert.equal(replay.processed, 0)
  assert.equal(processed.length, 1)
})

test('cache retention cannot cascade-delete a message required by a non-terminal classification job', async () => {
  const saved = await persistEmailMailboxMessage(mailboxFixture({
    message: {
      ...mailboxFixture().message,
      mailboxUid: 12,
      messageId: '<retention-classification-lease@example.test>',
      rawHash: 'c'.repeat(64),
      subject: 'Retention must preserve this queued message',
      receivedAt: '2025-01-01T00:00:00.000Z',
      internalDate: '2025-01-01T00:00:00.000Z'
    }
  }))

  const protectedDelete = await pool.query(deleteExcessEmailMessagesSql, [1, 5_000, 10])
  assert.equal(protectedDelete.rowCount, 0)
  const stillPresent = await pool.query(
    'SELECT id FROM email_messages WHERE id = $1 AND user_id = $2',
    [saved.message.id, OWNER_ID]
  )
  assert.equal(stillPresent.rowCount, 1)

  const processed = await processEmailClassificationJobs({
    poolInstance: pool,
    policy: { batchSize: 10, maxAttempts: 5 },
    runtimeConfig: { emailSourceKey: 'integration-mail' },
    processFn: async () => {}
  })
  assert.equal(processed.succeeded, 1)

  const terminalDelete = await pool.query(deleteExcessEmailMessagesSql, [1, 5_000, 10])
  assert.equal(terminalDelete.rowCount, 1)
  const removed = await pool.query(
    'SELECT id FROM email_messages WHERE id = $1 AND user_id = $2',
    [saved.message.id, OWNER_ID]
  )
  assert.equal(removed.rowCount, 0)
})

test('042 backfill and runtime replay never requeue linked or legacy hash-matched events', async () => {
  const unclassifiedMessage = {
    ...mailboxFixture().message,
    mailboxUid: 13,
    messageId: '<migration-backfill-without-event@example.test>',
    rawHash: 'd'.repeat(64),
    subject: 'Message committed before classification existed',
    text: 'This canonical message has no classification event.'
  }
  const interruptedMessage = {
    ...mailboxFixture().message,
    mailboxUid: 14,
    messageId: '<runtime-notification-recovery@example.test>',
    rawHash: 'e'.repeat(64),
    subject: '安全警报：账号异常登录，需要立即处理',
    text: '检测到新的异常登录，请立即核对。'
  }
  const legacyUnlinkedMessage = {
    ...mailboxFixture().message,
    mailboxUid: 15,
    messageId: '<legacy-unlinked-notification@example.test>',
    rawHash: 'f'.repeat(64),
    subject: '安全警报：历史事件尚未关联新缓存',
    text: '这是一条迁移前已完成分类的历史事件。'
  }
  const unclassified = await persistEmailMailboxMessage(
    mailboxFixture({ message: unclassifiedMessage })
  )
  const interrupted = await persistEmailMailboxMessage(
    mailboxFixture({ message: interruptedMessage })
  )
  const legacyUnlinked = await persistEmailMailboxMessage(
    mailboxFixture({ message: legacyUnlinkedMessage })
  )
  async function createInterruptedEvent(saved, rawMessage) {
    const result = await processInboundEmail({
      userId: OWNER_ID,
      sourceKey: 'integration-mail',
      emailMessageId: saved.message.id,
      notificationEligible: true,
      email: {
        messageId: rawMessage.messageId,
        mailboxUid: rawMessage.mailboxUid,
        senderName: rawMessage.sender.name,
        senderAddress: rawMessage.sender.address,
        recipient: rawMessage.to[0].address,
        subject: rawMessage.subject,
        text: rawMessage.text,
        receivedAt: rawMessage.receivedAt
      }
    })
    assert.equal(result.inserted, true)
    assert.equal(result.event.notificationAction, 'immediate')
    await pool.query(
      `DELETE FROM notifications
       WHERE user_id = $1 AND source_type = 'email' AND source_id = $2`,
      [OWNER_ID, result.event.id]
    )
    await pool.query(
      `UPDATE email_events
       SET notified_at = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [result.event.id, OWNER_ID]
    )
    return result
  }
  const classified = await createInterruptedEvent(interrupted, interruptedMessage)
  const legacyClassified = await createInterruptedEvent(legacyUnlinked, legacyUnlinkedMessage)

  await pool.query(
    `UPDATE email_events
     SET email_message_id = NULL, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [legacyClassified.event.id, OWNER_ID]
  )
  await pool.query(
    `DELETE FROM email_classification_jobs
     WHERE user_id = $1 AND email_message_id = ANY($2::uuid[])`,
    [OWNER_ID, [unclassified.message.id, interrupted.message.id, legacyUnlinked.message.id]]
  )

  const migration = await fs.readFile(
    new URL('../src/db/migrations/042_email_ingest_pipeline.sql', import.meta.url),
    'utf8'
  )
  const backfillSql = migration.match(
    /INSERT INTO email_classification_jobs \(user_id, account_id, email_message_id\)[\s\S]*?ON CONFLICT \(user_id, email_message_id\) DO NOTHING;/
  )?.[0]
  assert.ok(backfillSql)
  const backfilled = await pool.query(backfillSql)
  assert.equal(backfilled.rowCount, 1)
  const backfillReplay = await pool.query(backfillSql)
  assert.equal(backfillReplay.rowCount, 0)

  const backfillJobs = await pool.query(
    `SELECT email_message_id, notification_eligible
     FROM email_classification_jobs
     WHERE user_id = $1 AND email_message_id = ANY($2::uuid[])
     ORDER BY email_message_id`,
    [OWNER_ID, [unclassified.message.id, interrupted.message.id, legacyUnlinked.message.id]]
  )
  assert.deepEqual(
    backfillJobs.rows.map((row) => row.email_message_id),
    [unclassified.message.id]
  )
  assert.equal(backfillJobs.rows[0].notification_eligible, false)
  const untouchedEvents = await pool.query(
    `SELECT id, email_message_id, notified_at
     FROM email_events
     WHERE user_id = $1 AND id = ANY($2::uuid[])
     ORDER BY id`,
    [OWNER_ID, [classified.event.id, legacyClassified.event.id]]
  )
  assert.equal(untouchedEvents.rowCount, 2)
  const linkedEvent = untouchedEvents.rows.find((row) => row.id === classified.event.id)
  const unlinkedEvent = untouchedEvents.rows.find((row) => row.id === legacyClassified.event.id)
  assert.equal(linkedEvent.email_message_id, interrupted.message.id)
  assert.equal(linkedEvent.notified_at, null)
  assert.equal(unlinkedEvent.email_message_id, null)
  assert.equal(unlinkedEvent.notified_at, null)
  const historicalNotification = await pool.query(
    `SELECT id FROM notifications
     WHERE user_id = $1 AND source_type = 'email' AND source_id = ANY($2::text[])`,
    [OWNER_ID, [classified.event.id, legacyClassified.event.id]]
  )
  assert.equal(historicalNotification.rowCount, 0)

  const linkedRuntimeReplay = await persistEmailMailboxMessage(
    mailboxFixture({ message: interruptedMessage })
  )
  const unlinkedRuntimeReplay = await persistEmailMailboxMessage(
    mailboxFixture({ message: legacyUnlinkedMessage })
  )
  assert.equal(linkedRuntimeReplay.inserted, false)
  assert.equal(linkedRuntimeReplay.classificationQueued, false)
  assert.equal(unlinkedRuntimeReplay.inserted, false)
  assert.equal(unlinkedRuntimeReplay.classificationQueued, false)
  const historicalJobs = await pool.query(
    `SELECT email_message_id
     FROM email_classification_jobs
     WHERE user_id = $1 AND email_message_id = ANY($2::uuid[])`,
    [OWNER_ID, [interrupted.message.id, legacyUnlinked.message.id]]
  )
  assert.equal(historicalJobs.rowCount, 0)

  const newMessageWithoutMessageId = await persistEmailMailboxMessage(mailboxFixture({
    message: {
      ...mailboxFixture().message,
      mailboxUid: 16,
      messageId: '',
      rawHash: '1'.repeat(64),
      subject: 'New message without a Message-ID'
    }
  }))
  assert.equal(newMessageWithoutMessageId.inserted, true)
  assert.equal(newMessageWithoutMessageId.classificationQueued, true)
})

test('initial mailbox catch-up is classified and searchable without creating a notification', async () => {
  const historicalMessage = {
    ...mailboxFixture().message,
    mailboxUid: 17,
    messageId: '<historical-catch-up-silent@example.test>',
    rawHash: '2'.repeat(64),
    subject: '安全警报：历史邮件需要分类但不得补发通知',
    text: '这是首次同步发现的历史邮件。'
  }
  const historical = await persistEmailMailboxMessage(mailboxFixture({
    notificationEligible: false,
    message: historicalMessage
  }))
  const historicalRun = await processEmailClassificationJobs({
    poolInstance: pool,
    policy: { batchSize: 10, maxAttempts: 5 },
    runtimeConfig: { emailSourceKey: 'integration-mail' }
  })
  assert.equal(historicalRun.succeeded, 1)

  const historicalJob = await pool.query(
    `SELECT status, notification_eligible
     FROM email_classification_jobs
     WHERE user_id = $1 AND email_message_id = $2`,
    [OWNER_ID, historical.message.id]
  )
  assert.equal(historicalJob.rows[0].status, 'succeeded')
  assert.equal(historicalJob.rows[0].notification_eligible, false)
  const historicalEvent = await pool.query(
    `SELECT id, notification_action, notification_reason, notified_at
     FROM email_events
     WHERE user_id = $1 AND email_message_id = $2`,
    [OWNER_ID, historical.message.id]
  )
  assert.equal(historicalEvent.rowCount, 1)
  assert.equal(historicalEvent.rows[0].notification_action, 'silent')
  assert.match(historicalEvent.rows[0].notification_reason, /历史补齐邮件/)
  assert.equal(historicalEvent.rows[0].notified_at, null)
  const historicalNotifications = await pool.query(
    `SELECT id FROM notifications
     WHERE user_id = $1 AND source_type = 'email' AND source_id = $2`,
    [OWNER_ID, historicalEvent.rows[0].id]
  )
  assert.equal(historicalNotifications.rowCount, 0)

  const liveMessage = {
    ...mailboxFixture().message,
    mailboxUid: 18,
    messageId: '<live-mail-notifies@example.test>',
    rawHash: '3'.repeat(64),
    subject: '安全警报：账号异常登录，需要立即处理',
    text: '检测到新的异常登录，请立即核对。'
  }
  const live = await persistEmailMailboxMessage(mailboxFixture({
    notificationEligible: true,
    message: liveMessage
  }))
  const liveRun = await processEmailClassificationJobs({
    poolInstance: pool,
    policy: { batchSize: 10, maxAttempts: 5 },
    runtimeConfig: { emailSourceKey: 'integration-mail' }
  })
  assert.equal(liveRun.succeeded, 1)
  const liveEvent = await pool.query(
    `SELECT id, notification_action, notified_at
     FROM email_events
     WHERE user_id = $1 AND email_message_id = $2`,
    [OWNER_ID, live.message.id]
  )
  assert.equal(liveEvent.rowCount, 1)
  assert.equal(liveEvent.rows[0].notification_action, 'immediate')
  assert.ok(liveEvent.rows[0].notified_at)
  const liveNotifications = await pool.query(
    `SELECT id, push_enabled FROM notifications
     WHERE user_id = $1 AND source_type = 'email' AND source_id = $2`,
    [OWNER_ID, liveEvent.rows[0].id]
  )
  assert.equal(liveNotifications.rowCount, 1)
  assert.equal(liveNotifications.rows[0].push_enabled, true)
})

test('notification rules are owner-bound, encrypted at rest and protect critical mail', async () => {
  const saved = await persistEmailMailboxMessage(mailboxFixture())
  const encryptedEvent = await encryptEmailPayload({
    senderName: 'Sender',
    senderAddress: 'sender@example.test',
    subject: 'Critical sign-in alert',
    text: 'A new sign-in needs review.',
    reason: 'Security event',
    suggestedAction: 'Review the account directly.',
    urgency: 'high'
  }, { context: `${OWNER_ID}:integration-mail` })
  const marker = createHash('sha256').update('notification-rule-integration').digest('hex')
  const insertedEvent = await pool.query(
    `INSERT INTO email_events (
       user_id, source_key, mailbox_uid, message_id_hash, sender_hash,
       received_at, tier, urgency, deterministic_signature,
       event_signature, state_signature, classification_status,
       content_encrypted, email_message_id, category, importance_score,
       notification_action, notification_reason, notification_evaluated_at
     ) VALUES (
       $1, 'integration-mail', 10, $2, $3,
       NOW(), 1, 'high', $4, $5, $6, 'fallback',
       $7, $8, 'security', 95, 'immediate', 'Security default', NOW()
     ) RETURNING id`,
    [
      OWNER_ID,
      createHash('sha256').update('notification-message').digest('hex'),
      createHash('sha256').update('sender@example.test').digest('hex'),
      marker,
      createHash('sha256').update(`${marker}:event`).digest('hex'),
      createHash('sha256').update(`${marker}:state`).digest('hex'),
      encryptedEvent,
      saved.message.id
    ]
  )

  const payload = {
    accountId: saved.account.id,
    scope: 'sender',
    matchValue: 'sender@example.test',
    action: 'silent',
    enabled: true
  }
  const preview = await previewEmailNotificationRule({
    userId: OWNER_ID,
    payload
  }, { queryFn: (text, parameters) => pool.query(text, parameters) })
  assert.equal(preview.matchCount, 1)
  assert.equal(preview.criticalMatchCount, 1)
  assert.equal(preview.requiresCriticalConfirmation, true)
  await assert.rejects(
    upsertEmailNotificationRule({ userId: OWNER_ID, payload }, {
      queryFn: (text, parameters) => pool.query(text, parameters)
    }),
    (error) => error?.code === 'EMAIL_CRITICAL_NOTIFICATION_CONFIRMATION_REQUIRED'
  )

  const savedRule = await upsertEmailNotificationRule({
    userId: OWNER_ID,
    payload: { ...payload, criticalOverrideConfirmed: true }
  }, { queryFn: (text, parameters) => pool.query(text, parameters) })
  assert.equal(savedRule.created, true)
  assert.equal(savedRule.rule.matchValue, 'sender@example.test')
  assert.equal(savedRule.rule.criticalOverrideConfirmed, true)
  await assert.rejects(
    updateEmailNotificationRule({
      userId: OWNER_ID,
      ruleId: savedRule.rule.id,
      payload: { action: 'digest' }
    }, { queryFn: (text, parameters) => pool.query(text, parameters) }),
    (error) => error?.code === 'EMAIL_CRITICAL_NOTIFICATION_CONFIRMATION_REQUIRED'
  )
  const digestRule = await updateEmailNotificationRule({
    userId: OWNER_ID,
    ruleId: savedRule.rule.id,
    payload: { action: 'digest', criticalOverrideConfirmed: true }
  }, { queryFn: (text, parameters) => pool.query(text, parameters) })
  assert.equal(digestRule.action, 'digest')
  assert.equal(digestRule.criticalOverrideConfirmed, true)
  const restoredSilentRule = await updateEmailNotificationRule({
    userId: OWNER_ID,
    ruleId: savedRule.rule.id,
    payload: { action: 'silent', criticalOverrideConfirmed: true }
  }, { queryFn: (text, parameters) => pool.query(text, parameters) })
  assert.equal(restoredSilentRule.action, 'silent')
  assert.equal(restoredSilentRule.criticalOverrideConfirmed, true)

  const storedRule = await pool.query(
    `SELECT match_value_digest, match_value_encrypted
     FROM email_notification_rules WHERE id = $1 AND user_id = $2`,
    [savedRule.rule.id, OWNER_ID]
  )
  assert.match(storedRule.rows[0].match_value_digest, /^[0-9a-f]{64}$/)
  assert.equal(
    storedRule.rows[0].match_value_encrypted.includes(Buffer.from('sender@example.test')),
    false
  )

  const ownerRules = await listEmailNotificationRules({
    userId: OWNER_ID,
    accountId: saved.account.id
  }, { queryFn: (text, parameters) => pool.query(text, parameters) })
  assert.equal(ownerRules.length, 1)
  await assert.rejects(
    listEmailNotificationRules({ userId: OTHER_USER_ID, accountId: saved.account.id }, {
      queryFn: (text, parameters) => pool.query(text, parameters)
    }),
    (error) => error?.statusCode === 404
  )

  const decision = await resolveEmailNotificationDecision({
    userId: OWNER_ID,
    accountId: saved.account.id,
    senderAddress: 'sender@example.test',
    category: 'security',
    conversationKey: saved.message.thread_key_hash,
    tier: 1,
    queryFn: (text, parameters) => pool.query(text, parameters)
  })
  assert.equal(decision.action, 'silent')
  assert.equal(decision.ruleId, savedRule.rule.id)
  assert.equal(
    Number((await pool.query(
      'SELECT hit_count FROM email_notification_rules WHERE id = $1',
      [savedRule.rule.id]
    )).rows[0].hit_count),
    0
  )

  const inbound = {
    messageId: '<notification-rule-hit@example.test>',
    mailboxUid: 11,
    senderName: 'Security Sender',
    senderAddress: 'sender@example.test',
    recipient: 'owner@example.test',
    subject: 'Security alert requires action',
    text: 'A suspicious login requires action.',
    receivedAt: new Date().toISOString()
  }
  const firstInbound = await processInboundEmail({
    userId: OWNER_ID,
    sourceKey: 'integration-mail',
    notificationEligible: true,
    email: inbound,
    queryFn: (text, parameters) => pool.query(text, parameters)
  })
  assert.equal(firstInbound.inserted, true)
  assert.equal(
    Number((await pool.query(
      'SELECT hit_count FROM email_notification_rules WHERE id = $1',
      [savedRule.rule.id]
    )).rows[0].hit_count),
    1
  )
  const duplicateInbound = await processInboundEmail({
    userId: OWNER_ID,
    sourceKey: 'integration-mail',
    notificationEligible: true,
    email: inbound,
    queryFn: (text, parameters) => pool.query(text, parameters)
  })
  assert.equal(duplicateInbound.inserted, false)
  assert.equal(duplicateInbound.duplicate, true)
  assert.equal(
    Number((await pool.query(
      'SELECT hit_count FROM email_notification_rules WHERE id = $1',
      [savedRule.rule.id]
    )).rows[0].hit_count),
    1
  )

  await pool.query(
    `UPDATE email_events SET notification_rule_id = $1 WHERE id = $2 AND user_id = $3`,
    [savedRule.rule.id, insertedEvent.rows[0].id, OWNER_ID]
  )
  await deleteEmailNotificationRule({ userId: OWNER_ID, ruleId: savedRule.rule.id }, {
    queryFn: (text, parameters) => pool.query(text, parameters)
  })
  assert.equal(
    (await pool.query('SELECT notification_rule_id FROM email_events WHERE id = $1', [insertedEvent.rows[0].id]))
      .rows[0].notification_rule_id,
    null
  )
})

test('UIDVALIDITY reset expires old remote locations without deleting canonical messages', async () => {
  const oldMessage = await persistEmailMailboxMessage(mailboxFixture())
  await pool.query(
    `UPDATE email_folders
     SET reconciled_modseq = 20,
         last_reconciled_at = NOW(),
         last_reconcile_mode = 'qresync'
     WHERE id = $1 AND user_id = $2`,
    [oldMessage.folder.id, OWNER_ID]
  )
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
  const resetFolder = await pool.query(
    `SELECT reconciled_modseq, last_reconciled_at, last_reconcile_mode
     FROM email_folders WHERE id = $1 AND user_id = $2`,
    [nextMessage.folder.id, OWNER_ID]
  )
  assert.equal(resetFolder.rows[0].reconciled_modseq, null)
  assert.equal(resetFolder.rows[0].last_reconciled_at, null)
  assert.equal(resetFolder.rows[0].last_reconcile_mode, 'uidvalidity_reset')
  assert.equal(
    Number((await pool.query('SELECT COUNT(*) FROM email_messages WHERE user_id = $1', [OWNER_ID])).rows[0].count),
    2
  )
})

test('protocol reconciliation applies monotonic flags and exact expunges without crossing owners', async () => {
  const first = await persistEmailMailboxMessage(mailboxFixture())
  const second = await persistEmailMailboxMessage(mailboxFixture({
    message: {
      ...mailboxFixture().message,
      mailboxUid: 11,
      messageId: '<mailbox-reconcile-second@example.test>',
      rawHash: 'b'.repeat(64),
      subject: 'Second reconcile message',
      flags: [],
      modseq: '21'
    },
    folder: {
      ...mailboxFixture().folder,
      uidNext: '12',
      highestModseq: '21'
    }
  }))
  await pool.query(
    `UPDATE email_folders
     SET reconciled_modseq = 21, last_reconciled_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [first.folder.id, OWNER_ID]
  )

  const applied = await applyEmailFolderReconciliation({
    poolInstance: pool,
    userId: OWNER_ID,
    folderId: first.folder.id,
    uidValidity: '100',
    mode: 'qresync',
    remoteHighestModseq: '25',
    flagUpdates: [{
      uid: 10,
      modseq: '25',
      flags: ['\\Flagged', 'remote-keyword']
    }],
    expungedUids: [11]
  })
  assert.deepEqual(applied, { flagsUpdated: 1, expunged: 1, mode: 'qresync' })

  const state = await pool.query(
    `SELECT reconciled_modseq, last_reconcile_mode, last_reconcile_error_code
     FROM email_folders WHERE id = $1 AND user_id = $2`,
    [first.folder.id, OWNER_ID]
  )
  assert.equal(String(state.rows[0].reconciled_modseq), '25')
  assert.equal(state.rows[0].last_reconcile_mode, 'qresync')
  assert.equal(state.rows[0].last_reconcile_error_code, null)

  const locations = await pool.query(
    `SELECT uid, modseq, seen, flagged, keywords, expunged_at
     FROM email_folder_messages
     WHERE folder_id = $1 AND user_id = $2
     ORDER BY uid`,
    [first.folder.id, OWNER_ID]
  )
  assert.equal(Number(locations.rows[0].uid), 10)
  assert.equal(String(locations.rows[0].modseq), '25')
  assert.equal(locations.rows[0].seen, false)
  assert.equal(locations.rows[0].flagged, true)
  assert.deepEqual(locations.rows[0].keywords, ['remote-keyword'])
  assert.equal(locations.rows[0].expunged_at, null)
  assert.equal(Number(locations.rows[1].uid), 11)
  assert.ok(locations.rows[1].expunged_at)

  const third = await persistEmailMailboxMessage(mailboxFixture({
    message: {
      ...mailboxFixture().message,
      mailboxUid: 12,
      messageId: '<mailbox-reconcile-third@example.test>',
      rawHash: 'c'.repeat(64),
      subject: 'Third reconcile message',
      flags: [],
      modseq: '24'
    },
    folder: {
      ...mailboxFixture().folder,
      uidNext: '13',
      highestModseq: '25'
    }
  }))
  const authoritative = await applyEmailFolderReconciliation({
    poolInstance: pool,
    userId: OWNER_ID,
    folderId: first.folder.id,
    uidValidity: '100',
    mode: 'condstore',
    remoteHighestModseq: '25',
    flagUpdates: [{ uid: 10, modseq: '24', flags: ['\\Seen'] }],
    authoritativeRemoteUids: [10]
  })
  assert.deepEqual(authoritative, { flagsUpdated: 0, expunged: 1, mode: 'condstore' })
  const monotonic = await pool.query(
    `SELECT uid, modseq, seen, flagged, expunged_at
     FROM email_folder_messages
     WHERE id = ANY($1::uuid[]) AND user_id = $2
     ORDER BY uid`,
    [[first.location.id, third.location.id], OWNER_ID]
  )
  assert.equal(String(monotonic.rows[0].modseq), '25')
  assert.equal(monotonic.rows[0].seen, false)
  assert.equal(monotonic.rows[0].flagged, true)
  assert.ok(monotonic.rows[1].expunged_at)

  const canonicalCount = await pool.query(
    'SELECT COUNT(*)::integer AS count FROM email_messages WHERE user_id = $1',
    [OWNER_ID]
  )
  assert.equal(canonicalCount.rows[0].count, 3)

  await assert.rejects(
    applyEmailFolderReconciliation({
      poolInstance: pool,
      userId: OTHER_USER_ID,
      folderId: first.folder.id,
      uidValidity: '100',
      mode: 'qresync',
      remoteHighestModseq: '26'
    }),
    (error) => error?.code === 'EMAIL_RECONCILE_FOLDER_MISSING'
  )
  await assert.rejects(
    applyEmailFolderReconciliation({
      poolInstance: pool,
      userId: OWNER_ID,
      folderId: first.folder.id,
      uidValidity: '999',
      mode: 'qresync',
      remoteHighestModseq: '26'
    }),
    (error) => error?.code === 'EMAIL_RECONCILE_UIDVALIDITY_CHANGED'
  )
  await assert.rejects(
    applyEmailFolderReconciliation({
      poolInstance: pool,
      userId: OWNER_ID,
      folderId: first.folder.id,
      uidValidity: '100',
      mode: 'qresync',
      remoteHighestModseq: '24'
    }),
    (error) => error?.code === 'EMAIL_RECONCILE_MODSEQ_REGRESSION'
  )
  await assert.rejects(
    applyEmailFolderReconciliation({
      poolInstance: pool,
      userId: OWNER_ID,
      folderId: first.folder.id,
      uidValidity: '100',
      mode: 'condstore',
      remoteHighestModseq: null
    }),
    (error) => error?.code === 'EMAIL_RECONCILE_MODSEQ_MISSING'
  )

  const replay = await applyEmailFolderReconciliation({
    poolInstance: pool,
    userId: OWNER_ID,
    folderId: first.folder.id,
    uidValidity: '100',
    mode: 'qresync',
    remoteHighestModseq: '25',
    expungedUids: [11]
  })
  assert.equal(replay.expunged, 0)
  assert.equal(second.message.id.length, 36)
})

test('periodic folder sync ingests a subscribed secondary folder and honors error cooldown', async () => {
  const primary = await persistEmailMailboxMessage(mailboxFixture())
  await pool.query(
    `UPDATE email_folders
     SET initial_sync_complete = TRUE,
         last_synced_at = NOW(),
         last_reconciled_at = NOW(),
         reconciled_modseq = highest_modseq
     WHERE id = $1 AND user_id = $2`,
    [primary.folder.id, OWNER_ID]
  )
  const archiveClient = await pool.connect()
  let archive
  try {
    await archiveClient.query('BEGIN')
    archive = await upsertEmailFolder(archiveClient, {
      accountId: primary.account.id,
      userId: OWNER_ID,
      path: 'Archive',
      delimiter: '/',
      specialUse: 'archive',
      selectable: true,
      subscribed: true,
      uidValidity: '300',
      uidNext: '2',
      highestModseq: '51',
      lastUid: 0
    })
    await archiveClient.query('COMMIT')
  } catch (error) {
    await archiveClient.query('ROLLBACK')
    throw error
  } finally {
    archiveClient.release()
  }

  const mailboxByPath = new Map([['Archive', {
    path: 'Archive',
    delimiter: '/',
    uidValidity: 300n,
    uidNext: 2,
    highestModseq: 51n,
    exists: 1,
    noModseq: true
  }]])
  const fakeImap = {
    capabilities: new Set(['IDLE']),
    enabled: new Set(),
    mailbox: null,
    async getMailboxLock(folderPath) {
      this.mailbox = mailboxByPath.get(folderPath)
      assert.ok(this.mailbox, `unexpected IMAP folder ${folderPath}`)
      return { release() {} }
    },
    on() {},
    off() {},
    async search() { return [1] },
    async fetchAll(range, query) {
      if (query?.envelope) {
        assert.equal(range, '1:1')
        return [{
          uid: 1,
          envelope: {
            messageId: '<archive-one@example.test>',
            subject: 'Archived message',
            from: [{ name: 'Archive sender', address: 'archive@example.test' }],
            to: [{ name: 'Owner', address: 'owner@example.test' }],
            date: new Date('2026-08-30T12:00:00.000Z')
          },
          internalDate: new Date('2026-08-30T12:00:00.000Z'),
          size: 128,
          flags: new Set(['\\Seen']),
          modseq: 51n
        }]
      }
      assert.deepEqual(range, [1])
      return [{ uid: 1, flags: new Set(['\\Seen']), modseq: 51n }]
    },
    async fetchOne(uid) {
      assert.equal(uid, 1)
      return { source: Buffer.from('Subject: Archived message\r\n\r\nArchived body') }
    }
  }
  const parseMessage = async (message) => ({
    mailboxUid: Number(message.uid),
    messageId: `<archive-${message.uid}@example.test>`,
    rawHash: createHash('sha256').update(`archive-${message.uid}`).digest('hex'),
    sender: { name: 'Archive sender', address: 'archive@example.test' },
    to: [{ name: 'Owner', address: 'owner@example.test' }],
    subject: 'Archived message',
    text: 'Archived body',
    receivedAt: '2026-08-30T12:00:00.000Z',
    internalDate: '2026-08-30T12:00:00.000Z',
    size: 128,
    flags: [...(message.flags || [])],
    modseq: String(message.modseq || 51),
    attachments: []
  })
  const firstRun = await syncDueEmailFolders({
    client: fakeImap,
    poolInstance: pool,
    userId: OWNER_ID,
    sourceKey: 'integration-mail',
    primaryMailbox: 'INBOX',
    policy: { folderSyncIntervalSeconds: 900, foldersPerRun: 2 },
    parseMessage
  })
  assert.equal(firstRun.foldersProcessed, 1)
  assert.equal(firstRun.uidScanFolders, 1)
  assert.equal(firstRun.secondaryProcessed, 1)
  assert.equal(firstRun.secondaryRemaining, 0)

  const stored = await pool.query(
    `SELECT folder.path, folder.last_uid, folder.initial_sync_complete,
            folder.last_reconcile_mode, job.notification_eligible
     FROM email_folders AS folder
     JOIN email_folder_messages AS location
       ON location.folder_id = folder.id AND location.user_id = folder.user_id
     JOIN email_classification_jobs AS job
       ON job.email_message_id = location.message_id AND job.user_id = location.user_id
     WHERE folder.id = $1 AND folder.user_id = $2`,
    [archive.id, OWNER_ID]
  )
  assert.equal(stored.rows[0].path, 'Archive')
  assert.equal(Number(stored.rows[0].last_uid), 1)
  assert.equal(stored.rows[0].initial_sync_complete, true)
  assert.equal(stored.rows[0].last_reconcile_mode, 'uid_flags_scan')
  assert.equal(stored.rows[0].notification_eligible, false)

  const immediateReplay = await syncDueEmailFolders({
    client: fakeImap,
    poolInstance: pool,
    userId: OWNER_ID,
    sourceKey: 'integration-mail',
    primaryMailbox: 'INBOX',
    policy: { folderSyncIntervalSeconds: 900, foldersPerRun: 2 },
    parseMessage
  })
  assert.equal(immediateReplay.foldersProcessed, 0)

  await pool.query(
    `UPDATE email_folders
     SET initial_sync_complete = FALSE,
         last_reconciled_at = NULL,
         last_reconcile_error_at = NOW(),
         last_reconcile_error_code = 'EMAIL_RECONCILE_UID_SCAN_FAILED'
     WHERE id = $1 AND user_id = $2`,
    [archive.id, OWNER_ID]
  )
  const cooledDown = await syncDueEmailFolders({
    client: fakeImap,
    poolInstance: pool,
    userId: OWNER_ID,
    sourceKey: 'integration-mail',
    primaryMailbox: 'INBOX',
    policy: { folderSyncIntervalSeconds: 900, foldersPerRun: 2 },
    parseMessage
  })
  assert.equal(cooledDown.foldersProcessed, 0)
})

test('QRESYNC fetch applies changed flags and VANISHED UIDs from the selected folder', async () => {
  const first = await persistEmailMailboxMessage(mailboxFixture())
  const second = await persistEmailMailboxMessage(mailboxFixture({
    message: {
      ...mailboxFixture().message,
      mailboxUid: 11,
      messageId: '<qresync-vanished@example.test>',
      rawHash: 'd'.repeat(64),
      subject: 'QRESYNC vanished message',
      flags: [],
      modseq: '21'
    },
    folder: {
      ...mailboxFixture().folder,
      uidNext: '12',
      highestModseq: '21'
    }
  }))
  await pool.query(
    `UPDATE email_folders
     SET initial_sync_complete = TRUE,
         reconciled_modseq = 21,
         last_reconciled_at = NOW() - INTERVAL '1 hour'
     WHERE id = $1 AND user_id = $2`,
    [first.folder.id, OWNER_ID]
  )
  const listeners = new Map()
  let remoteHighestModseq = 25n
  let vanishedUid = 11
  const fakeImap = {
    capabilities: new Set(['CONDSTORE', 'QRESYNC']),
    enabled: new Set(['CONDSTORE', 'QRESYNC']),
    mailbox: null,
    async getMailboxLock(folderPath) {
      assert.equal(folderPath, 'INBOX')
      this.mailbox = {
        path: 'INBOX',
        delimiter: '/',
        uidValidity: 100n,
        uidNext: 12,
        highestModseq: remoteHighestModseq,
        exists: 1,
        noModseq: false
      }
      return { release() {} }
    },
    on(name, handler) { listeners.set(name, handler) },
    off(name, handler) {
      if (listeners.get(name) === handler) listeners.delete(name)
    },
    async fetchAll(range, query, options) {
      assert.equal(range, '1:*')
      assert.equal(options.uid, true)
      assert.ok([21n, 25n].includes(options.changedSince))
      assert.equal(query.modseq, true)
      listeners.get('expunge')?.({ path: 'INBOX', uid: vanishedUid, vanished: true, earlier: true })
      if (vanishedUid != null) this.mailbox.highestModseq = 99n
      return vanishedUid == null
        ? []
        : [{ uid: 10, flags: new Set(['\\Flagged']), modseq: 25n }]
    }
  }
  const summary = await syncDueEmailFolders({
    client: fakeImap,
    poolInstance: pool,
    userId: OWNER_ID,
    sourceKey: 'integration-mail',
    primaryMailbox: 'INBOX',
    policy: { folderSyncIntervalSeconds: 60, foldersPerRun: 1 },
    parseMessage: async () => { throw new Error('primary reconciliation must not parse content') }
  })
  assert.equal(summary.foldersProcessed, 1)
  assert.equal(summary.qresyncFolders, 1)
  assert.equal(summary.flagUpdates, 1)
  assert.equal(summary.expunged, 1)
  assert.equal(listeners.size, 0)

  const locations = await pool.query(
    `SELECT id, modseq, flagged, expunged_at
     FROM email_folder_messages
     WHERE id = ANY($1::uuid[]) AND user_id = $2
     ORDER BY uid`,
    [[first.location.id, second.location.id], OWNER_ID]
  )
  assert.equal(String(locations.rows[0].modseq), '25')
  assert.equal(locations.rows[0].flagged, true)
  assert.equal(locations.rows[0].expunged_at, null)
  assert.ok(locations.rows[1].expunged_at)

  await pool.query(
    `UPDATE email_folders
     SET last_reconciled_at = NOW() - INTERVAL '1 hour'
     WHERE id = $1 AND user_id = $2`,
    [first.folder.id, OWNER_ID]
  )
  remoteHighestModseq = 26n
  vanishedUid = null
  const failedClosed = await syncDueEmailFolders({
    client: fakeImap,
    poolInstance: pool,
    userId: OWNER_ID,
    sourceKey: 'integration-mail',
    primaryMailbox: 'INBOX',
    policy: { folderSyncIntervalSeconds: 60, foldersPerRun: 1 },
    parseMessage: async () => { throw new Error('primary reconciliation must not parse content') }
  })
  assert.equal(failedClosed.foldersProcessed, 0)
  assert.equal(failedClosed.foldersFailed, 1)
  const failedState = await pool.query(
    `SELECT reconciled_modseq, last_reconcile_error_code
     FROM email_folders WHERE id = $1 AND user_id = $2`,
    [first.folder.id, OWNER_ID]
  )
  assert.equal(String(failedState.rows[0].reconciled_modseq), '25')
  assert.equal(failedState.rows[0].last_reconcile_error_code, 'EMAIL_RECONCILE_EXPUNGE_UNKNOWN')

  const cooldown = await syncDueEmailFolders({
    client: fakeImap,
    poolInstance: pool,
    userId: OWNER_ID,
    sourceKey: 'integration-mail',
    primaryMailbox: 'INBOX',
    policy: { folderSyncIntervalSeconds: 60, foldersPerRun: 1 },
    parseMessage: async () => { throw new Error('primary reconciliation must not parse content') }
  })
  assert.equal(cooldown.foldersProcessed, 0)
  assert.equal(cooldown.foldersFailed, 0)
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
  }, { poolInstance: pool, assertDeliveryReadyFn: assertIntegrationDeliveryReady })
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
      async sendMail(message) {
        const parsed = await simpleParser(message.raw)
        try {
          deliveries.push({
            envelope: message.envelope,
            subject: parsed.subject,
            text: parsed.text?.trim()
          })
        } finally {
          for (const attachment of parsed.attachments || []) {
            if (Buffer.isBuffer(attachment.content)) attachment.content.fill(0)
          }
        }
        return { accepted: message.envelope.to, rejected: [] }
      },
      close() {}
    }
  }
  const deliveryOptions = {
    poolInstance: pool,
    policy: { batchSize: 10, maxAttempts: 3, intervalSeconds: 30 },
    runtimeConfig: {
      emailSourceKey: 'integration-mail',
      emailOwnerUsername: 'mail-owner',
      smtpFromAddress: 'nav@example.test',
      smtpFromName: 'DOMO NAV'
    },
    transportFactory
  }
  const firstDelivery = await deliverMailOutbox(deliveryOptions)
  assert.equal(firstDelivery.processed, 1)
  assert.equal(firstDelivery.sent, 1)
  assert.equal(deliveries.length, 1)
  assert.deepEqual(deliveries[0].envelope.to, [
    'recipient@example.test',
    'copy@example.test'
  ])
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

test('attachment ciphertext lifecycle reaches an encrypted pending Sent job and terminal scrub', async () => {
  const attachmentMarker = Buffer.from('ATTACHMENT-PLAINTEXT-MARKER-037-038', 'utf8')
  const attachmentPlaintext = Buffer.alloc((256 * 1024) + 4096, 0x61)
  attachmentMarker.copy(attachmentPlaintext)
  const attachmentSha256 = createHash('sha256').update(attachmentPlaintext).digest('hex')
  const filename = 'private-attachment-marker-037-038.txt'
  const subject = 'Sent lifecycle subject marker 038'
  const body = 'Sent lifecycle body marker 038'
  let smtpSnapshot = null
  let appendedSnapshot = null

  try {
    const saved = await persistEmailMailboxMessage(mailboxFixture())
    const draft = await createEmailDraft({
      userId: OWNER_ID,
      accountId: saved.account.id,
      payload: {
        to: ['recipient@example.test'],
        cc: ['copy@example.test'],
        subject,
        text: body
      }
    }, { poolInstance: pool })

    const attachment = await createDraftEmailAttachment({
      userId: OWNER_ID,
      draftId: draft.id,
      metadata: {
        filename,
        contentType: 'text/plain',
        disposition: 'attachment'
      },
      content: attachmentPlaintext
    }, { poolInstance: pool })
    assert.equal(attachment.sha256, attachmentSha256)
    assert.equal(attachment.size, attachmentPlaintext.length)
    assert.equal(attachment.ordinal, 0)

    const listed = await listDraftEmailAttachments(
      { userId: OWNER_ID, draftId: draft.id },
      { queryFn: pool.query.bind(pool) }
    )
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, attachment.id)
    assert.equal(listed[0].filename, filename)
    assert.equal(listed[0].contentType, 'text/plain')
    assert.deepEqual(
      await listDraftEmailAttachments(
        { userId: OTHER_USER_ID, draftId: draft.id },
        { queryFn: pool.query.bind(pool) }
      ),
      []
    )

    const storedObject = await pool.query(
      `SELECT * FROM email_attachment_objects
       WHERE id = $1 AND user_id = $2`,
      [attachment.id, OWNER_ID]
    )
    assert.equal(storedObject.rowCount, 1)
    assert.equal(storedObject.rows[0].state, 'draft')
    assert.equal(storedObject.rows[0].outbox_id, null)
    assert.equal(storedObject.rows[0].sha256, attachmentSha256)
    assert.equal(Number(storedObject.rows[0].size_bytes), attachmentPlaintext.length)
    assert.equal(Number(storedObject.rows[0].chunk_count), 2)
    assert.ok(Buffer.isBuffer(storedObject.rows[0].metadata_encrypted))
    assert.equal(
      storedObject.rows[0].metadata_encrypted.includes(Buffer.from(filename, 'utf8')),
      false
    )

    const storedChunks = await pool.query(
      `SELECT chunk_index, plaintext_size, ciphertext_encrypted
       FROM email_attachment_chunks
       WHERE attachment_id = $1 AND user_id = $2
       ORDER BY chunk_index`,
      [attachment.id, OWNER_ID]
    )
    assert.equal(storedChunks.rowCount, 2)
    assert.deepEqual(storedChunks.rows.map((row) => Number(row.chunk_index)), [0, 1])
    assert.equal(
      storedChunks.rows.reduce((total, row) => total + Number(row.plaintext_size), 0),
      attachmentPlaintext.length
    )
    for (const row of storedChunks.rows) {
      assert.ok(Buffer.isBuffer(row.ciphertext_encrypted))
      assert.equal(
        row.ciphertext_encrypted.length,
        Number(row.plaintext_size) + 29
      )
      assert.equal(row.ciphertext_encrypted.includes(attachmentMarker), false)
    }

    await assert.rejects(
      pool.query(
        `INSERT INTO email_attachment_objects (
           id, user_id, draft_id, state, ordinal, sha256, size_bytes,
           chunk_count, metadata_encrypted, metadata_digest
         ) VALUES ($1,$2,$3,'draft',1,$4,1,1,$5,$6)`,
        [
          randomUUID(),
          OTHER_USER_ID,
          draft.id,
          'b'.repeat(64),
          Buffer.alloc(32, 0x31),
          'c'.repeat(64)
        ]
      ),
      (error) => error?.code === '23503'
    )
    await assert.rejects(
      pool.query(
        `INSERT INTO email_attachment_chunks (
           attachment_id, user_id, chunk_index, plaintext_size, ciphertext_encrypted
         ) VALUES ($1,$2,39,1,$3)`,
        [attachment.id, OTHER_USER_ID, Buffer.alloc(30, 0x32)]
      ),
      (error) => error?.code === '23503'
    )

    const refreshedDraft = await refreshEmailDraftContentHash(
      { userId: OWNER_ID, draftId: draft.id },
      { poolInstance: pool }
    )
    assert.notEqual(refreshedDraft.contentHash, draft.contentHash)
    assert.equal(refreshedDraft.attachments.length, 1)

    const queued = await queueEmailDraft({
      userId: OWNER_ID,
      draftId: draft.id,
      contentHash: refreshedDraft.contentHash,
      confirmed: true
    }, { poolInstance: pool, assertDeliveryReadyFn: assertIntegrationDeliveryReady })
    assert.ok(queued.outboxId)

    const claimed = await pool.query(
      `SELECT state, outbox_id, metadata_encrypted, scrubbed_at
       FROM email_attachment_objects
       WHERE id = $1 AND user_id = $2`,
      [attachment.id, OWNER_ID]
    )
    assert.equal(claimed.rows[0].state, 'claimed')
    assert.equal(claimed.rows[0].outbox_id, queued.outboxId)
    assert.ok(Buffer.isBuffer(claimed.rows[0].metadata_encrypted))
    assert.equal(claimed.rows[0].scrubbed_at, null)

    const runtimeConfig = {
      emailEncryptionKeyFile: process.env.NAV_EMAIL_ENCRYPTION_KEY_FILE,
      emailSentAppendEnabled: true,
      emailSourceKey: 'integration-mail',
      emailOwnerUsername: 'mail-owner',
      smtpFromAddress: 'nav@example.test',
      smtpFromName: 'DOMO NAV'
    }
    const delivery = await deliverMailOutbox({
      poolInstance: pool,
      policy: { batchSize: 10, maxAttempts: 3, intervalSeconds: 30 },
      runtimeConfig,
      transportFactory: async () => ({
        async sendMail(message) {
          const parsed = await simpleParser(message.raw)
          try {
            smtpSnapshot = {
              envelope: message.envelope,
              mimeSha256: createHash('sha256').update(message.raw).digest('hex'),
              mimeSizeBytes: message.raw.length,
              subject: parsed.subject,
              text: parsed.text?.trim(),
              attachments: (parsed.attachments || []).map((item) => ({
                filename: item.filename,
                contentType: item.contentType,
                sha256: createHash('sha256').update(item.content).digest('hex')
              }))
            }
          } finally {
            for (const item of parsed.attachments || []) {
              if (Buffer.isBuffer(item.content)) item.content.fill(0)
            }
          }
          return { accepted: message.envelope.to, rejected: [] }
        },
        close() {}
      })
    })
    assert.equal(delivery.processed, 1)
    assert.equal(delivery.sent, 1)
    assert.deepEqual(smtpSnapshot.envelope.to, [
      'recipient@example.test',
      'copy@example.test'
    ])
    assert.equal(smtpSnapshot.subject, subject)
    assert.equal(smtpSnapshot.text, body)
    assert.deepEqual(smtpSnapshot.attachments, [{
      filename,
      contentType: 'text/plain',
      sha256: attachmentSha256
    }])

    const afterSmtp = await pool.query(
      `SELECT job.*, outbox.status AS outbox_status,
              outbox.payload_encrypted AS outbox_payload_encrypted,
              outbox.scrubbed_at AS outbox_scrubbed_at
       FROM email_sent_append_jobs AS job
       JOIN mail_outbox AS outbox ON outbox.id = job.outbox_id
       WHERE job.outbox_id = $1 AND job.user_id = $2`,
      [queued.outboxId, OWNER_ID]
    )
    assert.equal(afterSmtp.rowCount, 1)
    const sentJob = afterSmtp.rows[0]
    assert.equal(sentJob.status, 'pending')
    assert.equal(sentJob.outbox_status, 'sent')
    assert.ok(sentJob.smtp_accepted_at)
    assert.equal(sentJob.append_attempted, false)
    assert.equal(Number(sentJob.append_attempt_count), 0)
    assert.equal(sentJob.append_started_at, null)
    assert.equal(sentJob.appended_at, null)
    assert.equal(sentJob.scrubbed_at, null)
    assert.ok(Buffer.isBuffer(sentJob.mime_encrypted))
    assert.equal(sentJob.mime_sha256, smtpSnapshot.mimeSha256)
    assert.equal(Number(sentJob.mime_size_bytes), smtpSnapshot.mimeSizeBytes)
    assert.equal(sentJob.mime_encrypted.length, smtpSnapshot.mimeSizeBytes + 29)
    assert.equal(sentJob.outbox_payload_encrypted, null)
    assert.ok(sentJob.outbox_scrubbed_at)
    for (const marker of [subject, body, filename, attachmentMarker.toString('utf8')]) {
      assert.equal(sentJob.mime_encrypted.includes(Buffer.from(marker, 'utf8')), false)
    }

    const scrubbedAttachment = await pool.query(
      `SELECT state, outbox_id, metadata_encrypted, scrubbed_at,
              sha256, size_bytes, chunk_count, metadata_digest
       FROM email_attachment_objects
       WHERE id = $1 AND user_id = $2`,
      [attachment.id, OWNER_ID]
    )
    assert.equal(scrubbedAttachment.rows[0].state, 'scrubbed')
    assert.equal(scrubbedAttachment.rows[0].outbox_id, queued.outboxId)
    assert.equal(scrubbedAttachment.rows[0].metadata_encrypted, null)
    assert.ok(scrubbedAttachment.rows[0].scrubbed_at)
    assert.equal(scrubbedAttachment.rows[0].sha256, attachmentSha256)
    assert.equal(Number(scrubbedAttachment.rows[0].size_bytes), attachmentPlaintext.length)
    assert.equal(Number(scrubbedAttachment.rows[0].chunk_count), 2)
    assert.match(scrubbedAttachment.rows[0].metadata_digest, /^[0-9a-f]{64}$/)
    assert.equal(
      Number((await pool.query(
        'SELECT COUNT(*) FROM email_attachment_chunks WHERE attachment_id = $1',
        [attachment.id]
      )).rows[0].count),
      0
    )

    const dbClient = await pool.connect()
    try {
      const fakeImap = {
        async search() { return [] },
        async append(folderPath, raw, flags, date) {
          const parsed = await simpleParser(raw)
          try {
            appendedSnapshot = {
              folderPath,
              flags,
              date,
              mimeSha256: createHash('sha256').update(raw).digest('hex'),
              attachmentSha256: createHash('sha256')
                .update(parsed.attachments[0].content)
                .digest('hex')
            }
          } finally {
            for (const item of parsed.attachments || []) {
              if (Buffer.isBuffer(item.content)) item.content.fill(0)
            }
          }
          return { uid: 4242, uidValidity: 9001 }
        }
      }
      const outcome = await processEmailSentAppendJob({
        dbClient,
        imap: fakeImap,
        job: sentJob,
        folder: { path: 'Sent', delimiter: '/', specialUse: '\\Sent' },
        uidValidity: 9001,
        policy: { reconcileDelaySeconds: 30, blockedDelaySeconds: 300 },
        runtimeConfig,
        decryptMimeFn: decryptEmailSentMime,
        poolInstance: pool,
        cacheFn: async () => {}
      })
      assert.equal(outcome, 'appended')
    } finally {
      dbClient.release()
    }
    assert.equal(appendedSnapshot.folderPath, 'Sent')
    assert.deepEqual(appendedSnapshot.flags, ['\\Seen'])
    assert.ok(appendedSnapshot.date instanceof Date)
    assert.equal(appendedSnapshot.mimeSha256, smtpSnapshot.mimeSha256)
    assert.equal(appendedSnapshot.attachmentSha256, attachmentSha256)

    const terminalSent = await pool.query(
      `SELECT status, mime_encrypted, append_attempted,
              append_attempt_count, reconcile_count, smtp_accepted_at,
              append_started_at,
              appended_at, sent_folder_path, uid_validity, uid,
              last_error_code, scrubbed_at
       FROM email_sent_append_jobs
       WHERE outbox_id = $1 AND user_id = $2`,
      [queued.outboxId, OWNER_ID]
    )
    assert.equal(terminalSent.rows[0].status, 'appended')
    assert.equal(terminalSent.rows[0].mime_encrypted, null)
    assert.equal(terminalSent.rows[0].append_attempted, true)
    assert.equal(Number(terminalSent.rows[0].append_attempt_count), 1)
    assert.equal(Number(terminalSent.rows[0].reconcile_count), 0)
    assert.ok(terminalSent.rows[0].smtp_accepted_at)
    assert.ok(terminalSent.rows[0].append_started_at)
    assert.ok(terminalSent.rows[0].appended_at)
    assert.equal(terminalSent.rows[0].sent_folder_path, 'Sent')
    assert.equal(Number(terminalSent.rows[0].uid_validity), 9001)
    assert.equal(Number(terminalSent.rows[0].uid), 4242)
    assert.equal(terminalSent.rows[0].last_error_code, null)
    assert.ok(terminalSent.rows[0].scrubbed_at)
  } finally {
    attachmentPlaintext.fill(0)
  }
})

test('retirement sends only transactional notifications and leaves old mailbox outbox untouched', async () => {
  const saved = await persistEmailMailboxMessage(mailboxFixture())
  const draft = await createEmailDraft({
    userId: OWNER_ID, accountId: saved.account.id,
    payload: { to: ['personal@example.test'], subject: 'Retired message', text: 'Never send' }
  }, { poolInstance: pool })
  const queued = await queueEmailDraft({
    userId: OWNER_ID, draftId: draft.id, contentHash: draft.contentHash, confirmed: true
  }, { poolInstance: pool, assertDeliveryReadyFn: assertIntegrationDeliveryReady })
  const systemId = randomUUID()
  const digestId = randomUUID()
  await pool.query(
    `INSERT INTO mail_outbox (id,user_id,message_type,recipient,subject,text_body,dedupe_key,sensitive)
     VALUES ($1::uuid,$3::uuid,'system.test','system@example.test','System test','Test',$1::text,false),
            ($2::uuid,$3::uuid,'email.digest','digest@example.test','Old digest','Test',$2::text,false)`,
    [systemId, digestId, OWNER_ID]
  )
  const recipients = []
  const summary = await deliverMailOutbox({
    poolInstance: pool, policy: {}, systemOnly: true,
    runtimeConfig: { emailSourceKey: 'integration-mail', emailOwnerUsername: 'mail-owner', smtpFromAddress: 'nav@example.test' },
    transportFactory: async () => ({
      async sendMail(message) { recipients.push(message.to); return { accepted: [message.to], rejected: [] } },
      close() {}
    })
  })
  assert.deepEqual(recipients, ['system@example.test'])
  assert.equal(summary.sent, 1)
  assert.equal(summary.remaining, 0)
  const { rows } = await pool.query('SELECT id,status FROM mail_outbox WHERE id=ANY($1::uuid[])', [[systemId, digestId, queued.outboxId]])
  const states = new Map(rows.map((row) => [row.id, row.status]))
  assert.equal(states.get(systemId), 'sent')
  assert.equal(states.get(digestId), 'pending')
  assert.equal(states.get(queued.outboxId), 'pending')
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
  }, { poolInstance: pool, assertDeliveryReadyFn: assertIntegrationDeliveryReady })
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
      emailSourceKey: 'integration-mail',
      emailOwnerUsername: 'mail-owner',
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
