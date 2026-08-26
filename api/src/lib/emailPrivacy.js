const DEFAULT_MAXIMUM = 6_000

function normalizeText(value, maximum, { preserveLines = false } = {}) {
  let normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
  normalized = preserveLines
    ? normalized
        .replace(/[\t\f\v ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
    : normalized.replace(/\s+/g, ' ')
  return normalized.trim().slice(0, maximum)
}

function redact(value, maximum, options = {}) {
  return normalizeText(value, maximum * 2, options)
    .replace(/https?:\/\/[^\s<>'"]+/giu, '[LINK_REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[EMAIL_REDACTED]')
    .replace(/\b(?:Bearer\s+)?(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/giu, '[SECRET_REDACTED]')
    .replace(/\b(?:api[ _-]?key|password|passwd|token|secret|authorization)\b\s*[:=]\s*\S+/giu, '[SECRET_REDACTED]')
    .replace(/\b(?:验证码|verification code|one[- ]time code|otp)\D{0,12}\d{4,10}\b/giu, '[OTP_REDACTED]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[PHONE_REDACTED]')
    .replace(/\b\d{6,8}\b/g, '[NUMERIC_CODE_REDACTED]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CARD_REDACTED]')
    .slice(0, maximum)
}

export function redactEmailForAi(value, maximum = DEFAULT_MAXIMUM) {
  return redact(value, maximum)
}

export function redactEmailBodyForAi(value, maximum = DEFAULT_MAXIMUM) {
  return redact(value, maximum, { preserveLines: true })
}
