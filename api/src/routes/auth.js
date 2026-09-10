import { createHash, randomBytes } from 'node:crypto'
import { invalidatePasswordProofs } from '../lib/accountPasswordEffects.js'
import { botGuardPublicConfig, enforceBotGuard } from '../lib/botGuard.js'
import { config } from '../config.js'
import { sessionLifetimeDays } from '../lib/sessionPolicy.js'
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
import {
  notifyRegistrationRequestToAdmins,
  queueRegistrationDecision,
  updateRegistrationNotification,
  queueRegistrationVerification
} from '../lib/notificationDelivery.js'
import { normalizeEmailAddress, verifiedMailConfigurationStatus } from '../lib/mailOutbox.js'
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

  fastify.get('/auth/bot-guard/config', {config:{skipSession:true}}, async (_request,reply) => {
    reply.header('Cache-Control','no-store')
    return botGuardPublicConfig()
  })

  fastify.get('/auth/registration/config', {
    config: { skipSession: true }
  }, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60')
    return {
      emailVerificationEnabled: config.registrationEmailEnabled,
      emailRequired: config.registrationEmailEnabled
    }
  })

  fastify.post('/auth/register', async (request, reply) => {
    const rateLimited = await enforcePublicAuthRateLimit('register', request, reply)
    if (rateLimited) return rateLimited.response
    await enforceBotGuard(request, 'register')

    const username = normalizeUsername(request.body?.username)
    const password = String(request.body?.password || '')
    let email = null
    if (config.registrationEmailEnabled) {
      try {
        email = normalizeEmailAddress(request.body?.email)
      } catch (error) {
        reply.code(400)
        return { error: error.message }
      }
      const mailStatus = await verifiedMailConfigurationStatus()
      if (!mailStatus.configured || !mailStatus.enabled) {
        reply.code(503)
        return { error: 'Registration email verification is temporarily unavailable' }
      }
    }

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

    if (email) {
      const existingEmail = await query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email])
      if (existingEmail.rowCount > 0) {
        reply.code(409)
        return { error: 'Email address is already registered' }
      }
    }

    await query(
      `
        UPDATE registration_requests
        SET status = 'expired', verification_token_hash = NULL,
            verification_expires_at = NULL, updated_at = NOW()
        WHERE status = 'email_pending'
          AND verification_expires_at <= NOW()
      `
    )

    const pendingRequest = await query(
      `
        SELECT id
        FROM registration_requests
        WHERE (username = $1 OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2)))
          AND status IN ('email_pending', 'pending')
        LIMIT 1
      `,
      [username, email]
    )

    if (pendingRequest.rowCount > 0) {
      reply.code(409)
      return { error: 'A pending registration already exists for this username or email address' }
    }

    const verificationToken = email ? randomBytes(32).toString('base64url') : ''
    const verificationTokenHash = verificationToken
      ? createHash('sha256').update(verificationToken).digest('hex')
      : null
    let rows
    try {
      // Match the text casts in CASE; the target hash column is CHAR(64).
      const inserted = await query(
        `
          INSERT INTO registration_requests (
            username, password_hash, email, status,
            verification_token_hash, verification_expires_at, verification_sent_at
          )
          VALUES (
            $1, $2, $3, $4, $5::text,
            CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() + ($6::integer * INTERVAL '1 minute') END,
            CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() END
          )
          RETURNING id, username, email, email_verified_at, status,
                    created_at, updated_at, decided_at, decided_by
        `,
        [
          username,
          await hashPassword(password),
          email,
          email ? 'email_pending' : 'pending',
          verificationTokenHash,
          config.registrationEmailVerificationMinutes
        ]
      )
      rows = inserted.rows
    } catch (error) {
      if (error?.code === '23505') {
        reply.code(409)
        return { error: 'A pending registration already exists for this username or email address' }
      }
      throw error
    }

    if (email) {
      try {
        await queueRegistrationVerification(rows[0], verificationToken)
      } catch (error) {
        await query('DELETE FROM registration_requests WHERE id = $1 AND status = $2', [rows[0].id, 'email_pending'])
        throw error
      }
    } else {
      await notifyRegistrationRequestToAdmins(rows[0]).catch((error) => {
        fastify.log.error(error, 'failed to queue registration notification')
      })
    }

    reply.code(201)
    return { request: mapRegistrationRequest(rows[0]) }
  })

  fastify.post('/auth/register/verify', {
    config: { skipSession: true }
  }, async (request, reply) => {
    const rateLimited = await enforcePublicAuthRateLimit('register', request, reply)
    if (rateLimited) return rateLimited.response
    const requestId = String(request.body?.requestId || '')
    const token = String(request.body?.token || '').trim()
    if (!UUID_PATTERN.test(requestId) || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      reply.code(400)
      return { error: 'Email verification link is invalid' }
    }
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const { rows } = await query(
      `
        UPDATE registration_requests
        SET status = 'pending', email_verified_at = NOW(),
            verification_token_hash = NULL, verification_expires_at = NULL,
            updated_at = NOW()
        WHERE id = $1 AND status = 'email_pending'
          AND verification_token_hash = $2
          AND verification_expires_at > NOW()
        RETURNING id, username, email, email_verified_at, status,
                  created_at, updated_at, decided_at, decided_by
      `,
      [requestId, tokenHash]
    )
    if (!rows[0]) {
      reply.code(400)
      return { error: 'Email verification link is invalid or expired' }
    }
    await notifyRegistrationRequestToAdmins(rows[0]).catch((error) => {
      fastify.log.error(error, 'failed to queue verified registration notification')
    })
    return { ok: true, request: mapRegistrationRequest(rows[0]) }
  })

  fastify.post('/auth/register/resend-verification', {
    config: { skipSession: true }
  }, async (request, reply) => {
    const rateLimited = await enforcePublicAuthRateLimit('register', request, reply)
    if (rateLimited) return rateLimited.response
    await enforceBotGuard(request, 'register_resend')

    let email
    try {
      email = normalizeEmailAddress(request.body?.email)
    } catch {
      reply.code(202)
      return { ok: true, message: 'If a pending registration exists, a new verification email will be sent.' }
    }

    const token = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const rotated = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `
          UPDATE registration_requests
          SET verification_token_hash = $2,
              verification_expires_at = NOW() + ($3::integer * INTERVAL '1 minute'),
              verification_sent_at = NOW(),
              updated_at = NOW()
          WHERE id = (
            SELECT id
            FROM registration_requests
            WHERE LOWER(email) = LOWER($1)
              AND status = 'email_pending'
              AND (
                verification_sent_at IS NULL
                OR verification_sent_at <= NOW() - INTERVAL '60 seconds'
              )
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, username, email, email_verified_at, status,
                    created_at, updated_at, decided_at, decided_by
        `,
        [email, tokenHash, config.registrationEmailVerificationMinutes]
      )
      return rows[0] || null
    })

    if (rotated) {
      await queueRegistrationVerification(rotated, token).catch((error) => {
        fastify.log.error(error, 'failed to queue replacement registration verification email')
      })
    }

    reply.code(202)
    return { ok: true, message: 'If a pending registration exists, a new verification email will be sent.' }
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

    await enforceBotGuard(request, 'password_login')
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
          String(sessionLifetimeDays(request.body?.trustDevice))
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

    await fastify.setSessionCookie(reply, login.token, request.body?.trustDevice === true)

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
      await invalidatePasswordProofs(client, request.currentUser.id)

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

    await enforceBotGuard(request, 'account_recovery')
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
      await invalidatePasswordProofs(client, match.user_id)
      const removedPasskeys = await client.query(
        'DELETE FROM webauthn_credentials WHERE user_id = $1',
        [match.user_id]
      )
      const removedDeviceKeys = await client.query('DELETE FROM auth_device_keys WHERE user_id=$1', [match.user_id])

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
          + (removedDeviceKeys.rowCount || 0)
      })

      return {
        userId: match.user_id,
        removedPasskeyCount: (removedPasskeys.rowCount || 0) + (removedDeviceKeys.rowCount || 0)
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
        SELECT id, username, email, email_verified_at, role, status,
               created_at, updated_at, approved_at, last_login_at
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
        SELECT id, username, email, email_verified_at, status,
               created_at, updated_at, decided_at, decided_by
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
    if (!UUID_PATTERN.test(String(requestId || ''))) {
      reply.code(400)
      return { error: 'Registration request id is invalid' }
    }

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
        if (registration.status !== 'approved') {
          reply.code(409)
          return { conflict: true }
        }
        const mail = await queueRegistrationDecision(registration, 'approved', { queryFn: client.query.bind(client) })
        await updateRegistrationNotification(registration, 'approved', { queryFn: client.query.bind(client) })
        return { request: mapRegistrationRequest(registration), notification: { mailStatus: mail.skipped ? 'not_applicable' : mail.status } }
      }

      const existingUser = await client.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [registration.username])
      let subjectUserId = existingUser.rows[0]?.id || null
      if (existingUser.rowCount === 0) {
        const createdUser = await client.query(
          `
            INSERT INTO users (
              username,
              password_hash,
              email,
              email_verified_at,
              role,
              status,
              approved_at
            ) VALUES ($1, $2, $3, $4, 'user', 'approved', NOW())
            RETURNING id
          `,
          [
            registration.username,
            registration.password_hash,
            registration.email,
            registration.email_verified_at
          ]
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
          RETURNING id, username, email, email_verified_at, status,
                    created_at, updated_at, decided_at, decided_by
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

      // Approval, ordinary account creation, audit, notice state and result mail
      // commit together. Queue failure must never look like a completed decision.
      const mail = await queueRegistrationDecision(approved.rows[0], 'approved', { queryFn: client.query.bind(client) })
      await updateRegistrationNotification(approved.rows[0], 'approved', { queryFn: client.query.bind(client) })
      return { request: mapRegistrationRequest(approved.rows[0]), notification: { mailStatus: mail.skipped ? 'not_applicable' : mail.status } }
    })

    if (!result) {
      return { error: 'Registration request not found' }
    }

    if (result.conflict) return { error: 'Registration request is not awaiting approval', code: 'REGISTRATION_NOT_PENDING' }
    return result
  })

  fastify.post('/admin/registration-requests/:requestId/reject', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    const requestId = request.params.requestId
    if (!UUID_PATTERN.test(String(requestId || ''))) {
      reply.code(400)
      return { error: 'Registration request id is invalid' }
    }

    const rejected = await withTransaction(async (client) => {
      const existing = (await client.query('SELECT * FROM registration_requests WHERE id = $1 FOR UPDATE', [requestId])).rows[0]
      if (!existing) return null
      if (!['pending', 'rejected'].includes(existing.status)) { reply.code(409); return { conflict: true } }
      if (existing.status === 'rejected') {
        const mail = await queueRegistrationDecision(existing, 'rejected', { queryFn: client.query.bind(client) })
        await updateRegistrationNotification(existing, 'rejected', { queryFn: client.query.bind(client) })
        return { request: mapRegistrationRequest(existing), notification: { mailStatus: mail.skipped ? 'not_applicable' : mail.status } }
      }
      const requestResult = await client.query(
        `
          UPDATE registration_requests
          SET status = 'rejected',
              updated_at = NOW(),
              decided_at = NOW(),
              decided_by = $2
          WHERE id = $1
            AND status = 'pending'
          RETURNING id, username, email, email_verified_at, status,
                    created_at, updated_at, decided_at, decided_by
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
      const mail = await queueRegistrationDecision(requestResult.rows[0], 'rejected', { queryFn: client.query.bind(client) })
      await updateRegistrationNotification(requestResult.rows[0], 'rejected', { queryFn: client.query.bind(client) })
      return { request: mapRegistrationRequest(requestResult.rows[0]), notification: { mailStatus: mail.skipped ? 'not_applicable' : mail.status } }
    })

    if (!rejected) {
      reply.code(404)
      return { error: 'Pending registration request not found' }
    }

    if (rejected.conflict) return { error: 'Registration request is not awaiting approval', code: 'REGISTRATION_NOT_PENDING' }
    return rejected
  })
}
