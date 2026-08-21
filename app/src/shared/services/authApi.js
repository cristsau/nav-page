import { CURRENT_USER_STORAGE_KEY } from '@/shared/db/database'
import { apiRequest as request } from '@/shared/services/apiClient'

const AUTH_MODE = import.meta.env.VITE_AUTH_MODE || 'local'

function setCurrentUserId(userId) {
  if (typeof window === 'undefined' || !window.localStorage) return

  if (userId) {
    window.localStorage.setItem(CURRENT_USER_STORAGE_KEY, userId)
  } else {
    window.localStorage.removeItem(CURRENT_USER_STORAGE_KEY)
  }
}

export function isBackendAuthEnabled() {
  return AUTH_MODE === 'backend'
}

export async function fetchBackendSession() {
  const payload = await request('/auth/session', {
    method: 'GET',
    cache: 'no-store'
  })
  const user = payload.user || null
  setCurrentUserId(user?.id || null)
  return user
}

export async function loginWithBackend(username, password) {
  const payload = await request('/auth/login', {
    method: 'POST',
    expectedUnauthorized: true,
    body: JSON.stringify({ username, password })
  })

  setCurrentUserId(payload.user?.id || null)
  return payload.user
}

export async function logoutWithBackend() {
  await request('/auth/logout', { method: 'POST', body: JSON.stringify({}) })
  setCurrentUserId(null)
}

export async function updateBackendUsername(payload) {
  const result = await request('/auth/account/username', {
    method: 'PUT',
    body: JSON.stringify(payload)
  })
  setCurrentUserId(result.user?.id || null)
  return result
}

export async function updateBackendPassword(payload) {
  const result = await request('/auth/account/password', {
    method: 'PUT',
    body: JSON.stringify(payload)
  })
  setCurrentUserId(null)
  return result
}

export async function fetchBackendSessions() {
  const result = await request('/auth/sessions', {
    method: 'GET',
    cache: 'no-store'
  })
  return Array.isArray(result.sessions) ? result.sessions : []
}

export async function revokeBackendSession(sessionId) {
  const result = await request(
    `/auth/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' }
  )

  if (result.currentSessionRevoked) {
    setCurrentUserId(null)
  }

  return result
}

export async function revokeOtherBackendSessions() {
  return request('/auth/sessions/revoke-others', {
    method: 'POST'
  })
}

export async function revokeAllBackendSessions() {
  const result = await request('/auth/sessions/revoke-all', {
    method: 'POST'
  })
  setCurrentUserId(null)
  return result
}

export async function fetchBackendRecoveryCodeStatus() {
  const result = await request('/auth/recovery-codes/status', {
    method: 'GET',
    cache: 'no-store'
  })

  return {
    configured: Boolean(result.configured),
    activeCodeCount: Number(result.activeCodeCount || 0),
    generatedAt: result.generatedAt || null
  }
}

export async function rotateBackendRecoveryCodes(currentPassword) {
  const result = await request('/auth/recovery-codes', {
    method: 'POST',
    body: JSON.stringify({ currentPassword })
  })

  return {
    codes: Array.isArray(result.codes) ? result.codes : [],
    generatedAt: result.generatedAt || null,
    warning: result.warning || ''
  }
}

export async function recoverBackendAccount(payload) {
  const result = await request('/auth/recover', {
    method: 'POST',
    expectedUnauthorized: true,
    body: JSON.stringify(payload)
  })
  setCurrentUserId(null)
  return result
}

export async function registerWithBackend(payload) {
  const result = await request('/auth/register', {
    method: 'POST',
    expectedUnauthorized: true,
    body: JSON.stringify(payload)
  })

  return result.request
}

export async function fetchBackendApprovedUsers() {
  const result = await request('/admin/users', { method: 'GET' })
  return result.users || []
}

export async function fetchBackendRegistrationRequests(status = 'all') {
  const result = await request(`/admin/registration-requests?status=${encodeURIComponent(status)}`, {
    method: 'GET'
  })

  return result.requests || []
}

export async function approveBackendRegistration(requestId) {
  const result = await request(`/admin/registration-requests/${requestId}/approve`, {
    method: 'POST',
    body: JSON.stringify({})
  })

  return result.request
}

export async function rejectBackendRegistration(requestId) {
  const result = await request(`/admin/registration-requests/${requestId}/reject`, {
    method: 'POST',
    body: JSON.stringify({})
  })

  return result.request
}
