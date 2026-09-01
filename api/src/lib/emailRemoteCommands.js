import {
  assertPermanentDeleteAllowed,
  buildEmailRemoteCommandRequestHash,
  compareEmailRemoteSnapshot,
  EMAIL_REMOTE_COMMAND_UNDO_SECONDS,
  EmailRemoteCommandError,
  normalizeEmailRemoteCommandRequest
} from './emailRemoteCommandPolicy.js'

function asIso(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function serializeEmailRemoteCommand(row) {
  if (!row) return null
  return {
    id: row.id,
    accountId: row.account_id,
    locationId: row.source_location_id,
    sourceFolderId: row.source_folder_id,
    targetFolderId: row.target_folder_id,
    action: row.action,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 0),
    undoUntil: asIso(row.undo_until),
    nextAttemptAt: asIso(row.next_attempt_at),
    startedAt: asIso(row.started_at),
    completedAt: asIso(row.completed_at),
    lastErrorCode: row.last_error_code || null,
    resultFolderId: row.result_folder_id || null,
    resultUidValidity: row.result_uid_validity == null ? null : String(row.result_uid_validity),
    resultUid: row.result_uid == null ? null : String(row.result_uid),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at)
  }
}

async function inTransaction(poolInstance, callback) {
  if (!poolInstance?.connect) throw new TypeError('PostgreSQL pool is required')
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch {}
    throw error
  } finally {
    client.release()
  }
}

function currentSnapshot(row) {
  return {
    uidValidity: row.uid_validity,
    modseq: row.modseq,
    seen: row.seen,
    flagged: row.flagged,
    deleted: row.deleted
  }
}

const BULK_MARK_READ_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,80}$/
const BULK_MARK_READ_LIMIT = 5000

/**
 * Queue one fail-closed IMAP \Seen mutation for every unread message in an
 * owned folder. The batch is deliberately bounded and inserted in one
 * transaction so a partial queue cannot masquerade as "all read".
 */
export async function enqueueEmailFolderMarkAllRead({
  poolInstance,
  userId,
  accountId,
  folderId,
  idempotencyKey
}) {
  const batchKey = String(idempotencyKey || '').normalize('NFKC').trim()
  if (!BULK_MARK_READ_KEY_PATTERN.test(batchKey)) {
    throw new EmailRemoteCommandError('A valid bulk idempotency key is required')
  }
  return inTransaction(poolInstance, async (client) => {
    const folderResult = await client.query(
      `SELECT id
       FROM email_folders
       WHERE id = $1 AND account_id = $2 AND user_id = $3 AND selectable = TRUE
       FOR UPDATE`,
      [folderId, accountId, userId]
    )
    if (!folderResult.rowCount) {
      throw new EmailRemoteCommandError('Email folder not found', {
        code: 'REMOTE_TARGET_MISSING', statusCode: 404
      })
    }

    // The materialized candidate set makes the limit check and insert share
    // one PostgreSQL snapshot. The folder row lock serializes simultaneous
    // bulk requests for the same mailbox so distinct idempotency keys cannot
    // enqueue duplicate mutations.
    const inserted = await client.query(
      `WITH candidates AS MATERIALIZED (
         SELECT location.*
         FROM email_folder_messages AS location
         WHERE location.folder_id = $1 AND location.account_id = $2
           AND location.user_id = $3 AND location.expunged_at IS NULL
           AND location.seen = FALSE
         ORDER BY location.internal_date ASC, location.id ASC
       ), candidate_stats AS (
         SELECT COUNT(*)::integer AS matched FROM candidates
       ), inserted AS (
         INSERT INTO email_remote_commands (
           user_id, account_id, source_location_id, source_folder_id,
           source_message_id, target_folder_id, action, status,
           idempotency_key, request_hash, expected_uid_validity, expected_uid,
           expected_modseq, expected_seen, expected_flagged, expected_deleted,
           undo_until, next_attempt_at
         )
         SELECT
           location.user_id, location.account_id, location.id, location.folder_id,
           location.message_id, NULL, 'mark_read', 'scheduled',
           LEFT($4, 80) || ':' || location.id::text,
           ENCODE(DIGEST($4 || ':' || location.id::text || ':mark_read', 'sha256'), 'hex'),
           location.uid_validity, location.uid, location.modseq,
           location.seen, location.flagged, location.deleted,
           NOW(), NOW()
         FROM candidates AS location
         CROSS JOIN candidate_stats AS stats
         WHERE stats.matched <= $5
           AND NOT EXISTS (
             SELECT 1 FROM email_remote_commands AS pending
             WHERE pending.user_id = location.user_id
               AND pending.source_location_id = location.id
               AND pending.action = 'mark_read'
               AND pending.status IN ('scheduled', 'running', 'retry_wait')
           )
         ON CONFLICT (user_id, idempotency_key) DO NOTHING
         RETURNING id
       )
       SELECT stats.matched, COUNT(inserted.id)::integer AS queued
       FROM candidate_stats AS stats
       LEFT JOIN inserted ON TRUE
       GROUP BY stats.matched`,
      [folderId, accountId, userId, batchKey, BULK_MARK_READ_LIMIT]
    )
    const matched = Number(inserted.rows[0]?.matched || 0)
    const queued = Number(inserted.rows[0]?.queued || 0)
    if (matched > BULK_MARK_READ_LIMIT) {
      throw new EmailRemoteCommandError(
        `Too many unread messages; the safe one-click limit is ${BULK_MARK_READ_LIMIT}`,
        { code: 'REMOTE_BULK_LIMIT_EXCEEDED', statusCode: 409 }
      )
    }
    return {
      matched,
      queued,
      alreadyQueued: Math.max(0, matched - queued)
    }
  })
}

export async function enqueueEmailRemoteCommand({
  poolInstance,
  userId,
  accountId,
  locationId,
  input,
  undoSeconds = EMAIL_REMOTE_COMMAND_UNDO_SECONDS
}) {
  const command = normalizeEmailRemoteCommandRequest(input)
  const requestHash = buildEmailRemoteCommandRequestHash({ accountId, locationId, command })
  return inTransaction(poolInstance, async (client) => {
    const existingResult = await client.query(
      `SELECT *
       FROM email_remote_commands
       WHERE user_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [userId, command.idempotencyKey]
    )
    const existing = existingResult.rows[0]
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new EmailRemoteCommandError('Idempotency key was already used for another command', {
          code: 'REMOTE_IDEMPOTENCY_CONFLICT', statusCode: 409
        })
      }
      return { command: serializeEmailRemoteCommand(existing), inserted: false }
    }
    const sourceResult = await client.query(
      `SELECT location.id, location.folder_id, location.message_id,
              location.uid_validity, location.uid, location.modseq,
              location.seen, location.flagged, location.deleted,
              location.expunged_at, folder.special_use
       FROM email_folder_messages AS location
       JOIN email_folders AS folder
         ON folder.id = location.folder_id
        AND folder.account_id = location.account_id
        AND folder.user_id = location.user_id
       WHERE location.id = $1 AND location.account_id = $2 AND location.user_id = $3
       FOR UPDATE OF location`,
      [locationId, accountId, userId]
    )
    const source = sourceResult.rows[0]
    if (!source || source.expunged_at) {
      throw new EmailRemoteCommandError('Email message location not found', {
        code: 'REMOTE_MESSAGE_NOT_FOUND', statusCode: 404
      })
    }
    if (command.targetFolderId) {
      const targetResult = await client.query(
        `SELECT id, selectable
         FROM email_folders
         WHERE id = $1 AND account_id = $2 AND user_id = $3
         FOR SHARE`,
        [command.targetFolderId, accountId, userId]
      )
      const target = targetResult.rows[0]
      if (!target || target.selectable !== true) {
        throw new EmailRemoteCommandError('Target email folder not found', {
          code: 'REMOTE_TARGET_MISSING', statusCode: 404
        })
      }
      if (String(target.id) === String(source.folder_id)) {
        throw new EmailRemoteCommandError('Source and target folders must differ', {
          code: 'REMOTE_TARGET_SAME_FOLDER', statusCode: 409
        })
      }
    }
    if (command.action === 'delete') {
      assertPermanentDeleteAllowed({ specialUse: source.special_use, deleted: source.deleted })
    }
    const snapshot = compareEmailRemoteSnapshot(command.expected, currentSnapshot(source), {
      action: command.action
    })
    if (!snapshot.ok) {
      throw new EmailRemoteCommandError('Email state changed before the command was queued', {
        code: snapshot.code, statusCode: 409
      })
    }
    const result = await client.query(
      `INSERT INTO email_remote_commands (
         user_id, account_id, source_location_id, source_folder_id,
         source_message_id, target_folder_id, action, status,
         idempotency_key, request_hash, expected_uid_validity, expected_uid,
         expected_modseq, expected_seen, expected_flagged, expected_deleted,
         undo_until, next_attempt_at, permanent_confirmed_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,'scheduled',$8,$9,$10,$11,$12,$13,$14,$15,
         NOW() + ($16::integer * INTERVAL '1 second'),
         NOW() + ($16::integer * INTERVAL '1 second'),
         CASE WHEN $17 THEN NOW() ELSE NULL END
       )
       ON CONFLICT (user_id, idempotency_key) DO UPDATE
         SET idempotency_key = email_remote_commands.idempotency_key
       RETURNING email_remote_commands.*, (xmax = 0) AS inserted`,
      [
        userId,
        accountId,
        locationId,
        source.folder_id,
        source.message_id,
        command.targetFolderId,
        command.action,
        command.idempotencyKey,
        requestHash,
        source.uid_validity,
        source.uid,
        command.expected.modseq,
        command.expected.seen,
        command.expected.flagged,
        command.expected.deleted,
        Math.max(3, Math.min(60, Number(undoSeconds) || EMAIL_REMOTE_COMMAND_UNDO_SECONDS)),
        command.permanentConfirmed
      ]
    )
    const row = result.rows[0]
    if (row.request_hash !== requestHash) {
      throw new EmailRemoteCommandError('Idempotency key was already used for another command', {
        code: 'REMOTE_IDEMPOTENCY_CONFLICT', statusCode: 409
      })
    }
    return {
      command: serializeEmailRemoteCommand(row),
      inserted: row.inserted === true
    }
  })
}

export async function getEmailRemoteCommand({
  poolInstance,
  userId,
  commandId
}) {
  if (!poolInstance?.query) throw new TypeError('PostgreSQL pool is required')
  const { rows } = await poolInstance.query(
    `SELECT * FROM email_remote_commands WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [commandId, userId]
  )
  return serializeEmailRemoteCommand(rows[0])
}

export async function undoEmailRemoteCommand({
  poolInstance,
  userId,
  commandId
}) {
  return inTransaction(poolInstance, async (client) => {
    const currentResult = await client.query(
      `SELECT * FROM email_remote_commands WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [commandId, userId]
    )
    const current = currentResult.rows[0]
    if (!current) {
      throw new EmailRemoteCommandError('Email command not found', {
        code: 'REMOTE_COMMAND_NOT_FOUND', statusCode: 404
      })
    }
    if (
      current.status !== 'scheduled'
      || current.started_at
      || new Date(current.undo_until).getTime() < Date.now()
    ) {
      throw new EmailRemoteCommandError('The undo window has closed', {
        code: 'REMOTE_UNDO_EXPIRED', statusCode: 409
      })
    }
    const { rows } = await client.query(
      `UPDATE email_remote_commands
       SET status = 'cancelled', completed_at = NOW(), updated_at = NOW(),
           last_error_code = NULL
       WHERE id = $1 AND user_id = $2 AND status = 'scheduled'
       RETURNING *`,
      [commandId, userId]
    )
    if (!rows[0]) {
      throw new EmailRemoteCommandError('The command started before it could be undone', {
        code: 'REMOTE_UNDO_EXPIRED', statusCode: 409
      })
    }
    return serializeEmailRemoteCommand(rows[0])
  })
}
