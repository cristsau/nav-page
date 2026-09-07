import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readOwnerSecretFile } from './ownerSecretFile.js'
import { config } from '../config.js'

export const EMAIL_CODE_TTL_SECONDS = 300
export const EMAIL_CODE_RESEND_SECONDS = 60
export const EMAIL_CODE_MAX_ATTEMPTS = 5

export function parseAuthEmailKeys(value) {
  const keys = JSON.parse(value)
  if (!Number.isSafeInteger(keys.version) || keys.version < 1
      || !/^[a-f0-9]{64}$/i.test(keys.hmacKey || '')
      || !/^[a-f0-9]{64}$/i.test(keys.encryptionKey || '')
      || keys.hmacKey.toLowerCase() === keys.encryptionKey.toLowerCase()) throw new Error('AUTH_EMAIL_KEYS_INVALID')
  const current={ version: keys.version, hmac: Buffer.from(keys.hmacKey, 'hex'), encryption: Buffer.from(keys.encryptionKey, 'hex') }
  if(keys.previous) {
    if(keys.previous.previous || keys.previous.version>=keys.version)throw new Error('AUTH_EMAIL_KEYS_INVALID')
    const until=Date.parse(keys.previous.acceptUntil)
    const since=Date.parse(keys.previous.rotatedAt)
    if(!Number.isFinite(until) || !Number.isFinite(since) || until<=since || until-since>300000 || since>Date.now()+5000)throw new Error('AUTH_EMAIL_KEYS_INVALID')
    current.previous={...parseAuthEmailKeys(JSON.stringify(keys.previous)),acceptUntil:until}
  }
  return current
}

export function authEmailKeyVersion(keys,version,now=Date.now()) {
  if(keys.version===version)return keys
  if(keys.previous?.version===version && now<keys.previous.acceptUntil)return keys.previous
  throw new Error('AUTH_EMAIL_KEY_VERSION_EXPIRED')
}

export async function loadAuthEmailKeys(runtime = config) {
  return parseAuthEmailKeys(await readOwnerSecretFile(runtime.authEmailKeysFile, { label: 'Auth email keys', maxBytes: 2048, allowWhitespace: true }))
}

export function newEmailCode() { return String(randomInt(0, 1_000_000)).padStart(6, '0') }
export function authEmailJobContext(job) { return JSON.stringify(['job',job.id,job.message_type,job.challenge_id || null]) }
export function proofDigest(value) { return createHash('sha256').update(String(value)).digest('hex') }
export function emailKeyDigest(email, keys) { return createHmac('sha256', keys.hmac).update(JSON.stringify(['email', email])).digest('hex') }
export function emailCodeMac(challenge, code, keys) {
  return createHmac('sha256', keys.hmac).update(JSON.stringify([
    keys.version, challenge.id, challenge.user_id, challenge.purpose,
    challenge.email_key_digest, challenge.origin, challenge.flow_digest, code
  ])).digest('hex')
}
export function equalDigest(a, b) {
  return /^[0-9a-f]{64}$/.test(String(a)) && /^[0-9a-f]{64}$/.test(String(b))
    && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
export function encryptAuthPayload(payload, context, keys) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keys.encryption, iv)
  cipher.setAAD(Buffer.from(JSON.stringify([keys.version, context])))
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64url')).join('.')
}
export function decryptAuthPayload(payload, context, keys) {
  const parts = String(payload).split('.')
  if (parts.length !== 3) throw new Error('AUTH_EMAIL_PAYLOAD_INVALID')
  const [iv, tag, body] = parts.map(p => Buffer.from(p, 'base64url'))
  if (iv.length !== 12 || tag.length !== 16 || body.length > 16_384) throw new Error('AUTH_EMAIL_PAYLOAD_INVALID')
  const decipher = createDecipheriv('aes-256-gcm', keys.encryption, iv)
  decipher.setAAD(Buffer.from(JSON.stringify([keys.version, context])))
  decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'))
}
