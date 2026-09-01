import { config } from '../config.js'
import { assertManagedMailUpdateAvailable } from './managedIntegrations.js'
import { getEmailOauthRuntime } from './managedOauthIntegrations.js'

const TOKEN_ENDPOINTS = Object.freeze({
  google: 'https://oauth2.googleapis.com/token'
})

function microsoftTokenEndpoint(tenant) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`
}

function assertProvider(provider) {
  const value = String(provider || '').trim().toLowerCase()
  if (value !== 'google' && value !== 'microsoft') {
    throw new Error('Email OAuth provider is not configured')
  }
  return value
}

export async function refreshEmailAccessToken(provider, {
  runtimeConfig = config,
  fetchImpl = fetch
} = {}) {
  const normalized = assertProvider(provider)
  const oauth = await getEmailOauthRuntime(normalized, runtimeConfig)
  if (!oauth.enabled) throw new Error('Email OAuth provider is disabled or incomplete')
  const endpoint = normalized === 'google'
    ? TOKEN_ENDPOINTS.google
    : microsoftTokenEndpoint(oauth.tenant)
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: oauth.clientId,
    client_secret: oauth.clientSecret,
    refresh_token: oauth.refreshToken
  })
  if (normalized === 'microsoft' && oauth.scope) body.set('scope', oauth.scope)
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body,
    signal: AbortSignal.timeout(12_000)
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.error || !payload.access_token) {
    throw new Error('Email OAuth access token refresh failed')
  }
  return {
    provider: normalized,
    accessToken: String(payload.access_token),
    expiresIn: Number(payload.expires_in || 0)
  }
}

export function emailOauthConfigured(runtimeConfig = config) {
  const provider = String(runtimeConfig.imapOauthProvider || runtimeConfig.smtpOauthProvider || '').trim().toLowerCase()
  return provider === 'google' || provider === 'microsoft'
}

async function assertManagedCredentialReadStable(runtimeConfig) {
  if (runtimeConfig?.emailManagedAccount !== true) return
  await assertManagedMailUpdateAvailable(runtimeConfig)
}

export async function resolveImapAuth(runtimeConfig = config, {
  readSecretImpl,
  tokenProvider = refreshEmailAccessToken
} = {}) {
  await assertManagedCredentialReadStable(runtimeConfig)
  const provider = String(runtimeConfig.imapOauthProvider || '').trim().toLowerCase()
  if (provider) {
    const token = await tokenProvider(provider, { runtimeConfig })
    await assertManagedCredentialReadStable(runtimeConfig)
    return { user: String(runtimeConfig.imapUsername || '').trim(), accessToken: token.accessToken }
  }
  if (!readSecretImpl || !runtimeConfig.imapPasswordFile) {
    throw new Error('IMAP password file is not configured')
  }
  const password = await readSecretImpl(runtimeConfig.imapPasswordFile, {
    label: 'IMAP password',
    maxBytes: 4096
  })
  await assertManagedCredentialReadStable(runtimeConfig)
  return { user: String(runtimeConfig.imapUsername || '').trim(), pass: password }
}

export async function resolveSmtpAuth(runtimeConfig = config, {
  readSecretImpl,
  tokenProvider = refreshEmailAccessToken
} = {}) {
  await assertManagedCredentialReadStable(runtimeConfig)
  const provider = String(runtimeConfig.smtpOauthProvider || '').trim().toLowerCase()
  if (provider) {
    const token = await tokenProvider(provider, { runtimeConfig })
    await assertManagedCredentialReadStable(runtimeConfig)
    return {
      type: 'OAuth2',
      user: String(runtimeConfig.smtpUsername || '').trim(),
      accessToken: token.accessToken
    }
  }
  if (!readSecretImpl || !runtimeConfig.smtpPasswordFile) {
    throw new Error('SMTP password file is not configured')
  }
  const password = await readSecretImpl(runtimeConfig.smtpPasswordFile, {
    label: 'SMTP password',
    maxBytes: 4096
  })
  await assertManagedCredentialReadStable(runtimeConfig)
  return { user: String(runtimeConfig.smtpUsername || '').trim(), pass: password }
}

export const EMAIL_OAUTH_TOKEN_ENDPOINTS = Object.freeze({
  ...TOKEN_ENDPOINTS,
  microsoft: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token'
})
