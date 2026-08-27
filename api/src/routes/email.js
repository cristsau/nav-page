import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { pool, query } from '../db/index.js'
import { getUserSettingValue } from '../lib/userSettings.js'
import { enforceAiRateLimit } from '../lib/aiRateLimit.js'
import { resolveChatProviderModel } from '../lib/aiModelCatalog.js'
import { AI_USAGE_FEATURES } from '../lib/aiUsage.js'
import { recordRuntimeAiUsageSafely } from '../lib/aiUsageRuntime.js'
import {
  EMAIL_AI_ACTIONS,
  runEmailAi,
  selectEmailAiProvider
} from '../lib/emailAi.js'
import { loadEmailEncryptionKey } from '../lib/emailCrypto.js'
import {
  createEmailDraft,
  getEmailDraftForUser,
  queueEmailDraft,
  refreshEmailDraftContentHash
} from '../lib/emailDrafts.js'
import {
  createDraftEmailAttachment,
  deleteDraftEmailAttachment,
  EMAIL_ATTACHMENT_LIMITS
} from '../lib/emailAttachmentStore.js'
import { getEmailEventForUser, getEmailNotificationDetails } from '../lib/emailEvents.js'
import { validateImapConfig } from '../lib/emailIngestScheduler.js'
import {
  decorateIncomingAttachmentMetadata,
  fetchIncomingAttachment,
  safeAttachmentDownloadName
} from '../lib/emailIncomingAttachments.js'
import { createEmailMailboxEventBroker } from '../lib/emailMailboxEventBroker.js'
import { createEmailSseConnectionLimiter, writeEmailSse } from '../lib/emailSse.js'
import {
  decryptStoredMailboxMessage,
  EMAIL_MAILBOX_CHANGE_CHANNEL
} from '../lib/emailMailboxStore.js'
import {
  EMAIL_MAILBOX_SEARCH_LIMITS,
  mailboxFilterSql,
  mailboxMessageMatchesQuery,
  normalizeMailboxFilter,
  normalizeMailboxSearchQuery
} from '../lib/emailMailboxSearch.js'
import {
  enqueueMail,
  normalizeEmailAddress,
  SMTP_DELIVERY_ERROR_CODES,
  verifiedMailConfigurationStatus
} from '../lib/mailOutbox.js'
import { readOwnerSecretFile } from '../lib/ownerSecretFile.js'
import { recordSecurityEventBestEffort } from '../lib/securityEvents.js'

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const EMAIL_STREAM_MAX_LIFETIME_MS = 5 * 60 * 1000
const EMAIL_STREAM_RETRY_AFTER_SECONDS = 5
const emailStreamConnectionLimiter = createEmailSseConnectionLimiter({ maxConnections: 3 })

function boundedLimit(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 40
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify([
    new Date(row.internal_date).toISOString(),
    String(row.location_id)
  ]), 'utf8').toString('base64url')
}

function decodeCursor(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new TypeError('Invalid email cursor')
  let parsed
  try { parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) } catch {
    throw new TypeError('Invalid email cursor')
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || !UUID_PATTERN.test(String(parsed[1] || ''))) {
    throw new TypeError('Invalid email cursor')
  }
  const date = new Date(parsed[0])
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid email cursor')
  return [date.toISOString(), String(parsed[1])]
}

function mapAddress(value) {
  return value && typeof value === 'object'
    ? { name: String(value.name || ''), address: String(value.address || '') }
    : { name: '', address: '' }
}

export function mapDraftDeliveryState(outboxStatus, sentStatus, {
  sentAppendEnabled = config.emailSentAppendEnabled === true,
  deliveryErrorCode = null
} = {}) {
  const normalizedDeliveryErrorCode = String(deliveryErrorCode || '').trim().toUpperCase()
  const deliveryStatus = normalizedDeliveryErrorCode === SMTP_DELIVERY_ERROR_CODES.ambiguous
    ? 'ambiguous'
    : normalizedDeliveryErrorCode === SMTP_DELIVERY_ERROR_CODES.partial
      ? 'partial'
      : ({
          pending: 'queued',
          sending: 'sending',
          sent: 'accepted',
          failed: 'failed',
          expired: 'failed'
      })[String(outboxStatus || '')] || 'queued'
  const mappedSentStatus = ({
    prepared: 'pending',
    pending: 'pending',
    appending: 'syncing',
    reconcile: 'reconciling',
    appended: 'synced',
    blocked: 'blocked',
    cancelled: 'failed',
    expired: 'failed'
  })[String(sentStatus || '')]
  const sentSyncStatus = mappedSentStatus
    || (!sentAppendEnabled
      ? 'disabled'
      : String(outboxStatus || '') === 'sent'
        ? 'unavailable'
        : 'pending')
  return { deliveryStatus, sentSyncStatus }
}

async function attachDraftDeliveryState(draft, userId) {
  if (!draft?.outboxId) {
    return { ...draft, deliveryStatus: draft?.status === 'failed' ? 'failed' : 'draft', sentSyncStatus: 'not-started' }
  }
  const { rows } = await query(
    `SELECT outbox.status AS outbox_status, outbox.last_error_code AS delivery_error_code,
            sent.status AS sent_status, sent.last_error_code AS sent_error_code,
            sent.smtp_accepted_at, sent.appended_at
     FROM mail_outbox AS outbox
     LEFT JOIN email_sent_append_jobs AS sent ON sent.outbox_id = outbox.id
     WHERE outbox.id = $1 AND outbox.user_id = $2
     LIMIT 1`,
    [draft.outboxId, userId]
  )
  if (!rows[0]) return { ...draft, deliveryStatus: 'unavailable', sentSyncStatus: 'unavailable' }
  return {
    ...draft,
    ...mapDraftDeliveryState(rows[0].outbox_status, rows[0].sent_status, {
      deliveryErrorCode: rows[0].delivery_error_code
    }),
    deliveryErrorCode: rows[0].delivery_error_code || null,
    sentSyncErrorCode: rows[0].sent_error_code || null,
    smtpAcceptedAt: rows[0].smtp_accepted_at || null,
    sentCopyAppendedAt: rows[0].appended_at || null
  }
}

async function getCanonicalMailboxRowForUser(messageId, userId) {
  if (!UUID_PATTERN.test(String(messageId || ''))) return null
  const { rows } = await query(
    `SELECT message.id AS message_id, message.account_id, message.user_id,
            account.source_key, message.envelope_encrypted,
            message.content_encrypted, message.received_at,
            message.has_attachments, message.attachment_count
     FROM email_messages AS message
     JOIN email_accounts AS account
       ON account.id = message.account_id AND account.user_id = message.user_id
     WHERE message.id = $1 AND message.user_id = $2
     LIMIT 1`,
    [messageId, userId]
  )
  return rows[0] || null
}

async function mapMailboxRow(row, { includeBody = false } = {}) {
  const { envelope, content } = await decryptStoredMailboxMessage(row, {
    userId: row.user_id,
    sourceKey: row.source_key
  })
  return {
    // A mailbox row is a folder location, not merely a canonical RFC message.
    // The same message can legitimately exist in multiple folders (and even
    // multiple UIDs), so the location is the stable UI/API identity.
    id: row.location_id,
    locationId: row.location_id,
    canonicalMessageId: row.message_id,
    folderId: row.folder_id,
    from: mapAddress(envelope.sender),
    to: Array.isArray(envelope.to) ? envelope.to.map(mapAddress) : [],
    cc: Array.isArray(envelope.cc) ? envelope.cc.map(mapAddress) : [],
    subject: String(envelope.subject || '(无主题)'),
    preview: String(content.text || '').slice(0, 320),
    body: includeBody ? String(content.text || '') : undefined,
    attachments: includeBody
      ? decorateIncomingAttachmentMetadata(content.attachments)
      : undefined,
    receivedAt: row.received_at,
    internalDate: row.internal_date,
    sizeBytes: Number(row.size_bytes || 0),
    hasAttachments: Boolean(row.has_attachments),
    attachmentCount: Number(row.attachment_count || 0),
    flags: {
      seen: Boolean(row.seen),
      answered: Boolean(row.answered),
      flagged: Boolean(row.flagged),
      draft: Boolean(row.draft),
      deleted: Boolean(row.deleted),
      keywords: Array.isArray(row.keywords) ? row.keywords : []
    }
  }
}

async function emailFeatureStatus({ includeTransportDetails = false } = {}) {
  let encryptionConfigured = false
  let imapConfigured = false
  try {
    const key = await loadEmailEncryptionKey(config, { bypassCache: true })
    key.fill(0)
    encryptionConfigured = true
  } catch {}
  try {
    validateImapConfig(config)
    await readOwnerSecretFile(config.imapPasswordFile, { label: 'IMAP password', maxBytes: 4096 })
    imapConfigured = true
  } catch {}
  const mailStatus = await verifiedMailConfigurationStatus()
  return {
    mail: includeTransportDetails
      ? mailStatus
      : {
          configured: mailStatus.configured,
          enabled: mailStatus.enabled,
          transport: mailStatus.transport
        },
    ingest: {
      enabled: config.emailIngestEnabled,
      configured: imapConfigured && encryptionConfigured,
      source: 'imap-tls',
      idle: null
    },
    digest: {
      enabled: config.emailDigestEnabled,
      hours: config.emailDigestHours,
      timeZone: config.emailDigestTimeZone
    },
    encryptionConfigured
  }
}

export default async function emailRoutes(fastify) {
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: EMAIL_ATTACHMENT_LIMITS.maximumSingleBytes },
    (_request, body, done) => done(null, body)
  )
  const mailboxEventBroker = createEmailMailboxEventBroker({
    poolInstance: pool,
    channel: EMAIL_MAILBOX_CHANGE_CHANNEL,
    logger: fastify.log
  })
  fastify.addHook('onClose', async () => mailboxEventBroker.close())

  fastify.get('/email/status', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const status = await emailFeatureStatus()
    const state = await query(
      `SELECT account.id AS account_id, account.source_key, account.capabilities,
              account.last_connected_at, account.last_error_at, account.last_error_code,
              MAX(folder.last_synced_at) AS last_message_at
       FROM email_accounts AS account
       LEFT JOIN email_folders AS folder
         ON folder.account_id = account.id AND folder.user_id = account.user_id
       WHERE account.user_id = $1
       GROUP BY account.id
       ORDER BY account.updated_at DESC LIMIT 1`,
      [request.currentUser.id]
    )
    const mailbox = state.rows[0] || null
    const capabilities = mailbox?.capabilities && typeof mailbox.capabilities === 'object'
      ? mailbox.capabilities
      : {}
    return {
      ...status,
      ingest: {
        ...status.ingest,
        idle: mailbox ? Boolean(capabilities.IDLE) : null,
        mode: mailbox ? (capabilities.IDLE ? 'idle' : 'poll') : 'pending'
      },
      mailbox
    }
  })

  fastify.get('/email/events', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const tier = Number(request.query?.tier || 0)
    if (tier && ![1, 2, 3].includes(tier)) {
      reply.code(400)
      return { error: 'Email tier is invalid' }
    }
    const limit = boundedLimit(request.query?.limit)
    const { rows } = await query(
      `SELECT id, tier, received_at
       FROM email_events
       WHERE user_id = $1 AND ($2::integer = 0 OR tier = $2)
       ORDER BY received_at DESC, id DESC LIMIT $3`,
      [request.currentUser.id, tier, limit]
    )
    const details = await getEmailNotificationDetails(
      request.currentUser.id,
      rows.map((row) => row.id)
    )
    return { emails: rows.map((row) => details.get(String(row.id))).filter(Boolean) }
  })

  fastify.get('/email/events/:emailEventId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const id = String(request.params.emailEventId || '')
    if (!UUID_PATTERN.test(id)) {
      reply.code(400)
      return { error: 'Invalid email event id' }
    }
    const email = await getEmailEventForUser(request.currentUser.id, id)
    if (!email) {
      reply.code(404)
      return { error: 'Email event not found' }
    }
    return { email }
  })

  fastify.get('/email/accounts', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const { rows } = await query(
      `SELECT account.id, account.source_key, account.label, account.enabled,
              account.capabilities, account.last_connected_at, account.last_error_at,
              account.last_error_code, account.updated_at,
              COUNT(DISTINCT location.message_id) FILTER (WHERE location.expunged_at IS NULL)::integer AS message_count,
              COUNT(DISTINCT location.message_id) FILTER (WHERE location.expunged_at IS NULL AND location.seen = FALSE)::integer AS unread_count
       FROM email_accounts AS account
       LEFT JOIN email_folder_messages AS location
         ON location.account_id = account.id AND location.user_id = account.user_id
       WHERE account.user_id = $1
       GROUP BY account.id
       ORDER BY account.enabled DESC, account.created_at ASC, account.id ASC`,
      [request.currentUser.id]
    )
    return {
      accounts: rows.map((row) => ({
        id: row.id,
        sourceKey: row.source_key,
        label: row.label,
        enabled: row.enabled,
        capabilities: row.capabilities || {},
        syncState: row.last_error_at ? 'error' : row.last_connected_at ? 'connected' : 'pending',
        lastConnectedAt: row.last_connected_at,
        lastErrorCode: row.last_error_code,
        messageCount: Number(row.message_count || 0),
        unreadCount: Number(row.unread_count || 0),
        revision: row.updated_at
      })),
      defaultAccountId: rows.find((row) => row.enabled)?.id || rows[0]?.id || null
    }
  })

  fastify.get('/email/accounts/:accountId/folders', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const accountId = String(request.params.accountId || '')
    if (!UUID_PATTERN.test(accountId)) {
      reply.code(400)
      return { error: 'Invalid email account id' }
    }
    const { rows } = await query(
      `SELECT folder.id, folder.path, folder.special_use, folder.selectable,
              folder.subscribed, folder.initial_sync_complete, folder.last_synced_at,
              folder.last_error_at, folder.last_error_code, folder.updated_at,
              COUNT(location.id) FILTER (WHERE location.expunged_at IS NULL)::integer AS message_count,
              COUNT(location.id) FILTER (WHERE location.expunged_at IS NULL AND location.seen = FALSE)::integer AS unread_count
       FROM email_folders AS folder
       LEFT JOIN email_folder_messages AS location
         ON location.folder_id = folder.id AND location.user_id = folder.user_id
       WHERE folder.account_id = $1 AND folder.user_id = $2
         AND folder.selectable = TRUE
         AND folder.last_synced_at IS NOT NULL
       GROUP BY folder.id
       ORDER BY
         CASE folder.special_use
           WHEN 'inbox' THEN 0 WHEN 'flagged' THEN 1 WHEN 'sent' THEN 2
           WHEN 'drafts' THEN 3 WHEN 'archive' THEN 4 WHEN 'trash' THEN 8 WHEN 'junk' THEN 9 ELSE 6
         END,
         folder.path ASC`,
      [accountId, request.currentUser.id]
    )
    if (!rows.length) {
      const account = await query('SELECT 1 FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, request.currentUser.id])
      if (!account.rowCount) {
        reply.code(404)
        return { error: 'Email account not found' }
      }
    }
    return {
      folders: rows.map((row) => ({
        id: row.id,
        name: row.path,
        specialUse: row.special_use,
        selectable: row.selectable,
        subscribed: row.subscribed,
        messageCount: Number(row.message_count || 0),
        unreadCount: Number(row.unread_count || 0),
        syncState: row.last_error_at ? 'error' : row.initial_sync_complete ? 'ready' : 'syncing',
        lastSyncedAt: row.last_synced_at,
        lastErrorCode: row.last_error_code
      })),
      revision: rows.reduce((latest, row) => {
        const value = new Date(row.updated_at || 0).getTime()
        return value > latest ? value : latest
      }, 0)
    }
  })

  fastify.get('/email/accounts/:accountId/messages', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const accountId = String(request.params.accountId || '')
    const folderId = String(request.query?.folderId || '')
    if (!UUID_PATTERN.test(accountId) || !UUID_PATTERN.test(folderId)) {
      reply.code(400)
      return { error: 'Invalid email account or folder id' }
    }
    let cursor
    try { cursor = decodeCursor(request.query?.cursor) } catch (error) {
      reply.code(400)
      return { error: error.message }
    }
    const limit = boundedLimit(request.query?.limit)
    let searchQuery
    let filter
    try {
      searchQuery = normalizeMailboxSearchQuery(request.query?.q)
      filter = normalizeMailboxFilter(request.query?.filter)
    } catch (error) {
      reply.code(400)
      return { error: error.message }
    }
    const filterSql = mailboxFilterSql(filter)
    async function loadCandidateRows(batchCursor, batchLimit) {
      const { rows } = await query(
        `SELECT message.id AS message_id, message.user_id, account.source_key,
               message.envelope_encrypted, message.content_encrypted,
               message.received_at, message.has_attachments, message.attachment_count,
               location.id AS location_id, location.folder_id, location.internal_date,
              location.size_bytes, location.seen, location.answered, location.flagged,
              location.draft, location.deleted, location.keywords, location.updated_at
       FROM email_folder_messages AS location
       JOIN email_messages AS message
         ON message.id = location.message_id
        AND message.account_id = location.account_id
        AND message.user_id = location.user_id
        JOIN email_accounts AS account
          ON account.id = location.account_id AND account.user_id = location.user_id
        WHERE location.account_id = $1 AND location.folder_id = $2
          AND location.user_id = $3 AND location.expunged_at IS NULL
          ${filterSql}
          AND ($4::timestamptz IS NULL OR (location.internal_date, location.id) < ($4::timestamptz, $5::uuid))
        ORDER BY location.internal_date DESC, location.id DESC
        LIMIT $6`,
        [
          accountId,
          folderId,
          request.currentUser.id,
          batchCursor?.[0] || null,
          batchCursor?.[1] || null,
          batchLimit + 1
        ]
      )
      return rows
    }

    const matched = []
    let lastScannedRow = null
    let scannedCount = 0
    let hasScanOverflow = false
    let batchCursor = cursor
    do {
      const remainingScanRows = searchQuery
        ? EMAIL_MAILBOX_SEARCH_LIMITS.scanRows - scannedCount
        : limit
      const batchLimit = searchQuery
        ? Math.min(EMAIL_MAILBOX_SEARCH_LIMITS.scanBatchRows, remainingScanRows)
        : remainingScanRows
      const rows = await loadCandidateRows(batchCursor, batchLimit)
      const scanRows = rows.slice(0, batchLimit)
      hasScanOverflow = rows.length > scanRows.length
      for (const row of scanRows) {
        lastScannedRow = row
        scannedCount += 1
        try {
          const message = await mapMailboxRow(row)
          if (!searchQuery || mailboxMessageMatchesQuery(message, searchQuery)) {
            matched.push({ row, message })
            if (searchQuery && matched.length > limit) break
          }
        } catch {
          if (!searchQuery) {
            matched.push({
              row,
              message: {
                id: row.location_id,
                locationId: row.location_id,
                canonicalMessageId: row.message_id,
                folderId: row.folder_id,
                subject: '邮件内容暂时无法解密',
                preview: '请检查服务器邮件加密密钥。',
                receivedAt: row.received_at,
                internalDate: row.internal_date,
                flags: { seen: Boolean(row.seen), flagged: Boolean(row.flagged) },
                unavailable: true
              }
            })
          }
        }
      }
      if (!searchQuery || matched.length > limit || !hasScanOverflow || !lastScannedRow) break
      batchCursor = [new Date(lastScannedRow.internal_date).toISOString(), String(lastScannedRow.location_id)]
    } while (scannedCount < EMAIL_MAILBOX_SEARCH_LIMITS.scanRows)

    const page = matched.slice(0, limit)
    const messages = []
    for (const entry of page) messages.push(entry.message)
    const hasMatchedOverflow = matched.length > limit
    const hasMore = hasMatchedOverflow || hasScanOverflow
    const cursorRow = hasMatchedOverflow
      ? page[page.length - 1]?.row
      : hasScanOverflow
        ? lastScannedRow
        : null
    return {
      messages,
      hasMore,
      nextCursor: hasMore && cursorRow ? encodeCursor(cursorRow) : null,
      revision: page.reduce((latest, entry) => Math.max(
        latest,
        new Date(entry.row.updated_at || 0).getTime() || 0
      ), 0),
      search: {
        query: searchQuery,
        filter,
        scanned: scannedCount,
        capped: searchQuery && hasScanOverflow && !hasMatchedOverflow
      }
    }
  })

  fastify.get('/email/accounts/:accountId/messages/:locationId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const accountId = String(request.params.accountId || '')
    const locationId = String(request.params.locationId || '')
    const folderId = String(request.query?.folderId || '')
    if (![accountId, locationId, folderId].every((value) => UUID_PATTERN.test(value))) {
      reply.code(400)
      return { error: 'Invalid email message identity' }
    }
    const { rows } = await query(
      `SELECT message.id AS message_id, message.user_id, account.source_key,
              message.envelope_encrypted, message.content_encrypted,
              message.received_at, message.has_attachments, message.attachment_count,
              location.id AS location_id, location.folder_id, location.internal_date,
              location.size_bytes, location.seen, location.answered, location.flagged,
              location.draft, location.deleted, location.keywords
       FROM email_messages AS message
       JOIN email_accounts AS account
         ON account.id = message.account_id AND account.user_id = message.user_id
       JOIN email_folder_messages AS location
         ON location.message_id = message.id
        AND location.account_id = message.account_id
        AND location.user_id = message.user_id
       WHERE location.id = $1 AND location.account_id = $2 AND location.user_id = $3
         AND location.folder_id = $4 AND location.expunged_at IS NULL
       LIMIT 1`,
      [locationId, accountId, request.currentUser.id, folderId]
    )
    if (!rows[0]) {
      reply.code(404)
      return { error: 'Email message not found' }
    }
    try { return { message: await mapMailboxRow(rows[0], { includeBody: true }) } } catch {
      reply.code(503)
      return { error: 'Email content could not be decrypted' }
    }
  })

  fastify.get('/email/accounts/:accountId/messages/:locationId/attachments/:attachmentId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const accountId = String(request.params.accountId || '')
    const locationId = String(request.params.locationId || '')
    const attachmentId = String(request.params.attachmentId || '')
    const folderId = String(request.query?.folderId || '')
    if (![accountId, locationId, folderId].every((value) => UUID_PATTERN.test(value))
      || !/^[0-9a-f]{32}$/i.test(attachmentId)) {
      reply.code(400)
      return { error: 'Invalid email attachment identity' }
    }
    const { rows } = await query(
      `SELECT folder.path AS folder_path, location.uid_validity, location.uid,
              location.size_bytes
       FROM email_folder_messages AS location
       JOIN email_folders AS folder
         ON folder.id = location.folder_id
        AND folder.account_id = location.account_id
        AND folder.user_id = location.user_id
       WHERE location.id = $1 AND location.account_id = $2
         AND location.user_id = $3 AND location.folder_id = $4
         AND location.expunged_at IS NULL
       LIMIT 1`,
      [locationId, accountId, request.currentUser.id, folderId]
    )
    if (!rows[0]) {
      reply.code(404)
      return { error: 'Email attachment location not found' }
    }
    try {
      const attachment = await fetchIncomingAttachment(rows[0], attachmentId)
      const filename = safeAttachmentDownloadName(attachment.filename)
      const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(attachment.contentType)
        ? attachment.contentType
        : 'application/octet-stream'
      reply.header('Content-Type', contentType)
      reply.header('Content-Length', String(attachment.content.length))
      reply.header('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(filename)}`)
      reply.header('Content-Security-Policy', 'sandbox')
      reply.header('Cross-Origin-Resource-Policy', 'same-origin')
      reply.header('X-Content-Type-Options', 'nosniff')
      return reply.send(attachment.content)
    } catch (error) {
      const code = String(error?.code || '')
      if (code === 'EMAIL_ATTACHMENT_NOT_FOUND') reply.code(404)
      else if (code === 'EMAIL_UIDVALIDITY_CHANGED') reply.code(409)
      else if (code === 'EMAIL_SOURCE_TOO_LARGE' || code === 'EMAIL_ATTACHMENT_TOO_LARGE') reply.code(413)
      else reply.code(503)
      return { error: code || 'Email attachment could not be downloaded' }
    }
  })

  fastify.post('/email/messages/:messageId/ai', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const messageId = String(request.params.messageId || '')
    const action = String(request.body?.action || '').trim().toLowerCase()
    if (!UUID_PATTERN.test(messageId) || !Object.hasOwn(EMAIL_AI_ACTIONS, action)) {
      reply.code(400)
      return { error: 'Invalid email AI request' }
    }
    const rateLimited = await enforceAiRateLimit(request, reply, {
      deniedError: '邮件 AI 请求过于频繁，请稍后再试'
    })
    if (rateLimited) return rateLimited

    const row = await getCanonicalMailboxRowForUser(messageId, request.currentUser.id)
    if (!row) {
      reply.code(404)
      return { error: 'Email message not found' }
    }
    let stored
    try {
      stored = await decryptStoredMailboxMessage(row, {
        userId: row.user_id,
        sourceKey: row.source_key
      })
    } catch {
      reply.code(503)
      return { error: 'Email content could not be decrypted' }
    }

    const appConfig = await getUserSettingValue(request.currentUser.id, 'appConfig', {})
    const startedAt = Date.now()
    let provider = null
    try {
      const resolution = await resolveChatProviderModel(
        appConfig?.search?.providers?.chatgpt || {}
      )
      provider = selectEmailAiProvider({ chatgpt: resolution.provider })
      if (!provider) {
        reply.code(503)
        return { error: '请先在设置中启用 ChatGPT / OpenAI' }
      }
      const result = await runEmailAi(provider, {
        action,
        subject: stored.envelope.subject,
        sender: stored.envelope.sender?.address || stored.envelope.sender?.name,
        to: stored.envelope.to,
        cc: stored.envelope.cc,
        receivedAt: row.received_at,
        text: stored.content.text,
        userInstruction: request.body?.instruction,
        targetLanguage: request.body?.language
      }, request.currentUser.id)
      await recordRuntimeAiUsageSafely({
        userId: request.currentUser.id,
        feature: AI_USAGE_FEATURES.EMAIL_ASSIST,
        provider: result.provider,
        model: result.model,
        apiMode: result.apiMode,
        success: true,
        usage: result.usage,
        latencyMs: result.latencyMs
      }, request.log)
      const {
        usage: _usage,
        apiMode: _apiMode,
        latencyMs: _latencyMs,
        ...publicResult
      } = result
      return { result: publicResult }
    } catch (error) {
      await recordRuntimeAiUsageSafely({
        userId: request.currentUser.id,
        feature: AI_USAGE_FEATURES.EMAIL_ASSIST,
        provider: provider?.id || 'chatgpt',
        model: provider?.config?.model || 'unknown',
        apiMode: provider?.config?.apiMode || 'unknown',
        success: false,
        usage: null,
        latencyMs: Math.max(0, Date.now() - startedAt)
      }, request.log)
      reply.code(502)
      return { error: error.message || '邮件 AI 执行失败' }
    }
  })

  fastify.post('/email/drafts', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const accountId = String(request.body?.accountId || '')
    const sourceMessageId = request.body?.sourceMessageId
      ? String(request.body.sourceMessageId)
      : null
    if (!UUID_PATTERN.test(accountId) || (sourceMessageId && !UUID_PATTERN.test(sourceMessageId))) {
      reply.code(400)
      return { error: 'Invalid email draft identity' }
    }
    let replyHeaders = null
    if (sourceMessageId) {
      const source = await getCanonicalMailboxRowForUser(sourceMessageId, request.currentUser.id)
      if (!source || String(source.account_id) !== accountId) {
        reply.code(404)
        return { error: 'Source email message not found' }
      }
      try {
        const { envelope } = await decryptStoredMailboxMessage(source, {
          userId: source.user_id,
          sourceKey: source.source_key
        })
        replyHeaders = {
          inReplyTo: envelope.messageId || '',
          references: [
            ...(Array.isArray(envelope.references) ? envelope.references : []),
            ...(envelope.messageId ? [envelope.messageId] : [])
          ]
        }
      } catch {
        reply.code(503)
        return { error: 'Source email headers could not be decrypted' }
      }
    }
    try {
      const draft = await createEmailDraft({
        userId: request.currentUser.id,
        accountId,
        sourceMessageId,
        // Reply threading headers are trusted only when decrypted from the
        // owned source message above. Never accept client-supplied Message-ID
        // or References values.
        payload: {
          to: request.body?.to,
          cc: request.body?.cc,
          bcc: request.body?.bcc,
          subject: request.body?.subject,
          text: request.body?.text
        },
        replyHeaders
      })
      await recordSecurityEventBestEffort({
        request,
        eventType: 'email.draft.create',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'email_draft',
        resourceId: draft.id,
        affectedCount: 1
      }, request.log)
      reply.code(201)
      return { draft: await attachDraftDeliveryState(draft, request.currentUser.id) }
    } catch (error) {
      reply.code(error instanceof TypeError ? 400 : 409)
      return { error: error.message || 'Email draft could not be saved' }
    }
  })

  fastify.get('/email/drafts/:draftId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const draftId = String(request.params.draftId || '')
    if (!UUID_PATTERN.test(draftId)) {
      reply.code(400)
      return { error: 'Invalid email draft id' }
    }
    try {
      const draft = await getEmailDraftForUser(request.currentUser.id, draftId)
      if (!draft) {
        reply.code(404)
        return { error: 'Email draft not found' }
      }
      return { draft: await attachDraftDeliveryState(draft, request.currentUser.id) }
    } catch {
      reply.code(503)
      return { error: 'Email draft could not be decrypted' }
    }
  })

  fastify.post('/email/drafts/:draftId/attachments', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const draftId = String(request.params.draftId || '')
    if (!UUID_PATTERN.test(draftId) || !Buffer.isBuffer(request.body) || !request.body.length) {
      reply.code(400)
      return { error: 'Invalid email attachment upload' }
    }
    let createdAttachment = null
    try {
      createdAttachment = await createDraftEmailAttachment({
        userId: request.currentUser.id,
        draftId,
        metadata: {
          filename: request.query?.filename,
          contentType: request.query?.contentType || 'application/octet-stream',
          disposition: 'attachment'
        },
        content: request.body
      })
      let draft
      try {
        draft = await refreshEmailDraftContentHash({
          userId: request.currentUser.id,
          draftId
        })
      } catch (error) {
        try {
          await deleteDraftEmailAttachment({
            userId: request.currentUser.id,
            draftId,
            attachmentId: createdAttachment.id
          })
        } catch {}
        throw error
      }
      reply.code(201)
      return { draft }
    } catch (error) {
      const statusCode = Number(error?.statusCode)
      reply.code(Number.isSafeInteger(statusCode) ? statusCode : (error instanceof TypeError ? 400 : 409))
      return { error: error?.code || error?.message || 'Email attachment could not be uploaded' }
    } finally {
      request.body.fill(0)
    }
  })

  fastify.delete('/email/drafts/:draftId/attachments/:attachmentId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const draftId = String(request.params.draftId || '')
    const attachmentId = String(request.params.attachmentId || '')
    if (![draftId, attachmentId].every((value) => UUID_PATTERN.test(value))) {
      reply.code(400)
      return { error: 'Invalid email attachment identity' }
    }
    try {
      await deleteDraftEmailAttachment({
        userId: request.currentUser.id,
        draftId,
        attachmentId
      })
      const draft = await refreshEmailDraftContentHash({
        userId: request.currentUser.id,
        draftId
      })
      return { draft }
    } catch (error) {
      const statusCode = Number(error?.statusCode)
      reply.code(Number.isSafeInteger(statusCode) ? statusCode : (error instanceof TypeError ? 400 : 409))
      return { error: error?.code || error?.message || 'Email attachment could not be removed' }
    }
  })

  fastify.post('/email/drafts/:draftId/send', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const draftId = String(request.params.draftId || '')
    if (!UUID_PATTERN.test(draftId)) {
      reply.code(400)
      return { error: 'Invalid email draft id' }
    }
    const mailStatus = await verifiedMailConfigurationStatus()
    if (!mailStatus.configured || !mailStatus.enabled) {
      reply.code(503)
      return { error: 'Mail delivery is not configured and enabled' }
    }
    try {
      const draft = await queueEmailDraft({
        userId: request.currentUser.id,
        draftId,
        contentHash: request.body?.contentHash,
        confirmed: request.body?.confirm
      })
      await recordSecurityEventBestEffort({
        request,
        eventType: 'email.send.queued',
        outcome: 'success',
        actorUserId: request.currentUser.id,
        subjectUserId: request.currentUser.id,
        resourceType: 'email_draft',
        resourceId: draft.id,
        affectedCount: 1
      }, request.log)
      reply.code(202)
      return {
        queued: true,
        draft: await attachDraftDeliveryState(draft, request.currentUser.id)
      }
    } catch (error) {
      reply.code(error instanceof TypeError ? 400 : 409)
      return { error: error.message || 'Email could not be queued' }
    }
  })

  fastify.get('/email/stream', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const accountId = String(request.query?.accountId || '')
    if (!UUID_PATTERN.test(accountId)) {
      reply.code(400)
      return { error: 'Invalid email account id' }
    }
    const owned = await query('SELECT 1 FROM email_accounts WHERE id = $1 AND user_id = $2', [accountId, request.currentUser.id])
    if (!owned.rowCount) {
      reply.code(404)
      return { error: 'Email account not found' }
    }
    const releaseStreamSlot = emailStreamConnectionLimiter.acquire({
      userId: request.currentUser.id,
      accountId
    })
    if (!releaseStreamSlot) {
      reply.header('Retry-After', String(EMAIL_STREAM_RETRY_AFTER_SECONDS))
      reply.code(429)
      return { error: 'Too many active email streams for this account' }
    }
    let heartbeat = null
    let lifetime = null
    let unsubscribe = null
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      if (lifetime) clearTimeout(lifetime)
      unsubscribe?.()
      unsubscribe = null
      releaseStreamSlot()
    }
    // Register cleanup before the shared LISTEN connection is started so an
    // early client disconnect cannot leak its per-account connection slot.
    reply.raw.once('close', close)
    try {
      await mailboxEventBroker.start()
    } catch (error) {
      close()
      throw error
    }
    if (closed || reply.raw.destroyed) return
    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    reply.raw.setHeader('Cache-Control', 'private, no-store, no-transform')
    reply.raw.setHeader('Connection', 'keep-alive')
    reply.raw.setHeader('X-Accel-Buffering', 'no')
    reply.raw.flushHeaders?.()
    const onMailboxEvent = (payload) => {
      if (String(payload.userId) !== String(request.currentUser.id) || String(payload.accountId) !== accountId) return
      const written = writeEmailSse(reply.raw, 'mail.changed', {
        accountId,
        folderId: payload.folderId,
        locationId: payload.locationId,
        canonicalMessageId: payload.messageId,
        revision: payload.revision
      }, `${payload.revision || Date.now()}:${payload.locationId || ''}`)
      if (!written) close()
    }
    const onBrokerError = (error) => {
      if (!reply.raw.destroyed) reply.raw.destroy(error)
      close()
    }
    unsubscribe = mailboxEventBroker.subscribe({
      onEvent: onMailboxEvent,
      onError: onBrokerError
    })
    heartbeat = setInterval(() => {
      if (!writeEmailSse(reply.raw, 'heartbeat', { at: new Date().toISOString() })) close()
    }, 20_000)
    heartbeat.unref?.()
    // Re-authenticate periodically so a revoked session cannot retain an
    // indefinite metadata stream. The client reconnects and runs requireAuth.
    lifetime = setTimeout(() => {
      writeEmailSse(reply.raw, 'reauth', { reconnect: true })
      reply.raw.end()
      close()
    }, EMAIL_STREAM_MAX_LIFETIME_MS)
    lifetime.unref?.()
    if (!writeEmailSse(reply.raw, 'ready', { accountId, reset: true })) close()
  })

  fastify.get('/admin/mail/status', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    return emailFeatureStatus({ includeTransportDetails: true })
  })

  fastify.post('/admin/mail/test', async (request, reply) => {
    await fastify.requireAdmin(request, reply)
    reply.header('Cache-Control', 'private, no-store')

    const mailStatus = await verifiedMailConfigurationStatus()
    if (!mailStatus.configured || !mailStatus.enabled) {
      reply.code(503)
      return { error: 'Mail delivery is not configured and enabled' }
    }

    let recipient
    try {
      recipient = normalizeEmailAddress(request.body?.recipient)
    } catch (error) {
      reply.code(400)
      return { error: error.message }
    }

    const origin = String(config.publicAppOrigin || 'https://nav.skrskr.net').replace(/\/$/, '')
    const queued = await enqueueMail({
      messageType: 'system.test',
      recipient,
      subject: 'DOMO NAV 邮件通道测试',
      textBody: `这是 DOMO NAV 的 SMTP 通道测试邮件。\n\n收到这封邮件说明发件队列与 SMTP 通道工作正常。\n${origin}`,
      htmlBody: `<p>这是 DOMO NAV 的 SMTP 通道测试邮件。</p><p>收到这封邮件说明发件队列与 SMTP 通道工作正常。</p><p><a href="${origin}">打开 DOMO NAV</a></p>`,
      dedupeKey: `system-test:${request.currentUser.id}:${randomUUID()}`,
      sensitive: true
    })

    await recordSecurityEventBestEffort({
      request,
      eventType: 'admin.mail.test',
      outcome: 'success',
      actorUserId: request.currentUser.id,
      subjectUserId: request.currentUser.id,
      resourceType: 'mail_outbox',
      resourceId: queued.id,
      affectedCount: 1
    }, request.log)

    reply.code(202)
    return { queued: true, id: queued.id, status: queued.status }
  })
}
