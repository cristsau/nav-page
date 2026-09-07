const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u

/**
 * Return a canonical HTTP(S) URL or an empty string.
 *
 * Credential-bearing URLs are rejected instead of rewritten so a pasted
 * secret cannot be hidden by display normalization while still being sent to
 * an unexpected host.
 */
export function sanitizeHttpUrl(value) {
  const input = String(value ?? '').trim()
  if (!input || CONTROL_CHARACTER_PATTERN.test(input)) return ''

  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    if (!url.hostname || url.username || url.password) return ''
    return url.toString()
  } catch {
    return ''
  }
}

/**
 * Accept only application-local root-relative paths. Protocol-relative URLs
 * and backslashes are excluded because browsers may reinterpret them as a
 * network target.
 */
export function sanitizeInternalPath(value) {
  const input = String(value ?? '').trim()
  if (
    !input.startsWith('/')
    || input.startsWith('//')
    || input.includes('\\')
    || CONTROL_CHARACTER_PATTERN.test(input)
  ) {
    return ''
  }

  return input
}

export function sanitizeLinkHref(value) {
  return sanitizeInternalPath(value) || sanitizeHttpUrl(value)
}

export function isInternalPath(value) {
  return Boolean(sanitizeInternalPath(value))
}
