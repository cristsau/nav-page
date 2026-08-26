const DEFAULT_MESSAGE_ATTEMPTS = 3
const MAX_MESSAGE_ATTEMPTS = 10
const MAX_BATCH_SOURCE_BYTES = 16 * 1024 * 1024

function safeInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export function deriveEmailBatchSourceBudget(maxMessageBytes, configuredBudget) {
  const perMessage = Math.max(1, safeInteger(maxMessageBytes, 512 * 1024))
  const minimum = perMessage + 1
  const derived = Math.min(MAX_BATCH_SOURCE_BYTES, Math.max(minimum, perMessage * 8))
  const configured = safeInteger(configuredBudget, derived)
  return Math.min(MAX_BATCH_SOURCE_BYTES, Math.max(minimum, configured))
}

export function normalizeEmailMessageAttempts(value) {
  const parsed = safeInteger(value, DEFAULT_MESSAGE_ATTEMPTS)
  return Math.min(MAX_MESSAGE_ATTEMPTS, Math.max(1, parsed))
}

function normalizedUid(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 4_294_967_295) {
    throw new TypeError('IMAP message UID is invalid')
  }
  return parsed
}

export function emailMessageFailureState({ errorCode, uid, maxAttempts }) {
  const normalizedMessageUid = normalizedUid(uid)
  const limit = normalizeEmailMessageAttempts(maxAttempts)
  if (String(errorCode || '') === `EMAIL_UID_${normalizedMessageUid}_DEADLETTER`) {
    return {
      attempt: limit,
      deadLetter: true,
      code: `EMAIL_UID_${normalizedMessageUid}_DEADLETTER`
    }
  }
  const match = String(errorCode || '').match(/^EMAIL_UID_(\d+)_RETRY_(\d+)$/)
  const previous = match && Number(match[1]) === normalizedMessageUid
    ? safeInteger(match[2], 0)
    : 0
  const attempt = Math.min(limit, previous + 1)
  const deadLetter = attempt >= limit
  return {
    attempt,
    deadLetter,
    code: deadLetter
      ? `EMAIL_UID_${normalizedMessageUid}_DEADLETTER`
      : `EMAIL_UID_${normalizedMessageUid}_RETRY_${attempt}`
  }
}

export function truncateUtf8(value, maxBytes) {
  const source = Buffer.from(String(value ?? ''), 'utf8')
  const limit = Math.max(0, safeInteger(maxBytes, 0))
  if (source.length <= limit) return source.toString('utf8')
  if (!limit) return ''

  let sequenceStart = limit
  while (sequenceStart > 0 && (source[sequenceStart] & 0xc0) === 0x80) sequenceStart -= 1
  const lead = source[sequenceStart]
  const sequenceBytes = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  const safeEnd = sequenceStart + sequenceBytes <= limit ? limit : sequenceStart
  return source.subarray(0, safeEnd).toString('utf8')
}
