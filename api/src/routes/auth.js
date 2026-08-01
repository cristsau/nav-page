import { config } from '../config.js'
import { query, withTransaction } from '../db/index.js'
import {
  PUBLIC_ACCOUNT_RECOVERY_ERROR,
  createRecoveryCodes,
  createSessionToken,
  hashPassword,
  hashRecoveryCode,
  hashSessionToken,
  isValidRecoveryCode,
  isValidUsername,
  normalizeUsername,
  validateNewPassword,
  verifyPassword
} from '../lib/auth.js'
import {
  applyRateLimitReply,
  consumePublicAuthRateLimit
} from '../lib/requestRateLimit.js'
import { sendDecisionNotificationToAdmins, sendRegistrationNotificationToAdmins } from '../lib/telegram.js'
import { mapRegistrationRequest, sanitizeUser } from '../lib/users.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function enforcePublicAuthRateLimit(kind, request, reply, identity = '') {
  const rateLimit = consumePublicAuthRateLimit(kind, request, identity)
  if (!applyRateLimitReply(reply, rateLimit)) return null

  return {
    error: 'Too many authentication attempts, please try again later'
  }
}

function mapSession(session, currentSessionId = '') {
  return {
    id: session.id,
    current: session.id === currentSessionId,
    ipAddress: session.ip_address || '',
    userAgent: session.user_agent || '',
    createdAt: session.created_at,
    lastSeenAt: session.last_seen_at,
    expiresAt: session.expires_at
  }
}

export default async function authRoutes(fastify) {
  fastify.get('/auth/session', async (request) => ({
    user: request.currentUser || null
  }))

  fastify.post('/auth/register', async (request, reply) => {
    const rateLimited = enforcePublicAuthRateLimit('register', request, reply)
    if (rateLimited) return rateLimited

    const username = normalizeUsername(request.body?.username)
    const password = String(request.body?.password || '')

    if (!isValidUsername(username) || !password) {
      reply.code(400)
      return { error: 'A username of 1 to 128 characters and a password are required' }
    }

    const passwordValidation = validateNewPassword(password)
    if (!passwordValidation.valid) {
      reply.code(400)
      return { error: passwordValidation.error }
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
    if (!isValidUsername(username)) {
      reply.code(401)
      return { error: 'Invalid username or password' }
    }
    const rateLimited = enforcePublicAuthRateLimit(
      'login',
      request,
      reply,
      username
    )
    if (rateLimited) return rateLimited

    const login = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `
          SELECT *
          FROM users
          WHERE username = $1
          LIMIT 1
          FOR UPDATE
        `,
        [username]
      )
      const user = rows[0]
      const valid = user
        ? await verifyPassword(password, user.password_hash)
        : false

      if (!valid) {
        return { status: 'invalid' }
      }

      if (user.status !== 'approved') {
        return { status: 'unapproved' }
      }

      const updatedUser = await client.query(
        `
          UPDATE users
          SET last_login_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [user.id]
      )
      const token = createSessionToken()
      const tokenHash = hashSessionToken(token)

      await client.query(
        `
          INSERT INTO sessions (
            user_id,
            token_hash,
            ip_address,
            user_agent,
            expires_at
          ) VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)
        `,
        [
          user.id,
          tokenHash,
          request.ip,
          request.headers['user-agent'] || '',
          String(config.sessionTtlDays)
        ]
      )

      return {
        status: 'authenticated',
        token,
        user: updatedUser.rows[0]
      }
    })

    if (login.status === 'invalid') {
      reply.code(401)
      return { error: 'Invalid username or password' }
    }

    if (login.status === 'unapproved') {
      reply.code(403)
      return { error: 'This account is not approved yet' }
    }

    await fastify.setSessionCookie(reply, login.token)

    return {
      user: sanitizeUser(login.user)
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

  fastify.get('/auth/sessions', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const { rows } = await query(
      `
        SELECT
          id,
          ip_address,
          user_agent,
          created_at,
          last_seen_at,
          expires_at
        FROM sessions
        WHERE user_id = $1
          AND expires_at > NOW()
        ORDER BY last_seen_at DESC, created_at DESC
      `,
      [request.currentUser.id]
    )

    return {
      sessions: rows.map((session) => mapSession(
        session,
        request.session?.id || ''
      ))
    }
  })

  fastify.delete('/auth/sessions/:sessionId', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const sessionId = String(request.params?.sessionId || '').trim()
    if (!UUID_PATTERN.test(sessionId)) {
      reply.code(404)
      return { error: 'Session not found' }
    }

    const { rows } = await query(
      `
        DELETE FROM sessions
        WHERE id = $1
          AND user_id = $2
        RETURNING id
      `,
      [sessionId, request.currentUser.id]
    )

    if (!rows.length) {
      reply.code(404)
      return { error: 'Session not found' }
    }

    const revokedCurrentSession = sessionId === request.session?.id
    if (revokedCurrentSession) {
      await fastify.clearSessionCookie(reply)
    }

    return {
      ok: true,
      revokedSessionId: sessionId,
      currentSessionRevoked: revokedCurrentSession
    }
  })

  fastify.post('/auth/sessions/revoke-others', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const currentSessionId = request.session?.id
    if (!currentSessionId) {
      reply.code(401)
      return { error: 'Authentication required' }
    }

    const result = await query(
      `
        DELETE FROM sessions
        WHERE user_id = $1
          AND id <> $2
      `,
      [request.currentUser.id, currentSessionId]
    )

    return {
      ok: true,
      revokedCount: result.rowCount || 0,
      currentSessionRevoked: false
    }
  })

  fastify.post('/auth/sessions/revoke-all', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const result = await query(
      'DELETE FROM sessions WHERE user_id = $1',
      [request.currentUser.id]
    )

    await fastify.clearSessionCookie(reply)
    return {
      ok: true,
      revokedCount: result.rowCount || 0,
      currentSessionRevoked: true
    }
  })

  fastify.get('/auth/recovery-codes/status', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const { rows } = await query(
      `
        SELECT
          COUNT(*) FILTER (
            WHERE used_at IS NULL
              AND revoked_at IS NULL
          )::integer AS active_code_count,
          MAX(created_at) FILTER (
            WHERE used_at IS NULL
              AND revoked_at IS NULL
          ) AS generated_at
        FROM account_recovery_codes
        WHERE user_id = $1
      `,
      [request.currentUser.id]
    )
    const activeCodeCount = Number(rows[0]?.active_code_count || 0)

    return {
      configured: activeCodeCount > 0,
      activeCodeCount,
      generatedAt: rows[0]?.generated_at || null
    }
  })

  fastify.post('/auth/recovery-codes', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const currentPassword = String(request.body?.currentPassword || '')
    if (!currentPassword) {
      reply.code(400)
      return { error: 'Current password is required' }
    }

    const recoveryCodes = createRecoveryCodes()
    const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode)
    const rotation = await withTransaction(async (client) => {
      const userResult = await client.query(
        `
          SELECT password_hash
          FROM users
          WHERE id = $1
          FOR UPDATE
        `,
        [request.currentUser.id]
      )
      const user = userResult.rows[0]

      if (!user || !await verifyPassword(currentPassword, user.password_hash)) {
        return null
      }

      await client.query(
        `
          UPDATE account_recovery_codes
          SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE user_id = $1
        `,
        [request.currentUser.id]
      )

      await client.query(
        `
          INSERT INTO account_recovery_codes (user_id, code_hash)
          SELECT $1, generated.code_hash
          FROM UNNEST($2::text[]) AS generated(code_hash)
        `,
        [request.currentUser.id, recoveryCodeHashes]
      )

      const generatedAt = await client.query('SELECT NOW() AS generated_at')
      return generatedAt.rows[0]?.generated_at || new Date().toISOString()
    })

    if (!rotation) {
      reply.code(400)
      return { error: 'Current password is incorrect' }
    }

    return {
      codes: recoveryCodes,
      generatedAt: rotation,
      warning: 'These recovery codes are shown only once. Store them securely.'
    }
  })

  fastify.post('/auth/recover', async (request, reply) => {
    const username = normalizeUsername(request.body?.username)
    const rawRecoveryCode = String(request.body?.recoveryCode || '').slice(0, 256)
    const newPassword = String(request.body?.newPassword || '')
    const ipRateLimited = enforcePublicAuthRateLimit(
      'recovery',
      request,
      reply
    )
    if (ipRateLimited) return ipRateLimited

    if (!isValidUsername(username)) {
      reply.code(401)
      return { error: PUBLIC_ACCOUNT_RECOVERY_ERROR }
    }

    const identityRateLimited = enforcePublicAuthRateLimit(
      'recovery',
      request,
      reply,
      username
    )
    if (identityRateLimited) return identityRateLimited

    const passwordValidation = validateNewPassword(newPassword)

    if (!passwordValidation.valid) {
      reply.code(400)
      return { error: passwordValidation.error }
    }

    const recoveryCodeValid = isValidRecoveryCode(rawRecoveryCode)
    const recoveryCodeHash = hashRecoveryCode(rawRecoveryCode)
    const recovered = await withTransaction(async (client) => {
      const recoveryResult = await client.query(
        `
          SELECT
            u.id AS user_id,
            recovery.id AS recovery_code_id
          FROM users u
          JOIN account_recovery_codes recovery
            ON recovery.user_id = u.id
          WHERE u.username = $1
            AND u.status = 'approved'
            AND recovery.code_hash = $2
            AND recovery.used_at IS NULL
            AND recovery.revoked_at IS NULL
          LIMIT 1
          FOR UPDATE OF u, recovery
        `,
        [
          recoveryCodeValid ? username : '',
          recoveryCodeHash
        ]
      )
      const match = recoveryResult.rows[0]
      if (!match) return null
      const newPasswordHash = await hashPassword(newPassword)

      await client.query(
        `
          UPDATE users
          SET password_hash = $2,
              password_changed_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [match.user_id, newPasswordHash]
      )

      await client.query(
        `
          UPDATE account_recovery_codes
          SET used_at = CASE
                WHEN id = $2 THEN NOW()
                ELSE used_at
              END,
              revoked_at = COALESCE(revoked_at, NOW())
          WHERE user_id = $1
            AND revoked_at IS NULL
        `,
        [match.user_id, match.recovery_code_id]
      )

      await client.query(
        'DELETE FROM sessions WHERE user_id = $1',
        [match.user_id]
      )

      return {
        userId: match.user_id
      }
    })

    if (!recovered) {
      reply.code(401)
      return { error: PUBLIC_ACCOUNT_RECOVERY_ERROR }
    }

    if (request.currentUser?.id === recovered.userId) {
      await fastify.clearSessionCookie(reply)
    }

    return {
      ok: true,
      message: 'Password updated. Sign in again with the new password.'
    }
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
