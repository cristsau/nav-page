export function normalizeHttpUrl(value) {
  const input = String(value || '').trim()
  if (!input) return ''

  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(input)
    ? input
    : `https://${input}`

  try {
    const parsed = new URL(withProtocol)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    if (!parsed.hostname) return ''
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

export function getOriginPattern(value) {
  const normalized = normalizeHttpUrl(value)
  if (!normalized) return ''

  const url = new URL(normalized)
  return `${url.origin}/*`
}
