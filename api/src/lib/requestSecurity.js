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
  return [...new Set(String(value || '')
    .split(',')
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter((origin) => origin && !isExtensionOrigin(origin)))]
}

export function isExtensionOrigin(value) {
  return /^chrome-extension:\/\/[a-p]{32}$/i.test(String(value || ''))
}

export function parseAllowedExtensionOrigins(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map((origin) => String(origin || '').trim().toLowerCase())
    .filter((origin) => isExtensionOrigin(origin)))]
}

export function isAllowedExtensionOrigin(value, allowedExtensionOriginValue) {
  const normalized = String(value || '').trim().toLowerCase()
  return isExtensionOrigin(normalized)
    && new Set(parseAllowedExtensionOrigins(allowedExtensionOriginValue)).has(normalized)
}

export function createCorsOriginValidator(
  allowedOriginValue,
  allowedExtensionOriginValue = ''
) {
  const allowedOrigins = new Set(parseAllowedOrigins(allowedOriginValue))
  const allowedExtensionOrigins = new Set(
    parseAllowedExtensionOrigins(allowedExtensionOriginValue)
  )

  return (origin, callback) => {
    if (!origin) {
      callback(null, true)
      return
    }

    const normalized = normalizeOrigin(origin)
    callback(
      null,
      allowedOrigins.has(normalized) || allowedExtensionOrigins.has(normalized)
    )
  }
}

export function isUnsafeRequestOriginTrusted(
  request,
  allowedOriginValue,
  allowedExtensionOriginValue = ''
) {
  if (SAFE_METHODS.has(String(request.method || '').toUpperCase())) {
    return true
  }

  const originHeader = String(request.headers?.origin || '')
  const fetchSite = String(request.headers?.['sec-fetch-site'] || '').toLowerCase()

  if (!originHeader) {
    return new Set(['same-origin', 'same-site', 'none']).has(fetchSite)
  }

  const origin = normalizeOrigin(originHeader)
  if (!origin || origin === 'null') {
    return false
  }

  if (isExtensionOrigin(origin)) {
    return isAllowedExtensionOrigin(origin, allowedExtensionOriginValue)
  }

  const allowedOrigins = new Set(parseAllowedOrigins(allowedOriginValue))
  return allowedOrigins.has(origin)
}
