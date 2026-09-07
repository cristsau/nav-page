import fp from 'fastify-plugin'
import { config, isProduction } from '../config.js'
import { query } from '../db/index.js'
import { hashSessionToken, shouldTouchSession } from '../lib/auth.js'
import {
  applyRateLimitReply,
  applyRateLimitUnavailableReply,
  consumeAuthenticatedWriteRateLimit,
  isAuthenticatedWriteRequest
} from '../lib/requestRateLimit.js'
import { sanitizeUser } from '../lib/users.js'
import { actionRequestPath, passwordProtectedAction, consumeActionProof } from '../lib/authActionProof.js'
import {
  inspectReleaseAcceptanceLoginEligibility,
  isReleaseAcceptanceUsername
} from '../ops/releaseAcceptanceAccount.js'

async function authPlugin(fastify) {
  let nextExpiredSessionCleanupAt = 0
  let expiredSessionCleanupPromise = null

  fastify.decorateRequest('currentUser', null)
  fastify.decorateRequest('session', null)

  fastify.decorate('setSessionCookie', async (reply, token) => {
    const secure = (
      config.sessionCookieSecure
      || isProduction()
      || config.sessionCookieSameSite === 'none'
    )

    reply.setCookie(config.sessionCookieName, token, {
      httpOnly: true,
      secure,
      sameSite: config.sessionCookieSameSite,
      path: '/',
      maxAge: config.sessionTtlDays * 24 * 60 * 60
    })
  })

  fastify.decorate('clearSessionCookie', async (reply) => {
    reply.clearCookie(config.sessionCookieName, {
      path: '/',
      secure: config.sessionCookieSecure || isProduction() || config.sessionCookieSameSite === 'none',
      sameSite: config.sessionCookieSameSite
    })
  })

  fastify.decorate('requireAuth', async (request, reply) => {
    if (!request.currentUser) {
      reply.code(401)
      throw new Error('Authentication required')
    }
  })

  fastify.decorate('requireAdmin', async (request, reply) => {
    if (!request.currentUser) {
      reply.code(401)
      throw new Error('Authentication required')
    }

    if (request.currentUser.role !== 'admin') {
      reply.code(403)
      throw new Error('Admin access required')
    }
  })

  async function maybeCleanupExpiredSessions() {
    const now = Date.now()
    if (
      now < nextExpiredSessionCleanupAt
      || expiredSessionCleanupPromise
    ) {
      return
    }

    nextExpiredSessionCleanupAt = (
      now
      + config.sessionCleanupIntervalSeconds * 1000
    )
    expiredSessionCleanupPromise = query(
      'DELETE FROM sessions WHERE expires_at <= NOW()'
    )

    try {
      await expiredSessionCleanupPromise
    } catch (error) {
      fastify.log.error(error, 'failed to clean up expired sessions')
    } finally {
      expiredSessionCleanupPromise = null
    }
  }

  fastify.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.config?.skipSession) return

    const token = request.cookies[config.sessionCookieName]
    if (!token) return

    await maybeCleanupExpiredSessions()

    const tokenHash = hashSessionToken(token)
    const { rows } = await query(
      `
        SELECT
          s.id AS session_id,
          s.expires_at,
          s.last_seen_at,
          u.id,
          u.username,
          u.email,
          u.email_verified_at,
          u.role,
          u.status,
          u.created_at,
          u.updated_at,
          u.approved_at,
          u.last_login_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > NOW()
          AND u.status = 'approved'
        LIMIT 1
      `,
      [tokenHash]
    )

    if (!rows.length) {
      await fastify.clearSessionCookie(reply)
      return
    }

    const session = rows[0]
    if (isReleaseAcceptanceUsername(session.username)) {
      const eligibility = await inspectReleaseAcceptanceLoginEligibility(
        { query },
        {
          userId: session.id,
          username: session.username
        }
      )
      if (!eligibility.active) {
        await query(
          'DELETE FROM sessions WHERE id = $1 AND user_id = $2',
          [session.session_id, session.id]
        )
        await fastify.clearSessionCookie(reply)
        return
      }
    }

    request.session = {
      id: session.session_id,
      expiresAt: session.expires_at,
      lastSeenAt: session.last_seen_at
    }
    request.currentUser = sanitizeUser(session)

    if (shouldTouchSession(session.last_seen_at, {
      intervalMs: config.sessionTouchIntervalSeconds * 1000
    })) {
      await query(
        `
          UPDATE sessions
          SET last_seen_at = NOW()
          WHERE id = $1
            AND last_seen_at <= NOW() - ($2 || ' seconds')::interval
        `,
        [session.session_id, String(config.sessionTouchIntervalSeconds)]
      )
    }
  })

  fastify.addHook('preHandler', async (request, reply) => {
    if (!isAuthenticatedWriteRequest(request)) return

    let rateLimit
    try {
      rateLimit = await consumeAuthenticatedWriteRateLimit(request)
    } catch (error) {
      if (!applyRateLimitUnavailableReply(reply, error)) throw error

      request.log.error(error, 'persistent authenticated-write rate limiter unavailable')
      return reply.send({
        error: 'Security rate limiting is temporarily unavailable'
      })
    }

    if (applyRateLimitReply(reply, rateLimit)) {
      return reply.send({
        error: 'Too many authenticated write requests, please try again later'
      })
    }
  })

  fastify.addHook('preHandler',async(request,reply)=>{
    if(!request.currentUser)return
    const path=actionRequestPath(request)
    if(!passwordProtectedAction(request.method,path))return
    if(!await consumeActionProof(request))return reply.code(403).header('Cache-Control','no-store').send({
      code:'PASSWORD_REAUTH_REQUIRED',error:'此敏感操作需要验证当前密码，验证仅对本次操作有效。'
    })
  })
}

export default fp(authPlugin)
