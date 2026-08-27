import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { loadEmailEncryptionKey } from './emailCrypto.js'

const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const AAD_PREFIX = 'domo-nav-email-attachment:v1'

export const EMAIL_ATTACHMENT_CHUNK_BYTES = 256 * 1024
export const EMAIL_ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES = 1 + IV_BYTES + TAG_BYTES

function assertUuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(normalized)) throw new TypeError(`${label} is invalid`)
  return normalized
}

function assertChunkIndex(value) {
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 39) {
    throw new TypeError('Email attachment chunk index is invalid')
  }
  return normalized
}

function assertEncryptionKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new TypeError('Email attachment encryption key must be 32 bytes')
  }
  return key
}

function buildChunkAad({ userId, attachmentId, chunkIndex }) {
  return Buffer.from(
    `${AAD_PREFIX}:${assertUuid(userId, 'User id')}:${assertUuid(attachmentId, 'Attachment id')}:${assertChunkIndex(chunkIndex)}`,
    'utf8'
  )
}

function normalizePlaintext(value) {
  const plaintext = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value || [])
  if (!plaintext.length || plaintext.length > EMAIL_ATTACHMENT_CHUNK_BYTES) {
    throw new Error('Email attachment chunk is empty or too large')
  }
  return plaintext
}

export function encryptEmailAttachmentChunkWithKey(
  plaintextValue,
  keyValue,
  context
) {
  const plaintext = normalizePlaintext(plaintextValue)
  const key = assertEncryptionKey(keyValue)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(buildChunkAad(context))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([
    Buffer.from([VERSION]),
    iv,
    cipher.getAuthTag(),
    ciphertext
  ])
}

export function decryptEmailAttachmentChunkWithKey(
  encryptedValue,
  keyValue,
  context,
  { expectedPlaintextBytes = null } = {}
) {
  const encrypted = Buffer.isBuffer(encryptedValue)
    ? encryptedValue
    : Buffer.from(encryptedValue || [])
  if (
    encrypted.length <= EMAIL_ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES
    || encrypted.length > EMAIL_ATTACHMENT_CHUNK_BYTES + EMAIL_ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES
    || encrypted[0] !== VERSION
  ) {
    throw new Error('Email attachment ciphertext format is invalid')
  }
  const key = assertEncryptionKey(keyValue)
  const iv = encrypted.subarray(1, 1 + IV_BYTES)
  const tag = encrypted.subarray(1 + IV_BYTES, EMAIL_ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES)
  const ciphertext = encrypted.subarray(EMAIL_ATTACHMENT_ENCRYPTION_OVERHEAD_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(buildChunkAad(context))
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (plaintext.length > EMAIL_ATTACHMENT_CHUNK_BYTES) {
    plaintext.fill(0)
    throw new Error('Email attachment decrypted chunk is too large')
  }
  if (expectedPlaintextBytes !== null) {
    const expected = Number(expectedPlaintextBytes)
    if (!Number.isSafeInteger(expected) || expected < 1 || expected > EMAIL_ATTACHMENT_CHUNK_BYTES) {
      plaintext.fill(0)
      throw new TypeError('Expected email attachment chunk size is invalid')
    }
    if (plaintext.length !== expected) {
      plaintext.fill(0)
      throw new Error('Email attachment decrypted chunk size mismatch')
    }
  }
  return plaintext
}

export async function encryptEmailAttachmentChunk(plaintext, context, options = {}) {
  const key = await loadEmailEncryptionKey(
    options.runtimeConfig || config,
    options
  )
  return encryptEmailAttachmentChunkWithKey(plaintext, key, context)
}

export async function decryptEmailAttachmentChunk(encrypted, context, options = {}) {
  const key = await loadEmailEncryptionKey(
    options.runtimeConfig || config,
    options
  )
  return decryptEmailAttachmentChunkWithKey(
    encrypted,
    key,
    context,
    { expectedPlaintextBytes: options.expectedPlaintextBytes ?? null }
  )
}
