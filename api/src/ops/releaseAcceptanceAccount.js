import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { digestSensitiveValue } from '../lib/persistentRateLimit.js'

export const RELEASE_ACCEPTANCE_USERNAME_PREFIX = 'nav_release_accept_'
export const RELEASE_ACCEPTANCE_MARKER_PREFIX = 'release_acceptance_account:'
export const RELEASE_ACCEPTANCE_LOCK_NAME = 'nav_release_acceptance_account'
export const RELEASE_ACCEPTANCE_ACCOUNT_TTL_SECONDS = 30 * 60
export const RELEASE_ACCEPTANCE_RECOVERY_INTERVAL_MS = 60 * 1000

const RUN_ID_PATTERN = /^[0-9a-f]{48}$/
const USERNAME_PATTERN = /^nav_release_accept_[0-9a-f]{32}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_CLIENT_IPS = 8
const MAX_RECOVERY_CANDIDATES = 8

export class ReleaseAcceptanceAccountError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ReleaseAcceptanceAccountError'
    this.code = code
  }
}

function fail(code) {
  throw new ReleaseAcceptanceAccountError(code)
}

function normalizeRunId(value) {
  const runId = String(value || '').trim().toLowerCase()
  if (!RUN_ID_PATTERN.test(runId)) fail('INVALID_RUN_ID')
  return runId
}

function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase()
  if (!USERNAME_PATTERN.test(username)) fail('INVALID_ACCEPTANCE_USERNAME')
  return username
}

export function isReleaseAcceptanceUsername(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .startsWith(RELEASE_ACCEPTANCE_USERNAME_PREFIX)
}

function normalizeUserId(value) {
  const userId = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(userId)) fail('INVALID_ACCEPTANCE_USER_ID')
  return userId
}

function normalizeClientIps(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CLIENT_IPS) {
    fail('INVALID_ACCEPTANCE_CLIENT_IPS')
  }
  const unique = [...new Set(value.map((entry) => String(entry || '').trim().toLowerCase()))]
  if (unique.length < 1 || unique.some((entry) => !isIP(entry))) {
    fail('INVALID_ACCEPTANCE_CLIENT_IPS')
  }
  return unique
}

function markerKey(runId) {
  return `${RELEASE_ACCEPTANCE_MARKER_PREFIX}${normalizeRunId(runId)}`
}

function normalizeTimestamp(value, errorCode = 'INVALID_ACCEPTANCE_MARKER') {
  if (value === null || value === undefined || String(value).trim() === '') {
    fail(errorCode)
  }
  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) fail(errorCode)
  return timestamp
}

export function evaluateReleaseAcceptanceMarker(marker, {
  expectedRunId,
  expectedUsername,
  expectedUserId,
  now = new Date()
} = {}) {
  if (
    !marker
    || typeof marker !== 'object'
    || ![2, 3].includes(marker.version)
  ) {
    fail('INVALID_ACCEPTANCE_MARKER')
  }

  const runId = normalizeRunId(marker.runId)
  const username = normalizeUsername(marker.username)
  const userId = normalizeUserId(marker.userId)
  const clientIps = normalizeClientIps(marker.clientIps)
  if (expectedRunId && runId !== normalizeRunId(expectedRunId)) {
    fail('ACCEPTANCE_MARKER_RUN_ID_MISMATCH')
  }
  if (expectedUsername && username !== normalizeUsername(expectedUsername)) {
    fail('ACCEPTANCE_MARKER_USERNAME_MISMATCH')
  }
  if (expectedUserId && userId !== normalizeUserId(expectedUserId)) {
    fail('ACCEPTANCE_MARKER_USER_ID_MISMATCH')
  }

  const currentTime = normalizeTimestamp(now)
  const expiresAt = marker.version === 3
    ? normalizeTimestamp(marker.expiresAt)
    : null

  return {
    version: marker.version,
    runId,
    username,
    userId,
    clientIps,
    expiresAt: expiresAt?.toISOString() || null,
    expired: !expiresAt || expiresAt.getTime() <= currentTime.getTime()
  }
}

async function acquireLifecycleLock(client) {
  await client.query(
    `
      SELECT pg_advisory_xact_lock(
        hashtext(current_database()),
        hashtext($1)
      )
    `,
    [RELEASE_ACCEPTANCE_LOCK_NAME]
  )
}

async function findResidue(client) {
  const [markers, users] = await Promise.all([
    client.query(
      `
        SELECT key
        FROM system_settings
        WHERE LEFT(key, LENGTH($1)) = $1
        ORDER BY key
        FOR UPDATE
      `,
      [RELEASE_ACCEPTANCE_MARKER_PREFIX]
    ),
    client.query(
      `
        SELECT id
        FROM users
        WHERE LEFT(username, LENGTH($1)) = $1
        ORDER BY id
        FOR UPDATE
      `,
      [RELEASE_ACCEPTANCE_USERNAME_PREFIX]
    )
  ])

  return {
    markerCount: markers.rowCount,
    userCount: users.rowCount
  }
}

function rateLimitKeyDigest(scope, rawKey, secret) {
  return digestSensitiveValue(`rate-limit:${scope}`, rawKey, { secret })
}

function loginIdentityKey(username, clientIp) {
  const identityDigest = createHash('sha256')
    .update(username)
    .digest('hex')
  return `login:${String(clientIp || '').trim().toLowerCase()}:id:${identityDigest}`
}

function buildOwnedRateLimitBuckets({ userId, username, clientIps, sessions, secret }) {
  const exact = new Map()
  const add = (scope, rawKey) => {
    exact.set(
      `${scope}:${rawKey}`,
      {
        scope,
        digest: rateLimitKeyDigest(scope, rawKey, secret)
      }
    )
  }

  add('authenticated_write', `user:${userId}`)
  add('ai_requests', `user:${userId}`)

  for (const clientIp of clientIps) {
    add('auth_login', loginIdentityKey(username, clientIp))
  }

  for (const session of sessions) {
    const sessionId = normalizeUserId(session.id)
    add('data_restore', `user:${userId}:session:${sessionId}`)
    const clientIp = String(session.ip_address || '').trim()
    if (clientIp) add('auth_login', loginIdentityKey(username, clientIp))
  }

  return [...exact.values()]
}

export async function inspectReleaseAcceptanceResidue(client) {
  const markers = await client.query(
    `
      SELECT COUNT(*)::integer AS count
      FROM system_settings
      WHERE LEFT(key, LENGTH($1)) = $1
    `,
    [RELEASE_ACCEPTANCE_MARKER_PREFIX]
  )
  const users = await client.query(
    `
      SELECT COUNT(*)::integer AS count
      FROM users
      WHERE LEFT(username, LENGTH($1)) = $1
    `,
    [RELEASE_ACCEPTANCE_USERNAME_PREFIX]
  )
  const database = await client.query(
    `
      SELECT
        current_database() AS database_name,
        (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
        COALESCE(inet_server_addr()::text, '') AS database_server_address,
        inet_server_port()::integer AS database_server_port,
        current_setting('server_version_num') AS server_version_num
    `
  )
  const identity = database.rows[0] || {}

  return {
    markerCount: Number(markers.rows[0]?.count || 0),
    userCount: Number(users.rows[0]?.count || 0),
    databaseName: String(identity.database_name || ''),
    databaseOid: String(identity.database_oid || ''),
    databaseServerAddress: String(identity.database_server_address || ''),
    databaseServerPort: Number(identity.database_server_port || 0),
    serverVersionNum: String(identity.server_version_num || '')
  }
}

export async function provisionReleaseAcceptanceAccount(client, {
  runId,
  username,
  passwordHash,
  clientIps
}) {
  const normalizedRunId = normalizeRunId(runId)
  const normalizedUsername = normalizeUsername(username)
  const normalizedPasswordHash = String(passwordHash || '').trim()
  const normalizedClientIps = normalizeClientIps(clientIps)
  if (!/^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/i.test(normalizedPasswordHash)) {
    fail('INVALID_PASSWORD_HASH')
  }

  await acquireLifecycleLock(client)
  const residue = await findResidue(client)
  if (residue.markerCount > 0 || residue.userCount > 0) {
    fail('ACCEPTANCE_ACCOUNT_RESIDUE_PRESENT')
  }

  const inserted = await client.query(
    `
      INSERT INTO users (
        username,
        password_hash,
        role,
        status,
        approved_at
      ) VALUES ($1, $2, 'admin', 'approved', NOW())
      RETURNING id
    `,
    [normalizedUsername, normalizedPasswordHash]
  )
  const userId = normalizeUserId(inserted.rows[0]?.id)

  const marker = await client.query(
    `
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (
        $1,
        jsonb_build_object(
          'version', 3,
          'runId', $2::text,
          'username', $3::text,
          'userId', $4::text,
          'clientIps', to_jsonb($5::text[]),
          'expiresAt', to_jsonb(
            CURRENT_TIMESTAMP + ($6::integer * INTERVAL '1 second')
          )
        ),
        NOW()
      )
      RETURNING value->>'expiresAt' AS expires_at
    `,
    [
      markerKey(normalizedRunId),
      normalizedRunId,
      normalizedUsername,
      userId,
      normalizedClientIps,
      RELEASE_ACCEPTANCE_ACCOUNT_TTL_SECONDS
    ]
  )

  return {
    userId,
    expiresAt: normalizeTimestamp(marker.rows[0]?.expires_at).toISOString()
  }
}

export async function cleanupReleaseAcceptanceAccount(client, {
  runId,
  expectedUsername,
  expectedUserId,
  rateLimitSecret,
  expiredOnly = false,
  allowMissingExpected = false
}) {
  const normalizedRunId = normalizeRunId(runId)
  const normalizedExpectedUsername = normalizeUsername(expectedUsername)
  const normalizedExpectedUserId = expectedUserId
    ? normalizeUserId(expectedUserId)
    : ''
  const expectedMarkerKey = markerKey(normalizedRunId)

  await acquireLifecycleLock(client)
  const markerResult = await client.query(
    `
      SELECT value, CURRENT_TIMESTAMP AS database_now
      FROM system_settings
      WHERE key = $1
      FOR UPDATE
    `,
    [expectedMarkerKey]
  )

  if (markerResult.rowCount === 0) {
    const residue = await findResidue(client)
    if (residue.markerCount > 0 || residue.userCount > 0) {
      fail('UNTRACKED_ACCEPTANCE_ACCOUNT_RESIDUE')
    }
    if (normalizedExpectedUserId) {
      const exactExpectedUser = await client.query(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [normalizedExpectedUserId]
      )
      if (exactExpectedUser.rowCount > 0) {
        fail('EXPECTED_ACCEPTANCE_ACCOUNT_MISSING_OR_RENAMED')
      }
      if (!allowMissingExpected) {
        fail('EXPECTED_ACCEPTANCE_ACCOUNT_MISSING')
      }
    }
    return {
      cleaned: false,
      markerMissing: true,
      usersRemoved: 0,
      sessionsRemoved: 0,
      securityEventsRemoved: 0,
      rateLimitBucketsRemoved: 0
    }
  }

  const marker = evaluateReleaseAcceptanceMarker(
    markerResult.rows[0]?.value,
    {
      expectedRunId: normalizedRunId,
      expectedUsername: normalizedExpectedUsername,
      expectedUserId: normalizedExpectedUserId || undefined,
      now: markerResult.rows[0]?.database_now
    }
  )
  const { username, userId, clientIps } = marker
  if (expiredOnly && !marker.expired) {
    return {
      cleaned: false,
      markerMissing: false,
      notExpired: true,
      usersRemoved: 0,
      sessionsRemoved: 0,
      securityEventsRemoved: 0,
      rateLimitBucketsRemoved: 0
    }
  }

  const userResult = await client.query(
    `
      SELECT id, username, role, status
      FROM users
      WHERE id = $1
        AND username = $2
      FOR UPDATE
    `,
    [userId, username]
  )
  if (userResult.rowCount !== 1) fail('ACCEPTANCE_ACCOUNT_MISSING_OR_MISMATCHED')
  const user = userResult.rows[0]
  if (user.role !== 'admin' || user.status !== 'approved') {
    fail('ACCEPTANCE_ACCOUNT_STATE_MISMATCH')
  }

  const sessions = await client.query(
    `
      SELECT id, ip_address
      FROM sessions
      WHERE user_id = $1
      FOR UPDATE
    `,
    [userId]
  )
  const ownedBuckets = buildOwnedRateLimitBuckets({
    userId,
    username,
    clientIps,
    sessions: sessions.rows,
    secret: rateLimitSecret
  })
  let rateLimitBucketsRemoved = 0
  if (ownedBuckets.length > 0) {
    const deletedBuckets = await client.query(
      `
        DELETE FROM rate_limit_buckets AS bucket
        USING UNNEST($1::text[], $2::text[]) AS owned(scope, key_digest)
        WHERE bucket.scope = owned.scope
          AND bucket.key_digest = owned.key_digest
      `,
      [
        ownedBuckets.map((entry) => entry.scope),
        ownedBuckets.map((entry) => entry.digest)
      ]
    )
    rateLimitBucketsRemoved = deletedBuckets.rowCount
  }

  const deletedEvents = await client.query(
    `
      DELETE FROM security_events
      WHERE actor_user_id = $1
         OR subject_user_id = $1
    `,
    [userId]
  )
  const deletedUser = await client.query(
    'DELETE FROM users WHERE id = $1 AND username = $2',
    [userId, username]
  )
  if (deletedUser.rowCount !== 1) fail('ACCEPTANCE_ACCOUNT_DELETE_MISMATCH')
  await client.query('DELETE FROM system_settings WHERE key = $1', [expectedMarkerKey])

  const residue = await findResidue(client)
  if (residue.markerCount > 0 || residue.userCount > 0) {
    fail('ACCEPTANCE_ACCOUNT_CLEANUP_INCOMPLETE')
  }

  return {
    cleaned: true,
    markerMissing: false,
    usersRemoved: deletedUser.rowCount,
    sessionsRemoved: sessions.rowCount,
    securityEventsRemoved: deletedEvents.rowCount,
    rateLimitBucketsRemoved
  }
}

export async function inspectReleaseAcceptanceLoginEligibility(client, {
  userId,
  username
}) {
  const normalizedUsername = String(username || '').trim().toLowerCase()
  if (!isReleaseAcceptanceUsername(normalizedUsername)) {
    return {
      applicable: false,
      active: true,
      reason: 'not-release-acceptance'
    }
  }

  let normalizedUserId
  try {
    normalizedUserId = normalizeUserId(userId)
    normalizeUsername(normalizedUsername)
  } catch {
    return { applicable: true, active: false, reason: 'invalid-identity' }
  }

  const markerResult = await client.query(
    `
      SELECT key, value, CURRENT_TIMESTAMP AS database_now
      FROM system_settings
      WHERE value->>'username' = $1
        AND value->>'userId' = $2
      ORDER BY key
      LIMIT 2
    `,
    [normalizedUsername, normalizedUserId]
  )
  if (markerResult.rowCount !== 1) {
    return { applicable: true, active: false, reason: 'marker-missing-or-ambiguous' }
  }

  try {
    const row = markerResult.rows[0]
    const marker = evaluateReleaseAcceptanceMarker(row.value, {
      expectedUsername: normalizedUsername,
      expectedUserId: normalizedUserId,
      now: row.database_now
    })
    if (row.key !== markerKey(marker.runId)) {
      return { applicable: true, active: false, reason: 'marker-key-mismatch' }
    }
    return {
      applicable: true,
      active: !marker.expired,
      reason: marker.expired ? 'expired' : 'active',
      expiresAt: marker.expiresAt
    }
  } catch {
    return { applicable: true, active: false, reason: 'invalid-marker' }
  }
}

async function withPoolTransaction(poolInstance, callback) {
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL statement_timeout = '15s'")
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function recoverExpiredReleaseAcceptanceAccounts({
  poolInstance,
  limit = MAX_RECOVERY_CANDIDATES
}) {
  if (
    typeof poolInstance?.query !== 'function'
    || typeof poolInstance?.connect !== 'function'
  ) {
    throw new TypeError('poolInstance query and connect are required')
  }
  const boundedLimit = Number(limit)
  if (
    !Number.isSafeInteger(boundedLimit)
    || boundedLimit < 1
    || boundedLimit > MAX_RECOVERY_CANDIDATES
  ) {
    throw new TypeError(`limit must be an integer from 1 to ${MAX_RECOVERY_CANDIDATES}`)
  }

  const candidates = await withPoolTransaction(poolInstance, (client) => (
    client.query(
      `
        SELECT key, value, CURRENT_TIMESTAMP AS database_now
        FROM system_settings
        WHERE LEFT(key, LENGTH($1)) = $1
        ORDER BY updated_at ASC, key ASC
        LIMIT $2
      `,
      [RELEASE_ACCEPTANCE_MARKER_PREFIX, boundedLimit]
    )
  ))
  const result = {
    examinedCount: candidates.rowCount,
    cleanedCount: 0,
    activeCount: 0,
    failedCount: 0,
    failures: []
  }

  for (const row of candidates.rows) {
    let marker
    try {
      marker = evaluateReleaseAcceptanceMarker(row.value, {
        now: row.database_now
      })
      if (row.key !== markerKey(marker.runId)) {
        fail('ACCEPTANCE_MARKER_KEY_MISMATCH')
      }
    } catch (error) {
      result.failedCount += 1
      result.failures.push(error?.code || 'INVALID_ACCEPTANCE_MARKER')
      continue
    }

    if (!marker.expired) {
      result.activeCount += 1
      continue
    }

    try {
      const cleanup = await withPoolTransaction(poolInstance, (client) => (
        cleanupReleaseAcceptanceAccount(client, {
          runId: marker.runId,
          expectedUsername: marker.username,
          expectedUserId: marker.userId,
          expiredOnly: true,
          allowMissingExpected: true
        })
      ))
      if (cleanup.cleaned) result.cleanedCount += 1
      else if (cleanup.notExpired) result.activeCount += 1
    } catch (error) {
      result.failedCount += 1
      result.failures.push(error?.code || 'RELEASE_ACCEPTANCE_ACCOUNT_FAILED')
    }
  }

  return result
}

export function startReleaseAcceptanceAccountRecovery({
  poolInstance,
  logger,
  recoverFn = recoverExpiredReleaseAcceptanceAccounts,
  timerApi = globalThis,
  intervalMs = RELEASE_ACCEPTANCE_RECOVERY_INTERVAL_MS
}) {
  let stopped = false
  let activeRun = null

  const run = () => {
    if (stopped || activeRun) return activeRun
    activeRun = Promise.resolve()
      .then(() => recoverFn({ poolInstance }))
      .then((result) => {
        if (result?.cleanedCount > 0) {
          logger?.warn?.(
            { cleanedCount: result.cleanedCount },
            'expired release acceptance account recovered'
          )
        }
        if (result?.failedCount > 0) {
          logger?.error?.(
            { failedCount: result.failedCount, failures: result.failures },
            'release acceptance account recovery requires operator review'
          )
        }
        return result
      })
      .catch((error) => {
        logger?.error?.(error, 'failed to recover expired release acceptance account')
      })
      .finally(() => {
        activeRun = null
      })
    return activeRun
  }

  const intervalHandle = timerApi.setInterval(() => void run(), intervalMs)
  intervalHandle?.unref?.()

  return async () => {
    stopped = true
    timerApi.clearInterval(intervalHandle)
    if (activeRun) await activeRun
  }
}
