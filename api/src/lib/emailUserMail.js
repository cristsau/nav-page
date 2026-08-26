import { createHash } from 'node:crypto'

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u
const MESSAGE_ID_PATTERN = /^<[^<>\r\n]{1,996}>$/u
const MAX_RECIPIENTS = 50
const MAX_BODY_LENGTH = 80_000

export function normalizeEmailAddress(value) {
  const email = String(value || '').normalize('NFKC').trim().toLowerCase()
  if (!EMAIL_PATTERN.test(email) || email.length > 320 || /[\r\n]/.test(email)) {
    throw new TypeError('Email address is invalid')
  }
  return email
}

export function normalizeEmailAddressList(value, { required = false } = {}) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[;,]/u)
  const addresses = [...new Set(source
    .map((entry) => (
      typeof entry === 'object' && entry !== null
        ? (entry.address || entry.email)
        : entry
    ))
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .map(normalizeEmailAddress))]
  if (addresses.length > MAX_RECIPIENTS) throw new TypeError('Too many email recipients')
  if (required && !addresses.length) throw new TypeError('At least one recipient is required')
  return addresses
}

function normalizeSubject(value) {
  const subject = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\r\n]+/g, ' ')
    .trim()
  if (subject.length > 240) throw new TypeError('Email subject is too long')
  return subject || '(无主题)'
}

function normalizeBody(value) {
  const body = String(value ?? '')
    .normalize('NFC')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!body) throw new TypeError('Email body is required')
  if (body.length > MAX_BODY_LENGTH) throw new TypeError('Email body is too long')
  return body
}

function normalizeMessageId(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!MESSAGE_ID_PATTERN.test(raw)) throw new TypeError('Email reply header is invalid')
  return raw
}

export function normalizeUserMailPayload(value = {}, { replyHeaders = {} } = {}) {
  const inReplyTo = normalizeMessageId(replyHeaders.inReplyTo || value.inReplyTo)
  const references = [...new Set([
    ...(Array.isArray(replyHeaders.references) ? replyHeaders.references : []),
    ...(Array.isArray(value.references) ? value.references : []),
    ...(inReplyTo ? [inReplyTo] : [])
  ].map(normalizeMessageId).filter(Boolean))].slice(-100)
  const to = normalizeEmailAddressList(value.to, { required: true })
  const cc = normalizeEmailAddressList(value.cc)
  const bcc = normalizeEmailAddressList(value.bcc)
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new TypeError('Too many email recipients')
  }
  return {
    to,
    cc,
    bcc,
    subject: normalizeSubject(value.subject),
    text: normalizeBody(value.text ?? value.body),
    inReplyTo,
    references
  }
}

export function hashUserMailPayload(payload) {
  const canonical = normalizeUserMailPayload(payload)
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
