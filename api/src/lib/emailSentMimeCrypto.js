import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { loadEmailEncryptionKey } from './emailCrypto.js'

const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const OVERHEAD_BYTES = 1 + IV_BYTES + TAG_BYTES
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const AAD_PREFIX = 'domo-nav-email-sent-mime:v1'

export const EMAIL_SENT_MIME_MAX_BYTES = 40 * 1024 * 1024
export const EMAIL_SENT_MIME_ENCRYPTION_OVERHEAD_BYTES = OVERHEAD_BYTES

function assertUuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) throw new TypeError(`${label} is invalid`)
  return normalized
}

function assertKey(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new TypeError('Email sent MIME encryption key must be 32 bytes')
  }
  return value
}

function aad({ userId, outboxId }) {
  return Buffer.from(
    `${AAD_PREFIX}:${assertUuid(userId, 'User id')}:${assertUuid(outboxId, 'Outbox id')}`,
    'utf8'
  )
}

function normalizeMime(value) {
  const mime = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
  if (!mime.length || mime.length > EMAIL_SENT_MIME_MAX_BYTES) {
    throw new Error('Frozen email MIME is empty or too large')
  }
  return mime
}

export function encryptEmailSentMimeWithKey(value, keyValue, context) {
  const plaintext = normalizeMime(value)
  const key = assertKey(keyValue)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(context))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([
    Buffer.from([VERSION]),
    iv,
    cipher.getAuthTag(),
    ciphertext
  ])
}

export function decryptEmailSentMimeWithKey(value, keyValue, context, {
  expectedBytes = null
} = {}) {
  const encrypted = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
  if (
    encrypted.length <= OVERHEAD_BYTES
    || encrypted.length > EMAIL_SENT_MIME_MAX_BYTES + OVERHEAD_BYTES
    || encrypted[0] !== VERSION
  ) {
    throw new Error('Frozen email MIME ciphertext format is invalid')
  }
  const key = assertKey(keyValue)
  const iv = encrypted.subarray(1, 1 + IV_BYTES)
  const tag = encrypted.subarray(1 + IV_BYTES, OVERHEAD_BYTES)
  const ciphertext = encrypted.subarray(OVERHEAD_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(aad(context))
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (plaintext.length > EMAIL_SENT_MIME_MAX_BYTES) {
    plaintext.fill(0)
    throw new Error('Frozen email MIME plaintext is too large')
  }
  if (expectedBytes !== null && plaintext.length !== Number(expectedBytes)) {
    plaintext.fill(0)
    throw new Error('Frozen email MIME size mismatch')
  }
  return plaintext
}

export async function encryptEmailSentMime(value, context, options = {}) {
  const key = await loadEmailEncryptionKey(options.runtimeConfig || config, options)
  return encryptEmailSentMimeWithKey(value, key, context)
}

export async function decryptEmailSentMime(value, context, options = {}) {
  const key = await loadEmailEncryptionKey(options.runtimeConfig || config, options)
  return decryptEmailSentMimeWithKey(value, key, context, {
    expectedBytes: options.expectedBytes ?? null
  })
}
