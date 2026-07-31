export const MAX_NOTE_TAGS = 20
export const MAX_NOTE_TAG_LENGTH = 32

const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/u
const URL_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const ID_CARD_PATTERN = /^(?:\d{15}|\d{17}[\dX])$/i
const LONG_NUMBER_PATTERN = /^\d{8,}$/
const CREDENTIAL_PATTERN = /^(?:bearer\s+|gh[pousr]_|github_pat_|aiza|xox[baprs]-|sk_(?:live|test)_|pk_(?:live|test)_)[a-z0-9_./+=-]{8,}$/i
const AWS_ACCESS_KEY_PATTERN = /^(?:AKIA|ASIA|A3T[A-Z0-9]|AGPA|AIDA|ANPA|ANVA|AROA|AIPA)[A-Z0-9]{12,}$/
const DOMAIN_PATTERN = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{1,5})?(?:[/?#].*)?$/iu
const SECRET_KEY_SOURCE = String.raw`(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|client[\s_-]*secret|token|secret|password|passwd|pwd)`
const EXPLICIT_SECRET_PATTERN = new RegExp(
  String.raw`^["']?${SECRET_KEY_SOURCE}["']?\s*[:=]\s*(["']?)([a-z0-9_./+=-]{8,})\1$`,
  'i'
)
const SPACED_SECRET_PATTERN = new RegExp(
  String.raw`^${SECRET_KEY_SOURCE}\s+(["']?)([a-z0-9_./+=-]{8,})\1$`,
  'i'
)
const PREFIXED_SECRET_PATTERN = /^(?:sk|pk|token)[_-]([a-z0-9_./+=-]{8,})$/i
const SECRET_TOPIC_WORDS = new Set([
  'analysis',
  'authentication',
  'handling',
  'learning',
  'management',
  'rotation',
  'security'
])

function normalizeKey(value) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function isValidIpv4(value) {
  const octets = value.split('.')
  return octets.length === 4
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isIpv6Like(value) {
  const host = value.replace(/%[a-z0-9_.-]+$/i, '')
  if ((host.match(/:/g) || []).length < 2) return false
  if (!/^[0-9a-f:.]+$/i.test(host)) return false

  const ipv4Tail = host.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  return !ipv4Tail || isValidIpv4(ipv4Tail)
}

function extractNetworkHost(value) {
  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']')
    if (closingBracket < 0) return ''

    const suffix = value.slice(closingBracket + 1)
    if (!/^(?::\d{1,5})?(?:[/?#].*)?$/.test(suffix)) return ''
    return value.slice(1, closingBracket)
  }

  const hostWithPort = value.split(/[/?#]/, 1)[0]
  return (hostWithPort.match(/:/g) || []).length <= 1
    ? hostWithPort.replace(/:\d{1,5}$/, '')
    : hostWithPort
}

function looksLikeNetworkAddress(value) {
  if (DOMAIN_PATTERN.test(value)) return true

  const host = extractNetworkHost(value)
  if (!host) return false
  if (/^localhost$/i.test(host)) return true
  if (isValidIpv4(host)) return true
  return isIpv6Like(host)
}

function isLikelySecretValue(value, allowPlainLetters = false) {
  if (!/^[a-z0-9_./+=-]{8,}$/i.test(value)) return false

  const normalized = value.toLowerCase()
  return allowPlainLetters || !SECRET_TOPIC_WORDS.has(normalized)
}

function looksLikeSecret(value) {
  const explicitMatch = value.match(EXPLICIT_SECRET_PATTERN)
  if (explicitMatch) {
    return isLikelySecretValue(explicitMatch[2], true)
  }

  const spacedMatch = value.match(SPACED_SECRET_PATTERN)
  if (spacedMatch) {
    return isLikelySecretValue(spacedMatch[2])
  }

  const prefixedMatch = value.match(PREFIXED_SECRET_PATTERN)
  if (!prefixedMatch) return false

  return isLikelySecretValue(prefixedMatch[1])
}

export function normalizeNoteTag(value) {
  if (typeof value !== 'string') return ''

  const normalized = value
    .normalize('NFKC')
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')

  if (!normalized) return ''
  if ([...normalized].length > MAX_NOTE_TAG_LENGTH) return ''
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) return ''
  if (URL_PATTERN.test(normalized)) return ''
  if (EMAIL_PATTERN.test(normalized)) return ''
  if (ID_CARD_PATTERN.test(normalized)) return ''
  if (LONG_NUMBER_PATTERN.test(normalized)) return ''
  if (looksLikeSecret(normalized)) return ''
  if (CREDENTIAL_PATTERN.test(normalized)) return ''
  if (AWS_ACCESS_KEY_PATTERN.test(normalized)) return ''
  if (looksLikeNetworkAddress(normalized)) return ''

  return normalized
}

export function mergeSuggestedNoteTags(existingTags, suggestedTags) {
  const output = Array.isArray(existingTags) ? [...existingTags] : []
  const seen = new Set(
    output
      .map((tag) => normalizeNoteTag(tag))
      .filter(Boolean)
      .map(normalizeKey)
  )
  const added = []

  for (const item of Array.isArray(suggestedTags) ? suggestedTags : []) {
    if (output.length >= MAX_NOTE_TAGS) break

    const tag = normalizeNoteTag(item)
    if (!tag) continue

    const key = normalizeKey(tag)
    if (seen.has(key)) continue

    seen.add(key)
    output.push(tag)
    added.push(tag)
  }

  return {
    tags: output,
    added,
    limitReached: output.length >= MAX_NOTE_TAGS
  }
}
