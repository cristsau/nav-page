import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  decryptEmailSentMimeWithKey,
  encryptEmailSentMimeWithKey
} from '../src/lib/emailSentMimeCrypto.js'
import {
  buildSmtpEnvelope,
  deriveSentMessageIdentity,
  freezeOutgoingMime,
  getOrCreateFrozenSentAppend
} from '../src/lib/emailSentMessage.js'
import {
  processEmailSentAppendJob,
  selectUniqueSentMailbox
} from '../src/lib/emailSentAppend.js'
import {
  classifySmtpRecipientOutcome,
  deliverMailOutbox,
  enqueueUserMail,
  isDefinitiveSmtpRejection,
  SMTP_DELIVERY_ERROR_CODES
} from '../src/lib/mailOutbox.js'
import { hashUserMailPayload } from '../src/lib/emailUserMail.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'
const OUTBOX_ID = '33333333-3333-4333-8333-333333333333'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'

const runtimeConfig = {
  smtpFromAddress: 'sender@example.test',
  smtpFromName: 'DOMO NAV'
}

const payload = {
  to: ['to@example.test'],
  cc: ['cc@example.test'],
  bcc: ['secret-bcc@example.test'],
  subject: 'Frozen message',
  text: 'Body text',
  inReplyTo: '',
  references: []
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('frozen RFC822 uses stable identity, CRLF and an envelope-only Bcc recipient', async () => {
  assert.deepEqual(
    deriveSentMessageIdentity(OUTBOX_ID),
    deriveSentMessageIdentity(OUTBOX_ID)
  )
  assert.deepEqual(buildSmtpEnvelope(payload, runtimeConfig), {
    from: 'sender@example.test',
    to: ['to@example.test', 'cc@example.test', 'secret-bcc@example.test']
  })

  const attachment = Buffer.from('attachment secret')
  const frozen = await freezeOutgoingMime({
    outboxId: OUTBOX_ID,
    payload,
    attachments: [{
      filename: 'report.txt',
      contentType: 'text/plain',
      content: attachment
    }],
    date: '2026-08-27T09:30:00.000Z',
    runtimeConfig
  })
  try {
    const raw = frozen.mime.toString('utf8')
    assert.equal(/(^|[^\r])\n/.test(raw), false, 'RFC822 must use CRLF line endings')
    assert.match(raw, new RegExp(`Message-ID: ${frozen.messageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'))
    assert.match(raw, new RegExp(`X-DOMO-NAV-Id: ${frozen.navId}`, 'i'))
    assert.doesNotMatch(raw, /^Bcc:/im)
    assert.doesNotMatch(raw, /secret-bcc@example\.test/i)
    assert.match(raw, /report\.txt/i)
    assert.deepEqual(frozen.envelope.to, [
      'to@example.test',
      'cc@example.test',
      'secret-bcc@example.test'
    ])
  } finally {
    frozen.mime.fill(0)
    attachment.fill(0)
  }
})

test('one encrypted RFC822 source is frozen once and reused for SMTP/Sent', async () => {
  const key = Buffer.alloc(32, 7)
  const authoritativeRaw = Buffer.from(
    'From: sender@example.test\r\nTo: to@example.test\r\nMessage-ID: <stable@example.test>\r\n\r\nBody\r\n'
  )
  let stored = null
  let freezeCount = 0
  const client = {
    async query(sql, values = []) {
      if (/SELECT \* FROM email_sent_append_jobs WHERE outbox_id/.test(sql)) {
        return { rowCount: stored ? 1 : 0, rows: stored ? [{ ...stored, mime_encrypted: Buffer.from(stored.mime_encrypted) }] : [] }
      }
      if (/INSERT INTO email_sent_append_jobs/.test(sql)) {
        stored = {
          id: '55555555-5555-4555-8555-555555555555',
          outbox_id: values[0],
          user_id: values[1],
          account_id: values[2],
          status: 'prepared',
          message_id: values[3],
          nav_id: values[4],
          mime_encrypted: Buffer.from(values[5]),
          mime_sha256: values[6],
          mime_size_bytes: values[7]
        }
        return { rowCount: 1, rows: [{ ...stored, mime_encrypted: Buffer.from(stored.mime_encrypted) }] }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    }
  }
  const freezeMimeFn = async () => {
    freezeCount += 1
    return {
      ...deriveSentMessageIdentity(OUTBOX_ID),
      envelope: buildSmtpEnvelope(payload, runtimeConfig),
      mime: Buffer.from(authoritativeRaw),
      mimeSha256: sha256(authoritativeRaw),
      mimeSizeBytes: authoritativeRaw.length
    }
  }
  const encryptMimeFn = async (raw, context) => encryptEmailSentMimeWithKey(raw, key, context)
  const decryptMimeFn = async (encrypted, context, options) => decryptEmailSentMimeWithKey(
    encrypted,
    key,
    context,
    { expectedBytes: options.expectedBytes }
  )
  const message = {
    id: OUTBOX_ID,
    user_id: USER_ID,
    account_id: ACCOUNT_ID,
    confirmed_at: '2026-08-27T09:30:00.000Z'
  }

  const first = await getOrCreateFrozenSentAppend({
    client,
    message,
    payload,
    runtimeConfig,
    freezeMimeFn,
    encryptMimeFn,
    decryptMimeFn
  })
  const second = await getOrCreateFrozenSentAppend({
    client,
    message,
    payload,
    runtimeConfig,
    freezeMimeFn,
    encryptMimeFn,
    decryptMimeFn
  })
  try {
    assert.equal(freezeCount, 1)
    assert.deepEqual(first.mime, authoritativeRaw)
    assert.deepEqual(second.mime, authoritativeRaw)
    assert.equal(first.job.message_id, second.job.message_id)
    assert.equal(first.job.nav_id, second.job.nav_id)
  } finally {
    first.mime.fill(0)
    second.mime.fill(0)
    authoritativeRaw.fill(0)
    key.fill(0)
    stored?.mime_encrypted?.fill(0)
  }
})

test('sent MIME encryption authenticates both owner and outbox identity', () => {
  const key = Buffer.alloc(32, 3)
  const raw = Buffer.from('Subject: encrypted\r\n\r\nBody\r\n')
  const encrypted = encryptEmailSentMimeWithKey(raw, key, {
    userId: USER_ID,
    outboxId: OUTBOX_ID
  })
  const decrypted = decryptEmailSentMimeWithKey(encrypted, key, {
    userId: USER_ID,
    outboxId: OUTBOX_ID
  }, { expectedBytes: raw.length })
  assert.deepEqual(decrypted, raw)
  assert.throws(() => decryptEmailSentMimeWithKey(encrypted, key, {
    userId: USER_ID,
    outboxId: '66666666-6666-4666-8666-666666666666'
  }))
  decrypted.fill(0)
  encrypted.fill(0)
  raw.fill(0)
  key.fill(0)
})

function sentJob(overrides = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    user_id: USER_ID,
    outbox_id: OUTBOX_ID,
    status: 'pending',
    append_attempted: false,
    message_id: '<stable@example.test>',
    nav_id: 'a'.repeat(24),
    mime_encrypted: Buffer.from('encrypted'),
    mime_size_bytes: 10,
    smtp_accepted_at: '2026-08-27T09:30:00.000Z',
    ...overrides
  }
}

function appendHarness({ appendResult = { uid: 42, uidValidity: 9 }, appendError = null } = {}) {
  const queries = []
  let appendCalls = 0
  const dbClient = {
    async query(sql, values = []) {
      queries.push({ sql, values })
      if (/SET status = 'appending'/.test(sql)) return { rowCount: 1, rows: [{ id: values[0] }] }
      return { rowCount: 1, rows: [] }
    }
  }
  const imap = {
    async search() { return [] },
    async append() {
      appendCalls += 1
      if (appendError) throw appendError
      return appendResult
    }
  }
  return { dbClient, imap, queries, appendCalls: () => appendCalls }
}

const sentPolicy = {
  reconcileDelaySeconds: 60,
  blockedDelaySeconds: 900
}
const sentFolder = { path: 'Sent', delimiter: '/', subscribed: true }

test('pending Sent job searches first and performs one APPEND before finalization', async () => {
  const harness = appendHarness()
  const finalized = []
  const outcome = await processEmailSentAppendJob({
    dbClient: harness.dbClient,
    imap: harness.imap,
    job: sentJob(),
    folder: sentFolder,
    uidValidity: 9,
    policy: sentPolicy,
    runtimeConfig: {},
    decryptMimeFn: async () => Buffer.from('raw source'),
    parseMimeFn: async () => ({}),
    persistFn: async () => {},
    poolInstance: {},
    cacheFn: async () => {},
    finalizeFn: async (value) => { finalized.push(value) }
  })
  assert.equal(outcome, 'appended')
  assert.equal(harness.appendCalls(), 1)
  assert.equal(finalized.length, 1)
  assert.equal(finalized[0].uid, 42)
  assert.equal(harness.queries.filter(({ sql }) => /append_attempted = TRUE/.test(sql)).length, 1)
})

test('an uncertain APPEND moves to reconcile and never performs a second APPEND', async () => {
  const harness = appendHarness({ appendError: new Error('connection ended after APPEND') })
  const first = await processEmailSentAppendJob({
    dbClient: harness.dbClient,
    imap: harness.imap,
    job: sentJob(),
    folder: sentFolder,
    uidValidity: 9,
    policy: sentPolicy,
    runtimeConfig: {},
    decryptMimeFn: async () => Buffer.from('raw source'),
    parseMimeFn: async () => ({}),
    persistFn: async () => {},
    poolInstance: {},
    cacheFn: async () => {},
    finalizeFn: async () => {}
  })
  const second = await processEmailSentAppendJob({
    dbClient: harness.dbClient,
    imap: harness.imap,
    job: sentJob({ status: 'reconcile', append_attempted: true }),
    folder: sentFolder,
    uidValidity: 9,
    policy: sentPolicy,
    runtimeConfig: {},
    decryptMimeFn: async () => { throw new Error('reconcile must not need plaintext when no match') },
    parseMimeFn: async () => ({}),
    persistFn: async () => {},
    poolInstance: {},
    cacheFn: async () => {},
    finalizeFn: async () => {}
  })
  assert.equal(first, 'reconcile')
  assert.equal(second, 'reconcile')
  assert.equal(harness.appendCalls(), 1)
  assert.ok(harness.queries.some(({ sql }) => /SENT_APPEND_UNCONFIRMED/.test(sql)))
})

test('Sent mailbox selection requires one explicit or SPECIAL-USE mailbox', () => {
  const folders = [
    { path: 'INBOX', flags: new Set(), specialUse: null },
    { path: 'Sent Items', flags: new Set(['\\Sent']), specialUse: '\\Sent' }
  ]
  assert.equal(selectUniqueSentMailbox(folders).path, 'Sent Items')
  assert.equal(selectUniqueSentMailbox(folders, 'Sent Items').path, 'Sent Items')
  assert.throws(() => selectUniqueSentMailbox(folders, 'Sent'), /not found uniquely/i)
})

test('user-mail enqueue binds the normalized attachment manifest into the confirmed hash', async () => {
  const manifest = [{
    id: '77777777-7777-4777-8777-777777777777',
    sha256: 'b'.repeat(64),
    metadataDigest: 'c'.repeat(64),
    size: 12,
    ordinal: 0
  }]
  const encrypted = Buffer.from('encrypted payload')
  let values
  const result = await enqueueUserMail({
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    draftId: DRAFT_ID,
    payload,
    attachmentManifest: manifest,
    expectedContentHash: hashUserMailPayload(payload, manifest),
    outboxId: OUTBOX_ID,
    encryptPayloadFn: async () => encrypted,
    queryFn: async (_sql, suppliedValues) => {
      values = suppliedValues
      return { rows: [{ id: OUTBOX_ID, status: 'pending' }] }
    }
  })
  assert.equal(result.id, OUTBOX_ID)
  assert.equal(values[6], hashUserMailPayload(payload, manifest))
  await assert.rejects(enqueueUserMail({
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    draftId: DRAFT_ID,
    payload,
    attachmentManifest: [{ ...manifest[0], sha256: 'd'.repeat(64) }],
    expectedContentHash: hashUserMailPayload(payload, manifest),
    outboxId: OUTBOX_ID,
    encryptPayloadFn: async () => encrypted,
    queryFn: async () => { throw new Error('must not reach database') }
  }), /draft changed/i)
})

function outboxClient(handler) {
  const queries = []
  return {
    queries,
    async query(sql, values = []) {
      queries.push({ sql, values })
      return handler(sql, values)
    },
    release() {}
  }
}

test('startup expiration transaction scrubs prepared Sent MIME and claimed attachment storage', async () => {
  const staleId = '88888888-8888-4888-8888-888888888888'
  const maxId = '99999999-9999-4999-8999-999999999999'
  const client = outboxClient(async (sql) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
    if (/WHERE status = 'sending' AND updated_at/.test(sql)) {
      return { rowCount: 1, rows: [{ id: staleId, user_id: USER_ID }] }
    }
    if (/WHERE status IN \('pending', 'failed'\) AND attempt_count >=/.test(sql)) {
      return { rowCount: 1, rows: [{ id: maxId, user_id: USER_ID }] }
    }
    if (/SELECT \* FROM mail_outbox/.test(sql)) return { rowCount: 0, rows: [] }
    if (/SELECT COUNT\(\*\)::integer AS count FROM mail_outbox/.test(sql)) {
      return { rows: [{ count: 0 }] }
    }
    if (/pg_advisory_unlock/.test(sql)) return { rows: [{ released: true }] }
    return { rowCount: 1, rows: [] }
  })
  const summary = await deliverMailOutbox({
    poolInstance: { async connect() { return client } },
    policy: { maxAttempts: 3, batchSize: 5, intervalSeconds: 30 },
    runtimeConfig: {},
    transportFactory: async () => { throw new Error('transport must not be created') }
  })
  assert.equal(summary.expired, 2)
  assert.equal(client.queries.filter(({ sql }) => sql === 'BEGIN').length, 2)
  assert.equal(client.queries.filter(({ sql }) => sql === 'COMMIT').length, 2)
  assert.equal(client.queries.filter(({ sql }) => /UPDATE email_sent_append_jobs/.test(sql)).length, 2)
  assert.equal(client.queries.filter(({ sql }) => /DELETE FROM email_attachment_chunks/.test(sql)).length, 2)
  assert.equal(client.queries.filter(({ sql }) => /UPDATE email_attachment_objects/.test(sql)).length, 2)
})

test('last pre-SMTP failure expires and scrubs all retained artifacts atomically', async () => {
  const message = {
    id: OUTBOX_ID,
    user_id: USER_ID,
    account_id: ACCOUNT_ID,
    message_type: 'user.mail',
    status: 'pending',
    attempt_count: 2,
    payload_encrypted: null
  }
  const client = outboxClient(async (sql) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
    if (/WHERE status = 'sending' AND updated_at/.test(sql)) return { rowCount: 0, rows: [] }
    if (/WHERE status IN \('pending', 'failed'\) AND attempt_count >=/.test(sql)) return { rowCount: 0, rows: [] }
    if (/SELECT \* FROM mail_outbox/.test(sql)) return { rowCount: 1, rows: [message] }
    if (/SET status = 'sending'/.test(sql)) return { rowCount: 1, rows: [{ id: OUTBOX_ID }] }
    if (/SET status = 'expired', attempt_count/.test(sql)) {
      return { rowCount: 1, rows: [{ id: OUTBOX_ID, user_id: USER_ID }] }
    }
    if (/SELECT COUNT\(\*\)::integer AS count FROM mail_outbox/.test(sql)) return { rows: [{ count: 0 }] }
    if (/pg_advisory_unlock/.test(sql)) return { rows: [{ released: true }] }
    return { rowCount: 1, rows: [] }
  })
  const transport = { async sendMail() { throw new Error('must not send') }, close() {} }
  const summary = await deliverMailOutbox({
    poolInstance: { async connect() { return client } },
    policy: { maxAttempts: 3, batchSize: 5, intervalSeconds: 30 },
    runtimeConfig: {},
    transportFactory: async () => transport
  })
  assert.equal(summary.failed, 1)
  assert.equal(summary.expired, 1)
  assert.equal(client.queries.filter(({ sql }) => /UPDATE email_sent_append_jobs/.test(sql)).length, 1)
  assert.equal(client.queries.filter(({ sql }) => /DELETE FROM email_attachment_chunks/.test(sql)).length, 1)
  assert.equal(client.queries.filter(({ sql }) => /UPDATE email_attachment_objects/.test(sql)).length, 1)
})

test('a rejected sendMail promise becomes ambiguous and is never returned to retry', async () => {
  const message = {
    id: OUTBOX_ID,
    user_id: null,
    message_type: 'registration.approved',
    status: 'pending',
    attempt_count: 0,
    recipient: 'recipient@example.test',
    subject: 'Approved',
    text_body: 'Body',
    html_body: '',
    sensitive: true
  }
  const client = outboxClient(async (sql) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
    if (/WHERE status = 'sending' AND updated_at/.test(sql)) return { rowCount: 0, rows: [] }
    if (/WHERE status IN \('pending', 'failed'\) AND attempt_count >=/.test(sql)) return { rowCount: 0, rows: [] }
    if (/SELECT \* FROM mail_outbox/.test(sql)) return { rowCount: 1, rows: [message] }
    if (/SET status = 'sending'/.test(sql)) return { rowCount: 1, rows: [{ id: OUTBOX_ID }] }
    if (/SET status = 'expired', attempt_count = attempt_count \+ 1/.test(sql)) return { rowCount: 1, rows: [] }
    if (/SELECT COUNT\(\*\)::integer AS count FROM mail_outbox/.test(sql)) return { rows: [{ count: 0 }] }
    if (/pg_advisory_unlock/.test(sql)) return { rows: [{ released: true }] }
    return { rowCount: 1, rows: [] }
  })
  let sendCalls = 0
  const transport = {
    async sendMail() {
      sendCalls += 1
      throw new Error('socket closed after DATA')
    },
    close() {}
  }
  const summary = await deliverMailOutbox({
    poolInstance: { async connect() { return client } },
    policy: { maxAttempts: 3, batchSize: 5, intervalSeconds: 30 },
    runtimeConfig: {
      smtpFromAddress: 'sender@example.test',
      smtpFromName: 'DOMO NAV'
    },
    transportFactory: async () => transport
  })
  assert.equal(sendCalls, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.expired, 1)
  const ambiguousUpdate = client.queries.find(({ sql }) => /AMBIGUOUS_DELIVERY_STATE/.test(sql))
  assert.ok(ambiguousUpdate)
  assert.equal(client.queries.some(({ sql }) => (
    /UPDATE mail_outbox/.test(sql) && /SET status = 'failed'/.test(sql)
  )), false)
})

test('an empty resolved SMTP result is ambiguous and is never reported as sent', async () => {
  const message = {
    id: OUTBOX_ID,
    user_id: null,
    message_type: 'registration.approved',
    status: 'pending',
    attempt_count: 0,
    recipient: 'recipient@example.test',
    subject: 'Approved',
    text_body: 'Body',
    html_body: '',
    sensitive: true
  }
  const client = outboxClient(async (sql) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
    if (/WHERE status = 'sending' AND updated_at/.test(sql)) return { rowCount: 0, rows: [] }
    if (/WHERE status IN \('pending', 'failed'\) AND attempt_count >=/.test(sql)) return { rowCount: 0, rows: [] }
    if (/SELECT \* FROM mail_outbox/.test(sql)) return { rowCount: 1, rows: [message] }
    if (/SET status = 'sending'/.test(sql)) return { rowCount: 1, rows: [{ id: OUTBOX_ID }] }
    if (/SET status = 'expired', attempt_count = attempt_count \+ 1/.test(sql)) return { rowCount: 1, rows: [] }
    if (/SELECT COUNT\(\*\)::integer AS count FROM mail_outbox/.test(sql)) return { rows: [{ count: 0 }] }
    if (/pg_advisory_unlock/.test(sql)) return { rows: [{ released: true }] }
    return { rowCount: 1, rows: [] }
  })
  let sendCalls = 0
  const transport = {
    async sendMail() {
      sendCalls += 1
      return { accepted: [], rejected: [] }
    },
    close() {}
  }
  const summary = await deliverMailOutbox({
    poolInstance: { async connect() { return client } },
    policy: { maxAttempts: 3, batchSize: 5, intervalSeconds: 30 },
    runtimeConfig: {
      smtpFromAddress: 'sender@example.test',
      smtpFromName: 'DOMO NAV'
    },
    transportFactory: async () => transport
  })
  assert.equal(sendCalls, 1)
  assert.equal(summary.sent, 0)
  assert.equal(summary.failed, 1)
  assert.equal(summary.expired, 1)
  const ambiguousUpdate = client.queries.find(({ sql }) => /AMBIGUOUS_DELIVERY_STATE/.test(sql))
  assert.ok(ambiguousUpdate)
  assert.equal(client.queries.some(({ sql }) => (
    /UPDATE mail_outbox/.test(sql) && /SET status = 'failed'/.test(sql)
  )), false)
})

test('a partially accepted SMTP result becomes terminal manual review without whole-message retry', async () => {
  const message = {
    id: OUTBOX_ID,
    user_id: null,
    message_type: 'registration.approved',
    status: 'pending',
    attempt_count: 0,
    recipient: 'recipient@example.test',
    subject: 'Approved',
    text_body: 'Body',
    html_body: '',
    sensitive: true
  }
  const client = outboxClient(async (sql) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
    if (/WHERE status = 'sending' AND updated_at/.test(sql)) return { rowCount: 0, rows: [] }
    if (/WHERE status IN \('pending', 'failed'\) AND attempt_count >=/.test(sql)) return { rowCount: 0, rows: [] }
    if (/SELECT \* FROM mail_outbox/.test(sql)) return { rowCount: 1, rows: [message] }
    if (/SET status = 'sending'/.test(sql)) return { rowCount: 1, rows: [{ id: OUTBOX_ID }] }
    if (/PARTIAL_RECIPIENT_REJECTION/.test(sql) || /last_error_code = \$2/.test(sql)) {
      return { rowCount: 1, rows: [{ id: OUTBOX_ID }] }
    }
    if (/SELECT COUNT\(\*\)::integer AS count FROM mail_outbox/.test(sql)) return { rows: [{ count: 0 }] }
    if (/pg_advisory_unlock/.test(sql)) return { rows: [{ released: true }] }
    return { rowCount: 1, rows: [] }
  })
  let sendCalls = 0
  const transport = {
    async sendMail() {
      sendCalls += 1
      return {
        accepted: ['accepted@example.test'],
        rejected: ['rejected@example.test']
      }
    },
    close() {}
  }
  const summary = await deliverMailOutbox({
    poolInstance: { async connect() { return client } },
    policy: { maxAttempts: 3, batchSize: 5, intervalSeconds: 30 },
    runtimeConfig: {
      smtpFromAddress: 'sender@example.test',
      smtpFromName: 'DOMO NAV'
    },
    transportFactory: async () => transport
  })
  assert.equal(sendCalls, 1)
  assert.equal(summary.sent, 0)
  assert.equal(summary.failed, 1)
  assert.equal(summary.expired, 1)
  const partialUpdate = client.queries.find(({ sql, values }) => (
    /UPDATE mail_outbox/.test(sql)
    && values.includes(SMTP_DELIVERY_ERROR_CODES.partial)
  ))
  assert.ok(partialUpdate)
  assert.match(partialUpdate.sql, /payload_encrypted = NULL/)
  assert.equal(client.queries.some(({ sql }) => (
    /UPDATE mail_outbox/.test(sql) && /SET status = 'failed'/.test(sql)
  )), false)
})

test('SMTP recipient result classification never exposes recipient values', () => {
  assert.deepEqual(
    classifySmtpRecipientOutcome({
      accepted: ['accepted@example.test'],
      rejected: ['rejected@example.test']
    }),
    { status: 'partial', acceptedCount: 1, rejectedCount: 1 }
  )
  assert.deepEqual(
    classifySmtpRecipientOutcome({ accepted: [], rejected: ['rejected@example.test'] }),
    { status: 'rejected', acceptedCount: 0, rejectedCount: 1 }
  )
  assert.deepEqual(
    classifySmtpRecipientOutcome({ accepted: [], rejected: [] }),
    { status: 'ambiguous', acceptedCount: 0, rejectedCount: 0 }
  )
  assert.deepEqual(
    classifySmtpRecipientOutcome({}),
    { status: 'ambiguous', acceptedCount: 0, rejectedCount: 0 }
  )
})

test('only explicit SMTP/auth rejections are eligible for the normal retry state', () => {
  assert.equal(isDefinitiveSmtpRejection({ responseCode: 450, command: 'RCPT TO' }), true)
  assert.equal(isDefinitiveSmtpRejection({ responseCode: 550, command: 'DATA' }), true)
  assert.equal(isDefinitiveSmtpRejection({ code: 'EAUTH', command: 'AUTH' }), true)
  assert.equal(isDefinitiveSmtpRejection({ code: 'SMTP_ALL_RECIPIENTS_REJECTED', command: 'RCPT TO' }), true)
  assert.equal(isDefinitiveSmtpRejection({ code: 'ETIMEDOUT', command: 'DATA' }), false)
  assert.equal(isDefinitiveSmtpRejection({ code: 'ECONNECTION' }), false)
})
