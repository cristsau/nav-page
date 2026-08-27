import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  EMAIL_ATTACHMENT_CHUNK_BYTES,
  EMAIL_ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES,
  decryptEmailAttachmentChunkWithKey,
  encryptEmailAttachmentChunkWithKey
} from '../src/lib/emailAttachmentCrypto.js'

test('email attachment chunks round-trip raw bytes with bounded AES-GCM overhead', () => {
  const key = randomBytes(32)
  const context = {
    userId: randomUUID(),
    attachmentId: randomUUID(),
    chunkIndex: 0
  }
  const plaintext = randomBytes(EMAIL_ATTACHMENT_CHUNK_BYTES)
  const encrypted = encryptEmailAttachmentChunkWithKey(plaintext, key, context)

  assert.equal(encrypted.length, plaintext.length + EMAIL_ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES)
  assert.deepEqual(
    decryptEmailAttachmentChunkWithKey(encrypted, key, context, {
      expectedPlaintextBytes: plaintext.length
    }),
    plaintext
  )
})

test('email attachment chunk AAD binds user, attachment and chunk index', () => {
  const key = randomBytes(32)
  const context = {
    userId: randomUUID(),
    attachmentId: randomUUID(),
    chunkIndex: 3
  }
  const encrypted = encryptEmailAttachmentChunkWithKey(Buffer.from('private attachment'), key, context)

  for (const changed of [
    { ...context, userId: randomUUID() },
    { ...context, attachmentId: randomUUID() },
    { ...context, chunkIndex: 2 }
  ]) {
    assert.throws(
      () => decryptEmailAttachmentChunkWithKey(encrypted, key, changed),
      /authenticate|Unsupported state|unable/i
    )
  }

  const tampered = Buffer.from(encrypted)
  tampered[tampered.length - 1] ^= 0xff
  assert.throws(
    () => decryptEmailAttachmentChunkWithKey(tampered, key, context),
    /authenticate|Unsupported state|unable/i
  )
})

test('email attachment crypto rejects empty, oversized and malformed chunks', () => {
  const key = randomBytes(32)
  const context = {
    userId: randomUUID(),
    attachmentId: randomUUID(),
    chunkIndex: 0
  }

  assert.throws(
    () => encryptEmailAttachmentChunkWithKey(Buffer.alloc(0), key, context),
    /empty or too large/i
  )
  assert.throws(
    () => encryptEmailAttachmentChunkWithKey(Buffer.alloc(EMAIL_ATTACHMENT_CHUNK_BYTES + 1), key, context),
    /empty or too large/i
  )
  assert.throws(
    () => decryptEmailAttachmentChunkWithKey(Buffer.alloc(30), key, context),
    /format is invalid/i
  )
})
