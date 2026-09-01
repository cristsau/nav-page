import { ImapFlow } from 'imapflow'
import { config } from '../config.js'
import { EMAIL_MAILBOX_CHANGE_CHANNEL } from './emailMailboxStore.js'
import { resolveImapAuth } from './emailOauth2.js'
import {
  assertPermanentDeleteAllowed,
  classifyRemoteCommandFailure,
  compareEmailRemoteSnapshot,
  isEmailRemoteCommandSatisfied,
  isFlagOnlyRemoteCommand,
  retryDelaySeconds
} from './emailRemoteCommandPolicy.js'
import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'
import { assertSafeOutboundHost } from './outboundEndpoints.js'
import { recordSecurityEvent } from './securityEvents.js'

const UINT32_MAX = 4_294_967_295

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function validateEmailRemoteCommandPolicy(policy = {}) {
  return {
    intervalSeconds: boundedInteger(policy.intervalSeconds, 3, 1, 300),
    batchSize: boundedInteger(policy.batchSize, 10, 1, 50),
    staleRunningSeconds: boundedInteger(policy.staleRunningSeconds, 300, 60, 3600)
  }
}

function errorWithCode(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function uidNumber(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= UINT32_MAX ? parsed : null
}

function normalizedRuntimeSourceKey(runtimeConfig) {
  return String(runtimeConfig.emailSourceKey || '').normalize('NFKC').trim().toLowerCase()
}

function validateRuntimeConfig(runtimeConfig) {
  if (
    !runtimeConfig.imapHost
    || !runtimeConfig.imapUsername
    || (!runtimeConfig.imapPasswordFile && !runtimeConfig.imapOauthProvider)
  ) {
    throw errorWithCode('IMAP configuration is incomplete', 'IMAP_CONFIG_INCOMPLETE')
  }
  if (runtimeConfig.imapSecure !== true || Number(runtimeConfig.imapPort) !== 993) {
    throw errorWithCode('Remote email commands require implicit TLS on port 993', 'IMAP_TLS_REQUIRED')
  }
}

async function createImapClient(runtimeConfig, { ImapClient, readSecretImpl, assertHostImpl }) {
  validateRuntimeConfig(runtimeConfig)
  await assertHostImpl(runtimeConfig.imapHost, { label: 'IMAP ' })
  const auth = await resolveImapAuth(runtimeConfig, { readSecretImpl })
  return new ImapClient({
    host: runtimeConfig.imapHost,
    port: Number(runtimeConfig.imapPort),
    secure: true,
    auth,
    disableAutoIdle: true,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    logger: false
  })
}

function normalizedRemoteFlags(flags) {
  const values = flags instanceof Set ? [...flags] : Array.isArray(flags) ? flags : []
  const normalized = new Set(values.map((value) => String(value || '').trim().toLowerCase()))
  return {
    seen: normalized.has('\\seen'),
    answered: normalized.has('\\answered'),
    flagged: normalized.has('\\flagged'),
    draft: normalized.has('\\draft'),
    deleted: normalized.has('\\deleted'),
    keywords: values
      .map((value) => String(value || '').normalize('NFKC').trim())
      .filter((value) => value && !value.startsWith('\\'))
      .slice(0, 100)
  }
}

function remoteSnapshot(message, uidValidity) {
  const flags = normalizedRemoteFlags(message?.flags)
  return {
    uidValidity: String(uidValidity),
    uid: String(message?.uid || ''),
    modseq: message?.modseq == null ? null : String(message.modseq),
    ...flags
  }
}

function expectedSnapshot(job) {
  return {
    uidValidity: String(job.expected_uid_validity),
    modseq: job.expected_modseq == null ? null : String(job.expected_modseq),
    seen: job.expected_seen,
    flagged: job.expected_flagged,
    deleted: job.expected_deleted
  }
}

async function markStaleCommands(client, staleRunningSeconds, sourceKey, ownerUsername) {
  await client.query(
    `UPDATE email_remote_commands
     SET status = CASE
           WHEN action IN ('mark_read', 'mark_unread', 'star', 'unstar') THEN 'retry_wait'
           ELSE 'conflict'
         END,
         completed_at = CASE
           WHEN action IN ('mark_read', 'mark_unread', 'star', 'unstar') THEN NULL
           ELSE NOW()
         END,
         next_attempt_at = CASE
           WHEN action IN ('mark_read', 'mark_unread', 'star', 'unstar') THEN NOW()
           ELSE next_attempt_at
         END,
         last_error_code = 'REMOTE_COMMAND_RESULT_UNKNOWN', updated_at = NOW()
     WHERE status = 'running'
       AND remote_mutation_started_at IS NOT NULL
       AND updated_at < NOW() - ($1::integer * INTERVAL '1 second')
       AND EXISTS (
         SELECT 1 FROM email_accounts AS account
         JOIN users AS owner ON owner.id = account.user_id
         WHERE account.id = email_remote_commands.account_id
           AND account.user_id = email_remote_commands.user_id
           AND account.source_key = $2
           AND owner.username = $3
           AND owner.status = 'approved'
       )`,
    [staleRunningSeconds, sourceKey, ownerUsername]
  )
  await client.query(
    `UPDATE email_remote_commands
     SET status = 'retry_wait', next_attempt_at = NOW(),
         last_error_code = 'REMOTE_WORKER_INTERRUPTED', updated_at = NOW()
     WHERE status = 'running'
       AND remote_mutation_started_at IS NULL
       AND updated_at < NOW() - ($1::integer * INTERVAL '1 second')
       AND EXISTS (
         SELECT 1 FROM email_accounts AS account
         JOIN users AS owner ON owner.id = account.user_id
         WHERE account.id = email_remote_commands.account_id
           AND account.user_id = email_remote_commands.user_id
           AND account.source_key = $2
           AND owner.username = $3
           AND owner.status = 'approved'
       )`,
    [staleRunningSeconds, sourceKey, ownerUsername]
  )
  await client.query(
    `UPDATE email_remote_commands
     SET status = 'failed', completed_at = NOW(),
         last_error_code = COALESCE(last_error_code, 'REMOTE_RETRY_EXHAUSTED'), updated_at = NOW()
     WHERE status IN ('scheduled', 'retry_wait')
       AND attempt_count >= max_attempts
       AND EXISTS (
         SELECT 1 FROM email_accounts AS account
         JOIN users AS owner ON owner.id = account.user_id
         WHERE account.id = email_remote_commands.account_id
           AND account.user_id = email_remote_commands.user_id
           AND account.source_key = $1
           AND owner.username = $2
           AND owner.status = 'approved'
       )`,
    [sourceKey, ownerUsername]
  )
}

async function claimEmailRemoteCommand(poolInstance, policy, sourceKey, ownerUsername) {
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    await markStaleCommands(client, policy.staleRunningSeconds, sourceKey, ownerUsername)
    const candidate = await client.query(
      `SELECT id
       FROM email_remote_commands
       WHERE status IN ('scheduled', 'retry_wait')
         AND next_attempt_at <= NOW()
         AND undo_until <= NOW()
         AND attempt_count < max_attempts
         AND EXISTS (
            SELECT 1 FROM email_accounts AS account
            JOIN users AS owner ON owner.id = account.user_id
           WHERE account.id = email_remote_commands.account_id
             AND account.user_id = email_remote_commands.user_id
              AND account.enabled = TRUE
              AND account.source_key = $1
              AND owner.username = $2
              AND owner.status = 'approved'
         )
       ORDER BY next_attempt_at ASC, created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [sourceKey, ownerUsername]
    )
    if (!candidate.rows[0]) {
      await client.query('COMMIT')
      return null
    }
    const claimed = await client.query(
      `UPDATE email_remote_commands
       SET status = 'running', attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, NOW()),
           remote_mutation_started_at = NULL,
           remote_mutation_completed_at = NULL,
           last_error_code = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [candidate.rows[0].id]
    )
    await client.query('COMMIT')
    return claimed.rows[0]
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
  }
}

async function loadCommandContext(poolInstance, job) {
  const { rows } = await poolInstance.query(
    `SELECT command.*, account.source_key, owner.username AS owner_username,
            source.path AS source_folder_path,
            source.special_use AS source_special_use,
            location.message_id, location.internal_date, location.size_bytes,
            location.seen, location.answered, location.flagged,
            location.draft, location.deleted, location.keywords,
            location.expunged_at,
            explicit_target.path AS explicit_target_path,
            explicit_target.selectable AS explicit_target_selectable
     FROM email_remote_commands AS command
     JOIN email_accounts AS account
       ON account.id = command.account_id AND account.user_id = command.user_id
     JOIN users AS owner ON owner.id = account.user_id AND owner.status = 'approved'
     JOIN email_folder_messages AS location
       ON location.id = command.source_location_id
      AND location.account_id = command.account_id
      AND location.user_id = command.user_id
     JOIN email_folders AS source
       ON source.id = command.source_folder_id
      AND source.account_id = command.account_id
      AND source.user_id = command.user_id
     LEFT JOIN email_folders AS explicit_target
       ON explicit_target.id = command.target_folder_id
      AND explicit_target.account_id = command.account_id
      AND explicit_target.user_id = command.user_id
     WHERE command.id = $1 AND command.status = 'running'
     LIMIT 1`,
    [job.id]
  )
  const context = rows[0]
  if (!context || context.expunged_at) throw errorWithCode('Remote source message is missing', 'REMOTE_MESSAGE_MISSING')
  return context
}

async function resolveTargetFolder(poolInstance, job) {
  if (job.action === 'move') {
    if (!job.target_folder_id || !job.explicit_target_path || job.explicit_target_selectable !== true) {
      throw errorWithCode('Remote target folder is unavailable', 'REMOTE_TARGET_MISSING')
    }
    if (String(job.target_folder_id) === String(job.source_folder_id)) {
      throw errorWithCode('Remote target matches the source folder', 'REMOTE_TARGET_SAME_FOLDER')
    }
    return { id: job.target_folder_id, path: job.explicit_target_path }
  }
  const specialUse = job.action === 'archive' ? 'archive' : job.action === 'trash' ? 'trash' : null
  if (!specialUse) return null
  const { rows } = await poolInstance.query(
    `SELECT id, path
     FROM email_folders
     WHERE account_id = $1 AND user_id = $2 AND special_use = $3 AND selectable = TRUE
     ORDER BY id ASC
     LIMIT 2`,
    [job.account_id, job.user_id, specialUse]
  )
  if (!rows.length) throw errorWithCode('Remote target folder was not discovered', 'REMOTE_TARGET_MISSING')
  if (rows.length > 1) throw errorWithCode('Remote target folder is ambiguous', 'REMOTE_TARGET_AMBIGUOUS')
  if (String(rows[0].id) === String(job.source_folder_id)) {
    throw errorWithCode('Remote target matches the source folder', 'REMOTE_TARGET_SAME_FOLDER')
  }
  return rows[0]
}

async function markMutationStarted(poolInstance, commandId) {
  const result = await poolInstance.query(
    `UPDATE email_remote_commands
     SET remote_mutation_started_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'running' AND remote_mutation_started_at IS NULL`,
    [commandId]
  )
  if (!result.rowCount) throw errorWithCode('Remote command state changed before mutation', 'REMOTE_COMMAND_CONFLICT')
}

function mappedMoveUid(moveResult, sourceUid) {
  const uidMap = moveResult && typeof moveResult === 'object' ? moveResult.uidMap : null
  if (!uidMap || typeof uidMap.entries !== 'function') return null
  for (const [from, to] of uidMap.entries()) {
    if (String(from) === String(sourceUid)) return uidNumber(to)
  }
  return null
}

async function applyRemoteMutation({ imap, job, target }) {
  const options = { uid: true }
  if (job.expected_modseq != null && isFlagOnlyRemoteCommand(job.action)) {
    options.unchangedSince = BigInt(String(job.expected_modseq))
  }
  if (job.action === 'mark_read') {
    const changed = await imap.messageFlagsAdd(job.expected_uid, ['\\Seen'], options)
    if (changed === false) throw errorWithCode('Remote message changed before mark read', 'REMOTE_STATE_CHANGED')
    return { kind: 'flags' }
  }
  if (job.action === 'mark_unread') {
    const changed = await imap.messageFlagsRemove(job.expected_uid, ['\\Seen'], options)
    if (changed === false) throw errorWithCode('Remote message changed before mark unread', 'REMOTE_STATE_CHANGED')
    return { kind: 'flags' }
  }
  if (job.action === 'star') {
    const changed = await imap.messageFlagsAdd(job.expected_uid, ['\\Flagged'], options)
    if (changed === false) throw errorWithCode('Remote message changed before star', 'REMOTE_STATE_CHANGED')
    return { kind: 'flags' }
  }
  if (job.action === 'unstar') {
    const changed = await imap.messageFlagsRemove(job.expected_uid, ['\\Flagged'], options)
    if (changed === false) throw errorWithCode('Remote message changed before unstar', 'REMOTE_STATE_CHANGED')
    return { kind: 'flags' }
  }
  if (['archive', 'move', 'trash'].includes(job.action)) {
    const response = await imap.messageMove(job.expected_uid, target.path, { uid: true })
    if (response === false) throw errorWithCode('Remote server rejected message move', 'REMOTE_COMMAND_FAILED')
    return {
      kind: 'move',
      targetUid: mappedMoveUid(response, job.expected_uid),
      targetUidValidity: uidNumber(response?.uidValidity)
    }
  }
  if (job.action === 'delete') {
    const response = await imap.messageDelete(job.expected_uid, { uid: true })
    if (response === false) throw errorWithCode('Remote server rejected permanent deletion', 'REMOTE_COMMAND_FAILED')
    return { kind: 'delete' }
  }
  throw errorWithCode('Unsupported remote command action', 'REMOTE_COMMAND_FAILED')
}

async function recordWorkerEvent(client, job, { outcome, eventType }) {
  await recordSecurityEvent({
    client,
    eventType,
    outcome,
    actorUserId: job.user_id,
    subjectUserId: job.user_id,
    resourceType: 'email_remote_command',
    resourceId: job.id,
    affectedCount: outcome === 'success' ? 1 : 0
  })
}

async function publishMailboxChange(poolInstance, job, folderId) {
  const event = {
    userId: String(job.user_id),
    accountId: String(job.account_id),
    folderId: String(folderId || job.source_folder_id),
    messageId: String(job.source_message_id || job.message_id),
    locationId: String(job.source_location_id),
    revision: Date.now()
  }
  try {
    await poolInstance.query('SELECT pg_notify($1, $2)', [
      EMAIL_MAILBOX_CHANGE_CHANNEL,
      JSON.stringify(event)
    ])
  } catch {}
}

async function finalizeRemoteCommandSuccess({ poolInstance, job, mutation, remote, target }) {
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    if (mutation.kind === 'flags') {
      const locationUpdated = await client.query(
        `UPDATE email_folder_messages
         SET modseq = $2, seen = $3, answered = $4, flagged = $5,
             draft = $6, deleted = $7, keywords = $8::jsonb, updated_at = NOW()
         WHERE id = $1 AND account_id = $9 AND user_id = $10 AND expunged_at IS NULL`,
        [
          job.source_location_id,
          remote.modseq,
          remote.seen,
          remote.answered,
          remote.flagged,
          remote.draft,
          remote.deleted,
          JSON.stringify(remote.keywords),
          job.account_id,
          job.user_id
        ]
      )
      if (!locationUpdated.rowCount) {
        throw errorWithCode('Local mailbox state changed after remote mutation', 'REMOTE_COMMAND_RESULT_UNKNOWN')
      }
    } else {
      const locationUpdated = await client.query(
        `UPDATE email_folder_messages
         SET deleted = CASE WHEN $2 = 'delete' THEN TRUE ELSE deleted END,
             expunged_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND account_id = $3 AND user_id = $4 AND expunged_at IS NULL`,
        [job.source_location_id, mutation.kind, job.account_id, job.user_id]
      )
      if (!locationUpdated.rowCount) {
        throw errorWithCode('Local mailbox state changed after remote mutation', 'REMOTE_COMMAND_RESULT_UNKNOWN')
      }
      if (mutation.kind === 'move' && target && mutation.targetUid && mutation.targetUidValidity) {
        await client.query(
          `INSERT INTO email_folder_messages (
             folder_id, message_id, account_id, user_id, uid_validity, uid,
             modseq, seen, answered, flagged, draft, deleted, keywords,
             internal_date, size_bytes, expunged_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,FALSE,$11::jsonb,$12,$13,NULL,NOW())
           ON CONFLICT (folder_id, uid_validity, uid) DO UPDATE SET
             message_id = EXCLUDED.message_id,
             seen = EXCLUDED.seen,
             answered = EXCLUDED.answered,
             flagged = EXCLUDED.flagged,
             draft = EXCLUDED.draft,
             deleted = FALSE,
             keywords = EXCLUDED.keywords,
             expunged_at = NULL,
             updated_at = NOW()`,
          [
            target.id,
            job.message_id,
            job.account_id,
            job.user_id,
            mutation.targetUidValidity,
            mutation.targetUid,
            job.seen,
            job.answered,
            job.flagged,
            job.draft,
            JSON.stringify(Array.isArray(job.keywords) ? job.keywords : []),
            job.internal_date,
            job.size_bytes
          ]
        )
      }
    }
    const completed = await client.query(
      `UPDATE email_remote_commands
       SET status = 'succeeded', remote_mutation_completed_at = NOW(),
           completed_at = NOW(), last_error_code = NULL,
           result_folder_id = $2, result_uid_validity = $3, result_uid = $4,
           updated_at = NOW()
       WHERE id = $1 AND status = 'running'
       RETURNING id`,
      [
        job.id,
        target?.id || (mutation.kind === 'flags' ? job.source_folder_id : null),
        mutation.kind === 'flags' ? job.expected_uid_validity : mutation.targetUidValidity,
        mutation.kind === 'flags' ? job.expected_uid : mutation.targetUid
      ]
    )
    if (!completed.rowCount) throw errorWithCode('Remote command final state changed', 'REMOTE_COMMAND_CONFLICT')
    await recordWorkerEvent(client, job, {
      outcome: 'success', eventType: 'email.remote_command.executed'
    })
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
  }
  await publishMailboxChange(poolInstance, job, target?.id || job.source_folder_id)
}

async function finalizeRemoteCommandError({ poolInstance, job, error, mutationStarted }) {
  const errorCode = sanitizeMaintenanceErrorCode(error)
  const failureKind = classifyRemoteCommandFailure({
    action: job.action,
    errorCode,
    mutationStarted
  })
  const attemptsExhausted = Number(job.attempt_count) >= Number(job.max_attempts)
  const status = failureKind === 'conflict'
    ? 'conflict'
    : attemptsExhausted
      ? 'failed'
      : 'retry_wait'
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    const updated = await client.query(
      `UPDATE email_remote_commands
       SET status = $2,
           next_attempt_at = CASE
             WHEN $2 = 'retry_wait' THEN NOW() + ($3::integer * INTERVAL '1 second')
             ELSE next_attempt_at
           END,
           completed_at = CASE WHEN $2 IN ('conflict', 'failed') THEN NOW() ELSE NULL END,
           last_error_code = $4, updated_at = NOW()
       WHERE id = $1 AND status = 'running'
       RETURNING status`,
      [job.id, status, retryDelaySeconds(job.attempt_count), errorCode]
    )
    if (!updated.rowCount) {
      const current = await client.query(
        `SELECT status
         FROM email_remote_commands
         WHERE id = $1 AND user_id = $2
         LIMIT 1`,
        [job.id, job.user_id]
      )
      await client.query('COMMIT')
      const currentStatus = String(current.rows[0]?.status || '')
      if (['scheduled', 'running', 'retry_wait', 'succeeded', 'conflict', 'failed', 'cancelled'].includes(currentStatus)) {
        return currentStatus
      }
      throw errorWithCode('Remote command final state is unavailable', 'REMOTE_COMMAND_CONFLICT')
    }
    await recordWorkerEvent(client, job, {
      outcome: failureKind === 'conflict' ? 'denied' : 'failure',
      eventType: failureKind === 'conflict'
        ? 'email.remote_command.conflict'
        : 'email.remote_command.failed'
    })
    await client.query('COMMIT')
  } catch (finalizeError) {
    try { await client.query('ROLLBACK') } catch {}
    finalizeError.remoteMutationStarted = Boolean(
      finalizeError.remoteMutationStarted || mutationStarted
    )
    throw finalizeError
  } finally {
    client.release()
  }
  return status
}

export async function executeEmailRemoteCommand({ poolInstance, imap, claimedJob, runtimeConfig = config }) {
  const job = await loadCommandContext(poolInstance, claimedJob)
  if (job.source_key !== normalizedRuntimeSourceKey(runtimeConfig)) {
    throw errorWithCode('Remote source account does not match runtime', 'REMOTE_SOURCE_ACCOUNT_MISMATCH')
  }
  if (String(job.owner_username || '') !== String(runtimeConfig.emailOwnerUsername || '').trim()) {
    throw errorWithCode('Remote source owner does not match runtime', 'REMOTE_SOURCE_OWNER_MISMATCH')
  }
  let mailboxLock = null
  let mutationStarted = false
  try {
    const target = await resolveTargetFolder(poolInstance, job)
    mailboxLock = await imap.getMailboxLock(job.source_folder_path)
    const uidValidity = uidNumber(imap.mailbox?.uidValidity)
    if (!uidValidity) throw errorWithCode('Remote UIDVALIDITY is invalid', 'REMOTE_UIDVALIDITY_CHANGED')
    const message = await imap.fetchOne(
      job.expected_uid,
      { uid: true, flags: true, modseq: true },
      { uid: true }
    )
    if (!message) throw errorWithCode('Remote message is missing', 'REMOTE_MESSAGE_MISSING')
    const before = remoteSnapshot(message, uidValidity)
    if (String(before.uid) !== String(job.expected_uid)) {
      throw errorWithCode('Remote message UID changed unexpectedly', 'REMOTE_MESSAGE_MISSING')
    }
    if (job.action === 'delete') {
      assertPermanentDeleteAllowed({
        specialUse: job.source_special_use,
        deleted: before.deleted
      })
    }
    const comparison = compareEmailRemoteSnapshot(expectedSnapshot(job), before, { action: job.action })
    if (!comparison.ok) throw errorWithCode('Remote message state changed', comparison.code)
    if (comparison.alreadySatisfied) {
      await finalizeRemoteCommandSuccess({
        poolInstance,
        job,
        mutation: { kind: 'flags' },
        remote: before,
        target: null
      })
      return 'succeeded'
    }
    await markMutationStarted(poolInstance, job.id)
    mutationStarted = true
    const mutation = await applyRemoteMutation({ imap, job, target })
    let remote = before
    if (mutation.kind === 'flags') {
      const verified = await imap.fetchOne(
        job.expected_uid,
        { uid: true, flags: true, modseq: true },
        { uid: true }
      )
      if (!verified) throw errorWithCode('Remote flag mutation could not be verified', 'REMOTE_COMMAND_RESULT_UNKNOWN')
      remote = remoteSnapshot(verified, uidValidity)
      if (!isEmailRemoteCommandSatisfied(job.action, remote)) {
        throw errorWithCode('Remote flag mutation was not applied', 'REMOTE_COMMAND_RESULT_UNKNOWN')
      }
    }
    await finalizeRemoteCommandSuccess({ poolInstance, job, mutation, remote, target })
    return 'succeeded'
  } catch (error) {
    return finalizeRemoteCommandError({ poolInstance, job, error, mutationStarted })
  } finally {
    try { mailboxLock?.release?.() } catch {}
  }
}

export async function processEmailRemoteCommands({
  poolInstance,
  policy,
  runtimeConfig = config,
  ImapClient = ImapFlow,
  readSecretImpl = readOwnerSecretFile,
  assertHostImpl = assertSafeOutboundHost,
  logger
}) {
  const validated = validateEmailRemoteCommandPolicy(policy)
  const sourceKey = normalizedRuntimeSourceKey(runtimeConfig)
  const ownerUsername = String(runtimeConfig.emailOwnerUsername || '').trim()
  if (!ownerUsername) throw new Error('Email owner username is not configured')
  const summary = { processed: 0, succeeded: 0, retried: 0, conflicted: 0, failed: 0 }
  let imap = null
  try {
    for (let index = 0; index < validated.batchSize; index += 1) {
      const claimed = await claimEmailRemoteCommand(poolInstance, validated, sourceKey, ownerUsername)
      if (!claimed) break
      summary.processed += 1
      if (!imap) {
        try {
          imap = await createImapClient(runtimeConfig, { ImapClient, readSecretImpl, assertHostImpl })
          await imap.connect()
        } catch (error) {
          try { imap?.close?.() } catch {}
          imap = null
          const status = await finalizeRemoteCommandError({
            poolInstance, job: claimed, error, mutationStarted: false
          })
          if (status === 'retry_wait') summary.retried += 1
          else summary.failed += 1
          continue
        }
      }
      try {
        const status = await executeEmailRemoteCommand({
          poolInstance, imap, claimedJob: claimed, runtimeConfig
        })
        if (status === 'succeeded') summary.succeeded += 1
        else if (status === 'retry_wait') summary.retried += 1
        else if (status === 'conflict') summary.conflicted += 1
        else summary.failed += 1
      } catch (error) {
        logger?.warn?.({ commandId: claimed.id, errorCode: sanitizeMaintenanceErrorCode(error) }, 'email remote command execution failed')
        const status = await finalizeRemoteCommandError({
          poolInstance,
          job: claimed,
          error,
          mutationStarted: Boolean(error?.remoteMutationStarted)
        })
        if (status === 'retry_wait') summary.retried += 1
        else if (status === 'conflict') summary.conflicted += 1
        else summary.failed += 1
      }
    }
    return summary
  } finally {
    if (imap) {
      try {
        if (imap.usable) await imap.logout()
        else imap.close?.()
      } catch {
        try { imap.close?.() } catch {}
      }
    }
  }
}

async function notifyObserver(observer, method, payload, logger) {
  try { await observer?.[method]?.(payload) } catch (error) {
    logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'email remote command status could not be recorded')
  }
}

export function startEmailRemoteCommandScheduler({
  enabled,
  policy,
  poolInstance,
  runtimeConfig = config,
  logger,
  observer,
  processorFn = processEmailRemoteCommands,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateEmailRemoteCommandPolicy(policy)
  let stopped = false
  let activeRun = null
  let timer = null
  const schedule = () => {
    if (stopped || timer) return
    timer = timerApi.setTimeout(() => {
      timer = null
      void run()
    }, validated.intervalSeconds * 1000)
    timer?.unref?.()
  }
  const run = () => {
    if (stopped || activeRun) return activeRun
    const startedAtMs = clock()
    activeRun = Promise.resolve()
      .then(() => processorFn({ poolInstance, policy: validated, runtimeConfig, logger }))
      .then(async (result) => {
        const finishedAtMs = clock()
        await notifyObserver(observer, 'succeeded', {
          result,
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        return result
      })
      .catch(async (error) => {
        const finishedAtMs = clock()
        await notifyObserver(observer, 'failed', {
          error,
          result: {},
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        logger?.error?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'email remote command scheduler failed')
      })
      .finally(() => {
        activeRun = null
        schedule()
      })
    return activeRun
  }
  void run()
  return async () => {
    stopped = true
    if (timer) timerApi.clearTimeout(timer)
    timer = null
    if (activeRun) await activeRun
  }
}
