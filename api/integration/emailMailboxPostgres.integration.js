import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'
import { simpleParser } from 'mailparser'

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
let temporaryDirectory

before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-email-mailbox-'))
  const keyPath = path.join(temporaryDirectory, 'email-encryption-key')
  await fs.writeFile(keyPath, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600 })
  process.env.NAV_EMAIL_ENCRYPTION_KEY_FILE = keyPath
  ;({ pool } = await import('../src/db/index.js'))
  ;({ persistEmailMailboxMessage, decryptStoredMailboxMessage } = await import('../src/lib/emailMailboxStore.js'))
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
  ;({ processInboundEmail } = await import('../src/lib/emailEvents.js'))
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
    }, { poolInstance: pool })
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
