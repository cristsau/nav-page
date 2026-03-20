import { config } from '../config.js'
import { query, withTransaction } from '../db/index.js'
import { createSessionToken, hashPassword, hashSessionToken, normalizeUsername, verifyPassword } from '../lib/auth.js'
import { sendDecisionNotificationToAdmins, sendRegistrationNotificationToAdmins } from '../lib/telegram.js'
import { mapRegistrationRequest, sanitizeUser } from '../lib/users.js'

export default async function authRoutes(fastify) {
  fastify.get('/auth/session', async (request) => ({
    user: request.currentUser || null
  }))

  fastify.post('/auth/register', async (request, reply) => {
    const username = normalizeUsername(request.body?.username)
    const password = String(request.body?.password || '')

    if (!username || !password) {
      reply.code(400)
      return { error: 'Username and password are required' }
    }

    const existingUser = await query('SELECT id FROM users WHERE username = $1 LIMIT 1', [username])
    if (existingUser.rowCount > 0) {
      reply.code(409)
      return { error: 'Username already exists' }
    }

    const pendingRequest = await query(
      `
        SELECT id
        FROM registration_requests
        WHERE username = $1
          AND status = 'pending'
        LIMIT 1
      `,
      [username]
    )

    if (pendingRequest.rowCount > 0) {
      reply.code(409)
      return { error: 'A pending registration already exists for this username' }
    }

    const { rows } = await query(
      `
        INSERT INTO registration_requests (username, password_hash, status)
        VALUES ($1, $2, 'pending')
        RETURNING id, username, status, created_at, updated_at, decided_at, decided_by
      `,
      [username, await hashPassword(password)]
    )

    await sendRegistrationNotificationToAdmins(rows[0]).catch((error) => {
      fastify.log.error(error, 'failed to send registration notification')
    })

    reply.code(201)
    return { request: mapRegistrationRequest(rows[0]) }
  })

  fastify.post('/auth/login', async (request, reply) => {
    const username = normalizeUsername(request.body?.username)
    const password = String(request.body?.password || '')

    const { rows } = await query('SELECT * FROM users WHERE username = $1 LIMIT 1', [username])
    const user = rows[0]

    if (!user) {
      reply.code(401)
      return { error: 'Invalid username or password' }
    }

    if (user.status !== 'approved') {
      reply.code(403)
      return { error: 'This account is not approved yet' }
    }

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) {
      reply.code(401)
      return { error: 'Invalid username or password' }
    }

    await query('UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [user.id])

    const token = createSessionToken()
    const tokenHash = hashSessionToken(token)

    await query(
      `
        INSERT INTO sessions (
          user_id,
          token_hash,
          ip_address,
          user_agent,
          expires_at
        ) VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)
      `,
      [user.id, tokenHash, request.ip, request.headers['user-agent'] || '', String(config.sessionTtlDays)]
    )

    await fastify.setSessionCookie(reply, token)

    return {
      user: sanitizeUser({
        ...user,
        last_login_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    }
  })

  fastify.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[config.sessionCookieName]
    if (token) {
      await query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)])
    }

    await fastify.clearSessionCookie(reply)
    return { ok: true }
  })

  fastify.get('/admin/users', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    const { rows } = await query(
      `
        SELECT id, username, role, status, created_at, updated_at, approved_at, last_login_at
        FROM users
        ORDER BY created_at ASC
      `
    )

    return { users: rows.map(sanitizeUser) }
  })

  fastify.get('/admin/registration-requests', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    const status = String(request.query?.status || 'all')
    const params = []
    let whereClause = ''

    if (status !== 'all') {
      params.push(status)
      whereClause = 'WHERE status = $1'
    }

    const { rows } = await query(
      `
        SELECT id, username, status, created_at, updated_at, decided_at, decided_by
        FROM registration_requests
        ${whereClause}
        ORDER BY updated_at DESC
      `,
      params
    )

    return { requests: rows.map(mapRegistrationRequest) }
  })

  fastify.post('/admin/registration-requests/:requestId/approve', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    const requestId = request.params.requestId

    const result = await withTransaction(async (client) => {
      const requestResult = await client.query(
        'SELECT * FROM registration_requests WHERE id = $1 LIMIT 1',
        [requestId]
      )

      const registration = requestResult.rows[0]
      if (!registration) {
        reply.code(404)
        return null
      }

      if (registration.status !== 'pending') {
        return mapRegistrationRequest(registration)
      }

      const existingUser = await client.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [registration.username])
      if (existingUser.rowCount === 0) {
        await client.query(
          `
            INSERT INTO users (
              username,
              password_hash,
              role,
              status,
              approved_at
            ) VALUES ($1, $2, 'user', 'approved', NOW())
          `,
          [registration.username, registration.password_hash]
        )
      }

      const approved = await client.query(
        `
          UPDATE registration_requests
          SET status = 'approved',
              updated_at = NOW(),
              decided_at = NOW(),
              decided_by = $2
          WHERE id = $1
          RETURNING id, username, status, created_at, updated_at, decided_at, decided_by
        `,
        [requestId, request.currentUser.id]
      )

      return mapRegistrationRequest(approved.rows[0])
    })

    if (!result) {
      return { error: 'Registration request not found' }
    }

    await sendDecisionNotificationToAdmins(result, '批准').catch((error) => {
      fastify.log.error(error, 'failed to send approval notification')
    })

    return { request: result }
  })

  fastify.post('/admin/registration-requests/:requestId/reject', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    const requestId = request.params.requestId

    const requestResult = await query(
      `
        UPDATE registration_requests
        SET status = 'rejected',
            updated_at = NOW(),
            decided_at = NOW(),
            decided_by = $2
        WHERE id = $1
          AND status = 'pending'
        RETURNING id, username, status, created_at, updated_at, decided_at, decided_by
      `,
      [requestId, request.currentUser.id]
    )

    if (!requestResult.rows.length) {
      reply.code(404)
      return { error: 'Pending registration request not found' }
    }

    await sendDecisionNotificationToAdmins(requestResult.rows[0], '拒绝').catch((error) => {
      fastify.log.error(error, 'failed to send rejection notification')
    })

    return { request: mapRegistrationRequest(requestResult.rows[0]) }
  })
}
