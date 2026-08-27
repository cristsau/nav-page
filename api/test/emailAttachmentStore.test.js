import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  EMAIL_ATTACHMENT_CHUNK_BYTES,
  encryptEmailAttachmentChunkWithKey
} from '../src/lib/emailAttachmentCrypto.js'
import {
  EMAIL_ATTACHMENT_LIMITS,
  buildEmailAttachmentManifest,
  claimDraftEmailAttachments,
  createDraftEmailAttachment,
  disposeLoadedEmailAttachments,
  loadOutboxEmailAttachments,
  normalizeEmailAttachmentMetadata,
  scrubOutboxEmailAttachments
} from '../src/lib/emailAttachmentStore.js'
import { encryptEmailPayloadWithKey } from '../src/lib/emailCrypto.js'

const userId = '550e8400-e29b-41d4-a716-446655440000'
const draftId = '550e8400-e29b-41d4-a716-446655440001'
const outboxId = '550e8400-e29b-41d4-a716-446655440002'
const attachmentId = '550e8400-e29b-41d4-a716-446655440003'

function metadataContext() {
  return `attachment-metadata:${userId}:${attachmentId}`
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('email attachment metadata is canonical and manifests are stable and ordered', () => {
  assert.deepEqual(normalizeEmailAttachmentMetadata({
    filename: '..\\folder\\ report.pdf ',
    contentType: ' Application/PDF ',
    disposition: 'ATTACHMENT',
    contentId: '<report@example.test>'
  }), {
    filename: 'report.pdf',
    contentType: 'application/pdf',
    disposition: 'attachment',
    contentId: 'report@example.test'
  })
  assert.throws(
    () => normalizeEmailAttachmentMetadata({ filename: '..', contentType: 'text/plain' }),
    /filename is invalid/i
  )

  const rows = [1, 0].map((ordinal) => ({
    id: ordinal ? randomUUID() : attachmentId,
    sha256: String(ordinal).repeat(64),
    size_bytes: ordinal + 1,
    ordinal,
    metadata_digest: String(9 - ordinal).repeat(64)
  }))
  assert.deepEqual(buildEmailAttachmentManifest(rows).map((item) => item.ordinal), [0, 1])
})

test('draft attachment upload encrypts 256 KiB chunks and leaves caller bytes unchanged', async () => {
  const key = randomBytes(32)
  const original = randomBytes(EMAIL_ATTACHMENT_CHUNK_BYTES + 17)
  const originalCopy = Buffer.from(original)
  const statements = []
  const insertedChunks = []
  const client = {
    async query(sql, params = []) {
      statements.push(sql)
      if (/SELECT id FROM email_drafts/.test(sql)) return { rowCount: 1, rows: [{ id: draftId }] }
      if (/SELECT ordinal, size_bytes/.test(sql)) return { rowCount: 0, rows: [] }
      if (/COALESCE\(SUM\(size_bytes\)/.test(sql)) return { rowCount: 1, rows: [{ total_bytes: '0' }] }
      if (/INSERT INTO email_attachment_objects/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{
            id: params[0],
            user_id: params[1],
            draft_id: params[2],
            ordinal: params[3],
            sha256: params[4],
            size_bytes: params[5],
            chunk_count: params[6],
            metadata_encrypted: params[7],
            metadata_digest: params[8],
            created_at: new Date('2026-08-27T00:00:00.000Z')
          }]
        }
      }
      if (/INSERT INTO email_attachment_chunks/.test(sql)) insertedChunks.push(params)
      return { rowCount: 0, rows: [] }
    },
    release() {}
  }

  const created = await createDraftEmailAttachment({
    userId,
    draftId,
    metadata: { filename: 'report.bin', contentType: 'application/octet-stream' },
    content: original
  }, {
    poolInstance: { async connect() { return client } },
    keyLoader: async () => key,
    attachmentId
  })

  assert.deepEqual(original, originalCopy)
  assert.equal(created.id, attachmentId)
  assert.equal(created.size, original.length)
  assert.equal(created.ordinal, 0)
  assert.equal(insertedChunks.length, 2)
  assert.equal(insertedChunks[0][3], EMAIL_ATTACHMENT_CHUNK_BYTES)
  assert.equal(insertedChunks[0][4].length, EMAIL_ATTACHMENT_CHUNK_BYTES + 29)
  assert.equal(insertedChunks[1][3], 17)
  assert.match(created.sha256, /^[0-9a-f]{64}$/)
  assert.ok(statements.includes('BEGIN'))
  assert.ok(statements.includes('COMMIT'))
})

test('draft attachment claim is ownership-bound and returns an ordered manifest', async () => {
  const row = (ordinal) => ({
    id: ordinal ? randomUUID() : attachmentId,
    sha256: String(ordinal).repeat(64),
    size_bytes: ordinal + 1,
    ordinal,
    metadata_digest: String(9 - ordinal).repeat(64)
  })
  let call = 0
  const queryFn = async () => {
    call += 1
    if (call === 1) return { rowCount: 1, rows: [{ id: draftId }] }
    if (call === 2) return { rowCount: 0, rows: [] }
    return { rowCount: 2, rows: [row(1), row(0)] }
  }

  const manifest = await claimDraftEmailAttachments({ userId, draftId, outboxId }, { queryFn })
  assert.deepEqual(manifest.map((item) => item.ordinal), [0, 1])
  assert.equal(call, 3)
})

test('claimed attachment decrypts to Nodemailer buffers and can be zeroed after delivery', async () => {
  const key = randomBytes(32)
  const content = Buffer.from('confidential attachment body')
  const metadata = normalizeEmailAttachmentMetadata({
    filename: '合同.txt',
    contentType: 'text/plain',
    disposition: 'inline',
    contentId: 'contract@example.test'
  })
  const metadataDigest = digest(Buffer.from(JSON.stringify(metadata), 'utf8'))
  const encryptedMetadata = encryptEmailPayloadWithKey(metadata, key, { context: metadataContext() })
  const encryptedContent = encryptEmailAttachmentChunkWithKey(content, key, {
    userId,
    attachmentId,
    chunkIndex: 0
  })
  const row = {
    id: attachmentId,
    user_id: userId,
    draft_id: draftId,
    outbox_id: outboxId,
    ordinal: 0,
    sha256: digest(content),
    size_bytes: content.length,
    chunk_count: 1,
    metadata_encrypted: encryptedMetadata,
    metadata_digest: metadataDigest,
    chunk_index: 0,
    plaintext_size: content.length,
    ciphertext_encrypted: encryptedContent
  }

  const loaded = await loadOutboxEmailAttachments({ userId, outboxId }, {
    queryFn: async () => ({ rowCount: 1, rows: [row] }),
    keyLoader: async () => key
  })
  assert.equal(loaded.attachments.length, 1)
  assert.equal(loaded.attachments[0].filename, '合同.txt')
  assert.equal(loaded.attachments[0].contentType, 'text/plain')
  assert.equal(loaded.attachments[0].cid, 'contract@example.test')
  assert.deepEqual(loaded.attachments[0].content, content)
  assert.deepEqual(loaded.manifest, [{
    id: attachmentId,
    sha256: digest(content),
    size: content.length,
    ordinal: 0,
    metadataDigest
  }])

  disposeLoadedEmailAttachments(loaded.attachments)
  assert.ok(loaded.attachments[0].content.every((byte) => byte === 0))
})

test('terminal attachment scrub deletes ciphertext before retaining digest-only rows', async () => {
  const statements = []
  const client = {
    async query(sql) {
      statements.push(sql)
      if (/SELECT id, size_bytes/.test(sql)) {
        return { rowCount: 1, rows: [{ id: attachmentId, size_bytes: '42' }] }
      }
      if (/UPDATE email_attachment_objects/.test(sql)) {
        return { rowCount: 1, rows: [{ id: attachmentId }] }
      }
      return { rowCount: 0, rows: [] }
    },
    release() {}
  }
  const result = await scrubOutboxEmailAttachments({ userId, outboxId }, {
    poolInstance: { async connect() { return client } }
  })

  assert.deepEqual(result, { scrubbed: 1, scrubbedBytes: 42 })
  assert.ok(statements.findIndex((sql) => /DELETE FROM email_attachment_chunks/.test(sql))
    < statements.findIndex((sql) => /UPDATE email_attachment_objects/.test(sql)))
  assert.ok(statements.includes('COMMIT'))
})

test('email attachment migration stores encrypted metadata and chunk ciphertext only', async () => {
  const migration = await readFile(
    new URL('../src/db/migrations/037_email_attachments_sent_sync.sql', import.meta.url),
    'utf8'
  )

  assert.match(migration, /CREATE TABLE IF NOT EXISTS email_attachment_objects \(/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS email_attachment_chunks \(/)
  assert.match(migration, /metadata_encrypted BYTEA/)
  assert.match(migration, /ciphertext_encrypted BYTEA/)
  assert.match(migration, /plaintext_size BETWEEN 1 AND 262144/)
  assert.match(migration, /octet_length\(ciphertext_encrypted\) = plaintext_size \+ 29/)
  assert.match(migration, /size_bytes BETWEEN 1 AND 10485760/)
  const objectDefinition = migration.match(
    /CREATE TABLE IF NOT EXISTS email_attachment_objects \(([\s\S]*?)\n\);/
  )?.[1] || ''
  assert.doesNotMatch(objectDefinition, /\bfilename\b|\bcontent_type\b|\bcontent_id\b/)
})
