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
  applyRateLimitUnavailableReply,
  consumePublicAuthRateLimit
} from '../lib/requestRateLimit.js'
import {
  recordSecurityEvent,
  recordSecurityEventBestEffort
} from '../lib/securityEvents.js'
import { sendDecisionNotificationToAdmins, sendRegistrationNotificationToAdmins } from '../lib/telegram.js'
import { mapRegistrationRequest, sanitizeUser } from '../lib/users.js'
import {
  inspectReleaseAcceptanceLoginEligibility,
  isReleaseAcceptanceUsername
} from '../ops/releaseAcceptanceAccount.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function enforcePublicAuthRateLimit(kind, request, reply, identity = '') {
  let rateLimit
  try {
    rateLimit = await consumePublicAuthRateLimit(kind, request, identity)
  } catch (error) {
    if (!applyRateLimitUnavailableReply(reply, error)) throw error

    request.log.error(error, 'persistent public-auth rate limiter unavailable')
    return {
      response: {
        error: 'Security rate limiting is temporarily unavailable'
      },
      firstDenied: false
    }
  }

  if (!applyRateLimitReply(reply, rateLimit)) return null

  return {
    response: {
      error: 'Too many authentication attempts, please try again later'
    },
    firstDenied: rateLimit.firstDenied === true
  }
}

async function auditFirstRateLimitDenial(rateLimited, request, eventType) {
  if (!rateLimited?.firstDenied) return false

  return recordSecurityEventBestEffort({
    request,
    eventType,
    outcome: 'denied'
  }, request.log)
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
    const rateLimited = await enforcePublicAuthRateLimit('register', request, reply)
    if (rateLimited) return rateLimited.response

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
    const password = String(request.body?.password || '')
    const ipRateLimited = await enforcePublicAuthRateLimit(
      'login',
      request,
      reply
    )
    if (ipRateLimited) {
      await auditFirstRateLimitDenial(
        ipRateLimited,
        request,
        'auth.login'
      )
      return ipRateLimited.response
    }

    const username = normalizeUsername(request.body?.username)
    if (!isValidUsername(username)) {
      reply.code(401)
      return { error: 'Invalid username or password' }
    }
    const identityRateLimited = await enforcePublicAuthRateLimit(
      'login',
      request,
      reply,
      username
    )
    if (identityRateLimited) {
      await auditFirstRateLimitDenial(
        identityRateLimited,
        request,
        'auth.login'
      )
      return identityRateLimited.response
    }

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
        return {
          status: 'invalid',
          subjectUserId: user?.id || null
        }
      }

      if (isReleaseAcceptanceUsername(user.username)) {
        const eligibility = await inspectReleaseAcceptanceLoginEligibility(
          client,
          {
            userId: user.id,
            username: user.username
          }
        )
        if (!eligibility.active) {
          return {
            status: 'invalid',
            subjectUserId: user.id
          }
        }
      }

      if (user.status !== 'approved') {
        return {
          status: 'unapproved',
          subjectUserId: user.id
        }
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

      const createdSession = await client.query(
        `
          INSERT INTO sessions (
            user_id,
            token_hash,
            ip_address,
            user_agent,
            expires_at
          ) VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)
          RETURNING id
        `,
        [
          user.id,
          tokenHash,
          request.ip,
          request.headers['user-agent'] || '',
          String(config.sessionTtlDays)
        ]
      )

      await recordSecurityEvent({
        client,
        request,
        eventType: 'auth.login',
        outcome: 'success',
        actorUserId: user.id,
        subjectUserId: user.id,
        resourceType: 'session',
        resourceId: createdSession.rows[0].id,
        affectedCount: 1
      })

      return {
        status: 'authenticated',
        token,
        user: updatedUser.rows[0]
      }
    })

    if (login.status === 'invalid') {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.login',
        outcome: 'failure',
        subjectUserId: login.subjectUserId
      }, request.log)
      reply.code(401)
      return { error: 'Invalid username or password' }
    }

    if (login.status === 'unapproved') {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.login',
        outcome: 'denied',
        subjectUserId: login.subjectUserId
      }, request.log)
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
    if (token || request.currentUser?.id) {
      await withTransaction(async (client) => {
        const deletedSession = token
          ? await client.query(
              'DELETE FROM sessions WHERE token_hash = $1 RETURNING id',
              [hashSessionToken(token)]
            )
          : { rowCount: 0, rows: [] }

        if (request.currentUser?.id) {
          await recordSecurityEvent({
            client,
            request,
            eventType: 'auth.logout',
            outcome: 'success',
            actorUserId: request.currentUser.id,
            subjectUserId: request.currentUser.id,
            resourceType: 'session',
            resourceId: deletedSession.rows[0]?.id || request.session?.id || null,
            affectedCount: deletedSession.rowCount || 0
          })
        }
      })
    }

    await fastify.clearSessionCookie(reply)
    return { ok: true }
  })

  fastify.put('/auth/account/username', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    if (isReleaseAcceptanceUsername(request.currentUser.username)) {
      reply.code(403)
      return { error: 'Release acceptance accounts cannot change identity' }
    }

    const currentPassword = String(request.body?.currentPassword || '')
    const username = normalizeUsername(request.body?.username)
    if (!currentPassword) {
      reply.code(400)
      return { error: 'Current password is required' }
    }
    if (!isValidUsername(username)) {
      reply.code(400)
      return { error: 'A username of 1 to 128 characters is required' }
    }

    let update
    try {
      update = await withTransaction(async (client) => {
        const userResult = await client.query(
          `
            SELECT *
            FROM users
            WHERE id = $1
            FOR UPDATE
          `,
          [request.currentUser.id]
        )
        const user = userResult.rows[0]
        if (!user || !await verifyPassword(currentPassword, user.password_hash)) {
          return { status: 'invalid-password' }
        }
        if (user.username === username) {
          return { status: 'unchanged', user }
        }

        const updatedUser = await client.query(
          `
            UPDATE users
            SET username = $2,
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
          `,
          [request.currentUser.id, username]
        )

        await recordSecurityEvent({
          client,
          request,
          eventType: 'auth.account.username.update',
          outcome: 'success',
          actorUserId: request.currentUser.id,
          subjectUserId: request.currentUser.id,
          resourceType: 'user',
          resourceId: request.currentUser.id,
          affectedCount: 1
        })

        return { status: 'updated', user: updatedUser.rows[0] }
      })
    } catch (error) {
      if (error?.code === '23505') {
        reply.code(409)
        return { error: 'Username is already in use' }
      }
      throw error
    }

    if (update.status === 'invalid-password') {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.account.username.update',
        outcome: 'failure',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'user',
        resourceId: request.currentUser.id
      }, request.log)
      reply.code(400)
      return { error: 'Current password is incorrect' }
    }

    return {
      user: sanitizeUser(update.user),
      changed: update.status === 'updated'
    }
  })

  fastify.put('/auth/account/password', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const currentPassword = String(request.body?.currentPassword || '')
    const newPassword = String(request.body?.newPassword || '')
    if (!currentPassword) {
      reply.code(400)
      return { error: 'Current password is required' }
    }

    const passwordValidation = validateNewPassword(newPassword)
    if (!passwordValidation.valid) {
      reply.code(400)
      return { error: passwordValidation.error }
    }

    const update = await withTransaction(async (client) => {
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
        return { status: 'invalid-password' }
      }
      if (await verifyPassword(newPassword, user.password_hash)) {
        return { status: 'same-password' }
      }

      await client.query(
        `
          UPDATE users
          SET password_hash = $2,
              password_changed_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [request.currentUser.id, await hashPassword(newPassword)]
      )
      const revokedSessions = await client.query(
        'DELETE FROM sessions WHERE user_id = $1',
        [request.currentUser.id]
      )

      await recordSecurityEvent({
        client,
        request,
        eventType: 'auth.account.password.update',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'user',
        resourceId: request.currentUser.id,
        affectedCount: revokedSessions.rowCount || 0
      })

      return {
        status: 'updated',
        revokedSessionCount: revokedSessions.rowCount || 0
      }
    })

    if (update.status === 'invalid-password') {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.account.password.update',
        outcome: 'failure',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'user',
        resourceId: request.currentUser.id
      }, request.log)
      reply.code(400)
      return { error: 'Current password is incorrect' }
    }
    if (update.status === 'same-password') {
      reply.code(400)
      return { error: 'New password must be different from the current password' }
    }

    await fastify.clearSessionCookie(reply)
    return {
      ok: true,
      signInRequired: true,
      revokedSessionCount: update.revokedSessionCount
    }
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

    const revoked = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `
          DELETE FROM sessions
          WHERE id = $1
            AND user_id = $2
          RETURNING id
        `,
        [sessionId, request.currentUser.id]
      )

      if (!rows.length) return false

      await recordSecurityEvent({
        client,
        request,
        eventType: 'auth.session.revoke',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'session',
        resourceId: sessionId,
        affectedCount: 1
      })
      return true
    })

    if (!revoked) {
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

    const revokedCount = await withTransaction(async (client) => {
      const result = await client.query(
        `
          DELETE FROM sessions
          WHERE user_id = $1
            AND id <> $2
        `,
        [request.currentUser.id, currentSessionId]
      )
      const count = result.rowCount || 0

      await recordSecurityEvent({
        client,
        request,
        eventType: 'auth.session.revoke',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'session',
        affectedCount: count
      })
      return count
    })

    return {
      ok: true,
      revokedCount,
      currentSessionRevoked: false
    }
  })

  fastify.post('/auth/sessions/revoke-all', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const revokedCount = await withTransaction(async (client) => {
      const result = await client.query(
        'DELETE FROM sessions WHERE user_id = $1',
        [request.currentUser.id]
      )
      const count = result.rowCount || 0

      await recordSecurityEvent({
        client,
        request,
        eventType: 'auth.session.revoke',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'session',
        affectedCount: count
      })
      return count
    })

    await fastify.clearSessionCookie(reply)
    return {
      ok: true,
      revokedCount,
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

      await recordSecurityEvent({
        client,
        request,
        eventType: 'auth.recovery_codes.rotate',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'recovery_codes',
        affectedCount: recoveryCodeHashes.length
      })

      const generatedAt = await client.query('SELECT NOW() AS generated_at')
      return generatedAt.rows[0]?.generated_at || new Date().toISOString()
    })

    if (!rotation) {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.recovery_codes.rotate',
        outcome: 'failure',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'recovery_codes'
      }, request.log)
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
    const ipRateLimited = await enforcePublicAuthRateLimit(
      'recovery',
      request,
      reply
    )
    if (ipRateLimited) {
      await auditFirstRateLimitDenial(
        ipRateLimited,
        request,
        'auth.recovery'
      )
      return ipRateLimited.response
    }

    if (!isValidUsername(username)) {
      reply.code(401)
      return { error: PUBLIC_ACCOUNT_RECOVERY_ERROR }
    }

    const identityRateLimited = await enforcePublicAuthRateLimit(
      'recovery',
      request,
      reply,
      username
    )
    if (identityRateLimited) {
      await auditFirstRateLimitDenial(
        identityRateLimited,
        request,
        'auth.recovery'
      )
      return identityRateLimited.response
    }

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

      const revokedSessions = await client.query(
        'DELETE FROM sessions WHERE user_id = $1',
        [match.user_id]
      )
      const removedPasskeys = await client.query(
        'DELETE FROM webauthn_credentials WHERE user_id = $1',
        [match.user_id]
      )

      await recordSecurityEvent({
        client,
        request,
        eventType: 'auth.recovery',
        outcome: 'success',
        subjectUserId: match.user_id,
        resourceType: 'account',
        resourceId: match.user_id,
        affectedCount:
          (revokedSessions.rowCount || 0)
          + (removedPasskeys.rowCount || 0)
      })

      return {
        userId: match.user_id,
        removedPasskeyCount: removedPasskeys.rowCount || 0
      }
    })

    if (!recovered) {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.recovery',
        outcome: 'failure'
      }, request.log)
      reply.code(401)
      return { error: PUBLIC_ACCOUNT_RECOVERY_ERROR }
    }

    if (request.currentUser?.id === recovered.userId) {
      await fastify.clearSessionCookie(reply)
    }

    return {
      ok: true,
      message: 'Password updated. Sign in again with the new password.',
      removedPasskeyCount: recovered.removedPasskeyCount
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
        'SELECT * FROM registration_requests WHERE id = $1 LIMIT 1 FOR UPDATE',
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
      let subjectUserId = existingUser.rows[0]?.id || null
      if (existingUser.rowCount === 0) {
        const createdUser = await client.query(
          `
            INSERT INTO users (
              username,
              password_hash,
              role,
              status,
              approved_at
            ) VALUES ($1, $2, 'user', 'approved', NOW())
            RETURNING id
          `,
          [registration.username, registration.password_hash]
        )
        subjectUserId = createdUser.rows[0].id
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

      await recordSecurityEvent({
        client,
        request,
        eventType: 'admin.registration.approve',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId,
        resourceType: 'registration_request',
        resourceId: requestId,
        affectedCount: 1
      })

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

    const rejected = await withTransaction(async (client) => {
      const requestResult = await client.query(
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
      if (!requestResult.rows.length) return null

      await recordSecurityEvent({
        client,
        request,
        eventType: 'admin.registration.reject',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        resourceType: 'registration_request',
        resourceId: requestId,
        affectedCount: 1
      })
      return requestResult.rows[0]
    })

    if (!rejected) {
      reply.code(404)
      return { error: 'Pending registration request not found' }
    }

    await sendDecisionNotificationToAdmins(rejected, '拒绝').catch((error) => {
      fastify.log.error(error, 'failed to send rejection notification')
    })

    return { request: mapRegistrationRequest(rejected) }
  })
}
