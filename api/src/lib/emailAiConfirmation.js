import {
  createHash,
  createHmac,
  timingSafeEqual
} from 'node:crypto'
import { isUuid, stableJson } from './offlineMutations.js'

const TOKEN_VERSION = 1
const MAX_TOKEN_BYTES = 4_096
const MAX_TTL_SECONDS = 15 * 60
const PROPOSAL_KINDS = new Set(['create_diary', 'create_memo', 'create_draft'])

export class EmailAiConfirmationError extends Error {
  constructor(message, { code = 'email_ai_confirmation_invalid', statusCode = 400 } = {}) {
    super(message)
    this.name = 'EmailAiConfirmationError'
    this.code = code
    this.statusCode = statusCode
  }
}

function fail(message, code, statusCode = 400) {
  throw new EmailAiConfirmationError(message, { code, statusCode })
}

function secretBuffer(secret) {
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(secret || '')
  if (value.length < 32) fail('邮件 AI 确认密钥不可用', 'email_ai_confirmation_key_invalid', 503)
  return value
}

function paramsHash(params) {
  return createHash('sha256').update(stableJson(params || {})).digest('hex')
}

function resourceVersion(value) {
  const normalized = String(value || '').trim()
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    fail('邮件版本无效', 'email_ai_resource_version_invalid')
  }
  return normalized.toLowerCase()
}

function proposalKind(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!PROPOSAL_KINDS.has(normalized)) {
    fail('不支持的邮件 AI 提议', 'email_ai_proposal_kind_invalid')
  }
  return normalized
}

function hmac(body, secret) {
  return createHmac('sha256', secretBuffer(secret)).update(body).digest('base64url')
}

export function hashEmailAiProposalParams(params) {
  return paramsHash(params)
}

export function deriveEmailAiConfirmationSecret(emailEncryptionKey) {
  return createHmac('sha256', secretBuffer(emailEncryptionKey))
    .update('domo-nav-email-ai-confirmation:v1')
    .digest()
}

export function createEmailAiConfirmationToken({
  userId,
  messageId,
  resourceVersion: version,
  kind,
  params,
  operationId,
  ttlSeconds = 5 * 60,
  now = Date.now()
}, secret) {
  if (!isUuid(userId) || !isUuid(messageId) || !isUuid(operationId)) {
    fail('邮件 AI 确认身份无效', 'email_ai_confirmation_identity_invalid')
  }
  const ttl = Number(ttlSeconds)
  if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > MAX_TTL_SECONDS) {
    fail('邮件 AI 确认有效期无效', 'email_ai_confirmation_ttl_invalid')
  }
  const payload = {
    v: TOKEN_VERSION,
    uid: userId,
    mid: messageId,
    rv: resourceVersion(version),
    kind: proposalKind(kind),
    ph: paramsHash(params),
    oid: operationId,
    exp: Math.floor(Number(now) / 1000) + ttl
  }
  const body = Buffer.from(stableJson(payload), 'utf8').toString('base64url')
  return `${body}.${hmac(body, secret)}`
}

export function verifyEmailAiConfirmationToken(token, {
  userId,
  messageId,
  resourceVersion: version,
  kind,
  params,
  operationId
}, secret, { now = Date.now() } = {}) {
  const raw = String(token || '').trim()
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_TOKEN_BYTES) {
    fail('邮件 AI 确认令牌无效', 'email_ai_confirmation_invalid')
  }
  const parts = raw.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail('邮件 AI 确认令牌无效', 'email_ai_confirmation_invalid')
  }
  const expected = Buffer.from(hmac(parts[0], secret), 'utf8')
  const actual = Buffer.from(parts[1], 'utf8')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    fail('邮件 AI 确认令牌无效', 'email_ai_confirmation_invalid')
  }
  let payload
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) } catch {
    fail('邮件 AI 确认令牌无效', 'email_ai_confirmation_invalid')
  }
  if (payload?.v !== TOKEN_VERSION || !Number.isSafeInteger(payload?.exp)) {
    fail('邮件 AI 确认令牌无效', 'email_ai_confirmation_invalid')
  }
  if (payload.exp <= Math.floor(Number(now) / 1000)) {
    fail('邮件 AI 确认已过期，请重新生成预览', 'email_ai_confirmation_expired', 409)
  }
  const expectedPayload = {
    uid: String(userId || ''),
    mid: String(messageId || ''),
    rv: resourceVersion(version),
    kind: proposalKind(kind),
    ph: paramsHash(params),
    oid: String(operationId || '')
  }
  for (const [key, value] of Object.entries(expectedPayload)) {
    if (payload[key] !== value) {
      fail('邮件或提议已变化，请重新生成预览', 'email_ai_confirmation_mismatch', 409)
    }
  }
  return {
    userId: payload.uid,
    messageId: payload.mid,
    resourceVersion: payload.rv,
    kind: payload.kind,
    paramsHash: payload.ph,
    operationId: payload.oid,
    expiresAt: new Date(payload.exp * 1000).toISOString()
  }
}
