import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'

const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_PLAINTEXT_BYTES = 900_000
const AAD_PREFIX = 'domo-nav-email:v1'
let cachedKey = null
let cachedPath = ''

function decodeKey(value) {
  const raw = String(value || '').trim()
  let key
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex')
  else {
    try { key = Buffer.from(raw, 'base64') } catch { key = Buffer.alloc(0) }
  }
  if (key.length !== 32) {
    throw new Error('Email encryption key must decode to exactly 32 bytes')
  }
  return key
}

export async function loadEmailEncryptionKey(
  runtimeConfig = config,
  { readSecretImpl = readOwnerSecretFile, bypassCache = false } = {}
) {
  const filePath = String(runtimeConfig.emailEncryptionKeyFile || '').trim()
  if (!bypassCache && cachedKey && cachedPath === filePath) return cachedKey
  const raw = await readSecretImpl(filePath, {
    label: 'Email encryption key',
    maxBytes: 256
  })
  const key = decodeKey(raw)
  if (!bypassCache) {
    cachedPath = filePath
    cachedKey = key
  }
  return key
}

function aadForContext(context = '') {
  const normalized = String(context || '').normalize('NFKC').trim()
  if (normalized.length > 240 || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new TypeError('Email encryption context is invalid')
  }
  return Buffer.from(`${AAD_PREFIX}:${normalized}`, 'utf8')
}

export function encryptEmailPayloadWithKey(payload, key, { context = '' } = {}) {
  const plaintext = Buffer.from(JSON.stringify(payload ?? {}), 'utf8')
  if (!plaintext.length || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error('Email payload is empty or too large')
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aadForContext(context))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext])
}

export function decryptEmailPayloadWithKey(encrypted, key, { context = '' } = {}) {
  const input = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted || [])
  if (input.length < 1 + IV_BYTES + TAG_BYTES + 2 || input[0] !== VERSION) {
    throw new Error('Email ciphertext format is invalid')
  }
  const iv = input.subarray(1, 1 + IV_BYTES)
  const tag = input.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
  const ciphertext = input.subarray(1 + IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(aadForContext(context))
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString('utf8'))
}

export async function encryptEmailPayload(payload, options = {}) {
  return encryptEmailPayloadWithKey(
    payload,
    await loadEmailEncryptionKey(options.runtimeConfig, options),
    { context: options.context }
  )
}

export async function decryptEmailPayload(encrypted, options = {}) {
  return decryptEmailPayloadWithKey(
    encrypted,
    await loadEmailEncryptionKey(options.runtimeConfig, options),
    { context: options.context }
  )
}

export function clearEmailEncryptionKeyCache() {
  if (cachedKey) cachedKey.fill(0)
  cachedKey = null
  cachedPath = ''
}
