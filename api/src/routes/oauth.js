import { config } from '../config.js'
import { query, withTransaction } from '../db/index.js'
import { createSessionToken, hashSessionToken, verifyPassword } from '../lib/auth.js'
import {
  getIdentityProviderRuntime,
  getManagedOauthState,
  getOauthInternalKeys,
  identityOauthCallbacks,
  saveIdentityOauthConfig,
  withOauthIntegrationMutation
} from '../lib/managedOauthIntegrations.js'
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchGoogleDiscovery,
  randomOauthValue,
  safeReturnPath,
  sha256,
  signOauthCookie,
  subjectDigest,
  verifyOauthCookie
} from '../lib/oauthProtocol.js'
import { recordSecurityEvent, recordSecurityEventBestEffort } from '../lib/securityEvents.js'
import {
  applyRateLimitReply,
  applyRateLimitUnavailableReply,
  consumePublicAuthRateLimit
} from '../lib/requestRateLimit.js'
import { isReleaseAcceptanceUsername } from '../ops/releaseAcceptanceAccount.js'

const PROVIDERS = new Set(['google', 'wechat'])
const ORIGINS = new Map([
  ['nav.skrskr.net', 'https://nav.skrskr.net'],
  ['nav.cristsau.cn', 'https://nav.cristsau.cn']
])
const TRANSACTION_COOKIE = 'nav_oauth_transaction'
const TRANSACTION_TTL_SECONDS = 600
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function providerName(value) {
  const provider = String(value || '').trim().toLowerCase()
  if (!PROVIDERS.has(provider)) {
    const error = new TypeError('OAuth Provider 无效')
    error.statusCode = 400
    throw error
  }
  return provider
}

function exactOrigin(request) {
  const hostname = String(request.hostname || '').split(':', 1)[0].toLowerCase()
  const origin = ORIGINS.get(hostname)
  if (!origin) {
    const error = new Error('当前域名不允许发起 OAuth 登录')
    error.statusCode = 403
    throw error
  }
  return origin
}

function callbackUri(origin, provider) {
  return `${origin}/api/auth/oauth/${provider}/callback`
}

function setTransactionCookie(reply, value) {
  reply.setCookie(TRANSACTION_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/auth/oauth',
    maxAge: TRANSACTION_TTL_SECONDS
  })
}

function clearTransactionCookie(reply) {
  reply.clearCookie(TRANSACTION_COOKIE, { path: '/api/auth/oauth' })
}

async function audit(request, eventType, outcome, options = {}) {
  await recordSecurityEventBestEffort({
    request,
    eventType,
    outcome,
    actorUserId: options.actorUserId || request.currentUser?.id || null,
    subjectUserId: options.subjectUserId || request.currentUser?.id || null,
    resourceType: options.resourceType || null,
    resourceId: options.resourceId || null,
    affectedCount: options.affectedCount ?? null
  }, request.log)
}

async function enforceOauthStartRateLimit(request, reply, provider) {
  try {
    const result = await consumePublicAuthRateLimit('login', request, `oauth:${provider}`)
    if (!applyRateLimitReply(reply, result)) return false
    reply.send({ error: '外部登录尝试过于频繁，请稍后重试' })
    return true
  } catch (error) {
    if (!applyRateLimitUnavailableReply(reply, error)) throw error
    request.log.error(error, 'persistent oauth rate limiter unavailable')
    reply.send({ error: '安全限流暂时不可用，请稍后重试' })
    return true
  }
}

async function createAuthorization(request, reply, {
  provider,
  flow,
  userId = null,
  returnTo = '/'
}) {
  const origin = exactOrigin(request)
  const runtime = await getIdentityProviderRuntime(provider)
  if (!runtime.enabled) {
    reply.code(503)
    return { error: '该外部登录方式尚未启用或配置不完整' }
  }
  const { stateKey } = await getOauthInternalKeys()
  const state = randomOauthValue(32)
  const nonce = randomOauthValue(32)
  const verifier = randomOauthValue(64)
  const returnPath = safeReturnPath(
    returnTo,
    flow === 'link' ? '/settings?category=security' : '/'
  )
  const expiresAt = Date.now() + TRANSACTION_TTL_SECONDS * 1000
  await query(
    `DELETE FROM oauth_authorization_requests
     WHERE expires_at < NOW() - INTERVAL '1 day'`
  )
  await query(
    `INSERT INTO oauth_authorization_requests (
       provider, flow, user_id, state_digest, nonce_digest,
       origin, return_path, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, TO_TIMESTAMP($8 / 1000.0))`,
    [provider, flow, userId, sha256(state), sha256(nonce), origin, returnPath, expiresAt]
  )
  const transaction = {
    provider,
    flow,
    state,
    nonce,
    verifier,
    origin,
    redirectUri: callbackUri(origin, provider),
    expiresAt
  }
  setTransactionCookie(reply, signOauthCookie(transaction, stateKey))
  return {
    provider,
    authorizationUrl: await buildAuthorizationUrl(provider, runtime, transaction)
  }
}

async function loadApprovedOauthUser(client, provider, profile, runtime, subjectKey) {
  const digest = subjectDigest(provider, profile.subject, subjectKey)
  const identity = await client.query(
    `SELECT oi.id AS identity_id, u.*
     FROM oauth_identities oi
     JOIN users u ON u.id = oi.user_id
     WHERE oi.provider = $1 AND oi.subject_digest = $2
     LIMIT 1 FOR UPDATE OF oi, u`,
    [provider, digest]
  )
  if (identity.rows[0]) return identity.rows[0]

  if (
    provider !== 'google'
    || !runtime.allowVerifiedEmailAutoLink
    || !profile.emailVerified
    || !profile.email
  ) return null

  const candidates = await client.query(
    `SELECT * FROM users
     WHERE LOWER(email) = LOWER($1)
       AND email_verified_at IS NOT NULL
       AND status = 'approved'
     ORDER BY id
     LIMIT 2 FOR UPDATE`,
    [profile.email]
  )
  if (candidates.rowCount !== 1) return null
  const user = candidates.rows[0]
  if (!user || isReleaseAcceptanceUsername(user.username)) return null
  const linked = await client.query(
    `INSERT INTO oauth_identities (
       user_id, provider, subject_digest, email_verified_at, last_used_at
     ) VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (provider, subject_digest) DO NOTHING RETURNING id`,
    [user.id, provider, digest]
  )
  return linked.rows[0] ? { ...user, identity_id: linked.rows[0].id } : null
}

async function createOauthSession(client, request, user) {
  if (!user || user.status !== 'approved' || isReleaseAcceptanceUsername(user.username)) return null
  const token = createSessionToken()
  const session = await client.query(
    `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)
     RETURNING id`,
    [user.id, hashSessionToken(token), request.ip, request.headers['user-agent'] || '', String(config.sessionTtlDays)]
  )
  const updated = await client.query(
    'UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *',
    [user.id]
  )
  await client.query('UPDATE oauth_identities SET last_used_at = NOW() WHERE id = $1', [user.identity_id])
  await recordSecurityEvent({
    client,
    request,
    eventType: 'auth.oauth.login',
    outcome: 'success',
    actorUserId: user.id,
    subjectUserId: user.id,
    resourceType: 'session',
    resourceId: session.rows[0].id,
    affectedCount: 1
  })
  return { token, user: updated.rows[0] }
}

async function linkIdentity(request, transaction, provider, profile, digest) {
  return withTransaction(async (client) => {
    const result = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [transaction.userId])
    const user = result.rows[0]
    if (!user || user.status !== 'approved' || isReleaseAcceptanceUsername(user.username)) return null
    if (provider === 'google') {
      if (!profile.emailVerified || !profile.email) throw new Error('Google email is not verified')
      if (user.email && user.email.toLowerCase() !== profile.email.toLowerCase()) {
        throw new Error('Google email does not match this account')
      }
      if (!user.email) {
        await client.query(
          'UPDATE users SET email = $2, email_verified_at = NOW(), updated_at = NOW() WHERE id = $1',
          [user.id, profile.email]
        )
      } else if (!user.email_verified_at) {
        await client.query(
          'UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1',
          [user.id]
        )
      }
    }
    const identity = await client.query(
      `INSERT INTO oauth_identities (user_id, provider, subject_digest, email_verified_at)
       VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN NOW() ELSE NULL END)
       RETURNING id`,
      [user.id, provider, digest, profile.emailVerified === true]
    )
    await recordSecurityEvent({
      client,
      request,
      eventType: 'auth.oauth.link',
      outcome: 'success',
      actorUserId: user.id,
      subjectUserId: user.id,
      resourceType: 'oauth_identity',
      resourceId: identity.rows[0].id,
      affectedCount: 1
    })
    return identity.rows[0]
  })
}

export default async function oauthRoutes(fastify) {
  fastify.get('/auth/oauth/config', {
    config: { skipSession: true }
  }, async (_request, reply) => {
    const state = await getManagedOauthState()
    reply.header('Cache-Control', 'public, max-age=60')
    return {
      providers: {
        google: { enabled: state.identity.google.enabled && state.identity.google.secretConfigured },
        wechat: { enabled: state.identity.wechat.enabled && state.identity.wechat.secretConfigured }
      }
    }
  })

  fastify.post('/auth/oauth/:provider/start', {
    config: { skipSession: true }
  }, async (request, reply) => {
    const provider = providerName(request.params.provider)
    if (await enforceOauthStartRateLimit(request, reply, provider)) return
    return createAuthorization(request, reply, {
      provider,
      flow: 'login',
      returnTo: request.body?.returnTo
    })
  })

  fastify.post('/auth/oauth/:provider/link/start', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (isReleaseAcceptanceUsername(request.currentUser.username)) {
      reply.code(403)
      return { error: '临时验收账号不能绑定外部身份' }
    }
    const currentPassword = String(request.body?.currentPassword || '')
    const result = await query('SELECT password_hash FROM users WHERE id = $1', [request.currentUser.id])
    if (!currentPassword || !result.rows[0] || !await verifyPassword(currentPassword, result.rows[0].password_hash)) {
      reply.code(400)
      return { error: 'Current password is incorrect' }
    }
    return createAuthorization(request, reply, {
      provider: providerName(request.params.provider),
      flow: 'link',
      userId: request.currentUser.id,
      returnTo: request.body?.returnTo || '/settings?category=security'
    })
  })

  fastify.get('/auth/oauth/:provider/callback', async (request, reply) => {
    const provider = providerName(request.params.provider)
    const origin = exactOrigin(request)
    const { stateKey, subjectKey } = await getOauthInternalKeys()
    let transaction
    try {
      transaction = verifyOauthCookie(request.cookies[TRANSACTION_COOKIE], stateKey)
      if (
        transaction.provider !== provider
        || transaction.origin !== origin
        || transaction.redirectUri !== callbackUri(origin, provider)
        || transaction.state !== String(request.query?.state || '')
        || Number(transaction.expiresAt || 0) <= Date.now()
      ) throw new Error('OAuth transaction is invalid')
      const consumed = await query(
        `UPDATE oauth_authorization_requests SET consumed_at = NOW()
         WHERE state_digest = $1 AND nonce_digest = $2
           AND provider = $3 AND flow = $4 AND origin = $5
           AND consumed_at IS NULL AND expires_at > NOW()
         RETURNING user_id, return_path`,
        [sha256(transaction.state), sha256(transaction.nonce), provider, transaction.flow, origin]
      )
      if (!consumed.rows[0]) throw new Error('OAuth transaction is invalid or expired')
      transaction.userId = consumed.rows[0].user_id
      transaction.returnPath = safeReturnPath(consumed.rows[0].return_path)
    } catch {
      clearTransactionCookie(reply)
      await audit(request, transaction?.flow === 'link' ? 'auth.oauth.link' : 'auth.oauth.login', 'failure')
      return reply.redirect(`${origin}/auth?oauth_error=invalid_transaction`)
    }
    clearTransactionCookie(reply)

    try {
      const runtime = await getIdentityProviderRuntime(provider)
      if (!runtime.enabled) throw new Error('OAuth provider is disabled')
      const code = String(request.query?.code || '')
      if (!code || code.length > 4096) throw new Error('OAuth code is invalid')
      const profile = await exchangeAuthorizationCode(provider, runtime, transaction, code)
      const digest = subjectDigest(provider, profile.subject, subjectKey)

      if (transaction.flow === 'link') {
        if (!request.currentUser || request.currentUser.id !== transaction.userId) {
          throw new Error('Linking session is no longer valid')
        }
        const linked = await linkIdentity(request, transaction, provider, profile, digest)
        if (!linked) throw new Error('Account cannot be linked')
        const join = transaction.returnPath.includes('?') ? '&' : '?'
        return reply.redirect(`${origin}${transaction.returnPath}${join}oauth_linked=${provider}`)
      }

      const login = await withTransaction(async (client) => {
        const user = await loadApprovedOauthUser(client, provider, profile, runtime, subjectKey)
        return createOauthSession(client, request, user)
      })
      if (!login) {
        await audit(request, 'auth.oauth.login', 'denied')
        return reply.redirect(`${origin}/auth?oauth_error=not_linked`)
      }
      await fastify.setSessionCookie(reply, login.token)
      return reply.redirect(`${origin}${transaction.returnPath}`)
    } catch (error) {
      await audit(request, transaction.flow === 'link' ? 'auth.oauth.link' : 'auth.oauth.login', 'failure', {
        subjectUserId: transaction.userId || null
      })
      request.log.warn({ err: error, provider }, 'oauth callback failed')
      return reply.redirect(`${origin}/auth?oauth_error=provider_failed`)
    }
  })

  fastify.get('/auth/oauth/identities', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const result = await query(
      `SELECT id, provider, email_verified_at, created_at, last_used_at
       FROM oauth_identities WHERE user_id = $1 ORDER BY created_at ASC`,
      [request.currentUser.id]
    )
    return {
      identities: result.rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        emailVerifiedAt: row.email_verified_at,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at
      }))
    }
  })

  fastify.delete('/auth/oauth/identities/:id', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (!UUID_PATTERN.test(String(request.params.id || ''))) {
      reply.code(400)
      return { error: '外部身份 ID 无效' }
    }
    if (isReleaseAcceptanceUsername(request.currentUser.username)) {
      reply.code(403)
      return { error: '临时验收账号不能修改外部身份' }
    }
    const currentPassword = String(request.body?.currentPassword || '')
    const result = await withTransaction(async (client) => {
      const user = await client.query('SELECT password_hash FROM users WHERE id = $1 FOR UPDATE', [request.currentUser.id])
      if (!currentPassword || !user.rows[0] || !await verifyPassword(currentPassword, user.rows[0].password_hash)) {
        return 'password'
      }
      if (!user.rows[0].password_hash) return 'lockout'
      const deleted = await client.query(
        'DELETE FROM oauth_identities WHERE id = $1 AND user_id = $2 RETURNING id',
        [request.params.id, request.currentUser.id]
      )
      if (!deleted.rows[0]) return 'missing'
      await recordSecurityEvent({
        client,
        request,
        eventType: 'auth.oauth.unlink',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'oauth_identity',
        resourceId: deleted.rows[0].id,
        affectedCount: 1
      })
      return 'deleted'
    })
    if (result === 'password') {
      reply.code(400)
      return { error: 'Current password is incorrect' }
    }
    if (result === 'lockout') {
      reply.code(409)
      return { error: '解绑会导致账号无法登录，请先设置密码' }
    }
    if (result === 'missing') {
      reply.code(404)
      return { error: '外部身份不存在' }
    }
    return { deleted: true }
  })

  fastify.get('/admin/oauth-integrations', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const { identity, callbacks, writable, updatedAt } = await getManagedOauthState()
    return { identity, callbacks, writable, updatedAt }
  })

  fastify.put('/admin/oauth-integrations/identity', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    try {
      const identity = await withOauthIntegrationMutation(() => saveIdentityOauthConfig(request.body || {}))
      await audit(request, 'admin.integrations.oauth.updated', 'success', {
        resourceType: 'oauth_integration', affectedCount: 1
      })
      return { identity }
    } catch (error) {
      await audit(request, 'admin.integrations.oauth.updated', 'denied', { resourceType: 'oauth_integration' })
      reply.code(error instanceof TypeError ? 400 : 503)
      return { error: String(error.message || 'OAuth 配置保存失败').slice(0, 240) }
    }
  })

  fastify.post('/admin/oauth-integrations/identity/:provider/test', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    const provider = providerName(request.params.provider)
    try {
      const result = provider === 'google'
        ? { discovery: await fetchGoogleDiscovery(), callbackUris: identityOauthCallbacks().google }
        : { fixedEndpoints: true, callbackUris: identityOauthCallbacks().wechat }
      await audit(request, 'admin.integrations.oauth.tested', 'success', { resourceType: 'oauth_integration' })
      return { provider, structureValid: true, ...result }
    } catch {
      await audit(request, 'admin.integrations.oauth.tested', 'failure', { resourceType: 'oauth_integration' })
      reply.code(502)
      return { error: 'Provider 发现端点当前不可用或返回了不可信配置' }
    }
  })

}
