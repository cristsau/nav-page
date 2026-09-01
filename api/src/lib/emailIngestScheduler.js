import { createHash } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { config } from '../config.js'
import { sanitizeMaintenanceErrorCode } from './maintenanceJobStatus.js'
import { readOwnerSecretFile } from './ownerSecretFile.js'
import { resolveImapAuth } from './emailOauth2.js'
import { EMAIL_ENCRYPTION_MAX_PLAINTEXT_BYTES } from './emailCrypto.js'
import {
  persistEmailMailboxMessage,
  upsertEmailAccount,
  upsertEmailFolder
} from './emailMailboxStore.js'
import { assertSafeOutboundHost } from './outboundEndpoints.js'
import {
  EMAIL_INGEST_WAKE_CHANNEL,
  startEmailWakeListener
} from './emailIngestWake.js'
import {
  deriveEmailBatchSourceBudget,
  emailMessageFailureState,
  normalizeEmailMessageAttempts,
  truncateUtf8
} from './emailIngestLimits.js'
import { createEmailIngestTelemetry } from './emailIngestTelemetry.js'
import { syncDueEmailFolders } from './emailMailboxReconciliation.js'

// Leave more than half of the encrypted content budget for bounded attachment
// metadata and JSON overhead. This is byte-based because AES-GCM validates the
// serialized UTF-8 payload rather than JavaScript character count.
const MAX_PARSED_TEXT_BYTES = Math.floor(EMAIL_ENCRYPTION_MAX_PLAINTEXT_BYTES * 4 / 9)
const DEAD_LETTER_KEYWORD = '$nav-ingest-dead-letter'

export const UPDATE_MAILBOX_FAILURE_STATE_SQL = `
  UPDATE email_mailbox_state AS state
  SET last_error_at = NOW(), last_error_code = $3, updated_at = NOW()
  FROM users AS owner
  WHERE state.source_key = $1
    AND state.user_id = owner.id
    AND owner.username = $2
`

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function validateEmailIngestPolicy(policy = {}) {
  const maxMessageBytes = boundedInteger(policy.maxMessageBytes, 512 * 1024, 32 * 1024, 2 * 1024 * 1024)
  const normalized = {
    pollIntervalSeconds: boundedInteger(policy.pollIntervalSeconds, 60, 30, 3600),
    initialLookback: boundedInteger(policy.initialLookback, 1000, 1, 1000),
    batchSize: boundedInteger(policy.batchSize, 100, 1, 500),
    maxMessageBytes,
    maxBatchSourceBytes: deriveEmailBatchSourceBudget(maxMessageBytes, policy.maxBatchSourceBytes),
    maxMessageAttempts: normalizeEmailMessageAttempts(policy.maxMessageAttempts),
    drainMaxBatches: boundedInteger(policy.drainMaxBatches, 10, 1, 50),
    drainMaxMilliseconds: boundedInteger(policy.drainMaxMilliseconds, 15_000, 1_000, 60_000),
    protocolReconciliationEnabled: policy.protocolReconciliationEnabled !== false,
    secondaryFolderSyncEnabled: policy.secondaryFolderSyncEnabled !== false,
    folderSyncIntervalSeconds: boundedInteger(policy.folderSyncIntervalSeconds, 900, 60, 86_400),
    foldersPerRun: boundedInteger(policy.foldersPerRun, 2, 1, 20),
    maxReconcileMessages: boundedInteger(policy.maxReconcileMessages, 20_000, 100, 100_000),
    reconcileBatchSize: boundedInteger(policy.reconcileBatchSize, 500, 10, 2_000),
    telemetrySampleSize: boundedInteger(policy.telemetrySampleSize, 64, 8, 512)
  }
  return normalized
}

export async function drainEmailMailboxBatches({ syncMailbox, policy, clock = () => Date.now() }) {
  if (typeof syncMailbox !== 'function') throw new TypeError('syncMailbox is required')
  const validated = validateEmailIngestPolicy(policy)
  const drainStartedAt = clock()
  const combined = {
    processed: 0,
    inserted: 0,
    duplicates: 0,
    classificationQueued: 0,
    remaining: 0,
    caughtUp: false,
    syncRequestPending: false,
    maxIngestLatencyMs: 0,
    batches: 0,
    foldersProcessed: 0,
    foldersFailed: 0,
    qresyncFolders: 0,
    condstoreFolders: 0,
    uidScanFolders: 0,
    uidValidityResets: 0,
    flagUpdates: 0,
    expunged: 0,
    secondaryProcessed: 0,
    secondaryRemaining: 0
  }
  do {
    const batch = await syncMailbox()
    combined.processed += Number(batch.processed || 0)
    combined.inserted += Number(batch.inserted || 0)
    combined.duplicates += Number(batch.duplicates || 0)
    combined.classificationQueued += Number(batch.classificationQueued || 0)
    combined.maxIngestLatencyMs = Math.max(
      combined.maxIngestLatencyMs,
      Number(batch.maxIngestLatencyMs || 0)
    )
    combined.remaining = Number(batch.remaining || 0)
    combined.caughtUp = batch.caughtUp === true
    combined.syncRequestPending = batch.syncRequestPending === true
    combined.batches += 1
    for (const key of [
      'foldersProcessed', 'foldersFailed', 'qresyncFolders', 'condstoreFolders',
      'uidScanFolders', 'uidValidityResets', 'flagUpdates', 'expunged',
      'secondaryProcessed'
    ]) combined[key] += Number(batch[key] || 0)
    combined.secondaryRemaining = Number(batch.secondaryRemaining || 0)
    if (combined.caughtUp && !combined.syncRequestPending) break
  } while (
    combined.batches < validated.drainMaxBatches
    && clock() - drainStartedAt < validated.drainMaxMilliseconds
  )
  combined.continueImmediately = !combined.caughtUp || combined.syncRequestPending
  return combined
}

export function mailboxBatchNotificationState({
  initialSyncComplete = false,
  caughtUp = false
} = {}) {
  const notificationEligible = initialSyncComplete === true
  return {
    notificationEligible,
    nextInitialSyncComplete: notificationEligible || caughtUp === true
  }
}

export function validateImapConfig(runtimeConfig = config) {
  const sourceKey = String(runtimeConfig.emailSourceKey || '').trim().toLowerCase()
  if (!/^[a-z0-9_.-]{1,80}$/.test(sourceKey)) throw new Error('Email source key is invalid')
  if (!runtimeConfig.emailOwnerUsername) throw new Error('Email owner username is not configured')
  if (
    !runtimeConfig.imapHost
    || !runtimeConfig.imapUsername
    || (!runtimeConfig.imapPasswordFile && !runtimeConfig.imapOauthProvider)
  ) {
    throw new Error('IMAP configuration is incomplete')
  }
  if (!runtimeConfig.imapSecure) throw new Error('IMAP must use implicit TLS')
  if (Number(runtimeConfig.imapPort) !== 993) throw new Error('IMAP must use TLS port 993')
  if (!runtimeConfig.imapMailbox || /[\r\n\u0000]/.test(runtimeConfig.imapMailbox)) {
    throw new Error('IMAP mailbox name is invalid')
  }
  return sourceKey
}

export async function verifyImapConnection(
  runtimeConfig = config,
  {
    ImapClient = ImapFlow,
    readSecretImpl = readOwnerSecretFile,
    assertHostImpl = assertSafeOutboundHost
  } = {}
) {
  validateImapConfig(runtimeConfig)
  await assertHostImpl(runtimeConfig.imapHost, { label: 'IMAP ' })
  const auth = await resolveImapAuth(runtimeConfig, { readSecretImpl })
  const client = new ImapClient({
    host: runtimeConfig.imapHost,
    port: Number(runtimeConfig.imapPort),
    secure: true,
    auth,
    disableAutoIdle: true,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    logger: false
  })
  try {
    await client.connect()
    return { ok: true, host: runtimeConfig.imapHost, port: Number(runtimeConfig.imapPort), secure: true }
  } finally {
    try {
      if (client.usable) await client.logout()
      else client.close?.()
    } catch {
      try { client.close?.() } catch {}
    }
  }
}

function firstAddress(addresses) {
  const address = Array.isArray(addresses) ? addresses[0] : addresses
  return {
    name: String(address?.name || '').normalize('NFKC').trim().slice(0, 320),
    address: String(address?.address || '').normalize('NFKC').trim().toLowerCase().slice(0, 320)
  }
}

function joinAddresses(addresses) {
  return (Array.isArray(addresses) ? addresses : [])
    .map((address) => String(address?.address || '').trim().toLowerCase())
    .filter(Boolean)
    .join(', ')
    .slice(0, 1000)
}

function addressList(addresses) {
  return (Array.isArray(addresses) ? addresses : [])
    .map((address) => ({
      name: String(address?.name || '').normalize('NFKC').trim().slice(0, 320),
      address: String(address?.address || '').normalize('NFKC').trim().toLowerCase().slice(0, 320)
    }))
    .filter((address) => address.address)
    .slice(0, 50)
}

function capabilitiesOf(client) {
  const capabilities = client?.capabilities instanceof Set
    ? [...client.capabilities]
    : Array.isArray(client?.capabilities)
      ? client.capabilities
      : []
  return capabilities.map((value) => String(value || '').toUpperCase())
}

export async function parseImapMessage(message, maxMessageBytes) {
  const source = Buffer.isBuffer(message.source) ? message.source : Buffer.from(message.source || [])
  const rawHash = source.length && !message.sourceTruncated
    ? createHash('sha256').update(source).digest('hex')
    : ''
  const oversized = Boolean(message.sourceTruncated)
    || Number(message.size || 0) > maxMessageBytes
    || source.length > maxMessageBytes
  let parsed = null
  if (source.length && !oversized) {
    parsed = await simpleParser(source, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      maxHtmlLengthToParse: 0
    })
  }
  try {
    const envelope = message.envelope || {}
    const parsedFrom = firstAddress(parsed?.from?.value)
    const envelopeFrom = firstAddress(envelope.from)
    const sender = parsedFrom.address ? parsedFrom : envelopeFrom
    const receivedAt = parsed?.date || message.internalDate || envelope.date || new Date()
    const parsedTo = addressList(parsed?.to?.value || envelope.to)
    const parsedCc = addressList(parsed?.cc?.value || envelope.cc)
    const parsedBcc = addressList(parsed?.bcc?.value || envelope.bcc)
    return {
      mailboxUid: Number(message.uid),
      messageId: String(parsed?.messageId || envelope.messageId || '').trim(),
      senderName: sender.name,
      senderAddress: sender.address,
      sender,
      to: parsedTo,
      cc: parsedCc,
      bcc: parsedBcc,
      recipient: joinAddresses(parsedTo),
      subject: String(parsed?.subject || envelope.subject || '(无主题)').slice(0, 500),
      text: oversized
        ? '[邮件正文超过安全处理上限，已仅根据发件人和标题分类。]'
        : truncateUtf8(parsed?.text || '', MAX_PARSED_TEXT_BYTES),
      receivedAt,
      internalDate: message.internalDate || receivedAt,
      sentAt: parsed?.date || envelope.date || null,
      size: Math.max(0, Number(message.size || source.length || 0)),
      flags: message.flags || [],
      modseq: message.modseq == null ? null : String(message.modseq),
      references: (Array.isArray(parsed?.references) ? parsed.references : [])
        .map((reference) => String(reference || '').trim().slice(0, 998))
        .filter(Boolean)
        .slice(-50),
      inReplyTo: String(parsed?.inReplyTo || '').trim(),
      rawHash,
      attachments: (parsed?.attachments || []).slice(0, 50).map((attachment) => ({
        filename: String(attachment?.filename || '').slice(0, 240),
        contentType: String(attachment?.contentType || '').slice(0, 120),
        contentDisposition: String(attachment?.contentDisposition || '').slice(0, 32),
        contentId: String(attachment?.contentId || '').slice(0, 240),
        size: Number(attachment?.size || attachment?.content?.length || 0)
      }))
    }
  } finally {
    // Attachments are intentionally neither persisted nor sent to AI. Clear
    // bounded buffers created by mailparser before releasing this message.
    for (const attachment of parsed?.attachments || []) {
      if (Buffer.isBuffer(attachment?.content)) attachment.content.fill(0)
    }
  }
}

async function notifyObserver(observer, method, payload, logger) {
  try { await observer?.[method]?.(payload) } catch (error) {
    logger?.warn?.({ err: error }, 'email ingest status could not be recorded')
  }
}

export function startEmailIngestScheduler({
  enabled,
  policy,
  poolInstance,
  runtimeConfig = config,
  logger,
  observer,
  ImapClient = ImapFlow,
  readSecretImpl = readOwnerSecretFile,
  assertHostImpl = assertSafeOutboundHost,
  wakeListenerFactory = startEmailWakeListener,
  timerApi = globalThis,
  clock = () => Date.now()
}) {
  if (!enabled) return async () => {}
  const validated = validateEmailIngestPolicy(policy)
  const sourceKey = validateImapConfig(runtimeConfig)
  let stopped = false
  let imap = null
  let reconcileImap = null
  let activeRun = null
  let timer = null
  let reconnectTimer = null
  let rerunRequested = false
  let stopWakeListener = null
  let primaryConnectionAttempted = false
  let reconcileConnectionAttempted = false
  const telemetry = createEmailIngestTelemetry({ sampleSize: validated.telemetrySampleSize })

  const scheduleSoon = (delay = 250) => {
    if (stopped || reconnectTimer) return
    reconnectTimer = timerApi.setTimeout(() => {
      reconnectTimer = null
      void run()
    }, delay)
    reconnectTimer?.unref?.()
  }

  const recordIdleEvent = () => poolInstance.query(
    `UPDATE email_accounts AS account
     SET last_idle_event_at = NOW(), updated_at = NOW()
     FROM users AS owner
     WHERE account.user_id = owner.id
       AND account.source_key = $1
       AND owner.username = $2`,
    [sourceKey, runtimeConfig.emailOwnerUsername]
  ).catch((error) => {
    logger?.warn?.(
      { errorCode: sanitizeMaintenanceErrorCode(error) },
      'IMAP IDLE event timestamp could not be recorded'
    )
  })

  const ensureConnected = async () => {
    if (imap?.usable) return imap
    try { imap?.close?.() } catch {}
    const startedAt = clock()
    const retry = primaryConnectionAttempted
    primaryConnectionAttempted = true
    await assertHostImpl(runtimeConfig.imapHost, { label: 'IMAP ' })
    const auth = await resolveImapAuth(runtimeConfig, { readSecretImpl })
    const client = new ImapClient({
      host: runtimeConfig.imapHost,
      port: Number(runtimeConfig.imapPort),
      secure: true,
      auth,
      qresync: true,
      disableAutoIdle: false,
      maxIdleTime: Math.max(60_000, validated.pollIntervalSeconds * 1000),
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      logger: false
    })
    client.on('exists', () => {
      void recordIdleEvent()
      scheduleSoon()
    })
    client.on('error', (error) => logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'IMAP connection error'))
    client.on('close', () => {
      if (imap === client) imap = null
      telemetry.recordDisconnect('primary')
      scheduleSoon(5_000)
    })
    try {
      await client.connect()
      telemetry.recordConnectionAttempt({
        connection: 'primary', durationMs: clock() - startedAt, succeeded: true, retry
      })
    } catch (error) {
      telemetry.recordConnectionAttempt({
        connection: 'primary', durationMs: clock() - startedAt, succeeded: false, retry
      })
      try { client.close?.() } catch {}
      throw error
    }
    imap = client
    return client
  }

  const ensureReconcileConnected = async () => {
    if (reconcileImap?.usable) return reconcileImap
    try { reconcileImap?.close?.() } catch {}
    const startedAt = clock()
    const retry = reconcileConnectionAttempted
    reconcileConnectionAttempted = true
    await assertHostImpl(runtimeConfig.imapHost, { label: 'IMAP ' })
    const auth = await resolveImapAuth(runtimeConfig, { readSecretImpl })
    const client = new ImapClient({
      host: runtimeConfig.imapHost,
      port: Number(runtimeConfig.imapPort),
      secure: true,
      auth,
      qresync: true,
      disableAutoIdle: true,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      logger: false
    })
    client.on('error', (error) => logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'IMAP reconciliation connection error'))
    client.on('close', () => {
      if (reconcileImap === client) reconcileImap = null
      telemetry.recordDisconnect('reconcile')
    })
    try {
      await client.connect()
      telemetry.recordConnectionAttempt({
        connection: 'reconcile', durationMs: clock() - startedAt, succeeded: true, retry
      })
    } catch (error) {
      telemetry.recordConnectionAttempt({
        connection: 'reconcile', durationMs: clock() - startedAt, succeeded: false, retry
      })
      try { client.close?.() } catch {}
      throw error
    }
    reconcileImap = client
    return client
  }

  const syncMailbox = async () => {
    const user = await poolInstance.query(
      `SELECT id FROM users WHERE username = $1 AND status = 'approved' LIMIT 1`,
      [runtimeConfig.emailOwnerUsername]
    )
    if (!user.rows[0]) throw new Error('Configured email owner user was not found')
    const userId = user.rows[0].id
    const client = await ensureConnected()
    const capabilities = capabilitiesOf(client)
    let listedFolders = []
    let folderCatalogSucceeded = false
    try {
      listedFolders = await client.list()
      folderCatalogSucceeded = true
    } catch (error) {
      logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'IMAP folder catalog could not be refreshed')
    }
    const catalogClient = await poolInstance.connect()
    let account
    try {
      await catalogClient.query('BEGIN')
      account = await upsertEmailAccount(catalogClient, {
        userId,
        sourceKey,
        label: '个人邮箱',
        capabilities
      })
      for (const listed of listedFolders) {
        await upsertEmailFolder(catalogClient, {
          accountId: account.id,
          userId,
          path: listed.path,
          delimiter: listed.delimiter || null,
          specialUse: listed.specialUse || null,
          selectable: !listed.flags?.has?.('\\Noselect'),
          subscribed: listed.subscribed !== false
        })
      }
      if (!listedFolders.some((listed) => listed.path === runtimeConfig.imapMailbox)) {
        await upsertEmailFolder(catalogClient, {
          accountId: account.id,
          userId,
          path: runtimeConfig.imapMailbox,
          specialUse: runtimeConfig.imapMailbox.toUpperCase() === 'INBOX' ? 'inbox' : null,
          selectable: true,
          subscribed: true
        })
      }
      if (folderCatalogSucceeded) {
        const currentPaths = [...new Set(listedFolders
          .map((listed) => String(listed?.path || '').normalize('NFKC').trim())
          .filter(Boolean))]
        // A successful LIST is authoritative for discoverability. Never apply
        // this on LIST failure, and never hide the explicitly configured
        // mailbox even if the upstream omitted it from the catalog response.
        await catalogClient.query(
          `UPDATE email_folders
           SET selectable = FALSE, subscribed = FALSE, updated_at = NOW()
           WHERE account_id = $1 AND user_id = $2
             AND path <> $3
             AND NOT (path = ANY($4::text[]))`,
          [account.id, userId, runtimeConfig.imapMailbox, currentPaths]
        )
      }
      await catalogClient.query('COMMIT')
    } catch (error) {
      await catalogClient.query('ROLLBACK')
      throw error
    } finally {
      catalogClient.release()
    }
    const syncStarted = await poolInstance.query(
      `UPDATE email_accounts
       SET last_sync_started_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING sync_request_generation`,
      [account.id, userId]
    )
    const syncRequestGeneration = Number(syncStarted.rows[0]?.sync_request_generation || 0)
    const lock = await client.getMailboxLock(runtimeConfig.imapMailbox)
    let messages
    let uidValidity
    let lastUid
    let candidateEndUid = null
    let currentFolder
    let initialSyncComplete = false
    let mailboxErrorCode = null
    let mailboxUidNext = null
    let mailboxHighestModseq = null
    try {
      uidValidity = String(client.mailbox?.uidValidity || '')
      const uidNext = Number(client.mailbox?.uidNext || 1)
      mailboxUidNext = uidNext
      mailboxHighestModseq = client.mailbox?.highestModseq || null
      const folderClient = await poolInstance.connect()
      try {
        await folderClient.query('BEGIN')
        currentFolder = await upsertEmailFolder(folderClient, {
          accountId: account.id,
          userId,
          path: runtimeConfig.imapMailbox,
          delimiter: client.mailbox?.delimiter || null,
          specialUse: runtimeConfig.imapMailbox.toUpperCase() === 'INBOX' ? 'inbox' : null,
          selectable: true,
          subscribed: true,
          uidValidity,
          uidNext,
          highestModseq: client.mailbox?.highestModseq || null,
          lastUid: 0
        })
        await folderClient.query('COMMIT')
      } catch (error) {
        await folderClient.query('ROLLBACK')
        throw error
      } finally {
        folderClient.release()
      }
      const locationState = await poolInstance.query(
        `SELECT folder.uid_validity, folder.last_uid, folder.initial_sync_complete,
                COUNT(location.id) FILTER (WHERE location.expunged_at IS NULL)::integer AS current_count
         FROM email_folders AS folder
         LEFT JOIN email_folder_messages AS location
           ON location.folder_id = folder.id AND location.user_id = folder.user_id
         WHERE folder.id = $1 AND folder.user_id = $2
         GROUP BY folder.id`,
        [currentFolder.id, userId]
      )
      const state = locationState.rows[0]
      const mailboxState = await poolInstance.query(
        `SELECT uid_validity, last_error_code
         FROM email_mailbox_state
         WHERE source_key = $1 AND user_id = $2
         LIMIT 1`,
        [sourceKey, userId]
      )
      const previousMailboxState = mailboxState.rows[0]
      mailboxErrorCode = previousMailboxState
        && String(previousMailboxState.uid_validity || '') === uidValidity
        ? previousMailboxState.last_error_code || null
        : null
      initialSyncComplete = Boolean(state?.initial_sync_complete)
      lastUid = Number(state?.last_uid || 0)
      if (!initialSyncComplete && Number(state?.current_count || 0) === 0) {
        try {
          const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
          const recentUids = (await client.search({ since }, { uid: true }))
            .map(Number)
            .filter((uid) => Number.isSafeInteger(uid) && uid > 0 && uid < uidNext)
            .sort((left, right) => left - right)
            .slice(-validated.initialLookback)
          lastUid = recentUids.length ? Math.max(0, recentUids[0] - 1) : Math.max(0, uidNext - 1)
        } catch (error) {
          logger?.warn?.({ errorCode: sanitizeMaintenanceErrorCode(error) }, 'IMAP 90-day backfill search failed; using bounded UID fallback')
          lastUid = Math.max(0, uidNext - validated.initialLookback - 1)
        }
        await poolInstance.query(
          `UPDATE email_folders
           SET last_uid = $2, initial_sync_complete = FALSE, updated_at = NOW()
           WHERE id = $1 AND user_id = $3`,
          [currentFolder.id, lastUid, userId]
        )
      }
      const startUid = Math.max(1, lastUid + 1)
      if (uidNext > 0 && startUid >= uidNext) messages = []
      else {
        const endUid = Math.min(uidNext - 1, startUid + validated.batchSize - 1)
        candidateEndUid = endUid
        messages = await client.fetchAll(
          `${startUid}:${endUid}`,
          { uid: true, envelope: true, internalDate: true, size: true, flags: true, modseq: true },
          { uid: true }
        )
      }
    } finally {
      lock.release()
    }

    const summary = {
      processed: 0,
      inserted: 0,
      duplicates: 0,
      classificationQueued: 0,
      remaining: 0,
      caughtUp: false,
      maxIngestLatencyMs: 0,
      batches: 1
    }
    const listedCurrent = listedFolders.find((folder) => folder.path === runtimeConfig.imapMailbox)
    let sourceBytes = 0
    let sourceBudgetExhausted = false
    const batchNotificationState = mailboxBatchNotificationState({ initialSyncComplete })

    const persistOptions = (message) => ({
      poolInstance,
      userId,
      sourceKey,
      accountLabel: '个人邮箱',
      capabilities,
      // Messages discovered while the folder is still performing its bounded
      // initial catch-up remain fully searchable/classified, but must not be
      // announced as newly arrived mail.
      notificationEligible: batchNotificationState.notificationEligible,
      folder: {
        path: runtimeConfig.imapMailbox,
        delimiter: listedCurrent?.delimiter || null,
        specialUse: listedCurrent?.specialUse || null,
        selectable: true,
        subscribed: listedCurrent?.subscribed !== false,
        uidValidity,
        uidNext: mailboxUidNext,
        highestModseq: mailboxHighestModseq
      },
      message
    })

    const writeMailboxState = async ({ uid, errorCode = null, messageAt = true }) => {
      lastUid = Math.max(lastUid, Number(uid || 0))
      mailboxErrorCode = errorCode
      await poolInstance.query(
        `INSERT INTO email_mailbox_state (
           source_key, user_id, uid_validity, last_uid,
           last_connected_at, last_message_at, last_error_at,
           last_error_code, updated_at
         ) VALUES (
           $1, $2, $3, $4, NOW(), CASE WHEN $5 THEN NOW() ELSE NULL END,
           CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END, $6, NOW()
         )
         ON CONFLICT (user_id, source_key) DO UPDATE SET
           uid_validity = EXCLUDED.uid_validity,
           last_uid = CASE
             WHEN email_mailbox_state.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
               THEN EXCLUDED.last_uid
             ELSE GREATEST(email_mailbox_state.last_uid, EXCLUDED.last_uid)
           END,
           last_connected_at = NOW(),
           last_message_at = CASE WHEN $5 THEN NOW() ELSE email_mailbox_state.last_message_at END,
           last_error_at = CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END,
           last_error_code = $6,
           updated_at = NOW()`,
        [sourceKey, userId, uidValidity, lastUid, Boolean(messageAt), errorCode]
      )
    }

    const recordMessageFailure = async (uid, errorCode) => {
      mailboxErrorCode = errorCode
      // The source-level retry identity is the durable gate. Persist it first;
      // the per-folder status is diagnostic and must not erase a successful
      // retry reservation if that secondary update is temporarily unavailable.
      await poolInstance.query(
        `INSERT INTO email_mailbox_state (
           source_key, user_id, uid_validity, last_uid, last_connected_at,
           last_error_at, last_error_code, updated_at
         ) VALUES ($1, $2, $3, $4, NOW(), NOW(), $5, NOW())
         ON CONFLICT (user_id, source_key) DO UPDATE SET
           last_connected_at = NOW(), last_error_at = NOW(),
           last_error_code = EXCLUDED.last_error_code, updated_at = NOW()`,
        [sourceKey, userId, uidValidity, lastUid, errorCode]
      )
      try {
        await poolInstance.query(
          `UPDATE email_folders
           SET last_error_at = NOW(), last_error_code = $3, updated_at = NOW()
           WHERE id = $1 AND user_id = $2`,
          [currentFolder.id, userId, errorCode]
        )
      } catch {
        logger?.warn?.({ uid: Number(uid), errorCode }, 'email folder failure status could not be recorded')
      }
      logger?.warn?.({ uid: Number(uid), errorCode }, 'email message processing deferred')
    }

    const markDeadLetter = async (stored) => {
      await poolInstance.query(
        `UPDATE email_folder_messages
         SET keywords = CASE
               WHEN keywords @> $3::jsonb THEN keywords
               ELSE keywords || $3::jsonb
             END,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [stored.location.id, userId, JSON.stringify([DEAD_LETTER_KEYWORD])]
      )
    }

    for (const message of messages.sort((left, right) => Number(left.uid) - Number(right.uid))) {
      const uid = Number(message.uid)
      let stored = null
      let parsed = null
      try {
        const declaredSize = Math.max(0, Number(message.size || 0))
        if (declaredSize <= validated.maxMessageBytes) {
          const fetchLimit = declaredSize > 0
            ? Math.min(validated.maxMessageBytes + 1, declaredSize + 1)
            : validated.maxMessageBytes + 1
          if (sourceBytes + fetchLimit > validated.maxBatchSourceBytes) {
            sourceBudgetExhausted = true
            break
          }
          const messageLock = await client.getMailboxLock(runtimeConfig.imapMailbox)
          try {
            const sourceMessage = await client.fetchOne(
              uid,
              { source: { start: 0, maxLength: fetchLimit } },
              { uid: true }
            )
            message.source = Buffer.isBuffer(sourceMessage?.source)
              ? sourceMessage.source
              : Buffer.from(sourceMessage?.source || [])
            sourceBytes += message.source.length
            message.sourceTruncated = message.source.length >= fetchLimit
          } finally {
            messageLock.release()
          }
        }

        try {
          parsed = await parseImapMessage(message, validated.maxMessageBytes)
          stored = await persistEmailMailboxMessage(persistOptions(parsed))
          summary.processed += 1
          if (stored.inserted) summary.inserted += 1
          else summary.duplicates += 1
          if (stored.classificationQueued) summary.classificationQueued += 1
          const internalTime = new Date(parsed.internalDate || parsed.receivedAt || 0).getTime()
          if (Number.isFinite(internalTime) && internalTime > 0) {
            summary.maxIngestLatencyMs = Math.max(0, summary.maxIngestLatencyMs, clock() - internalTime)
          }
          // Cursor progress is coupled only to the encrypted mailbox row and
          // its durable classification job, both committed in one transaction.
          // Slow AI and notification delivery can no longer block later UIDs.
          await writeMailboxState({ uid })
        } catch (error) {
          const failure = emailMessageFailureState({
            errorCode: mailboxErrorCode,
            uid,
            maxAttempts: validated.maxMessageAttempts
          })
          await recordMessageFailure(uid, failure.code)
          if (!failure.deadLetter) {
            const retryError = new Error('Email message processing will be retried')
            retryError.code = failure.code
            throw retryError
          }

          // A terminal message-level failure must remain visible without
          // retaining its raw source or leaking parser/provider details. If
          // the canonical cache was not written, persist an encrypted generic
          // placeholder based only on the IMAP envelope and bounded metadata.
          try {
            if (!stored) {
              const placeholder = await parseImapMessage(message, 0)
              placeholder.text = '[此邮件无法安全处理，已保留死信占位；请在原邮箱中查看。]'
              stored = await persistEmailMailboxMessage(persistOptions(placeholder))
            }
            await markDeadLetter(stored)
            summary.processed += 1
            if (stored.inserted) summary.inserted += 1
            else summary.duplicates += 1
            if (stored.classificationQueued) summary.classificationQueued += 1
            await writeMailboxState({ uid, errorCode: failure.code })
            logger?.warn?.({ uid, errorCode: failure.code }, 'email message moved to the encrypted dead-letter cache')
          } catch {
            // Do not skip the UID unless the encrypted placeholder/marker was
            // durably committed. Preserve the retry identity without exposing
            // the underlying parser, crypto, database or provider error.
            const deadLetterError = new Error('Email dead-letter persistence will be retried')
            deadLetterError.code = failure.code
            throw deadLetterError
          }
        }
      } finally {
        if (Buffer.isBuffer(message.source)) message.source.fill(0)
        message.source = null
        message.sourceTruncated = false
      }
    }

    if (!sourceBudgetExhausted && candidateEndUid != null) {
      lastUid = Math.max(lastUid, candidateEndUid)
    }
    const caughtUp = lastUid >= Math.max(0, Number(mailboxUidNext || 1) - 1)
    const completedNotificationState = mailboxBatchNotificationState({
      initialSyncComplete,
      caughtUp
    })
    summary.caughtUp = caughtUp
    summary.remaining = Math.max(0, Number(mailboxUidNext || 1) - 1 - lastUid)
    await poolInstance.query(
      `UPDATE email_folders
       SET last_uid = GREATEST(last_uid, $2),
           initial_sync_complete = CASE WHEN $3 THEN TRUE ELSE initial_sync_complete END,
           last_synced_at = NOW(),
           last_error_at = CASE WHEN $5::text IS NULL THEN NULL ELSE COALESCE(last_error_at, NOW()) END,
           last_error_code = $5,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $4`,
      [
        currentFolder.id,
        lastUid,
        completedNotificationState.nextInitialSyncComplete,
        userId,
        mailboxErrorCode
      ]
    )
    await writeMailboxState({ uid: lastUid, errorCode: mailboxErrorCode, messageAt: false })
    const completed = await poolInstance.query(
      `UPDATE email_accounts
       SET sync_completed_generation = CASE
             WHEN $4::boolean THEN GREATEST(sync_completed_generation, $3)
             ELSE sync_completed_generation
           END,
           last_sync_completed_at = CASE
             WHEN $4::boolean THEN NOW()
             ELSE last_sync_completed_at
           END,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING sync_request_generation, sync_completed_generation`,
      [account.id, userId, syncRequestGeneration, caughtUp]
    )
    summary.syncRequestPending = Number(completed.rows[0]?.sync_request_generation || 0)
      > Number(completed.rows[0]?.sync_completed_generation || 0)
    if (caughtUp && (
      validated.protocolReconciliationEnabled
      || validated.secondaryFolderSyncEnabled
    )) {
      const protocolClient = await ensureReconcileConnected()
      const reconciled = await syncDueEmailFolders({
        client: protocolClient,
        poolInstance,
        userId,
        sourceKey,
        primaryMailbox: runtimeConfig.imapMailbox,
        policy: validated,
        parseMessage: parseImapMessage,
        logger
      })
      Object.assign(summary, reconciled)
      summary.syncRequestPending = summary.syncRequestPending || reconciled.continueImmediately === true
    }
    return summary
  }

  const syncMailboxWithDrain = async () => {
    return drainEmailMailboxBatches({
      syncMailbox,
      policy: validated,
      clock
    })
  }

  const run = () => {
    if (stopped) return activeRun
    if (activeRun) {
      rerunRequested = true
      return activeRun
    }
    const startedAtMs = clock()
    let continueImmediately = false
    activeRun = syncMailboxWithDrain()
      .then(async (result) => {
        const finishedAtMs = clock()
        continueImmediately = result.continueImmediately === true
        telemetry.recordSync(Math.max(0, finishedAtMs - startedAtMs))
        Object.assign(result, telemetry.snapshot())
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
        const errorCode = sanitizeMaintenanceErrorCode(error)
        await Promise.allSettled([
          poolInstance.query(UPDATE_MAILBOX_FAILURE_STATE_SQL, [
            sourceKey,
            runtimeConfig.emailOwnerUsername,
            errorCode
          ]),
          poolInstance.query(
            `WITH affected_accounts AS (
               UPDATE email_accounts AS account
               SET last_error_at = NOW(), last_error_code = $3, updated_at = NOW()
               FROM users AS owner
               WHERE account.user_id = owner.id
                 AND account.source_key = $1
                 AND owner.username = $2
               RETURNING account.id, account.user_id
             )
             UPDATE email_folders AS folder
             SET last_error_at = NOW(), last_error_code = $3, updated_at = NOW()
             FROM affected_accounts AS account
             WHERE folder.account_id = account.id
               AND folder.user_id = account.user_id`,
            [sourceKey, runtimeConfig.emailOwnerUsername, errorCode]
          )
        ])
        await notifyObserver(observer, 'failed', {
          error,
          result: {},
          startedAt: new Date(startedAtMs),
          finishedAt: new Date(finishedAtMs),
          durationMs: Math.max(0, finishedAtMs - startedAtMs)
        }, logger)
        logger?.error?.({ errorCode }, 'email ingestion failed')
      })
      .finally(() => {
        activeRun = null
        if ((rerunRequested || continueImmediately) && !stopped) {
          rerunRequested = false
          scheduleSoon(100)
        }
      })
    return activeRun
  }

  timer = timerApi.setInterval(() => void run(), validated.pollIntervalSeconds * 1000)
  timer?.unref?.()
  stopWakeListener = wakeListenerFactory({
    poolInstance,
    channel: EMAIL_INGEST_WAKE_CHANNEL,
    logger,
    timerApi,
    onWake: (payload) => {
      if (payload.sourceKey !== sourceKey) return
      void run()
    }
  })
  void run()
  return async () => {
    stopped = true
    if (timer) timerApi.clearInterval(timer)
    if (reconnectTimer) timerApi.clearTimeout(reconnectTimer)
    await stopWakeListener?.()
    const activeClient = imap
    imap = null
    try { activeClient?.close?.() } catch {}
    const activeReconcileClient = reconcileImap
    reconcileImap = null
    try { activeReconcileClient?.close?.() } catch {}
    if (activeRun) await activeRun
    const client = imap
    imap = null
    try { await client?.logout?.() } catch { try { client?.close?.() } catch {} }
    const reconcileClient = reconcileImap
    reconcileImap = null
    try { await reconcileClient?.logout?.() } catch { try { reconcileClient?.close?.() } catch {} }
  }
}
