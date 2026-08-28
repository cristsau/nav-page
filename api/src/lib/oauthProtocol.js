import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature
} from 'node:crypto'
import { OAUTH_PROVIDER_ENDPOINTS } from './managedOauthIntegrations.js'

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])
const GOOGLE_ENDPOINT_HOSTS = new Set(['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com'])
const discoveryCache = new Map()

export function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

export function randomOauthValue(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

export function pkceChallenge(verifier) {
  return createHash('sha256').update(String(verifier || '')).digest('base64url')
}

export function subjectDigest(provider, subject, key) {
  const normalizedProvider = String(provider || '').trim().toLowerCase()
  const normalizedSubject = String(subject || '').trim()
  if (!normalizedProvider || !normalizedSubject || !key) throw new TypeError('OAuth subject is invalid')
  return createHmac('sha256', key)
    .update(`nav-oauth-subject\u0000${normalizedProvider}\u0000${normalizedSubject}`)
    .digest('hex')
}

export function signOauthCookie(payload, key) {
  const encoded = base64Url(JSON.stringify(payload))
  const signature = createHmac('sha256', key).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

export function verifyOauthCookie(value, key) {
  const [encoded, signature, extra] = String(value || '').split('.')
  if (!encoded || !signature || extra) throw new Error('OAuth transaction cookie is invalid')
  const expected = createHmac('sha256', key).update(encoded).digest()
  let supplied
  try { supplied = Buffer.from(signature, 'base64url') } catch { throw new Error('OAuth transaction cookie is invalid') }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('OAuth transaction cookie is invalid')
  }
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OAuth transaction cookie is invalid')
  }
  return parsed
}

function exactHttpsEndpoint(value, allowedHosts, label) {
  let endpoint
  try { endpoint = new URL(value) } catch { throw new Error(`${label} is invalid`) }
  if (
    endpoint.protocol !== 'https:'
    || endpoint.username
    || endpoint.password
    || endpoint.hash
    || !allowedHosts.has(endpoint.hostname.toLowerCase())
  ) {
    throw new Error(`${label} is not trusted`)
  }
  return endpoint.toString()
}

export async function fetchGoogleDiscovery({ fetchImpl = fetch, now = Date.now() } = {}) {
  const cached = discoveryCache.get('google')
  if (cached && cached.expiresAt > now) return cached.value
  const response = await fetchImpl(OAUTH_PROVIDER_ENDPOINTS.google.discovery, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000)
  })
  if (!response.ok) throw new Error('Google discovery endpoint is unavailable')
  const body = await response.json()
  if (!GOOGLE_ISSUERS.has(String(body.issuer || ''))) throw new Error('Google issuer is invalid')
  const value = {
    issuer: String(body.issuer),
    authorizationEndpoint: exactHttpsEndpoint(body.authorization_endpoint, GOOGLE_ENDPOINT_HOSTS, 'Google authorization endpoint'),
    tokenEndpoint: exactHttpsEndpoint(body.token_endpoint, GOOGLE_ENDPOINT_HOSTS, 'Google token endpoint'),
    jwksUri: exactHttpsEndpoint(body.jwks_uri, GOOGLE_ENDPOINT_HOSTS, 'Google JWKS endpoint')
  }
  discoveryCache.set('google', { value, expiresAt: now + 5 * 60 * 1000 })
  return value
}

async function postForm(url, values, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(12_000)
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.error) throw new Error('OAuth token exchange failed')
  return body
}

function parseJwt(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new Error('OIDC ID token is invalid')
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
      signature: Buffer.from(parts[2], 'base64url'),
      signingInput: Buffer.from(`${parts[0]}.${parts[1]}`)
    }
  } catch {
    throw new Error('OIDC ID token is invalid')
  }
}

async function verifyGoogleIdToken(token, { clientId, nonce, jwksUri, fetchImpl = fetch, now = Date.now() }) {
  const parsed = parseJwt(token)
  if (parsed.header.alg !== 'RS256' || !parsed.header.kid) throw new Error('OIDC signing algorithm is invalid')
  const jwksResponse = await fetchImpl(jwksUri, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000)
  })
  if (!jwksResponse.ok) throw new Error('Google signing keys are unavailable')
  const jwks = await jwksResponse.json()
  const jwk = Array.isArray(jwks.keys)
    ? jwks.keys.find((key) => (
        key.kid === parsed.header.kid
        && key.kty === 'RSA'
        && (!key.use || key.use === 'sig')
        && (!key.alg || key.alg === 'RS256')
      ))
    : null
  if (!jwk) throw new Error('OIDC signing key is unavailable')
  const valid = verifySignature('RSA-SHA256', parsed.signingInput, createPublicKey({ key: jwk, format: 'jwk' }), parsed.signature)
  if (!valid) throw new Error('OIDC signature is invalid')
  const payload = parsed.payload
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (
    !GOOGLE_ISSUERS.has(String(payload.iss || ''))
    || !audience.includes(clientId)
    || (audience.length > 1 && String(payload.azp || '') !== clientId)
    || String(payload.nonce || '') !== nonce
    || Number(payload.exp || 0) * 1000 <= now
    || Number(payload.iat || 0) * 1000 > now + 60_000
    || !String(payload.sub || '')
  ) {
    throw new Error('OIDC claims are invalid')
  }
  return {
    subject: String(payload.sub),
    email: String(payload.email || '').trim().toLowerCase(),
    emailVerified: payload.email_verified === true
  }
}

export async function buildAuthorizationUrl(provider, providerConfig, transaction, options = {}) {
  if (provider === 'google') {
    const discovery = await fetchGoogleDiscovery(options)
    const url = new URL(discovery.authorizationEndpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: providerConfig.clientId,
      redirect_uri: transaction.redirectUri,
      scope: 'openid email profile',
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: pkceChallenge(transaction.verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account'
    }).toString()
    return url.toString()
  }
  if (provider === 'wechat') {
    const url = new URL(OAUTH_PROVIDER_ENDPOINTS.wechat.authorization)
    url.search = new URLSearchParams({
      appid: providerConfig.clientId,
      redirect_uri: transaction.redirectUri,
      response_type: 'code',
      scope: 'snsapi_login',
      state: transaction.state
    }).toString()
    url.hash = 'wechat_redirect'
    return url.toString()
  }
  throw new TypeError('OAuth provider is invalid')
}

export async function exchangeAuthorizationCode(provider, providerConfig, transaction, code, options = {}) {
  if (provider === 'google') {
    const discovery = await fetchGoogleDiscovery(options)
    const token = await postForm(discovery.tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      client_id: providerConfig.clientId,
      client_secret: providerConfig.clientSecret,
      redirect_uri: transaction.redirectUri,
      code_verifier: transaction.verifier
    }, options)
    return verifyGoogleIdToken(token.id_token, {
      clientId: providerConfig.clientId,
      nonce: transaction.nonce,
      jwksUri: discovery.jwksUri,
      fetchImpl: options.fetchImpl,
      now: options.now
    })
  }
  if (provider === 'wechat') {
    const url = new URL(OAUTH_PROVIDER_ENDPOINTS.wechat.token)
    url.search = new URLSearchParams({
      appid: providerConfig.clientId,
      secret: providerConfig.clientSecret,
      code,
      grant_type: 'authorization_code'
    }).toString()
    const response = await (options.fetchImpl || fetch)(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    })
    const token = await response.json().catch(() => ({}))
    if (!response.ok || token.errcode || !token.openid) throw new Error('OAuth token exchange failed')
    return {
      subject: token.unionid ? `unionid:${token.unionid}` : `openid:${token.openid}`,
      email: '',
      emailVerified: false
    }
  }
  throw new TypeError('OAuth provider is invalid')
}

export function safeReturnPath(value, fallback = '/') {
  const text = String(value || '').trim()
  if (!text.startsWith('/') || text.startsWith('//') || CONTROL_PATTERN.test(text) || text.length > 1000) return fallback
  return text
}

const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/
