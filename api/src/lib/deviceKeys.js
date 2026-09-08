import { randomBytes } from 'node:crypto'
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse
} from '@simplewebauthn/server'
import { pool, withTransaction } from '../db/index.js'
import { config } from '../config.js'
import { sha256 } from './oauthProtocol.js'
import { createSessionToken, hashSessionToken, verifyPassword } from './auth.js'
import { sessionLifetimeDays } from './sessionPolicy.js'
import { sanitizeUser } from './users.js'
import { recordSecurityEvent } from './securityEvents.js'
import { isReleaseAcceptanceUsername } from '../ops/releaseAcceptanceAccount.js'

export const DEVICE_KEY_ORIGIN = 'https://nav.skrskr.net'
export const DEVICE_KEY_RP_ID = 'nav.skrskr.net'
const FLOW_COOKIE = 'nav_device_key_flow'
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'strict', path: '/api/auth/device-keys', maxAge: 300 }
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])

export function deviceKeyError(code = 'DEVICE_KEY_INVALID', statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode })
}
export function deviceKeysAvailable(request) {
  return config.deviceKeysEnabled && request.hostname === DEVICE_KEY_RP_ID
}
export function requireDeviceKeyOrigin(request) {
  if (!deviceKeysAvailable(request)) throw deviceKeyError('DEVICE_KEY_UNAVAILABLE', 503)
  if (request.headers.origin !== DEVICE_KEY_ORIGIN) throw deviceKeyError('DEVICE_KEY_ORIGIN', 403)
}
export function deviceKeyUserHandle(id) { return new Uint8Array(Buffer.from(String(id), 'utf8')) }
export function sanitizedTransports(value) {
  return Array.isArray(value) ? [...new Set(value.filter(item => TRANSPORTS.has(item)))].slice(0, 7) : []
}
function flow(request, reply, create = false) {
  let value = request.cookies?.[FLOW_COOKIE]
  if (!/^[\w-]{43}$/.test(value || '')) value = create ? randomBytes(32).toString('base64url') : ''
  if (create) reply.setCookie(FLOW_COOKIE, value, COOKIE_OPTIONS)
  return value ? sha256(value) : ''
}
function approved(user) { return user?.status === 'approved' && !isReleaseAcceptanceUsername(user.username) }
function publicKeyInfo(row) {
  return { id: row.id, name: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at,
    synced: row.device_type === 'multiDevice', backedUp: row.backed_up, domain: row.rp_id }
}

export function createDeviceKeyService(database = { query: pool.query.bind(pool), withTransaction }, webauthn = {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse
}) {
  const cleanup = client => client.query(`DELETE FROM auth_device_key_challenges WHERE id IN
    (SELECT id FROM auth_device_key_challenges WHERE expires_at<=NOW() ORDER BY expires_at LIMIT 100)`)
  return {
    async list(userId) {
      const result = await database.query(`SELECT id,label,created_at,last_used_at,device_type,backed_up,rp_id
        FROM auth_device_keys WHERE user_id=$1 ORDER BY created_at,id`, [userId])
      return result.rows.map(publicKeyInfo)
    },
    async registerOptions(request, reply, { currentPassword, name }) {
      requireDeviceKeyOrigin(request)
      const digest = flow(request, reply, true)
      return database.withTransaction(async client => {
        const user = (await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [request.currentUser.id])).rows[0]
        if (!approved(user) || !await verifyPassword(currentPassword, user.password_hash)) throw deviceKeyError('DEVICE_KEY_REAUTH_REQUIRED', 403)
        const session = await client.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>NOW() FOR UPDATE', [request.session.id, user.id])
        if (!session.rowCount) throw deviceKeyError('AUTHENTICATION_REQUIRED', 401)
        const keys = (await client.query('SELECT credential_id,transports FROM auth_device_keys WHERE user_id=$1', [user.id])).rows
        if (keys.length >= 10) throw deviceKeyError('DEVICE_KEY_LIMIT')
        const options = await webauthn.generateRegistrationOptions({ rpName: 'DOMO NAV', rpID: DEVICE_KEY_RP_ID,
          userID: deviceKeyUserHandle(user.id), userName: user.username, userDisplayName: user.username,
          attestationType: 'none', timeout: 60000,
          authenticatorSelection: { residentKey: 'required', userVerification: 'required', authenticatorAttachment: 'platform' },
          excludeCredentials: keys.map(key => ({ id: key.credential_id, transports: sanitizedTransports(key.transports) })) })
        await cleanup(client)
        await client.query("DELETE FROM auth_device_key_challenges WHERE flow_digest=$1 AND kind='register'", [digest])
        const challenge = await client.query(`INSERT INTO auth_device_key_challenges
          (kind,challenge_digest,flow_digest,origin,user_id,session_id,credential_version,label)
          VALUES('register',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [sha256(options.challenge), digest, DEVICE_KEY_ORIGIN, user.id, request.session.id, user.auth_version, name.trim()])
        return { options, challengeId: challenge.rows[0].id }
      })
    },
    async registerVerify(request, reply, { challengeId, response }) {
      requireDeviceKeyOrigin(request)
      const digest = flow(request, reply)
      if (!digest) throw deviceKeyError()
      const result = await database.withTransaction(async client => {
        const user = (await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [request.currentUser.id])).rows[0]
        const challenge = (await client.query(`DELETE FROM auth_device_key_challenges
          WHERE id=$1 AND flow_digest=$2 AND kind='register' AND user_id=$3 AND session_id=$4
          AND origin=$5 AND expires_at>NOW() RETURNING *`,
        [challengeId, digest, request.currentUser.id, request.session.id, DEVICE_KEY_ORIGIN])).rows[0]
        if (!challenge || !approved(user) || String(user.auth_version) !== String(challenge.credential_version)) return null
        const session = await client.query('SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>NOW() FOR UPDATE', [request.session.id, user.id])
        if (!session.rowCount) return null
        const count = (await client.query('SELECT COUNT(*)::int AS count FROM auth_device_keys WHERE user_id=$1', [user.id])).rows[0].count
        if (count >= 10) return null
        let verification
        try {
          verification = await webauthn.verifyRegistrationResponse({ response, expectedChallenge: value => sha256(value) === challenge.challenge_digest,
            expectedOrigin: DEVICE_KEY_ORIGIN, expectedRPID: DEVICE_KEY_RP_ID, requireUserVerification: true })
        } catch { return null }
        const info = verification.registrationInfo
        if (!verification.verified || !info?.credential || !info.userVerified) return null
        const inserted = await client.query(`INSERT INTO auth_device_keys
          (user_id,credential_id,public_key,counter,label,transports,device_type,backed_up)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
        [user.id, info.credential.id, Buffer.from(info.credential.publicKey), info.credential.counter, challenge.label,
          JSON.stringify(sanitizedTransports(info.credential.transports)), info.credentialDeviceType, info.credentialBackedUp])
        await recordSecurityEvent({ client, request, eventType: 'auth.passkey.register', outcome: 'success', subjectUserId: user.id,
          resourceType: 'passkey', resourceId: inserted.rows[0].id, affectedCount: 1 })
        return publicKeyInfo(inserted.rows[0])
      })
      if (!result) throw deviceKeyError()
      return { key: result }
    },
    async loginOptions(request, reply, { trustDevice = false }) {
      requireDeviceKeyOrigin(request)
      const digest = flow(request, reply, true)
      const options = await webauthn.generateAuthenticationOptions({ rpID: DEVICE_KEY_RP_ID, userVerification: 'required', timeout: 60000 })
      const challenge = await database.withTransaction(async client => {
        await cleanup(client)
        await client.query("DELETE FROM auth_device_key_challenges WHERE flow_digest=$1 AND kind='login'", [digest])
        return client.query(`INSERT INTO auth_device_key_challenges(kind,challenge_digest,flow_digest,origin,trust_device)
          VALUES('login',$1,$2,$3,$4) RETURNING id`, [sha256(options.challenge), digest, DEVICE_KEY_ORIGIN, trustDevice === true])
      })
      return { options, challengeId: challenge.rows[0].id }
    },
    async loginVerify(request, reply, { challengeId, response }) {
      requireDeviceKeyOrigin(request)
      const digest = flow(request, reply)
      if (!digest) throw deviceKeyError()
      const result = await database.withTransaction(async client => {
        const user = (await client.query(`SELECT u.* FROM users u JOIN auth_device_keys k ON k.user_id=u.id
          WHERE k.credential_id=$1 AND k.rp_id=$2 FOR UPDATE OF u`, [response.id, DEVICE_KEY_RP_ID])).rows[0]
        const challenge = (await client.query(`DELETE FROM auth_device_key_challenges
          WHERE id=$1 AND flow_digest=$2 AND kind='login' AND origin=$3 AND expires_at>NOW() RETURNING *`,
        [challengeId, digest, DEVICE_KEY_ORIGIN])).rows[0]
        if (!challenge || !approved(user) || new Date(user.auth_changed_at).getTime() > new Date(challenge.created_at).getTime()) return null
        const key = (await client.query('SELECT * FROM auth_device_keys WHERE credential_id=$1 AND user_id=$2 AND rp_id=$3 FOR UPDATE', [response.id, user.id, DEVICE_KEY_RP_ID])).rows[0]
        if (!key || response.response?.userHandle !== Buffer.from(deviceKeyUserHandle(user.id)).toString('base64url')) return null
        let verification
        try {
          verification = await webauthn.verifyAuthenticationResponse({ response,
            expectedChallenge: value => sha256(value) === challenge.challenge_digest,
            expectedOrigin: DEVICE_KEY_ORIGIN, expectedRPID: DEVICE_KEY_RP_ID, requireUserVerification: true,
            credential: { id: key.credential_id, publicKey: new Uint8Array(key.public_key), counter: Number(key.counter), transports: sanitizedTransports(key.transports) } })
        } catch { return null }
        if (!verification.verified || !verification.authenticationInfo?.userVerified) return null
        await client.query('UPDATE auth_device_keys SET counter=$2,backed_up=$3,last_used_at=NOW() WHERE id=$1',
          [key.id, verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialBackedUp])
        const token = createSessionToken()
        const session = await client.query(`INSERT INTO sessions(user_id,token_hash,ip_address,user_agent,expires_at,device_key_id)
          VALUES($1,$2,$3,$4,NOW()+($5 || ' days')::interval,$6) RETURNING id`,
        [user.id, hashSessionToken(token), request.ip, String(request.headers['user-agent'] || '').slice(0,1000), String(sessionLifetimeDays(challenge.trust_device)), key.id])
        await client.query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [user.id])
        await recordSecurityEvent({ client, request, eventType: 'auth.passkey.login', outcome: 'success', subjectUserId: user.id,
          resourceType: 'session', resourceId: session.rows[0].id, affectedCount: 1 })
        return { token, user: sanitizeUser(user), trustDevice: challenge.trust_device }
      })
      if (!result) throw deviceKeyError()
      return result
    },
    async remove(request, { id, currentPassword }) {
      requireDeviceKeyOrigin(request)
      return database.withTransaction(async client => {
        const user = (await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [request.currentUser.id])).rows[0]
        if (!approved(user) || !await verifyPassword(currentPassword, user.password_hash)) throw deviceKeyError('DEVICE_KEY_REAUTH_REQUIRED', 403)
        const session = await client.query('SELECT id,device_key_id FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>NOW() FOR UPDATE', [request.session.id,user.id])
        if (!session.rowCount) throw deviceKeyError('AUTHENTICATION_REQUIRED',401)
        const removed = await client.query('DELETE FROM auth_device_keys WHERE id=$1 AND user_id=$2 RETURNING id', [id,user.id])
        if (!removed.rowCount) throw deviceKeyError()
        await client.query('DELETE FROM auth_device_key_challenges WHERE user_id=$1', [user.id])
        await recordSecurityEvent({ client, request, eventType:'auth.passkey.delete',outcome:'success',subjectUserId:user.id,resourceType:'passkey',resourceId:id,affectedCount:1 })
        return { ok: true, currentSessionRevoked: session.rows[0].device_key_id === id }
      })
    }
  }
}

export const deviceKeys = createDeviceKeyService()
