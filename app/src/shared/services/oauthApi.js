import { apiRequest as request } from '@/shared/services/apiClient'

export function fetchOauthLoginConfig() {
  return request('/auth/oauth/config', {
    method: 'GET',
    cache: 'no-store',
    expectedUnauthorized: true
  })
}

export function startOauthLogin(provider, returnTo) {
  return request(`/auth/oauth/${encodeURIComponent(provider)}/start`, {
    method: 'POST',
    expectedUnauthorized: true,
    body: JSON.stringify({ returnTo })
  })
}

export function fetchOauthIdentities() {
  return request('/auth/oauth/identities', { method: 'GET', cache: 'no-store' })
}

export function startOauthLink(provider, currentPassword, returnTo) {
  return request(`/auth/oauth/${encodeURIComponent(provider)}/link/start`, {
    method: 'POST',
    body: JSON.stringify({ currentPassword, returnTo })
  })
}

export function unlinkOauthIdentity(identityId, currentPassword) {
  return request(`/auth/oauth/identities/${encodeURIComponent(identityId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ currentPassword })
  })
}

export function fetchOauthIntegrationState() {
  return request('/admin/oauth-integrations', { method: 'GET', cache: 'no-store' })
}

export function saveIdentityOauthIntegration(payload) {
  return request('/admin/oauth-integrations/identity', {
    method: 'PUT',
    body: JSON.stringify(payload)
  })
}

export function testIdentityOauthIntegration(provider) {
  return request(`/admin/oauth-integrations/identity/${encodeURIComponent(provider)}/test`, {
    method: 'POST'
  })
}

export function saveEmailOauthIntegration(payload) {
  return request('/admin/oauth-integrations/email', {
    method: 'PUT',
    body: JSON.stringify(payload)
  })
}

export function testEmailOauthIntegration(provider) {
  return request(`/admin/oauth-integrations/email/${encodeURIComponent(provider)}/test`, {
    method: 'POST'
  })
}
