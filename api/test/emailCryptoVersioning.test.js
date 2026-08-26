import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import {
  decryptEmailPayloadWithKey,
  encryptEmailPayloadWithKey
} from '../src/lib/emailCrypto.js'

const IV_BYTES = 12

function encryptLegacyV1(payload, key, context) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`domo-nav-email:v1:${context}`, 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final()
  ])
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext])
}

test('email encryption keeps legacy v1 ciphertext readable', () => {
  const key = randomBytes(32)
  const context = 'legacy-user:mxroute'
  const payload = { subject: '旧邮件', text: '升级后仍然可以读取' }
  const encrypted = encryptLegacyV1(payload, key, context)

  assert.equal(encrypted[0], 1)
  assert.deepEqual(decryptEmailPayloadWithKey(encrypted, key, { context }), payload)
  assert.throws(
    () => decryptEmailPayloadWithKey(encrypted, key, { context: 'other-user:mxroute' }),
    /authenticate|Unsupported state|unable/i
  )
})

test('email encryption v2 compresses repetitive content before authenticated encryption', () => {
  const key = randomBytes(32)
  const context = 'user-a:message-a'
  const payload = { subject: '通知', text: 'same line\n'.repeat(20_000) }
  const plaintextBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  const encrypted = encryptEmailPayloadWithKey(payload, key, { context })

  assert.equal(encrypted[0], 2)
  assert.ok(encrypted.length < plaintextBytes / 4, 'repetitive payload should compress substantially')
  assert.deepEqual(decryptEmailPayloadWithKey(encrypted, key, { context }), payload)
})
