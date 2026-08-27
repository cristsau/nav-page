import { createHash, randomUUID } from 'node:crypto'
import {
  evaluateReleaseAcceptanceMarker,
  RELEASE_ACCEPTANCE_LOCK_NAME,
  RELEASE_ACCEPTANCE_MARKER_PREFIX,
  ReleaseAcceptanceAccountError
} from './releaseAcceptanceAccount.js'
import {
  buildCanonicalMailboxMessage,
  emailMailboxEncryptionContext
} from '../lib/emailMailboxStore.js'
import { encryptEmailPayload } from '../lib/emailCrypto.js'

const RUN_ID_PATTERN = /^[0-9a-f]{48}$/
const USERNAME_PATTERN = /^nav_release_accept_[0-9a-f]{32}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FIXTURE_MARKER_PREFIX = 'navmail.'
const FIXTURE_SOURCE_PREFIX = 'acceptance.'
const FIXTURE_FOLDER_PREFIX = 'NAV_RELEASE_ACCEPTANCE/'

export class MailAcceptanceFixtureError extends Error {
  constructor(code) {
    super(code)
    this.name = 'MailAcceptanceFixtureError'
    this.code = code
  }
}

function fail(code) {
  throw new MailAcceptanceFixtureError(code)
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

function normalizeUuid(value, code) {
  const uuid = String(value || '').trim().toLowerCase()
  if (!UUID_PATTERN.test(uuid)) fail(code)
  return uuid
}

function normalizeMarker(value, runId) {
  const marker = String(value || '').trim().toLowerCase()
  if (marker !== `${FIXTURE_MARKER_PREFIX}${runId}`) {
    fail('INVALID_FIXTURE_MARKER')
  }
  return marker
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function fixtureIdentity(runId) {
  return {
    sourceKey: `${FIXTURE_SOURCE_PREFIX}${runId}`,
    folderPath: `${FIXTURE_FOLDER_PREFIX}${runId}`,
    remoteMessageId: `<nav-release-accept-${runId}@invalid.example>`
  }
}

export function normalizeMailAcceptanceFixtureInput(input = {}, {
  cleanup = false
} = {}) {
  const runId = normalizeRunId(input.runId)
  const username = normalizeUsername(input.username)
  const marker = normalizeMarker(input.marker, runId)
  const normalized = { runId, username, marker }
  if (cleanup) {
    normalized.accountId = normalizeUuid(input.accountId, 'INVALID_FIXTURE_ACCOUNT_ID')
    normalized.folderId = normalizeUuid(input.folderId, 'INVALID_FIXTURE_FOLDER_ID')
    normalized.messageId = normalizeUuid(input.messageId, 'INVALID_FIXTURE_MESSAGE_ID')
    normalized.locationId = normalizeUuid(input.locationId, 'INVALID_FIXTURE_LOCATION_ID')
  }
  return normalized
}

export function buildMailAcceptanceFixtureMessage({ runId, marker }) {
  const identity = fixtureIdentity(runId)
  const timestamp = new Date()
  const sender = `fixture-${runId.slice(0, 12)}@invalid.example`
  const subject = `DOMO NAV release acceptance ${marker}`
  const text = [
    `Synthetic release acceptance message ${marker}.`,
    'This message exists only in the local encrypted NAV mailbox cache.',
    'No SMTP or IMAP operation created it.'
  ].join('\n')
  return {
    identity,
    rawMessage: {
      mailboxUid: 1,
      messageId: identity.remoteMessageId,
      rawHash: sha256(`release-acceptance-fixture:${runId}`),
      sender: { name: 'DOMO NAV Acceptance', address: sender },
      to: [{ name: 'Release Acceptance', address: 'acceptance@invalid.example' }],
      cc: [],
      bcc: [],
      subject,
      text,
      receivedAt: timestamp,
      internalDate: timestamp,
      sentAt: timestamp,
      size: Buffer.byteLength(`${subject}\n${text}`, 'utf8'),
      flags: [],
      modseq: '1',
      references: [],
      inReplyTo: '',
      attachments: []
    }
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

async function loadActiveAcceptanceOwner(client, { runId, username }) {
  const markerKey = `${RELEASE_ACCEPTANCE_MARKER_PREFIX}${runId}`
  const result = await client.query(
    `
      SELECT marker.key, marker.value, CURRENT_TIMESTAMP AS database_now,
             owner.id, owner.username, owner.role, owner.status
      FROM system_settings AS marker
      JOIN users AS owner
        ON owner.id::text = marker.value->>'userId'
       AND owner.username = marker.value->>'username'
      WHERE marker.key = $1
      FOR UPDATE OF marker, owner
    `,
    [markerKey]
  )
  if (result.rowCount !== 1) fail('ACCEPTANCE_OWNER_NOT_FOUND')
  const row = result.rows[0]
  let evaluated
  try {
    evaluated = evaluateReleaseAcceptanceMarker(row.value, {
      expectedRunId: runId,
      expectedUsername: username,
      expectedUserId: row.id,
      now: row.database_now
    })
  } catch (error) {
    if (error instanceof ReleaseAcceptanceAccountError) {
      fail(error.code)
    }
    throw error
  }
  if (evaluated.expired) fail('ACCEPTANCE_OWNER_EXPIRED')
  if (row.key !== markerKey || row.role !== 'admin' || row.status !== 'approved') {
    fail('ACCEPTANCE_OWNER_STATE_MISMATCH')
  }
  return evaluated.userId
}

async function assertNoMailResidue(client, userId) {
  const result = await client.query(
    `
      SELECT
        (SELECT COUNT(*)::integer FROM email_accounts WHERE user_id = $1) AS accounts,
        (SELECT COUNT(*)::integer FROM email_folders WHERE user_id = $1) AS folders,
        (SELECT COUNT(*)::integer FROM email_messages WHERE user_id = $1) AS messages,
        (SELECT COUNT(*)::integer FROM email_folder_messages WHERE user_id = $1) AS locations,
        (SELECT COUNT(*)::integer FROM mail_outbox WHERE user_id = $1) AS outbox
    `,
    [userId]
  )
  const row = result.rows[0] || {}
  if (['accounts', 'folders', 'messages', 'locations', 'outbox']
    .some((key) => Number(row[key] || 0) !== 0)) {
    fail('FIXTURE_RESIDUE_PRESENT')
  }
}

function boundedUidValidity(runId) {
  return Math.max(1, Number.parseInt(runId.slice(0, 8), 16))
}

export async function prepareMailAcceptanceFixture(client, input, {
  encryptPayload = encryptEmailPayload,
  uuidFactory = randomUUID
} = {}) {
  const normalized = normalizeMailAcceptanceFixtureInput(input)
  await acquireLifecycleLock(client)
  const userId = await loadActiveAcceptanceOwner(client, normalized)
  await assertNoMailResidue(client, userId)

  const { identity, rawMessage } = buildMailAcceptanceFixtureMessage(normalized)
  const canonical = buildCanonicalMailboxMessage(rawMessage)
  const context = emailMailboxEncryptionContext(userId, identity.sourceKey)
  const [envelopeEncrypted, contentEncrypted] = await Promise.all([
    encryptPayload(canonical.envelope, { context }),
    encryptPayload(canonical.content, { context })
  ])
  if (!Buffer.isBuffer(envelopeEncrypted) || envelopeEncrypted.length < 32
    || !Buffer.isBuffer(contentEncrypted) || contentEncrypted.length < 32) {
    fail('FIXTURE_ENCRYPTION_FAILED')
  }

  const accountId = normalizeUuid(uuidFactory(), 'INVALID_GENERATED_ACCOUNT_ID')
  const folderId = normalizeUuid(uuidFactory(), 'INVALID_GENERATED_FOLDER_ID')
  const messageId = normalizeUuid(uuidFactory(), 'INVALID_GENERATED_MESSAGE_ID')
  const locationId = normalizeUuid(uuidFactory(), 'INVALID_GENERATED_LOCATION_ID')
  const folderPathHash = sha256(identity.folderPath)
  const fixtureCapabilities = JSON.stringify({
    releaseAcceptanceFixture: true,
    releaseAcceptanceRunId: normalized.runId
  })

  await client.query(
    `
      INSERT INTO email_accounts (
        id, user_id, source_key, label, enabled, capabilities,
        last_connected_at, created_at, updated_at
      ) VALUES ($1, $2, $3, '发布验收临时邮箱', TRUE, $4::jsonb, NOW(), NOW(), NOW())
    `,
    [accountId, userId, identity.sourceKey, fixtureCapabilities]
  )
  await client.query(
    `
      INSERT INTO email_folders (
        id, account_id, user_id, path, path_hash, delimiter, special_use,
        selectable, subscribed, uid_validity, uid_next, highest_modseq,
        last_uid, sync_generation, initial_sync_complete,
        last_listed_at, last_synced_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, '/', 'inbox',
        TRUE, TRUE, $6, 2, 1,
        1, 1, TRUE, NOW(), NOW(), NOW(), NOW()
      )
    `,
    [folderId, accountId, userId, identity.folderPath, folderPathHash, boundedUidValidity(normalized.runId)]
  )
  await client.query(
    `
      INSERT INTO email_messages (
        id, account_id, user_id, canonical_hash, message_id_hash, thread_key_hash,
        envelope_encrypted, content_encrypted, received_at, sent_at,
        size_bytes, has_attachments, attachment_count, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,FALSE,0,NOW(),NOW())
    `,
    [
      messageId,
      accountId,
      userId,
      canonical.canonicalHash,
      canonical.messageIdHash,
      canonical.threadKeyHash,
      envelopeEncrypted,
      contentEncrypted,
      canonical.receivedAt,
      canonical.sentAt,
      canonical.sizeBytes
    ]
  )
  await client.query(
    `
      INSERT INTO email_folder_messages (
        id, folder_id, message_id, account_id, user_id,
        uid_validity, uid, modseq, seen, answered, flagged, draft, deleted,
        keywords, internal_date, size_bytes, expunged_at, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,1,1,FALSE,FALSE,FALSE,FALSE,FALSE,
        '[]'::jsonb,$7,$8,NULL,NOW(),NOW()
      )
    `,
    [
      locationId,
      folderId,
      messageId,
      accountId,
      userId,
      boundedUidValidity(normalized.runId),
      canonical.receivedAt,
      canonical.sizeBytes
    ]
  )

  const proof = await client.query(
    `
      SELECT COUNT(*)::integer AS count,
             MIN(octet_length(message.envelope_encrypted))::integer AS envelope_bytes,
             MIN(octet_length(message.content_encrypted))::integer AS content_bytes,
             (SELECT COUNT(*)::integer FROM mail_outbox WHERE user_id = $5) AS outbox
      FROM email_accounts AS account
      JOIN email_folders AS folder
        ON folder.account_id = account.id AND folder.user_id = account.user_id
      JOIN email_messages AS message
        ON message.account_id = account.id AND message.user_id = account.user_id
      JOIN email_folder_messages AS location
        ON location.account_id = account.id
       AND location.user_id = account.user_id
       AND location.folder_id = folder.id
       AND location.message_id = message.id
      WHERE account.id = $1 AND folder.id = $2 AND message.id = $3 AND location.id = $4
        AND account.user_id = $5
        AND account.capabilities->>'releaseAcceptanceRunId' = $6
    `,
    [accountId, folderId, messageId, locationId, userId, normalized.runId]
  )
  const proofRow = proof.rows[0] || {}
  if (Number(proofRow.count || 0) !== 1
    || Number(proofRow.envelope_bytes || 0) < 32
    || Number(proofRow.content_bytes || 0) < 32
    || Number(proofRow.outbox || 0) !== 0) {
    fail('FIXTURE_PERSISTENCE_MISMATCH')
  }

  return {
    accountId,
    folderId,
    messageId,
    locationId,
    marker: normalized.marker
  }
}

export async function cleanupMailAcceptanceFixture(client, input) {
  const normalized = normalizeMailAcceptanceFixtureInput(input, { cleanup: true })
  await acquireLifecycleLock(client)
  const userId = await loadActiveAcceptanceOwner(client, normalized)
  const identity = fixtureIdentity(normalized.runId)
  const expectedCanonical = buildCanonicalMailboxMessage(
    buildMailAcceptanceFixtureMessage(normalized).rawMessage
  )
  const owned = await client.query(
    `
      SELECT COUNT(*)::integer AS count,
             (SELECT COUNT(*)::integer FROM mail_outbox WHERE user_id = $5) AS outbox
      FROM email_accounts AS account
      JOIN email_folders AS folder
        ON folder.account_id = account.id AND folder.user_id = account.user_id
      JOIN email_messages AS message
        ON message.account_id = account.id AND message.user_id = account.user_id
      JOIN email_folder_messages AS location
        ON location.account_id = account.id
       AND location.user_id = account.user_id
       AND location.folder_id = folder.id
       AND location.message_id = message.id
      WHERE account.id = $1 AND folder.id = $2 AND message.id = $3 AND location.id = $4
        AND account.user_id = $5
        AND account.source_key = $6
        AND account.capabilities->>'releaseAcceptanceRunId' = $7
        AND folder.path = $8
        AND folder.path_hash = $9
        AND message.canonical_hash = $10
    `,
    [
      normalized.accountId,
      normalized.folderId,
      normalized.messageId,
      normalized.locationId,
      userId,
      identity.sourceKey,
      normalized.runId,
      identity.folderPath,
      sha256(identity.folderPath),
      expectedCanonical.canonicalHash
    ]
  )
  const ownedRow = owned.rows[0] || {}
  if (Number(ownedRow.count || 0) !== 1 || Number(ownedRow.outbox || 0) !== 0) {
    fail('FIXTURE_IDENTITY_MISMATCH')
  }
  const removed = await client.query(
    `
      DELETE FROM email_accounts
      WHERE id = $1 AND user_id = $2 AND source_key = $3
        AND capabilities->>'releaseAcceptanceRunId' = $4
      RETURNING id
    `,
    [normalized.accountId, userId, identity.sourceKey, normalized.runId]
  )
  if (removed.rowCount !== 1) fail('FIXTURE_DELETE_MISMATCH')

  const residue = await client.query(
    `
      SELECT
        (SELECT COUNT(*)::integer FROM email_accounts WHERE user_id = $1 AND source_key = $2) AS accounts,
        (SELECT COUNT(*)::integer FROM mail_outbox WHERE user_id = $1) AS outbox
    `,
    [userId, identity.sourceKey]
  )
  const residueRow = residue.rows[0] || {}
  if (Number(residueRow.accounts || 0) !== 0 || Number(residueRow.outbox || 0) !== 0) {
    fail('FIXTURE_CLEANUP_INCOMPLETE')
  }
  return { cleaned: true }
}
