import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hashUserMailPayload,
  normalizeEmailAddress,
  normalizeEmailAddressList,
  normalizeUserMailAttachmentManifest,
  normalizeUserMailPayload
} from '../src/lib/emailUserMail.js'

test('user mail normalization canonicalizes, deduplicates and bounds recipient fields', () => {
  assert.equal(normalizeEmailAddress('  USER＠EXAMPLE.COM  '), 'user@example.com')
  assert.deepEqual(
    normalizeEmailAddressList(' First@Example.com;second@example.com,first@example.com '),
    ['first@example.com', 'second@example.com']
  )
  assert.throws(() => normalizeEmailAddress('victim@example.com\r\nBcc: attacker@example.com'), /invalid/i)
  assert.throws(
    () => normalizeEmailAddressList(Array.from({ length: 51 }, (_, index) => `u${index}@example.com`)),
    /Too many/i
  )
  assert.throws(
    () => normalizeUserMailPayload({
      to: Array.from({ length: 20 }, (_, index) => `to${index}@example.com`),
      cc: Array.from({ length: 20 }, (_, index) => `cc${index}@example.com`),
      bcc: Array.from({ length: 11 }, (_, index) => `bcc${index}@example.com`),
      text: 'body'
    }),
    /Too many/i
  )
})

test('user mail content hash binds an ordered attachment manifest without changing legacy empty hashes', () => {
  const payload = { to: 'user@example.com', subject: 'Report', text: 'Attached.' }
  const legacy = hashUserMailPayload(payload)
  assert.equal(legacy, hashUserMailPayload(payload, []))
  const manifest = [{
    id: '11111111-1111-4111-8111-111111111111',
    sha256: 'a'.repeat(64),
    size: 4096,
    ordinal: 0,
    metadataDigest: 'b'.repeat(64)
  }]
  assert.deepEqual(normalizeUserMailAttachmentManifest(manifest), manifest)
  const withAttachment = hashUserMailPayload(payload, manifest)
  assert.match(withAttachment, /^[0-9a-f]{64}$/)
  assert.notEqual(withAttachment, legacy)
  assert.notEqual(withAttachment, hashUserMailPayload(payload, [{
    ...manifest[0], sha256: 'c'.repeat(64)
  }]))
})

test('user mail normalization strips header injection and validates reply message ids', () => {
  const payload = normalizeUserMailPayload({
    to: [{ name: 'Recipient', address: 'Recipient@Example.com' }],
    cc: '',
    bcc: [],
    subject: 'Quarterly report\r\nBcc: hidden@example.com',
    text: 'first\r\nsecond\u0000',
    inReplyTo: '<message-1@example.com>',
    references: ['<message-0@example.com>', '<message-1@example.com>']
  })

  assert.deepEqual(payload.to, ['recipient@example.com'])
  assert.equal(payload.subject, 'Quarterly report Bcc: hidden@example.com')
  assert.equal(payload.text, 'first\nsecond')
  assert.equal(payload.inReplyTo, '<message-1@example.com>')
  assert.deepEqual(payload.references, ['<message-0@example.com>', '<message-1@example.com>'])
  assert.throws(
    () => normalizeUserMailPayload({
      to: 'recipient@example.com',
      text: 'body',
      inReplyTo: '<safe@example.com>\r\nBcc: hidden@example.com'
    }),
    /reply header is invalid/i
  )
  assert.throws(
    () => normalizeUserMailPayload({
      to: 'recipient@example.com',
      subject: 's'.repeat(241),
      text: 'body'
    }),
    /subject is too long/i
  )
  assert.throws(
    () => normalizeUserMailPayload({
      to: 'recipient@example.com',
      subject: 'subject',
      text: 'b'.repeat(80_001)
    }),
    /body is too long/i
  )
})

test('user mail content hashes use normalized canonical content', () => {
  const first = hashUserMailPayload({
    to: 'USER@example.com',
    subject: '  Hello  ',
    text: 'line 1\r\nline 2'
  })
  const canonical = hashUserMailPayload({
    to: ['user@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hello',
    text: 'line 1\nline 2',
    inReplyTo: '',
    references: []
  })
  const changed = hashUserMailPayload({
    to: 'user@example.com',
    subject: 'Hello',
    text: 'changed'
  })

  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(first, canonical)
  assert.notEqual(first, changed)
})
