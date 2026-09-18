// Operator-only bootstrap. No NAV database, server login, file API or backup job.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

export const SCOPES = Object.freeze([
  'account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write'
])
export const REDIRECT_URI = 'http://127.0.0.1:53682/dropbox/callback'
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'
const ACCOUNT_URL = 'https://api.dropboxapi.com/2/users/get_current_account'

export class AuthorizationError extends Error {
  constructor(code) { super(code); this.name = 'AuthorizationError' }
}
const fail = (code) => { throw new AuthorizationError(code) }

export function validateClientId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9]{8,80}$/.test(value)) fail('invalid_app_key')
  return value
}

export function challenge(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function createAttempt(clientId) {
  validateClientId(clientId)
  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const url = new URL('https://www.dropbox.com/oauth2/authorize')
  url.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: challenge(verifier),
    state, scope: SCOPES.join(' '), token_access_type: 'offline'
  }).toString()
  return { clientId, verifier, state, url: url.toString() }
}

export function parseCallback(rawUrl, host, expectedHost, state) {
  if (host !== expectedHost || typeof rawUrl !== 'string' || rawUrl.length > 8192
      || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) fail('invalid_callback')
  let url
  try { url = new URL(rawUrl, `http://${expectedHost}`) } catch { fail('invalid_callback') }
  if (url.pathname !== '/dropbox/callback' || url.hash) fail('invalid_callback')
  const supplied = url.searchParams.getAll('state')
  if (supplied.length !== 1) fail('invalid_state')
  const actual = Buffer.from(supplied[0])
  const expected = Buffer.from(state)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('invalid_state')
  const codes = url.searchParams.getAll('code')
  const errors = url.searchParams.getAll('error')
  if (errors.length === 1 && codes.length === 0) return { denied: true }
  if (errors.length || codes.length !== 1 || !codes[0] || codes[0].length > 4096
      || /[\x00-\x20\x7f]/.test(codes[0])) fail('invalid_callback')
  return { code: codes[0] }
}

export async function startReceiver({ state, port = 53682, timeoutMs = 600_000 } = {}) {
  if (typeof state !== 'string' || state.length < 32) fail('invalid_state')
  let used = false
  let resolveResult, rejectResult, timer
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  // Caller may still be opening the browser when cancellation occurs.
  result.catch(() => {})
  const server = createServer({ maxHeaderSize: 10_240 }, (req, res) => {
    const expectedHost = `127.0.0.1:${server.address()?.port}`
    const respond = (status, message, extra = {}) => {
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        Connection: 'close', ...extra
      })
      res.end(message)
    }
    if (req.method !== 'GET' || req.headers.host !== expectedHost) {
      respond(400, 'Invalid request.'); return
    }
    if (req.url === '/done') {
      respond(200, 'Dropbox 授权已返回，请回到本机授权窗口确认账号。此页面不表示备份已启用。')
      return
    }
    if (used) { respond(409, 'This authorization attempt has already been used.'); return }
    let parsed
    try { parsed = parseCallback(req.url, req.headers.host, expectedHost, state) }
    catch { respond(400, 'Invalid authorization callback.'); return }
    used = true
    clearTimeout(timer)
    respond(303, '', { Location: '/done' })
    if (parsed.denied) rejectResult(new AuthorizationError('user_denied'))
    else resolveResult(parsed.code)
  })
  server.headersTimeout = 5000
  server.requestTimeout = 5000
  server.setTimeout(5000, (socket) => socket.destroy())
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new AuthorizationError('callback_port_unavailable')))
    server.listen(port, '127.0.0.1', resolve)
  })
  const stop = () => {
    clearTimeout(timer)
    if (!used) { used = true; rejectResult(new AuthorizationError('authorization_cancelled')) }
    server.close()
    server.closeAllConnections()
  }
  timer = setTimeout(() => {
    used = true
    rejectResult(new AuthorizationError('authorization_timed_out'))
    stop()
  }, timeoutMs)
  return { result, stop, address: server.address() }
}

async function boundedJson(response) {
  if (!response.ok) fail(`dropbox_http_${Number(response.status) || 0}`)
  const declared = Number(response.headers.get('content-length'))
  if (declared > 65_536) fail('dropbox_response_too_large')
  const reader = response.body?.getReader()
  if (!reader) fail('invalid_dropbox_response')
  let length = 0
  const chunks = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 65_536) fail('dropbox_response_too_large')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof AuthorizationError) throw error
    fail('invalid_dropbox_response')
  } finally { reader.releaseLock() }
}

async function post(url, headers, body, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000)
    })
    return await boundedJson(response)
  } catch (error) {
    if (error instanceof AuthorizationError) throw error
    fail('dropbox_network_or_response_error')
  }
}

function tokenString(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 16_384
    && !/[\x00-\x20\x7f]/.test(value)
}

export function validateTokens(tokens, { requireRefresh = true } = {}) {
  if (!tokens || tokens.error || String(tokens.token_type).toLowerCase() !== 'bearer'
      || !tokenString(tokens.access_token) || (requireRefresh && !tokenString(tokens.refresh_token))) {
    fail('invalid_oauth_tokens')
  }
  if (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) fail('invalid_token_expiry')
  const granted = new Set(String(tokens.scope || '').split(/\s+/).filter(Boolean))
  if (granted.size !== SCOPES.length || SCOPES.some(scope => !granted.has(scope))) fail('unexpected_oauth_scopes')
  return tokens
}

export async function exchangeAndVerify(attempt, code, { fetchImpl = fetch } = {}) {
  validateClientId(attempt.clientId)
  if (!tokenString(code) || !/^[A-Za-z0-9_-]{43,128}$/.test(attempt.verifier)) fail('invalid_oauth_request')
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  const tokens = validateTokens(await post(TOKEN_URL, headers, new URLSearchParams({
    grant_type: 'authorization_code', client_id: attempt.clientId, code,
    code_verifier: attempt.verifier, redirect_uri: REDIRECT_URI
  }), fetchImpl))
  if (!tokenString(tokens.account_id)) fail('missing_account_id')
  // Prove the offline refresh path without client_secret before persisting anything.
  const refreshed = await post(TOKEN_URL, headers, new URLSearchParams({
    grant_type: 'refresh_token', client_id: attempt.clientId, refresh_token: tokens.refresh_token
  }), fetchImpl)
  // Dropbox may omit scope on a refresh; it is then unchanged from the exact initial grant.
  validateTokens({ ...refreshed, scope: refreshed.scope ?? tokens.scope }, { requireRefresh: false })
  const account = await post(ACCOUNT_URL, {
    Authorization: `Bearer ${refreshed.access_token}`, 'Content-Type': 'application/json'
  }, 'null', fetchImpl)
  if (account.account_id !== tokens.account_id || account.disabled === true) fail('account_mismatch_or_disabled')
  return {
    display: String(account.email || account.name?.display_name || '(account information unavailable)'),
    credentials: {
      schema_version: 1, provider: 'dropbox', client_id: attempt.clientId,
      refresh_token: tokens.refresh_token, account_id: tokens.account_id,
      scopes: [...SCOPES], authorized_at: new Date().toISOString()
    }
  }
}
