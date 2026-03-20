import fp from 'fastify-plugin'
import { config, isProduction } from '../config.js'
import { query } from '../db/index.js'
import { hashSessionToken } from '../lib/auth.js'
import { sanitizeUser } from '../lib/users.js'

async function authPlugin(fastify) {
  fastify.decorateRequest('currentUser', null)
  fastify.decorateRequest('session', null)

  fastify.decorate('setSessionCookie', async (reply, token) => {
    const secure = config.sessionCookieSecure || isProduction()

    reply.setCookie(config.sessionCookieName, token, {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/',
      maxAge: config.sessionTtlDays * 24 * 60 * 60
    })
  })

  fastify.decorate('clearSessionCookie', async (reply) => {
    reply.clearCookie(config.sessionCookieName, {
      path: '/'
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

  fastify.addHook('preHandler', async (request) => {
    const token = request.cookies[config.sessionCookieName]
    if (!token) return

    const tokenHash = hashSessionToken(token)
    const { rows } = await query(
      `
        SELECT
          s.id AS session_id,
          s.expires_at,
          s.last_seen_at,
          u.id,
          u.username,
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
        LIMIT 1
      `,
      [tokenHash]
    )

    if (!rows.length) return

    const session = rows[0]
    request.session = {
      id: session.session_id,
      expiresAt: session.expires_at,
      lastSeenAt: session.last_seen_at
    }
    request.currentUser = sanitizeUser(session)

    await query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [session.session_id])
  })
}

export default fp(authPlugin)
