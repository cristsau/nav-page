import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'
import { emailMessageFailureState } from './emailIngestLimits.js'
import {
  persistEmailMailboxMessage,
  upsertEmailFolder
} from './emailMailboxStore.js'

const UINT32_MAX = 4_294_967_295n
const UINT64_MAX = 18_446_744_073_709_551_615n
const DEAD_LETTER_KEYWORD = '$nav-ingest-dead-letter'
const RECONCILE_MODES = new Set([
  'qresync',
  'condstore',
  'uid_flags_scan',
  'uidvalidity_reset'
])

function errorWithCode(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

function unsignedIntegerString(value, {
  label,
  maximum,
  allowNull = false,
  allowZero = false
}) {
  if (value == null || value === '') {
    if (allowNull) return null
    throw new TypeError(`${label} is required`)
  }
  const raw = String(value).trim()
  if (!/^\d+$/.test(raw)) throw new TypeError(`${label} is invalid`)
  const parsed = BigInt(raw)
  const minimum = allowZero ? 0n : 1n
  if (parsed < minimum || parsed > maximum) throw new TypeError(`${label} is out of range`)
  return parsed.toString()
}

function normalizedFolderPath(value) {
  const path = String(value || '').normalize('NFKC').trim()
  if (!path || path.length > 512 || /[\r\n\u0000]/.test(path)) {
    throw new TypeError('IMAP folder path is invalid')
  }
  return path
}

function normalizedFlags(flags) {
  const values = flags instanceof Set ? [...flags] : Array.isArray(flags) ? flags : []
  const lower = new Set(values.map((value) => String(value || '').trim().toLowerCase()))
  const keywords = values
    .map((value) => String(value || '').normalize('NFKC').trim())
    .filter((value) => value && !value.startsWith('\\'))
    .slice(0, 100)
  return {
    seen: lower.has('\\seen'),
    answered: lower.has('\\answered'),
    flagged: lower.has('\\flagged'),
    draft: lower.has('\\draft'),
    deleted: lower.has('\\deleted'),
    keywords
  }
}

function normalizeUidList(value, maximum = 100_000) {
  const source = Array.isArray(value) ? value : []
  if (source.length > maximum) throw errorWithCode('IMAP UID list exceeds the reconciliation limit', 'EMAIL_RECONCILE_UID_SCAN_LIMIT')
  return [...new Set(source.map((uid) => {
    const normalized = unsignedIntegerString(uid, {
      label: 'IMAP UID',
      maximum: UINT32_MAX
    })
    return Number(normalized)
  }))].sort((left, right) => left - right)
}

export function enabledImapCapabilities(client) {
  const result = new Set()
  const enabled = new Set()
  for (const source of [client?.capabilities, client?.enabled]) {
    const values = source instanceof Set ? [...source] : Array.isArray(source) ? source : []
    for (const value of values) {
      const normalized = String(value || '').trim().toUpperCase()
      if (normalized) result.add(normalized)
    }
  }
  for (const value of client?.enabled instanceof Set
    ? client.enabled
    : Array.isArray(client?.enabled) ? client.enabled : []) {
    const normalized = String(value || '').trim().toUpperCase()
    if (normalized) enabled.add(normalized)
  }
  // ImapFlow only emits CHANGEDSINCE/VANISHED semantics for extensions that
  // were actually enabled. An advertised-but-rejected extension must not move
  // the durable cursor past changes that were never returned.
  for (const extension of ['CONDSTORE', 'QRESYNC']) {
    if (!enabled.has(extension)) result.delete(extension)
  }
  return result
}

export function selectEmailReconcileMode({
  capabilities,
  reconciledModseq,
  remoteHighestModseq,
  noModseq = false
} = {}) {
  const available = capabilities instanceof Set
    ? capabilities
    : new Set((Array.isArray(capabilities) ? capabilities : []).map((value) => String(value).toUpperCase()))
  const hasCursor = reconciledModseq != null && String(reconciledModseq) !== ''
  const hasRemoteCursor = /^\d+$/.test(String(remoteHighestModseq ?? ''))
    && BigInt(String(remoteHighestModseq)) > 0n
  if (!noModseq && hasCursor && hasRemoteCursor && available.has('CONDSTORE')) {
    return available.has('QRESYNC') ? 'qresync' : 'condstore'
  }
  return 'uid_flags_scan'
}

function normalizeFlagUpdates(value) {
  const source = Array.isArray(value) ? value : []
  if (source.length > 100_000) {
    throw errorWithCode('IMAP flags response exceeds the reconciliation limit', 'EMAIL_RECONCILE_FLAGS_LIMIT')
  }
  const byUid = new Map()
  for (const message of source) {
    const uid = Number(unsignedIntegerString(message?.uid, {
      label: 'IMAP flag UID', maximum: UINT32_MAX
    }))
    const modseq = unsignedIntegerString(message?.modseq, {
      label: 'IMAP message MODSEQ', maximum: UINT64_MAX, allowNull: true
    })
    const flags = normalizedFlags(message?.flags)
    const existing = byUid.get(uid)
    if (
      existing
      && existing.modseq != null
      && (modseq == null || BigInt(existing.modseq) > BigInt(modseq))
    ) continue
    byUid.set(uid, { uid, modseq, ...flags })
  }
  return [...byUid.values()]
}

export async function applyEmailFolderReconciliation({
  poolInstance,
  userId,
  folderId,
  uidValidity,
  mode,
  remoteHighestModseq = null,
  flagUpdates = [],
  expungedUids = [],
  authoritativeRemoteUids
}) {
  if (!poolInstance?.connect) throw new TypeError('A PostgreSQL pool is required')
  const normalizedUidValidity = unsignedIntegerString(uidValidity, {
    label: 'IMAP UIDVALIDITY', maximum: UINT32_MAX
  })
  const normalizedMode = String(mode || '').trim().toLowerCase()
  if (!RECONCILE_MODES.has(normalizedMode)) throw new TypeError('Email reconciliation mode is invalid')
  const normalizedHighestModseq = unsignedIntegerString(remoteHighestModseq, {
    label: 'IMAP HIGHESTMODSEQ', maximum: UINT64_MAX, allowNull: true
  })
  if (
    (normalizedMode === 'qresync' || normalizedMode === 'condstore')
    && normalizedHighestModseq == null
  ) {
    throw errorWithCode('IMAP HIGHESTMODSEQ is missing for incremental reconciliation', 'EMAIL_RECONCILE_MODSEQ_MISSING')
  }
  const normalizedUpdates = normalizeFlagUpdates(flagUpdates)
  const normalizedExpunged = normalizeUidList(expungedUids)
  const normalizedRemote = Array.isArray(authoritativeRemoteUids)
    ? normalizeUidList(authoritativeRemoteUids)
    : null
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    const currentResult = await client.query(
      `SELECT uid_validity, reconciled_modseq
       FROM email_folders
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [folderId, userId]
    )
    const current = currentResult.rows[0]
    if (!current) throw errorWithCode('Email folder is missing', 'EMAIL_RECONCILE_FOLDER_MISSING')
    if (String(current.uid_validity || '') !== normalizedUidValidity) {
      throw errorWithCode('IMAP UIDVALIDITY changed during reconciliation', 'EMAIL_RECONCILE_UIDVALIDITY_CHANGED')
    }
    if (
      normalizedHighestModseq != null
      && current.reconciled_modseq != null
      && BigInt(normalizedHighestModseq) < BigInt(String(current.reconciled_modseq))
    ) {
      throw errorWithCode('IMAP MODSEQ regressed during reconciliation', 'EMAIL_RECONCILE_MODSEQ_REGRESSION')
    }

    let flagsUpdated = 0
    if (normalizedUpdates.length) {
      const updated = await client.query(
        `WITH remote AS (
           SELECT *
           FROM jsonb_to_recordset($4::jsonb) AS value(
             uid BIGINT,
             modseq NUMERIC(20, 0),
             seen BOOLEAN,
             answered BOOLEAN,
             flagged BOOLEAN,
             draft BOOLEAN,
             deleted BOOLEAN,
             keywords JSONB
           )
         )
         UPDATE email_folder_messages AS location
         SET modseq = COALESCE(remote.modseq, location.modseq),
             seen = remote.seen,
             answered = remote.answered,
             flagged = remote.flagged,
             draft = remote.draft,
             deleted = remote.deleted,
             keywords = remote.keywords,
             expunged_at = NULL,
             updated_at = NOW()
         FROM remote
         WHERE location.folder_id = $1
           AND location.user_id = $2
           AND location.uid_validity = $3::bigint
           AND location.uid = remote.uid
           AND location.expunged_at IS NULL
           AND (
             (remote.modseq IS NULL AND location.modseq IS NULL)
             OR (
               remote.modseq IS NOT NULL
               AND (location.modseq IS NULL OR remote.modseq >= location.modseq)
             )
           )`,
        [folderId, userId, normalizedUidValidity, JSON.stringify(normalizedUpdates)]
      )
      flagsUpdated = updated.rowCount
    }

    let expunged = 0
    if (normalizedExpunged.length) {
      const explicit = await client.query(
        `UPDATE email_folder_messages
         SET expunged_at = COALESCE(expunged_at, NOW()), updated_at = NOW()
         WHERE folder_id = $1 AND user_id = $2
           AND uid_validity = $3::bigint
           AND uid = ANY($4::bigint[])
           AND expunged_at IS NULL`,
        [folderId, userId, normalizedUidValidity, normalizedExpunged]
      )
      expunged += explicit.rowCount
    }
    if (normalizedRemote) {
      const missing = await client.query(
        `UPDATE email_folder_messages
         SET expunged_at = COALESCE(expunged_at, NOW()), updated_at = NOW()
         WHERE folder_id = $1 AND user_id = $2
           AND uid_validity = $3::bigint
           AND NOT (uid = ANY($4::bigint[]))
           AND expunged_at IS NULL`,
        [folderId, userId, normalizedUidValidity, normalizedRemote]
      )
      expunged += missing.rowCount
    }

    await client.query(
      `UPDATE email_folders
       SET reconciled_modseq = $3::numeric,
           highest_modseq = CASE
             WHEN $3::numeric IS NULL THEN highest_modseq
             WHEN highest_modseq IS NULL OR $3::numeric >= highest_modseq THEN $3::numeric
             ELSE highest_modseq
           END,
           last_reconciled_at = NOW(),
           last_reconcile_mode = $4,
           last_reconcile_error_at = NULL,
           last_reconcile_error_code = NULL,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [folderId, userId, normalizedHighestModseq, normalizedMode]
    )
    await client.query('COMMIT')
    return { flagsUpdated, expunged, mode: normalizedMode }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function recordEmailFolderReconcileFailure({
  poolInstance,
  userId,
  folderId,
  error
}) {
  const errorCode = sanitizeMaintenanceErrorCode(error)
  await poolInstance.query(
    `UPDATE email_folders
     SET last_reconcile_error_at = NOW(),
         last_reconcile_error_code = $3,
         last_error_at = NOW(),
         last_error_code = $3,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [folderId, userId, errorCode]
  )
  return errorCode
}

async function loadFolderState(poolInstance, { folderId, userId }) {
  const result = await poolInstance.query(
    `SELECT id, account_id, user_id, path, delimiter, special_use,
            selectable, subscribed, uid_validity, uid_next, highest_modseq,
            reconciled_modseq, last_uid, initial_sync_complete,
            last_synced_at, last_reconciled_at, last_error_code
     FROM email_folders
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [folderId, userId]
  )
  return result.rows[0] || null
}

async function upsertSelectedFolder({ poolInstance, userId, accountId, listedFolder, mailbox }) {
  const client = await poolInstance.connect()
  try {
    await client.query('BEGIN')
    const saved = await upsertEmailFolder(client, {
      accountId,
      userId,
      path: listedFolder.path,
      delimiter: mailbox?.delimiter || listedFolder.delimiter || null,
      specialUse: listedFolder.specialUse || null,
      selectable: true,
      subscribed: listedFolder.subscribed !== false,
      uidValidity: mailbox?.uidValidity,
      uidNext: mailbox?.uidNext,
      highestModseq: mailbox?.highestModseq || null,
      lastUid: 0
    })
    await client.query('COMMIT')
    return saved
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function fetchAllFlags(client, uids, batchSize) {
  const messages = []
  for (let offset = 0; offset < uids.length; offset += batchSize) {
    const batch = uids.slice(offset, offset + batchSize)
    if (!batch.length) continue
    const fetched = await client.fetchAll(
      batch,
      { uid: true, flags: true, modseq: true },
      { uid: true }
    )
    if (!Array.isArray(fetched)) {
      throw errorWithCode('IMAP flags scan failed', 'EMAIL_RECONCILE_FLAGS_SCAN_FAILED')
    }
    messages.push(...fetched)
  }
  return messages
}

export async function reconcileSelectedEmailFolder({
  client,
  poolInstance,
  userId,
  accountId,
  listedFolder,
  policy = {}
}) {
  const folderPath = normalizedFolderPath(listedFolder?.path)
  const maximumMessages = boundedInteger(policy.maxReconcileMessages, 20_000, 100, 100_000)
  const fetchBatchSize = boundedInteger(policy.reconcileBatchSize, 500, 10, 2_000)
  const lock = await client.getMailboxLock(folderPath, { readOnly: true })
  const expungeEvents = []
  const onExpunge = (event) => {
    if (String(event?.path || '') === folderPath) expungeEvents.push(event)
  }
  client.on?.('expunge', onExpunge)
  try {
    const mailbox = client.mailbox
    // Freeze the SELECT/EXAMINE watermark before fetching. Unsolicited FETCH
    // events may raise ImapFlow's live mailbox.highestModseq while this run is
    // applying an earlier response; persisting that mutable value could skip a
    // change that was never part of flagUpdates.
    const selectedHighestModseq = mailbox?.noModseq ? null : mailbox?.highestModseq || null
    const uidValidity = unsignedIntegerString(mailbox?.uidValidity, {
      label: 'IMAP UIDVALIDITY', maximum: UINT32_MAX
    })
    const previous = await loadFolderState(poolInstance, {
      folderId: listedFolder.id,
      userId
    })
    const saved = await upsertSelectedFolder({
      poolInstance,
      userId,
      accountId,
      listedFolder,
      mailbox
    })
    const state = await loadFolderState(poolInstance, { folderId: saved.id, userId })
    const uidValidityReset = previous?.uid_validity != null
      && String(previous.uid_validity) !== uidValidity
    const capabilities = enabledImapCapabilities(client)
    const mode = selectEmailReconcileMode({
      capabilities,
      reconciledModseq: state.reconciled_modseq,
      remoteHighestModseq: selectedHighestModseq,
      noModseq: Boolean(mailbox?.noModseq)
    })
    let flagUpdates = []
    let expungedUids = []
    let authoritativeRemoteUids

    if (mode === 'qresync' || mode === 'condstore') {
      flagUpdates = await client.fetchAll(
        '1:*',
        { uid: true, flags: true, modseq: true },
        { uid: true, changedSince: BigInt(String(state.reconciled_modseq)) }
      )
      if (!Array.isArray(flagUpdates) || flagUpdates.length > maximumMessages) {
        throw errorWithCode('IMAP changed flags exceed the reconciliation limit', 'EMAIL_RECONCILE_FLAGS_LIMIT')
      }
      if (expungeEvents.length > maximumMessages) {
        throw errorWithCode('IMAP VANISHED response exceeds the reconciliation limit', 'EMAIL_RECONCILE_UID_SCAN_LIMIT')
      }
      for (const event of expungeEvents) {
        if (!event?.uid) {
          throw errorWithCode('IMAP expunge response did not include a UID', 'EMAIL_RECONCILE_EXPUNGE_UNKNOWN')
        }
        expungedUids.push(event.uid)
      }
      if (mode === 'condstore') {
        if (Number(mailbox?.exists || 0) > maximumMessages) {
          throw errorWithCode('IMAP folder exceeds the bounded UID scan limit', 'EMAIL_RECONCILE_UID_SCAN_LIMIT')
        }
        const searched = await client.search({ all: true }, { uid: true })
        if (searched === false) throw errorWithCode('IMAP UID scan failed', 'EMAIL_RECONCILE_UID_SCAN_FAILED')
        authoritativeRemoteUids = normalizeUidList(searched, maximumMessages)
      }
    } else {
      if (Number(mailbox?.exists || 0) > maximumMessages) {
        throw errorWithCode('IMAP folder exceeds the bounded flags scan limit', 'EMAIL_RECONCILE_UID_SCAN_LIMIT')
      }
      const searched = await client.search({ all: true }, { uid: true })
      if (searched === false) throw errorWithCode('IMAP UID scan failed', 'EMAIL_RECONCILE_UID_SCAN_FAILED')
      authoritativeRemoteUids = normalizeUidList(searched, maximumMessages)
      flagUpdates = await fetchAllFlags(client, authoritativeRemoteUids, fetchBatchSize)
    }

    const applied = await applyEmailFolderReconciliation({
      poolInstance,
      userId,
      folderId: saved.id,
      uidValidity,
      mode,
      remoteHighestModseq: selectedHighestModseq,
      flagUpdates,
      expungedUids,
      authoritativeRemoteUids
    })
    return {
      folderId: saved.id,
      uidValidityReset,
      ...applied
    }
  } finally {
    client.off?.('expunge', onExpunge)
    lock.release()
  }
}

async function persistSecondaryMessage({
  client,
  poolInstance,
  userId,
  sourceKey,
  account,
  folder,
  capabilities,
  message,
  policy,
  parseMessage
}) {
  const maxMessageBytes = boundedInteger(policy.maxMessageBytes, 512 * 1024, 32 * 1024, 2 * 1024 * 1024)
  const declaredSize = Math.max(0, Number(message.size || 0))
  if (declaredSize <= maxMessageBytes) {
    const fetchLimit = declaredSize > 0
      ? Math.min(maxMessageBytes + 1, declaredSize + 1)
      : maxMessageBytes + 1
    const sourceMessage = await client.fetchOne(
      Number(message.uid),
      { source: { start: 0, maxLength: fetchLimit } },
      { uid: true }
    )
    message.source = Buffer.isBuffer(sourceMessage?.source)
      ? sourceMessage.source
      : Buffer.from(sourceMessage?.source || [])
    message.sourceTruncated = message.source.length >= fetchLimit
  }
  try {
    const parsed = await parseMessage(message, maxMessageBytes)
    return await persistEmailMailboxMessage({
      poolInstance,
      userId,
      sourceKey,
      accountLabel: account.label || '个人邮箱',
      capabilities,
      notificationEligible: false,
      folder: {
        path: folder.path,
        delimiter: folder.delimiter || null,
        specialUse: folder.special_use || null,
        selectable: true,
        subscribed: folder.subscribed !== false,
        uidValidity: folder.uid_validity,
        uidNext: folder.uid_next,
        highestModseq: folder.highest_modseq
      },
      message: parsed
    })
  } finally {
    if (Buffer.isBuffer(message.source)) message.source.fill(0)
    message.source = null
    message.sourceTruncated = false
  }
}

async function markSecondaryDeadLetter(poolInstance, { locationId, userId }) {
  await poolInstance.query(
    `UPDATE email_folder_messages
     SET keywords = CASE
           WHEN keywords @> $3::jsonb THEN keywords
           ELSE keywords || $3::jsonb
         END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [locationId, userId, JSON.stringify([DEAD_LETTER_KEYWORD])]
  )
}

export async function syncSecondaryEmailFolder({
  client,
  poolInstance,
  userId,
  sourceKey,
  account,
  folderId,
  policy = {},
  parseMessage
}) {
  if (typeof parseMessage !== 'function') throw new TypeError('parseMessage is required')
  const batchSize = boundedInteger(policy.batchSize, 100, 1, 500)
  const initialLookback = boundedInteger(policy.initialLookback, 1000, 1, 1000)
  const maxAttempts = boundedInteger(policy.maxMessageAttempts, 3, 1, 10)
  let folder = await loadFolderState(poolInstance, { folderId, userId })
  if (!folder) throw errorWithCode('Email folder is missing', 'EMAIL_RECONCILE_FOLDER_MISSING')
  const lock = await client.getMailboxLock(folder.path, { readOnly: true })
  try {
    const mailbox = client.mailbox
    const uidValidity = String(mailbox?.uidValidity || '')
    if (!uidValidity || uidValidity !== String(folder.uid_validity || '')) {
      throw errorWithCode('IMAP UIDVALIDITY changed before folder content sync', 'EMAIL_RECONCILE_UIDVALIDITY_CHANGED')
    }
    const uidNext = Number(mailbox?.uidNext || 1)
    let lastUid = Number(folder.last_uid || 0)
    if (!folder.initial_sync_complete && lastUid === 0) {
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      const recent = await client.search({ since }, { uid: true })
      if (recent !== false) {
        const recentUids = normalizeUidList(recent, 100_000)
          .filter((uid) => uid < uidNext)
          .slice(-initialLookback)
        lastUid = recentUids.length ? Math.max(0, recentUids[0] - 1) : Math.max(0, uidNext - 1)
      } else {
        lastUid = Math.max(0, uidNext - initialLookback - 1)
      }
    }
    const startUid = Math.max(1, lastUid + 1)
    const endUid = startUid >= uidNext
      ? null
      : Math.min(uidNext - 1, startUid + batchSize - 1)
    const messages = endUid == null
      ? []
      : await client.fetchAll(
          `${startUid}:${endUid}`,
          { uid: true, envelope: true, internalDate: true, size: true, flags: true, modseq: true },
          { uid: true }
        )
    if (!Array.isArray(messages)) {
      throw errorWithCode('IMAP folder content scan failed', 'EMAIL_FOLDER_SYNC_FETCH_FAILED')
    }
    const capabilities = [...enabledImapCapabilities(client)]
    let processed = 0
    let inserted = 0
    let duplicates = 0
    let classificationQueued = 0
    let errorCode = null
    for (const message of messages.sort((left, right) => Number(left.uid) - Number(right.uid))) {
      const uid = Number(message.uid)
      let stored = null
      try {
        stored = await persistSecondaryMessage({
          client,
          poolInstance,
          userId,
          sourceKey,
          account,
          folder: {
            ...folder,
            uid_next: uidNext,
            highest_modseq: mailbox?.highestModseq || folder.highest_modseq
          },
          capabilities,
          message,
          policy,
          parseMessage
        })
        processed += 1
        if (stored.inserted) inserted += 1
        else duplicates += 1
        if (stored.classificationQueued) classificationQueued += 1
        lastUid = Math.max(lastUid, uid)
        errorCode = null
      } catch (error) {
        const failure = emailMessageFailureState({
          errorCode: folder.last_error_code,
          uid,
          maxAttempts
        })
        errorCode = failure.code
        if (!failure.deadLetter) throw errorWithCode('Email folder message will be retried', failure.code)
        if (!stored) {
          const placeholderMessage = { ...message, source: Buffer.alloc(0), sourceTruncated: true }
          const placeholder = await parseMessage(placeholderMessage, 0)
          placeholder.text = '[此邮件无法安全处理，已保留死信占位；请在原邮箱中查看。]'
          stored = await persistEmailMailboxMessage({
            poolInstance,
            userId,
            sourceKey,
            accountLabel: account.label || '个人邮箱',
            capabilities,
            notificationEligible: false,
            folder: {
              path: folder.path,
              delimiter: folder.delimiter,
              specialUse: folder.special_use,
              selectable: true,
              subscribed: folder.subscribed !== false,
              uidValidity,
              uidNext,
              highestModseq: mailbox?.highestModseq || null
            },
            message: placeholder
          })
        }
        await markSecondaryDeadLetter(poolInstance, { locationId: stored.location.id, userId })
        processed += 1
        if (stored.inserted) inserted += 1
        else duplicates += 1
        if (stored.classificationQueued) classificationQueued += 1
        lastUid = Math.max(lastUid, uid)
      }
    }
    if (endUid != null) lastUid = Math.max(lastUid, endUid)
    const caughtUp = lastUid >= Math.max(0, uidNext - 1)
    await poolInstance.query(
      `UPDATE email_folders
       SET last_uid = GREATEST(last_uid, $3),
           uid_next = $4,
           highest_modseq = COALESCE($5::numeric, highest_modseq),
           initial_sync_complete = CASE WHEN $6 THEN TRUE ELSE initial_sync_complete END,
           last_synced_at = NOW(),
           last_error_at = CASE WHEN $7::text IS NULL THEN NULL ELSE NOW() END,
           last_error_code = $7,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [folderId, userId, lastUid, uidNext, mailbox?.highestModseq || null, caughtUp, errorCode]
    )
    folder = await loadFolderState(poolInstance, { folderId, userId })
    return {
      processed,
      inserted,
      duplicates,
      classificationQueued,
      remaining: Math.max(0, uidNext - 1 - lastUid),
      caughtUp,
      folderId: folder.id
    }
  } finally {
    lock.release()
  }
}

export async function syncDueEmailFolders({
  client,
  poolInstance,
  userId,
  sourceKey,
  primaryMailbox,
  policy = {},
  parseMessage,
  logger
}) {
  const folderIntervalSeconds = boundedInteger(policy.folderSyncIntervalSeconds, 900, 60, 86_400)
  const foldersPerRun = boundedInteger(policy.foldersPerRun, 2, 1, 20)
  const due = await poolInstance.query(
    `SELECT folder.*, account.label AS account_label
     FROM email_folders AS folder
     JOIN email_accounts AS account
       ON account.id = folder.account_id AND account.user_id = folder.user_id
     WHERE folder.user_id = $1
       AND account.source_key = $2
       AND account.enabled = TRUE
       AND folder.selectable = TRUE
       AND folder.subscribed = TRUE
       AND (
         folder.last_reconcile_error_at IS NULL
         OR folder.last_reconcile_error_at <= NOW() - ($3::integer * INTERVAL '1 second')
       )
       AND (
         folder.initial_sync_complete = FALSE
         OR folder.last_reconciled_at IS NULL
         OR folder.last_reconciled_at <= NOW() - ($3::integer * INTERVAL '1 second')
         OR (
           folder.path <> $4
           AND (
             folder.last_synced_at IS NULL
             OR folder.last_synced_at <= NOW() - ($3::integer * INTERVAL '1 second')
           )
         )
       )
     ORDER BY
       CASE WHEN folder.path = $4 THEN 0 ELSE 1 END,
       folder.initial_sync_complete ASC,
       folder.last_reconciled_at ASC NULLS FIRST,
       folder.id
     LIMIT $5`,
    [userId, sourceKey, folderIntervalSeconds, primaryMailbox, foldersPerRun]
  )
  const summary = {
    foldersProcessed: 0,
    foldersFailed: 0,
    qresyncFolders: 0,
    condstoreFolders: 0,
    uidScanFolders: 0,
    uidValidityResets: 0,
    flagUpdates: 0,
    expunged: 0,
    secondaryProcessed: 0,
    secondaryRemaining: 0,
    continueImmediately: false
  }
  for (const folder of due.rows) {
    try {
      const reconciled = await reconcileSelectedEmailFolder({
        client,
        poolInstance,
        userId,
        accountId: folder.account_id,
        listedFolder: folder,
        policy
      })
      summary.foldersProcessed += 1
      if (reconciled.mode === 'qresync') summary.qresyncFolders += 1
      else if (reconciled.mode === 'condstore') summary.condstoreFolders += 1
      else summary.uidScanFolders += 1
      if (reconciled.uidValidityReset) summary.uidValidityResets += 1
      summary.flagUpdates += reconciled.flagsUpdated
      summary.expunged += reconciled.expunged

      if (folder.path !== primaryMailbox) {
        const secondary = await syncSecondaryEmailFolder({
          client,
          poolInstance,
          userId,
          sourceKey,
          account: { id: folder.account_id, label: folder.account_label },
          folderId: folder.id,
          policy,
          parseMessage
        })
        summary.secondaryProcessed += secondary.processed
        summary.secondaryRemaining += secondary.remaining
        if (!secondary.caughtUp) summary.continueImmediately = true
      }
    } catch (error) {
      summary.foldersFailed += 1
      const errorCode = await recordEmailFolderReconcileFailure({
        poolInstance,
        userId,
        folderId: folder.id,
        error
      }).catch(() => sanitizeMaintenanceErrorCode(error))
      logger?.warn?.({ folderId: folder.id, errorCode }, 'email folder reconciliation failed closed')
    }
  }
  return summary
}
