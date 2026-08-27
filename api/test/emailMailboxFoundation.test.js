import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildCanonicalMailboxMessage } from '../src/lib/emailMailboxStore.js'

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

test('canonical mailbox identity is stable, source-derived and attachment-content free', () => {
  const first = buildCanonicalMailboxMessage({
    messageId: '<same@example.test>',
    rawHash: 'a'.repeat(64),
    sender: { name: 'Sender', address: 'sender@example.test' },
    subject: 'Hello',
    receivedAt: '2026-08-26T10:00:00.000Z',
    size: 123,
    attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 42, content: 'SECRET' }]
  })
  const replay = buildCanonicalMailboxMessage({
    messageId: '<same@example.test>',
    rawHash: 'a'.repeat(64),
    sender: { name: 'Sender', address: 'sender@example.test' },
    subject: 'Hello',
    receivedAt: '2026-08-26T10:00:00.000Z',
    size: 123,
    attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 42, content: 'CHANGED' }]
  })
  const differentRaw = buildCanonicalMailboxMessage({
    messageId: '<same@example.test>',
    rawHash: 'b'.repeat(64),
    sender: { address: 'sender@example.test' },
    subject: 'Hello',
    receivedAt: '2026-08-26T10:00:00.000Z',
    size: 123
  })

  assert.equal(first.canonicalHash, replay.canonicalHash)
  assert.notEqual(first.canonicalHash, differentRaw.canonicalHash)
  assert.equal(first.attachmentCount, 1)
  assert.equal('content' in first.content.attachments[0], false)
  assert.match(first.content.attachments[0].id, /^[0-9a-f]{32}$/)
  assert.equal(first.content.attachments[0].ordinal, 0)
  assert.doesNotMatch(JSON.stringify(first), /SECRET|CHANGED/)
})

test('mailbox normalization preserves plain-text line breaks and rejects unsafe numeric fallbacks', async () => {
  const canonical = buildCanonicalMailboxMessage({
    receivedAt: '2026-08-26T10:00:00.000Z',
    text: 'first line\r\nsecond\tline\u0000',
    size: Number.NaN,
    attachments: [{ size: Number.POSITIVE_INFINITY }]
  })

  assert.equal(canonical.content.text, 'first line\nsecond\tline')
  assert.equal(canonical.sizeBytes, 0)
  assert.equal(canonical.content.attachments[0].size, 0)

  const store = await source('../src/lib/emailMailboxStore.js')
  assert.match(store, /IMAP message UID/)
  assert.match(store, /UINT32_MAX/)
  assert.match(store, /UINT64_MAX/)
})

test('mailbox storage encrypts message fields and uses remote UID identity', async () => {
  const [store, migration, ingest] = await Promise.all([
    source('../src/lib/emailMailboxStore.js'),
    source('../src/db/migrations/035_email_mailbox_foundation.sql'),
    source('../src/lib/emailIngestScheduler.js')
  ])

  assert.match(store, /envelope_encrypted/)
  assert.match(store, /content_encrypted/)
  assert.doesNotMatch(migration, /\n\s*(?:subject|body|sender_address)\s+(?:TEXT|VARCHAR)/i)
  assert.match(migration, /UNIQUE \(folder_id, uid_validity, uid\)/)
  assert.match(store, /EXCLUDED\.modseq >= email_folder_messages\.modseq/)
  assert.match(store, /uid_validity <> \$3::bigint/)
  assert.match(ingest, /90 \* 24 \* 60 \* 60 \* 1000/)
  assert.match(ingest, /slice\(-validated\.initialLookback\)/)
  assert.match(ingest, /persistEmailMailboxMessage/)
  assert.match(ingest, /emailMessageId: stored\.message\.id/)
  assert.match(ingest, /await assertHostImpl\(runtimeConfig\.imapHost/)

  const persistBody = store.slice(
    store.indexOf('export async function persistEmailMailboxMessage'),
    store.indexOf('export async function decryptStoredMailboxMessage')
  )
  assert.doesNotMatch(persistBody, /UPDATE email_folders SET\s+last_uid/i)
  const classifyAt = ingest.indexOf('const result = await processFn')
  const advanceAt = ingest.indexOf('await writeMailboxState({ uid })', classifyAt)
  assert.ok(classifyAt > 0 && advanceAt > classifyAt, 'cursor advancement must follow classification')
})

test('mailbox REST uses user isolation, keyset pagination and metadata-only SSE', async () => {
  const route = await source('../src/routes/email.js')

  assert.match(route, /\/email\/accounts/)
  assert.match(route, /\/email\/accounts\/:accountId\/folders/)
  assert.match(route, /\/email\/accounts\/:accountId\/messages/)
  assert.match(route, /\/email\/accounts\/:accountId\/messages\/:locationId/)
  assert.match(route, /\/attachments\/:attachmentId/)
  assert.match(route, /fetchIncomingAttachment/)
  assert.match(route, /X-Content-Type-Options', 'nosniff'/)
  assert.match(route, /Content-Security-Policy', 'sandbox'/)
  assert.match(route, /addContentTypeParser\([\s\S]*'application\/octet-stream'/)
  assert.match(route, /\/email\/drafts\/:draftId\/attachments/)
  assert.match(route, /createDraftEmailAttachment/)
  assert.match(route, /deleteDraftEmailAttachment/)
  assert.match(route, /refreshEmailDraftContentHash/)
  assert.match(route, /id: row\.location_id/)
  assert.match(route, /canonicalMessageId: row\.message_id/)
  const unavailableSubjectAt = route.indexOf(
    "subject: '邮件内容暂时无法解密'",
    route.indexOf("fastify.get('/email/accounts/:accountId/messages'")
  )
  const unavailableFallbackStart = route.lastIndexOf('message: {', unavailableSubjectAt)
  const unavailableFallbackEnd = route.indexOf('receivedAt: row.received_at', unavailableSubjectAt)
  assert.ok(unavailableSubjectAt >= 0 && unavailableFallbackStart >= 0 && unavailableFallbackEnd > unavailableSubjectAt)
  const unavailableFallback = route.slice(
    unavailableFallbackStart,
    unavailableFallbackEnd
  )
  assert.match(unavailableFallback, /id: row\.location_id/)
  assert.match(unavailableFallback, /canonicalMessageId: row\.message_id/)
  assert.match(route, /WHERE location\.id = \$1/)
  assert.match(route, /folder\.selectable = TRUE/)
  assert.match(route, /folder\.last_synced_at IS NOT NULL/)
  assert.match(route, /location\.user_id = \$3/)
  assert.match(route, /\(location\.internal_date, location\.id\) < /)
  assert.doesNotMatch(route, /\bOFFSET\b/i)
  assert.match(route, /\/email\/stream/)
  assert.match(route, /createEmailMailboxEventBroker/)
  assert.match(route, /EMAIL_STREAM_MAX_LIFETIME_MS/)
  assert.match(route, /createEmailSseConnectionLimiter\(\{ maxConnections: 3 \}\)/)
  const streamRoute = route.slice(
    route.indexOf("fastify.get('/email/stream'"),
    route.indexOf("fastify.get('/admin/mail/status'")
  )
  assert.doesNotMatch(streamRoute, /pool\.connect\(/)
  assert.match(streamRoute, /reply\.code\(429\)/)
  assert.match(streamRoute, /Retry-After/)
  assert.match(streamRoute, /releaseStreamSlot\(\)/)
  assert.match(route, /String\(payload\.userId\) !== String\(request\.currentUser\.id\)/)
  const streamPayload = route.match(/writeEmailSse\(reply\.raw, 'mail\.changed',[\s\S]*?\n\s*\},/)?.[0] || ''
  assert.ok(streamPayload)
  assert.doesNotMatch(streamPayload, /subject|body|sender|recipient|preview/i)
})
