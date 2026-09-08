import { randomBytes } from 'node:crypto'
import { query, withTransaction } from '../db/index.js'
import { sha256, safeReturnPath } from './oauthProtocol.js'

export const HANDOFF_COOKIE = 'nav_oauth_handoff'
export const HANDOFF_TTL_SECONDS = 600
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const ORIGINS = new Set(['https://nav.skrskr.net', 'https://nav.cristsau.cn'])

export function validHandoffSecret(value) {
  return typeof value === 'string' && SECRET_PATTERN.test(value)
}

export function requireHandoffOrigin(request, origin) {
  if (!ORIGINS.has(origin) || request.headers.origin !== origin) {
    throw Object.assign(new Error('请从原应用重新发起登录'), { statusCode: 403, code: 'OAUTH_HANDOFF_ORIGIN' })
  }
}

export function setHandoffCookie(reply, secret) {
  reply.setCookie(HANDOFF_COOKIE, secret, {
    httpOnly: true, secure: true, sameSite: 'strict', path: '/api/auth/oauth', maxAge: HANDOFF_TTL_SECONDS
  })
}

export function clearHandoffCookie(reply) {
  reply.clearCookie(HANDOFF_COOKIE, { secure: true, sameSite: 'strict', path: '/api/auth/oauth' })
}

// Inject only the database adapter for isolated, non-network unit tests.
export function createOauthHandoffs(database = { query, withTransaction }) {
  return {
    async begin({ origin, provider, returnTo, trustDevice, previousClaim }) {
      if (!ORIGINS.has(origin) || !['google', 'wechat'].includes(provider)) throw new Error('Invalid handoff scope')
      const claim = randomBytes(32).toString('base64url')
      const launch = randomBytes(32).toString('base64url')
      await database.withTransaction(async client => {
        await client.query(`DELETE FROM auth_oauth_handoffs WHERE id IN
          (SELECT id FROM auth_oauth_handoffs WHERE expires_at<=NOW() ORDER BY expires_at LIMIT 100)`)
        if (validHandoffSecret(previousClaim)) {
          await client.query('DELETE FROM auth_oauth_handoffs WHERE claim_digest=$1 AND origin=$2', [sha256(previousClaim), origin])
        }
        await client.query(`INSERT INTO auth_oauth_handoffs
          (provider,origin,claim_digest,launch_digest,return_path,trust_device) VALUES($1,$2,$3,$4,$5,$6)`,
        [provider, origin, sha256(claim), sha256(launch), safeReturnPath(returnTo), trustDevice === true])
      })
      return { claim, launch, expiresIn: HANDOFF_TTL_SECONDS }
    },

    async launch({ origin, provider, secret }) {
      if (!validHandoffSecret(secret)) return null
      const result = await database.query(`UPDATE auth_oauth_handoffs SET launched_at=NOW()
        WHERE launch_digest=$1 AND origin=$2 AND provider=$3 AND launched_at IS NULL
        AND launch_expires_at>NOW() AND expires_at>NOW() RETURNING id,return_path,trust_device`,
      [sha256(secret), origin, provider])
      return result.rows[0] || null
    },

    async approve(client, { id, origin, provider, user }) {
      const result = await client.query(`UPDATE auth_oauth_handoffs
        SET user_id=$4,identity_id=$5,credential_version=$6,approved_at=NOW(),
          expires_at=LEAST(expires_at,NOW()+INTERVAL '2 minutes')
        WHERE id=$1 AND origin=$2 AND provider=$3 AND launched_at IS NOT NULL
        AND approved_at IS NULL AND expires_at>NOW()
        AND created_at >= $7::timestamptz RETURNING id`,
      [id, origin, provider, user.id, user.identity_id, user.auth_version, user.auth_changed_at])
      return result.rowCount === 1
    },

    async inspect({ origin, claim }) {
      if (!validHandoffSecret(claim)) return { state: 'expired' }
      const result = await database.query(`SELECT approved_at IS NOT NULL AS ready
        FROM auth_oauth_handoffs WHERE claim_digest=$1 AND origin=$2 AND expires_at>NOW()`,
      [sha256(claim), origin])
      return { state: result.rows[0] ? (result.rows[0].ready ? 'ready' : 'pending') : 'expired' }
    },

    async finish({ origin, claim, createSession }) {
      if (!validHandoffSecret(claim)) return null
      return database.withTransaction(async client => {
        const params = [sha256(claim), origin]
        // User -> handoff lock order matches password changes and callback approval.
        const user = (await client.query(`SELECT u.* FROM users u
          JOIN auth_oauth_handoffs h ON h.user_id=u.id
          WHERE h.claim_digest=$1 AND h.origin=$2 AND h.expires_at>NOW()
          AND h.approved_at IS NOT NULL FOR UPDATE OF u`, params)).rows[0]
        if (!user) return null
        const handoff = (await client.query(`SELECT h.*,i.user_id AS identity_user_id FROM auth_oauth_handoffs h
          JOIN oauth_identities i ON i.id=h.identity_id AND i.provider=h.provider
          WHERE h.claim_digest=$1 AND h.origin=$2 AND h.expires_at>NOW()
          AND h.approved_at IS NOT NULL FOR UPDATE OF h,i`, params)).rows[0]
        if (!handoff) return null
        await client.query('DELETE FROM auth_oauth_handoffs WHERE id=$1', [handoff.id])
        if (user.status !== 'approved' || String(user.auth_version) !== String(handoff.credential_version)
          || handoff.identity_user_id !== user.id) return null
        const session = await createSession(client, { ...user, identity_id: handoff.identity_id }, handoff.trust_device)
        return session ? { ...session, trustDevice: handoff.trust_device, returnTo: safeReturnPath(handoff.return_path) } : null
      })
    },

    async cancel({ origin, claim }) {
      if (validHandoffSecret(claim)) {
        await database.query('DELETE FROM auth_oauth_handoffs WHERE claim_digest=$1 AND origin=$2', [sha256(claim), origin])
      }
    }
  }
}

export const oauthHandoffs = createOauthHandoffs()
