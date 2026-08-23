import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server'
import { config } from '../config.js'
import { query, withTransaction } from '../db/index.js'
import {
  createSessionToken,
  hashSessionToken,
  isValidUsername,
  normalizeUsername,
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
import { sanitizeUser } from '../lib/users.js'
import {
  inspectReleaseAcceptanceLoginEligibility,
  isReleaseAcceptanceUsername
} from '../ops/releaseAcceptanceAccount.js'

const CHALLENGE_TTL_SECONDS = 300
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const GENERIC_PASSKEY_ERROR = 'Unable to sign in with this passkey'
const ALLOWED_TRANSPORTS = new Set([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb'
])

function isCanonicalOrigin(request) {
  return String(request.headers?.origin || '').trim() === config.webauthnOrigin
}

function requirePasskeyFeature(request, reply, { canonical = false } = {}) {
  if (!config.webauthnEnabled) {
    reply.code(404)
    return { error: 'Passkey authentication is not enabled' }
  }

  if (canonical && !isCanonicalOrigin(request)) {
    reply.code(403)
    return {
      error: `Passkeys are available only at ${config.webauthnOrigin}`
    }
  }

  return null
}

function normalizeDisplayName(value) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return (normalized || 'Passkey').slice(0, 128)
}

function normalizeTransports(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .map((item) => String(item || '').trim())
      .filter((item) => ALLOWED_TRANSPORTS.has(item))
  )]
}

function uuidToBytes(value) {
  return Uint8Array.from(Buffer.from(String(value).replace(/-/g, ''), 'hex'))
}

function mapPasskey(record) {
  return {
    id: record.id,
    displayName: record.display_name,
    deviceType: record.device_type,
    backedUp: Boolean(record.backed_up),
    rpId: record.rp_id,
    transports: normalizeTransports(record.transports),
    createdAt: record.created_at,
    lastUsedAt: record.last_used_at || null
  }
}

async function cleanupChallenges() {
  await query(
    `
      DELETE FROM webauthn_challenges
      WHERE expires_at <= NOW()
         OR (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '1 hour')
    `
  )
}

async function consumeChallenge({
  challengeId,
  kind,
  userId = null,
  sessionId = null
}) {
  if (!UUID_PATTERN.test(challengeId)) return null

  const clauses = [
    'id = $1',
    'kind = $2',
    'used_at IS NULL',
    'expires_at > NOW()',
    'rp_id = $3',
    'origin = $4'
  ]
  const params = [
    challengeId,
    kind,
    config.webauthnRpId,
    config.webauthnOrigin
  ]

  if (userId) {
    params.push(userId)
    clauses.push(`user_id = $${params.length}`)
  }
  if (sessionId) {
    params.push(sessionId)
    clauses.push(`session_id = $${params.length}`)
  }

  const result = await query(
    `
      UPDATE webauthn_challenges
      SET used_at = NOW()
      WHERE ${clauses.join('\n        AND ')}
      RETURNING *
    `,
    params
  )
  return result.rows[0] || null
}

async function enforcePasskeyLoginRateLimit(request, reply, identity = '') {
  let result
  try {
    result = await consumePublicAuthRateLimit('passkey', request, identity)
  } catch (error) {
    if (!applyRateLimitUnavailableReply(reply, error)) throw error
    request.log.error(error, 'persistent passkey rate limiter unavailable')
    return {
      blocked: true,
      response: { error: 'Security rate limiting is temporarily unavailable' }
    }
  }

  if (!applyRateLimitReply(reply, result)) return null
  if (result.firstDenied) {
    await recordSecurityEventBestEffort({
      request,
      eventType: 'auth.passkey.login',
      outcome: 'denied'
    }, request.log)
  }

  return {
    blocked: true,
    response: {
      error: 'Too many authentication attempts, please try again later'
    }
  }
}

async function createAuthenticationChallenge(username) {
  const userResult = await query(
    `
      SELECT u.id
      FROM users u
      WHERE u.username = $1
        AND u.status = 'approved'
        AND EXISTS (
          SELECT 1
          FROM webauthn_credentials credential
          WHERE credential.user_id = u.id
            AND credential.rp_id = $2
        )
      LIMIT 1
    `,
    [isValidUsername(username) ? username : '__invalid__', config.webauthnRpId]
  )
  const userId = userResult.rows[0]?.id || null
  const options = await generateAuthenticationOptions({
    rpID: config.webauthnRpId,
    allowCredentials: [],
    userVerification: 'required',
    timeout: CHALLENGE_TTL_SECONDS * 1000
  })
  const challengeResult = await query(
    `
      INSERT INTO webauthn_challenges (
        user_id,
        kind,
        challenge,
        rp_id,
        origin,
        expires_at
      ) VALUES (
        $1,
        'authentication',
        $2,
        $3,
        $4,
        NOW() + ($5 || ' seconds')::interval
      )
      RETURNING id
    `,
    [
      userId,
      options.challenge,
      config.webauthnRpId,
      config.webauthnOrigin,
      String(CHALLENGE_TTL_SECONDS)
    ]
  )

  return {
    challengeId: challengeResult.rows[0].id,
    options
  }
}

export default async function passkeyRoutes(fastify) {
  fastify.get('/auth/passkeys/config', {
    config: { skipSession: true }
  }, async () => ({
    enabled: config.webauthnEnabled,
    canonicalOrigin: config.webauthnOrigin,
    rpId: config.webauthnRpId,
    passwordOnlyAliasMessage:
      `Passkeys are available only at ${config.webauthnOrigin}. `
      + 'This domain supports password login only.'
  }))

  fastify.get('/auth/passkeys', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const { rows } = await query(
      `
        SELECT
          id,
          display_name,
          device_type,
          backed_up,
          rp_id,
          transports,
          created_at,
          last_used_at
        FROM webauthn_credentials
        WHERE user_id = $1
          AND rp_id = $2
        ORDER BY created_at DESC
      `,
      [request.currentUser.id, config.webauthnRpId]
    )
    return { passkeys: rows.map(mapPasskey) }
  })

  fastify.post('/auth/passkeys/register/options', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const unavailable = requirePasskeyFeature(request, reply, { canonical: true })
    if (unavailable) return unavailable

    const currentPassword = String(request.body?.currentPassword || '')
    const displayName = normalizeDisplayName(request.body?.displayName)
    if (!currentPassword) {
      reply.code(400)
      return { error: 'Current password is required' }
    }

    const userResult = await query(
      `
        SELECT id, username, password_hash
        FROM users
        WHERE id = $1
          AND status = 'approved'
        LIMIT 1
      `,
      [request.currentUser.id]
    )
    const user = userResult.rows[0]
    if (!user || !await verifyPassword(currentPassword, user.password_hash)) {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.passkey.register',
        outcome: 'failure',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'passkey'
      }, request.log)
      reply.code(400)
      return { error: 'Current password is incorrect' }
    }

    await cleanupChallenges()
    const credentialResult = await query(
      `
        SELECT credential_id, transports
        FROM webauthn_credentials
        WHERE user_id = $1
          AND rp_id = $2
      `,
      [user.id, config.webauthnRpId]
    )
    const options = await generateRegistrationOptions({
      rpName: config.webauthnRpName,
      rpID: config.webauthnRpId,
      userName: user.username,
      userDisplayName: user.username,
      userID: uuidToBytes(user.id),
      attestationType: 'none',
      excludeCredentials: credentialResult.rows.map((credential) => ({
        id: credential.credential_id,
        transports: normalizeTransports(credential.transports)
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required'
      },
      timeout: CHALLENGE_TTL_SECONDS * 1000
    })

    const challengeResult = await withTransaction(async (client) => {
      await client.query(
        `
          DELETE FROM webauthn_challenges
          WHERE kind = 'registration'
            AND session_id = $1
            AND used_at IS NULL
        `,
        [request.session.id]
      )
      return client.query(
        `
          INSERT INTO webauthn_challenges (
            user_id,
            session_id,
            kind,
            challenge,
            webauthn_user_id,
            rp_id,
            origin,
            expires_at
          ) VALUES (
            $1,
            $2,
            'registration',
            $3,
            $4,
            $5,
            $6,
            NOW() + ($7 || ' seconds')::interval
          )
          RETURNING id
        `,
        [
          user.id,
          request.session.id,
          options.challenge,
          user.id,
          config.webauthnRpId,
          config.webauthnOrigin,
          String(CHALLENGE_TTL_SECONDS)
        ]
      )
    })

    return {
      challengeId: challengeResult.rows[0].id,
      displayName,
      options
    }
  })

  fastify.post('/auth/passkeys/register/verify', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const unavailable = requirePasskeyFeature(request, reply, { canonical: true })
    if (unavailable) return unavailable

    const challengeId = String(request.body?.challengeId || '').trim()
    const displayName = normalizeDisplayName(request.body?.displayName)
    const response = request.body?.response
    const challenge = await consumeChallenge({
      challengeId,
      kind: 'registration',
      userId: request.currentUser.id,
      sessionId: request.session?.id
    })
    if (!challenge || !response) {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.passkey.register',
        outcome: 'failure',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'passkey'
      }, request.log)
      reply.code(400)
      return { error: 'Passkey registration request expired or was already used' }
    }

    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: config.webauthnOrigin,
        expectedRPID: config.webauthnRpId,
        requireUserVerification: true
      })
      if (!verification.verified || !verification.registrationInfo) {
        throw new Error('Passkey registration verification failed')
      }

      const {
        credential,
        credentialDeviceType,
        credentialBackedUp
      } = verification.registrationInfo
      const inserted = await withTransaction(async (client) => {
        const result = await client.query(
          `
            INSERT INTO webauthn_credentials (
              user_id,
              credential_id,
              public_key,
              webauthn_user_id,
              counter,
              transports,
              device_type,
              backed_up,
              display_name,
              rp_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (credential_id) DO NOTHING
            RETURNING *
          `,
          [
            request.currentUser.id,
            credential.id,
            Buffer.from(credential.publicKey),
            challenge.webauthn_user_id,
            credential.counter,
            normalizeTransports(credential.transports),
            credentialDeviceType,
            Boolean(credentialBackedUp),
            displayName,
            config.webauthnRpId
          ]
        )
        const record = result.rows[0]
        if (!record) throw new Error('Passkey credential already exists')

        await recordSecurityEvent({
          client,
          request,
          eventType: 'auth.passkey.register',
          outcome: 'success',
          actorUserId: request.currentUser.id,
          subjectUserId: request.currentUser.id,
          resourceType: 'passkey',
          resourceId: record.id,
          affectedCount: 1
        })
        return record
      })

      reply.code(201)
      return { passkey: mapPasskey(inserted) }
    } catch (error) {
      request.log.warn('passkey registration verification failed')
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.passkey.register',
        outcome: 'failure',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'passkey'
      }, request.log)
      reply.code(400)
      return { error: 'Unable to register this passkey' }
    }
  })

  fastify.delete('/auth/passkeys/:passkeyId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (!isCanonicalOrigin(request)) {
      reply.code(403)
      return {
        error: `Passkey management is available only at ${config.webauthnOrigin}`
      }
    }

    const passkeyId = String(request.params?.passkeyId || '').trim()
    const currentPassword = String(request.body?.currentPassword || '')
    if (!UUID_PATTERN.test(passkeyId)) {
      reply.code(404)
      return { error: 'Passkey not found' }
    }
    if (!currentPassword) {
      reply.code(400)
      return { error: 'Current password is required' }
    }

    const deleted = await withTransaction(async (client) => {
      const userResult = await client.query(
        'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE',
        [request.currentUser.id]
      )
      const user = userResult.rows[0]
      if (!user || !await verifyPassword(currentPassword, user.password_hash)) {
        return { status: 'invalid-password' }
      }

      const result = await client.query(
        `
          DELETE FROM webauthn_credentials
          WHERE id = $1
            AND user_id = $2
            AND rp_id = $3
          RETURNING id
        `,
        [passkeyId, request.currentUser.id, config.webauthnRpId]
      )
      if (!result.rows.length) return { status: 'not-found' }

      await recordSecurityEvent({
        client,
        request,
        eventType: 'auth.passkey.delete',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'passkey',
        resourceId: passkeyId,
        affectedCount: 1
      })
      return { status: 'deleted' }
    })

    if (deleted.status === 'invalid-password') {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.passkey.delete',
        outcome: 'failure',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'passkey',
        resourceId: passkeyId
      }, request.log)
      reply.code(400)
      return { error: 'Current password is incorrect' }
    }
    if (deleted.status === 'not-found') {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.passkey.delete',
        outcome: 'failure',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'passkey',
        resourceId: passkeyId
      }, request.log)
      reply.code(404)
      return { error: 'Passkey not found' }
    }
    return { ok: true, deletedPasskeyId: passkeyId }
  })

  fastify.post('/auth/passkeys/login/options', {
    config: { skipSession: true }
  }, async (request, reply) => {
    const unavailable = requirePasskeyFeature(request, reply, { canonical: true })
    if (unavailable) return unavailable

    const username = normalizeUsername(request.body?.username)
    const ipRateLimited = await enforcePasskeyLoginRateLimit(request, reply)
    if (ipRateLimited) return ipRateLimited.response
    const identityRateLimited = await enforcePasskeyLoginRateLimit(
      request,
      reply,
      username
    )
    if (identityRateLimited) return identityRateLimited.response

    await cleanupChallenges()
    return createAuthenticationChallenge(username)
  })

  fastify.post('/auth/passkeys/login/verify', {
    config: { skipSession: true }
  }, async (request, reply) => {
    const unavailable = requirePasskeyFeature(request, reply, { canonical: true })
    if (unavailable) return unavailable

    const verifyRateLimited = await enforcePasskeyLoginRateLimit(request, reply)
    if (verifyRateLimited) return verifyRateLimited.response

    const challengeId = String(request.body?.challengeId || '').trim()
    const response = request.body?.response
    const challenge = await consumeChallenge({
      challengeId,
      kind: 'authentication'
    })
    if (!challenge || !response || !challenge.user_id) {
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.passkey.login',
        outcome: 'failure'
      }, request.log)
      reply.code(401)
      return { error: GENERIC_PASSKEY_ERROR }
    }

    try {
      const login = await withTransaction(async (client) => {
        const credentialResult = await client.query(
          `
            SELECT
              credential.*,
              u.username,
              u.role,
              u.status,
              u.created_at AS user_created_at,
              u.updated_at AS user_updated_at,
              u.approved_at,
              u.last_login_at
            FROM webauthn_credentials credential
            JOIN users u ON u.id = credential.user_id
            WHERE credential.credential_id = $1
              AND credential.user_id = $2
              AND credential.rp_id = $3
              AND u.status = 'approved'
            LIMIT 1
            FOR UPDATE OF credential, u
          `,
          [response.id, challenge.user_id, config.webauthnRpId]
        )
        const credential = credentialResult.rows[0]
        if (!credential) throw new Error('Passkey credential unavailable')

        if (isReleaseAcceptanceUsername(credential.username)) {
          const eligibility = await inspectReleaseAcceptanceLoginEligibility(
            client,
            {
              userId: credential.user_id,
              username: credential.username
            }
          )
          if (!eligibility.active) {
            throw new Error('Passkey account unavailable')
          }
        }

        const counter = Number(credential.counter)
        if (!Number.isSafeInteger(counter) || counter < 0) {
          throw new Error('Invalid passkey counter')
        }
        const verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: config.webauthnOrigin,
          expectedRPID: config.webauthnRpId,
          requireUserVerification: true,
          credential: {
            id: credential.credential_id,
            publicKey: new Uint8Array(credential.public_key),
            counter,
            transports: normalizeTransports(credential.transports)
          }
        })
        if (!verification.verified) {
          throw new Error('Passkey authentication verification failed')
        }

        await client.query(
          `
            UPDATE webauthn_credentials
            SET counter = $2,
                last_used_at = NOW()
            WHERE id = $1
          `,
          [credential.id, verification.authenticationInfo.newCounter]
        )
        const updatedUser = await client.query(
          `
            UPDATE users
            SET last_login_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
          `,
          [credential.user_id]
        )
        const token = createSessionToken()
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
            credential.user_id,
            hashSessionToken(token),
            request.ip,
            request.headers['user-agent'] || '',
            String(config.sessionTtlDays)
          ]
        )

        await recordSecurityEvent({
          client,
          request,
          eventType: 'auth.passkey.login',
          outcome: 'success',
          actorUserId: credential.user_id,
          subjectUserId: credential.user_id,
          resourceType: 'session',
          resourceId: createdSession.rows[0].id,
          affectedCount: 1
        })
        return {
          token,
          user: updatedUser.rows[0]
        }
      })

      await fastify.setSessionCookie(reply, login.token)
      return { user: sanitizeUser(login.user) }
    } catch (error) {
      request.log.warn('passkey authentication verification failed')
      await recordSecurityEventBestEffort({
        request,
        eventType: 'auth.passkey.login',
        outcome: 'failure',
        subjectUserId: challenge.user_id
      }, request.log)
      reply.code(401)
      return { error: GENERIC_PASSKEY_ERROR }
    }
  })
}
