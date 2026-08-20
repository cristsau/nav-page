const SHARE_CODE_PATTERN = /^[A-Za-z0-9]{8}$/

function isLocalHostname(hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
}

export function normalizePublicAppOrigin(value, {
  allowLocalHttp = false
} = {}) {
  const input = String(value || '').trim()
  if (!input) return ''

  try {
    const url = new URL(input)
    const localHttp = allowLocalHttp
      && url.protocol === 'http:'
      && isLocalHostname(url.hostname)

    if (
      (url.protocol !== 'https:' && !localHttp)
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return ''
    }

    return url.origin
  } catch {
    return ''
  }
}

export function resolvePublicAppOrigin({
  configuredOrigin = import.meta.env?.VITE_PUBLIC_APP_ORIGIN,
  runtimeOrigin = globalThis.location?.origin,
  production = Boolean(import.meta.env?.PROD)
} = {}) {
  const configured = normalizePublicAppOrigin(configuredOrigin, {
    allowLocalHttp: !production
  })
  if (configured) return configured

  if (production) {
    throw new Error('VITE_PUBLIC_APP_ORIGIN must be a bare HTTPS origin')
  }

  const runtime = normalizePublicAppOrigin(runtimeOrigin, {
    allowLocalHttp: true
  })
  if (runtime) return runtime

  throw new Error('Public application origin is not configured')
}

export function buildPublicShareUrl(code, options = {}) {
  const normalizedCode = String(code || '').trim()
  if (!SHARE_CODE_PATTERN.test(normalizedCode)) {
    throw new Error('Invalid public share code')
  }

  return new URL(
    `/share/${encodeURIComponent(normalizedCode)}`,
    resolvePublicAppOrigin(options)
  ).href
}
