const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || '/api'
const EXPECTED_UNAUTHORIZED_PATHS = new Set([
  '/auth/login',
  '/auth/register',
  '/auth/recover'
])

const unauthorizedListeners = new Set()
let unauthorizedNotificationPending = false

function hasContentTypeHeader(headers) {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
}

export function buildApiRequestOptions(options = {}) {
  const {
    expectedUnauthorized: _expectedUnauthorized,
    ...requestOptions
  } = options
  const headers = { ...(requestOptions.headers || {}) }
  const hasBody = requestOptions.body !== undefined && requestOptions.body !== null

  if (hasBody && !hasContentTypeHeader(headers)) {
    headers['Content-Type'] = 'application/json'
  }

  return {
    ...requestOptions,
    credentials: requestOptions.credentials ?? 'include',
    headers
  }
}

function normalizeApiPath(path) {
  try {
    const pathname = new URL(String(path || ''), 'https://domo-nav.invalid').pathname
    return pathname.replace(/\/+$/, '') || '/'
  } catch {
    return (String(path || '').split('?', 1)[0].replace(/\/+$/, '') || '/')
  }
}

export function shouldNotifyUnauthorized(path, options = {}) {
  if (options.expectedUnauthorized === true) return false
  return !EXPECTED_UNAUTHORIZED_PATHS.has(normalizeApiPath(path))
}

export function onApiUnauthorized(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Unauthorized listener must be a function')
  }

  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

export function resetApiUnauthorizedNotification() {
  unauthorizedNotificationPending = false
}

function notifyUnauthorized(path) {
  if (unauthorizedNotificationPending) return
  unauthorizedNotificationPending = true

  const detail = { path: normalizeApiPath(path) }
  for (const listener of unauthorizedListeners) {
    try {
      listener(detail)
    } catch (error) {
      console.error('Failed to invalidate an unauthorized session:', error)
    }
  }

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('domo-nav:auth-unauthorized', { detail }))
  }
}

async function responseError(response, path, options) {
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() }
  const error = new Error(payload.error || `Request failed: ${response.status}`)
  error.status = response.status
  error.code = payload.code || ''
  error.payload = payload
  if (response.status === 401 && shouldNotifyUnauthorized(path, options)) {
    notifyUnauthorized(path)
  }
  return error
}

function downloadFilename(response) {
  const disposition = response.headers.get('content-disposition') || ''
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim())
    } catch {
      return utf8Match[1].trim()
    }
  }
  const quotedMatch = disposition.match(/filename="([^"]+)"/i)
  const plainMatch = disposition.match(/filename=([^;]+)/i)
  return (quotedMatch?.[1] || plainMatch?.[1] || 'download').trim()
}

export async function apiRequest(path, options = {}) {
  const response = await fetch(
    `${API_BASE_URL}${path}`,
    buildApiRequestOptions(options)
  )

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() }

  if (!response.ok) {
    const error = new Error(payload.error || `Request failed: ${response.status}`)
    error.status = response.status
    error.code = payload.code || ''
    error.payload = payload
    if (response.status === 401 && shouldNotifyUnauthorized(path, options)) {
      notifyUnauthorized(path)
    }
    throw error
  }

  return payload
}

export async function apiFileRequest(path, options = {}) {
  const response = await fetch(
    `${API_BASE_URL}${path}`,
    buildApiRequestOptions(options)
  )

  if (!response.ok) throw await responseError(response, path, options)

  return {
    blob: await response.blob(),
    filename: downloadFilename(response),
    count: Number(response.headers.get('x-nav-export-count') || 0),
    truncated: response.headers.get('x-nav-export-truncated') === 'true'
  }
}
