import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants
} from 'node:zlib'
import { config } from '../config.js'
import { assertManagedMailUpdateAvailable } from './managedIntegrations.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'

const LEGACY_VERSION = 1
const VERSION = 2
const IV_BYTES = 12
const TAG_BYTES = 16
export const EMAIL_ENCRYPTION_MAX_PLAINTEXT_BYTES = 900_000
const AAD_PREFIXES = Object.freeze({
  [LEGACY_VERSION]: 'domo-nav-email:v1',
  [VERSION]: 'domo-nav-email:v2'
})
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
  if (runtimeConfig?.emailManagedAccount === true) {
    await assertManagedMailUpdateAvailable(runtimeConfig)
  }
  if (!bypassCache && cachedKey && cachedPath === filePath) return cachedKey
  const raw = await readSecretImpl(filePath, {
    label: 'Email encryption key',
    maxBytes: 256
  })
  if (runtimeConfig?.emailManagedAccount === true) {
    await assertManagedMailUpdateAvailable(runtimeConfig)
  }
  const key = decodeKey(raw)
  if (!bypassCache) {
    cachedPath = filePath
    cachedKey = key
  }
  return key
}

function aadForContext(context = '', version = VERSION) {
  const normalized = String(context || '').normalize('NFKC').trim()
  if (normalized.length > 240 || /[\u0000-\u001F\u007F]/.test(normalized)) {
    throw new TypeError('Email encryption context is invalid')
  }
  const prefix = AAD_PREFIXES[version]
  if (!prefix) throw new Error('Email ciphertext version is unsupported')
  return Buffer.from(`${prefix}:${normalized}`, 'utf8')
}

export function encryptEmailPayloadWithKey(payload, key, { context = '' } = {}) {
  const plaintext = Buffer.from(JSON.stringify(payload ?? {}), 'utf8')
  if (!plaintext.length || plaintext.length > EMAIL_ENCRYPTION_MAX_PLAINTEXT_BYTES) {
    throw new Error('Email payload is empty or too large')
  }
  const compressed = brotliCompressSync(plaintext, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: plaintext.length
    }
  })
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aadForContext(context, VERSION))
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext])
}

export function decryptEmailPayloadWithKey(encrypted, key, { context = '' } = {}) {
  const input = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted || [])
  const version = input[0]
  if (
    input.length < 1 + IV_BYTES + TAG_BYTES + 2
    || ![LEGACY_VERSION, VERSION].includes(version)
  ) {
    throw new Error('Email ciphertext format is invalid')
  }
  const iv = input.subarray(1, 1 + IV_BYTES)
  const tag = input.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
  const ciphertext = input.subarray(1 + IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(aadForContext(context, version))
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const plaintext = version === VERSION ? brotliDecompressSync(decrypted) : decrypted
  if (plaintext.length > EMAIL_ENCRYPTION_MAX_PLAINTEXT_BYTES) {
    throw new Error('Email decrypted payload is too large')
  }
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
