const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function normalizeOrigin(value) {
  const input = String(value || '').trim()
  if (isExtensionOrigin(input)) {
    return input.toLowerCase()
  }

  try {
    return new URL(input).origin
  } catch {
    return ''
  }
}

export function parseAllowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter(Boolean)
}

export function isExtensionOrigin(value) {
  return /^chrome-extension:\/\/[a-p]{32}$/i.test(String(value || ''))
}

export function createCorsOriginValidator(allowedOriginValue) {
  const allowedOrigins = new Set(parseAllowedOrigins(allowedOriginValue))

  return (origin, callback) => {
    if (!origin) {
      callback(null, true)
      return
    }

    const normalized = normalizeOrigin(origin)
    callback(null, allowedOrigins.has(normalized) || isExtensionOrigin(normalized))
  }
}

export function isUnsafeRequestOriginTrusted(request, allowedOriginValue) {
  if (SAFE_METHODS.has(String(request.method || '').toUpperCase())) {
    return true
  }

  const originHeader = String(request.headers?.origin || '')
  const fetchSite = String(request.headers?.['sec-fetch-site'] || '').toLowerCase()

  if (!originHeader) {
    return fetchSite !== 'cross-site'
  }

  const origin = normalizeOrigin(originHeader)
  if (!origin || origin === 'null') {
    return false
  }

  if (isExtensionOrigin(origin)) {
    return true
  }

  const allowedOrigins = new Set(parseAllowedOrigins(allowedOriginValue))
  if (allowedOrigins.has(origin)) {
    return true
  }

  try {
    const originUrl = new URL(origin)
    const forwardedHost = String(request.headers?.['x-forwarded-host'] || '')
      .split(',')[0]
      .trim()
    const requestHost = forwardedHost || String(request.headers?.host || '').trim()
    return Boolean(requestHost && originUrl.host === requestHost)
  } catch {
    return false
  }
}
