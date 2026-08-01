import crypto from 'node:crypto'

const SCRYPT_KEYLEN = 64
export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 1024
export const MAX_USERNAME_LENGTH = 128
export const RECOVERY_CODE_COUNT = 8
export const PUBLIC_ACCOUNT_RECOVERY_ERROR = 'Unable to recover account with the supplied details'
const RECOVERY_CODE_RANDOM_BYTES = 20
const RECOVERY_CODE_PATTERN = /^NAV[0-9A-F]{40}$/
const USERNAME_CONTROL_PATTERN = /[\u0000-\u001F\u007F]/

function normalizeBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'hex')
}

export function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase()
}

export function isValidUsername(username) {
  const normalized = normalizeUsername(username)
  return Boolean(
    normalized
    && normalized.length <= MAX_USERNAME_LENGTH
    && !USERNAME_CONTROL_PATTERN.test(normalized)
  )
}

export function validateNewPassword(password) {
  const value = String(password || '')
  if (value.length < MIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    }
  }

  if (value.length > MAX_PASSWORD_LENGTH) {
    return {
      valid: false,
      error: `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer`
    }
  }

  return {
    valid: true,
    error: ''
  }
}

export async function hashPassword(password) {
  const passwordValue = String(password || '')
  const salt = crypto.randomBytes(16).toString('hex')
  const derivedKey = await new Promise((resolve, reject) => {
    crypto.scrypt(passwordValue, salt, SCRYPT_KEYLEN, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })

  return `scrypt:${salt}:${Buffer.from(derivedKey).toString('hex')}`
}

export async function verifyPassword(password, storedHash) {
  const passwordValue = String(password || '')
  if (passwordValue.length > MAX_PASSWORD_LENGTH) return false

  const [algorithm, salt, hash] = String(storedHash || '').split(':')
  if (algorithm !== 'scrypt' || !salt || !hash) return false

  const derivedKey = await new Promise((resolve, reject) => {
    crypto.scrypt(passwordValue, salt, SCRYPT_KEYLEN, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })

  const derivedBuffer = normalizeBuffer(derivedKey)
  const storedBuffer = normalizeBuffer(hash)
  return (
    derivedBuffer.length === storedBuffer.length
    && crypto.timingSafeEqual(derivedBuffer, storedBuffer)
  )
}

export function createSessionToken() {
  return crypto.randomBytes(48).toString('base64url')
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function normalizeRecoveryCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
}

export function isValidRecoveryCode(value) {
  return RECOVERY_CODE_PATTERN.test(normalizeRecoveryCode(value))
}

export function hashRecoveryCode(value) {
  return crypto
    .createHash('sha256')
    .update(`domo-nav-recovery:${normalizeRecoveryCode(value)}`)
    .digest('hex')
}

export function createRecoveryCode() {
  const encoded = crypto
    .randomBytes(RECOVERY_CODE_RANDOM_BYTES)
    .toString('hex')
    .toUpperCase()
  const groups = encoded.match(/.{1,4}/g) || [encoded]
  return `NAV-${groups.join('-')}`
}

export function createRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const boundedCount = Number.isSafeInteger(Number(count))
    ? Math.max(1, Math.min(20, Number(count)))
    : RECOVERY_CODE_COUNT
  const codes = new Set()

  while (codes.size < boundedCount) {
    codes.add(createRecoveryCode())
  }

  return [...codes]
}

export function shouldTouchSession(
  lastSeenAt,
  {
    now = Date.now(),
    intervalMs = 5 * 60 * 1000
  } = {}
) {
  const lastSeen = new Date(lastSeenAt || 0).getTime()
  return !Number.isFinite(lastSeen) || now - lastSeen >= intervalMs
}
