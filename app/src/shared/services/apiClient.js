const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || '/api'

function hasContentTypeHeader(headers) {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
}

export function buildApiRequestOptions(options = {}) {
  const headers = { ...(options.headers || {}) }
  const hasBody = options.body !== undefined && options.body !== null

  if (hasBody && !hasContentTypeHeader(headers)) {
    headers['Content-Type'] = 'application/json'
  }

  return {
    ...options,
    credentials: options.credentials ?? 'include',
    headers
  }
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
    throw new Error(payload.error || `Request failed: ${response.status}`)
  }

  return payload
}
