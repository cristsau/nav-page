import crypto from 'node:crypto'

const SCRYPT_KEYLEN = 64

function normalizeBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'hex')
}

export function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase()
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const derivedKey = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })

  return `scrypt:${salt}:${Buffer.from(derivedKey).toString('hex')}`
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, salt, hash] = String(storedHash || '').split(':')
  if (algorithm !== 'scrypt' || !salt || !hash) return false

  const derivedKey = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })

  return crypto.timingSafeEqual(normalizeBuffer(derivedKey), normalizeBuffer(hash))
}

export function createSessionToken() {
  return crypto.randomBytes(48).toString('base64url')
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}
