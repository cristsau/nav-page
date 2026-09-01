import { createHash } from 'node:crypto'
import { decryptEmailPayload, encryptEmailPayload } from './emailCrypto.js'
import { decorateIncomingAttachmentMetadata } from './emailIncomingAttachmentMetadata.js'
import {
  EMAIL_CLASSIFICATION_WAKE_CHANNEL,
  notifyEmailWake
} from './emailIngestWake.js'

export const EMAIL_MAILBOX_CHANGE_CHANNEL = 'nav_email_mailbox_changes'

const SOURCE_KEY_PATTERN = /^[a-z0-9_.-]{1,80}$/
const UINT32_MAX = 4_294_967_295n
const UINT64_MAX = 18_446_744_073_709_551_615n
const SPECIAL_USES = new Set([
  'inbox',
  'sent',
  'drafts',
  'trash',
  'junk',
  'archive',
  'all',
  'important',
  'flagged'
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function boundedText(value, maximum) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maximum)
}

function boundedBodyText(value, maximum) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maximum)
}

function nonNegativeSafeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

function unsignedIntegerString(value, {
  label,
  maximum,
  allowNull = false,
  allowZero = false
}) {
  if (value == null || String(value).trim() === '') {
    if (allowNull) return null
    throw new TypeError(`${label} is required`)
  }
  const raw = String(value).trim()
  if (!/^\d+$/.test(raw)) throw new TypeError(`${label} is invalid`)
  const parsed = BigInt(raw)
  const minimum = allowZero ? 0n : 1n
  if (parsed < minimum || parsed > maximum) throw new TypeError(`${label} is invalid`)
  return parsed.toString()
}

function normalizedSourceKey(value) {
  const sourceKey = boundedText(value, 80).toLowerCase()
  if (!SOURCE_KEY_PATTERN.test(sourceKey)) throw new TypeError('Email source key is invalid')
  return sourceKey
}

function normalizedFolderPath(value) {
  const path = boundedText(value, 512)
  if (!path) throw new TypeError('Email folder path is invalid')
  return path
}

function normalizedSpecialUse(value, path) {
  const raw = boundedText(value, 32).toLowerCase().replace(/^\\/, '')
  if (SPECIAL_USES.has(raw)) return raw
  return String(path || '').toUpperCase() === 'INBOX' ? 'inbox' : null
}

function normalizedAddress(address = {}) {
  return {
    name: boundedText(address.name, 320),
    address: boundedText(address.address, 320).toLowerCase()
  }
}

function normalizedAddressList(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizedAddress)
    .filter((entry) => entry.address)
    .slice(0, 100)
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

function safeDate(value, fallback = new Date()) {
  const date = new Date(value || fallback)
  return Number.isNaN(date.getTime()) ? fallback : date
}

function normalizedCapabilities(value) {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : []
  return [...new Set(values
    .map((item) => boundedText(item, 64).toUpperCase())
    .filter((item) => /^(?:IDLE|CONDSTORE|QRESYNC|MOVE|UIDPLUS|SPECIAL-USE)$/.test(item)))]
    .sort()
}

export function emailMailboxEncryptionContext(userId, sourceKey) {
  return `${String(userId || '')}:${normalizedSourceKey(sourceKey)}:mailbox-v1`
}

export function buildCanonicalMailboxMessage(raw = {}) {
  const messageId = boundedText(raw.messageId, 998).toLowerCase()
  const rawHash = /^[0-9a-f]{64}$/i.test(String(raw.rawHash || ''))
    ? String(raw.rawHash).toLowerCase()
    : ''
  const receivedAt = safeDate(raw.receivedAt || raw.internalDate)
  const sender = normalizedAddress(raw.sender)
  const to = normalizedAddressList(raw.to)
  const cc = normalizedAddressList(raw.cc)
  const bcc = normalizedAddressList(raw.bcc)
  const subject = boundedText(raw.subject || '(无主题)', 500)
  const text = boundedBodyText(raw.text, 300_000)
  const sentAt = raw.sentAt ? safeDate(raw.sentAt) : null
  const references = (Array.isArray(raw.references) ? raw.references : [])
    .map((value) => boundedText(value, 998).toLowerCase())
    .filter(Boolean)
    .slice(-100)
  const inReplyTo = boundedText(raw.inReplyTo, 998).toLowerCase()
  const fallbackFingerprint = [
    messageId,
    sender.address,
    to.map((entry) => entry.address).join(','),
    cc.map((entry) => entry.address).join(','),
    bcc.map((entry) => entry.address).join(','),
    subject,
    receivedAt.toISOString(),
    sentAt?.toISOString() || '',
    String(raw.size || 0),
    sha256(text)
  ].join('\u0000')
  const canonicalHash = sha256(rawHash ? `raw:${rawHash}` : `envelope:${fallbackFingerprint}`)
  const threadSeed = references[0] || inReplyTo || messageId || canonicalHash
  const attachments = decorateIncomingAttachmentMetadata(raw.attachments)
  return {
    canonicalHash,
    messageIdHash: messageId ? sha256(messageId) : null,
    threadKeyHash: sha256(threadSeed),
    receivedAt,
    sentAt,
    sizeBytes: nonNegativeSafeInteger(raw.size),
    envelope: { messageId, sender, to, cc, bcc, subject, references, inReplyTo },
    content: { text, attachments },
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length
  }
}

export async function upsertEmailAccount(client, {
  userId,
  sourceKey,
  label = '个人邮箱',
  capabilities = []
}) {
  const normalizedKey = normalizedSourceKey(sourceKey)
  const capabilityObject = Object.fromEntries(
    normalizedCapabilities(capabilities).map((capability) => [capability, true])
  )
  const normalizedLabel = boundedText(label, 120) || '个人邮箱'
  const { rows } = await client.query(
    `INSERT INTO email_accounts (
       user_id, source_key, label, capabilities, last_connected_at,
       last_error_at, last_error_code, updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, NOW(), NULL, NULL, NOW())
     ON CONFLICT (user_id, source_key) DO UPDATE SET
       label = EXCLUDED.label,
       capabilities = EXCLUDED.capabilities,
       last_connected_at = NOW(),
       last_error_at = NULL,
       last_error_code = NULL,
       updated_at = NOW()
     RETURNING *`,
    [userId, normalizedKey, normalizedLabel, JSON.stringify(capabilityObject)]
  )
  return rows[0]
}

export async function upsertEmailFolder(client, {
  accountId,
  userId,
  path,
  delimiter = null,
  specialUse = null,
  selectable = true,
  subscribed = true,
  uidValidity = null,
  uidNext = null,
  highestModseq = null,
  lastUid = 0,
  markSynced = false
}) {
  const normalizedPath = normalizedFolderPath(path)
  const normalizedPathHash = sha256(normalizedPath)
  const previousResult = await client.query(
    `SELECT id, uid_validity
     FROM email_folders
     WHERE account_id = $1 AND path_hash = $2
     FOR UPDATE`,
    [accountId, normalizedPathHash]
  )
  const previous = previousResult.rows[0] || null
  const normalizedUidValidity = unsignedIntegerString(uidValidity, {
    label: 'IMAP UIDVALIDITY',
    maximum: UINT32_MAX,
    allowNull: true
  })
  const normalizedUidNext = unsignedIntegerString(uidNext, {
    label: 'IMAP UIDNEXT',
    maximum: UINT32_MAX,
    allowNull: true
  })
  const normalizedHighestModseq = unsignedIntegerString(highestModseq, {
    label: 'IMAP HIGHESTMODSEQ',
    maximum: UINT64_MAX,
    allowNull: true
  })
  const normalizedLastUid = unsignedIntegerString(lastUid, {
    label: 'IMAP last UID',
    maximum: UINT32_MAX,
    allowZero: true
  })
  const { rows } = await client.query(
    `INSERT INTO email_folders (
       account_id, user_id, path, path_hash, delimiter, special_use,
       selectable, subscribed, uid_validity, uid_next, highest_modseq,
       last_uid, last_listed_at, last_synced_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, NOW(), CASE WHEN $13 THEN NOW() ELSE NULL END, NOW()
     )
     ON CONFLICT (account_id, path_hash) DO UPDATE SET
       path = EXCLUDED.path,
       delimiter = EXCLUDED.delimiter,
       special_use = EXCLUDED.special_use,
       selectable = EXCLUDED.selectable,
       subscribed = EXCLUDED.subscribed,
       uid_validity = COALESCE(EXCLUDED.uid_validity, email_folders.uid_validity),
       uid_next = COALESCE(EXCLUDED.uid_next, email_folders.uid_next),
       highest_modseq = COALESCE(EXCLUDED.highest_modseq, email_folders.highest_modseq),
       reconciled_modseq = CASE
         WHEN email_folders.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
              AND email_folders.uid_validity IS NOT NULL
              AND EXCLUDED.uid_validity IS NOT NULL THEN NULL
         ELSE email_folders.reconciled_modseq
       END,
       last_uid = CASE
         WHEN email_folders.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
              AND EXCLUDED.uid_validity IS NOT NULL THEN EXCLUDED.last_uid
         ELSE GREATEST(email_folders.last_uid, EXCLUDED.last_uid)
       END,
       sync_generation = CASE
         WHEN email_folders.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
              AND email_folders.uid_validity IS NOT NULL
              AND EXCLUDED.uid_validity IS NOT NULL
           THEN email_folders.sync_generation + 1
         ELSE email_folders.sync_generation
       END,
       initial_sync_complete = CASE
         WHEN email_folders.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
              AND email_folders.uid_validity IS NOT NULL
              AND EXCLUDED.uid_validity IS NOT NULL THEN FALSE
         ELSE email_folders.initial_sync_complete
       END,
       last_listed_at = NOW(),
       last_synced_at = CASE WHEN $13 THEN NOW() ELSE email_folders.last_synced_at END,
       last_reconciled_at = CASE
         WHEN email_folders.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
              AND email_folders.uid_validity IS NOT NULL
              AND EXCLUDED.uid_validity IS NOT NULL THEN NULL
         ELSE email_folders.last_reconciled_at
       END,
       last_reconcile_mode = CASE
         WHEN email_folders.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
              AND email_folders.uid_validity IS NOT NULL
              AND EXCLUDED.uid_validity IS NOT NULL THEN 'uidvalidity_reset'
         ELSE email_folders.last_reconcile_mode
       END,
       last_reconcile_error_at = CASE
         WHEN email_folders.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
              AND email_folders.uid_validity IS NOT NULL
              AND EXCLUDED.uid_validity IS NOT NULL THEN NULL
         ELSE email_folders.last_reconcile_error_at
       END,
       last_reconcile_error_code = CASE
         WHEN email_folders.uid_validity IS DISTINCT FROM EXCLUDED.uid_validity
              AND email_folders.uid_validity IS NOT NULL
              AND EXCLUDED.uid_validity IS NOT NULL THEN NULL
         ELSE email_folders.last_reconcile_error_code
       END,
       last_error_at = NULL,
       last_error_code = NULL,
       updated_at = NOW()
     RETURNING *`,
    [
      accountId,
      userId,
      normalizedPath,
      normalizedPathHash,
      delimiter ? boundedText(delimiter, 8) : null,
      normalizedSpecialUse(specialUse, normalizedPath),
      Boolean(selectable),
      Boolean(subscribed),
      normalizedUidValidity,
      normalizedUidNext,
      normalizedHighestModseq,
      normalizedLastUid,
      Boolean(markSynced)
    ]
  )
  const saved = rows[0]
  if (
    previous?.uid_validity != null
    && normalizedUidValidity != null
    && String(previous.uid_validity) !== normalizedUidValidity
  ) {
    await client.query(
      `UPDATE email_folder_messages
       SET expunged_at = COALESCE(expunged_at, NOW()), updated_at = NOW()
       WHERE folder_id = $1 AND user_id = $2
         AND uid_validity <> $3::bigint AND expunged_at IS NULL`,
      [saved.id, userId, normalizedUidValidity]
    )
  }
  return saved
}

export async function persistEmailMailboxMessage({
  poolInstance,
  userId,
  sourceKey,
  accountLabel,
  capabilities,
  folder,
  notificationEligible = false,
  message: rawMessage
}) {
  const source = normalizedSourceKey(sourceKey)
  const canonical = buildCanonicalMailboxMessage(rawMessage)
  const remoteUidValidity = unsignedIntegerString(folder?.uidValidity, {
    label: 'IMAP UIDVALIDITY',
    maximum: UINT32_MAX
  })
  const remoteUid = unsignedIntegerString(rawMessage?.mailboxUid, {
    label: 'IMAP message UID',
    maximum: UINT32_MAX
  })
  const remoteModseq = unsignedIntegerString(rawMessage?.modseq, {
    label: 'IMAP MODSEQ',
    maximum: UINT64_MAX,
    allowNull: true
  })
  const context = emailMailboxEncryptionContext(userId, source)
  const [envelopeEncrypted, contentEncrypted] = await Promise.all([
    encryptEmailPayload(canonical.envelope, { context }),
    encryptEmailPayload(canonical.content, { context })
  ])
  const flags = normalizedFlags(rawMessage.flags)
  const client = await poolInstance.connect()
  let account
  let savedFolder
  let message
  let location
  let inserted = false
  let classificationQueued = false
  try {
    await client.query('BEGIN')
    account = await upsertEmailAccount(client, {
      userId,
      sourceKey: source,
      label: accountLabel,
      capabilities
    })
    savedFolder = await upsertEmailFolder(client, {
      accountId: account.id,
      userId,
      ...folder,
      // Cursor movement remains a scheduler concern. This transaction commits
      // the encrypted canonical row and its durable classification job first;
      // only then may the scheduler advance last_uid.
      lastUid: 0,
      markSynced: true
    })
    const insertedMessage = await client.query(
      `INSERT INTO email_messages (
         account_id, user_id, canonical_hash, message_id_hash, thread_key_hash,
         envelope_encrypted, content_encrypted, received_at, sent_at,
         size_bytes, has_attachments, attachment_count, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (account_id, canonical_hash) DO NOTHING
       RETURNING *`,
      [
        account.id,
        userId,
        canonical.canonicalHash,
        canonical.messageIdHash,
        canonical.threadKeyHash,
        envelopeEncrypted,
        contentEncrypted,
        canonical.receivedAt,
        canonical.sentAt,
        canonical.sizeBytes,
        canonical.hasAttachments,
        canonical.attachmentCount
      ]
    )
    inserted = Boolean(insertedMessage.rows[0])
    if (inserted) message = insertedMessage.rows[0]
    else {
      const existing = await client.query(
        'SELECT * FROM email_messages WHERE account_id = $1 AND canonical_hash = $2 LIMIT 1',
        [account.id, canonical.canonicalHash]
      )
      message = existing.rows[0]
    }
    const locationResult = await client.query(
      `INSERT INTO email_folder_messages (
         folder_id, message_id, account_id, user_id, uid_validity, uid,
         modseq, seen, answered, flagged, draft, deleted, keywords,
         internal_date, size_bytes, expunged_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,NULL,NOW())
       ON CONFLICT (folder_id, uid_validity, uid) DO UPDATE SET
         message_id = EXCLUDED.message_id,
         modseq = CASE
           WHEN email_folder_messages.modseq IS NULL OR EXCLUDED.modseq IS NULL
             OR EXCLUDED.modseq >= email_folder_messages.modseq THEN EXCLUDED.modseq
           ELSE email_folder_messages.modseq
         END,
         seen = CASE WHEN email_folder_messages.modseq IS NULL OR EXCLUDED.modseq IS NULL
             OR EXCLUDED.modseq >= email_folder_messages.modseq THEN EXCLUDED.seen ELSE email_folder_messages.seen END,
         answered = CASE WHEN email_folder_messages.modseq IS NULL OR EXCLUDED.modseq IS NULL
             OR EXCLUDED.modseq >= email_folder_messages.modseq THEN EXCLUDED.answered ELSE email_folder_messages.answered END,
         flagged = CASE WHEN email_folder_messages.modseq IS NULL OR EXCLUDED.modseq IS NULL
             OR EXCLUDED.modseq >= email_folder_messages.modseq THEN EXCLUDED.flagged ELSE email_folder_messages.flagged END,
         draft = CASE WHEN email_folder_messages.modseq IS NULL OR EXCLUDED.modseq IS NULL
             OR EXCLUDED.modseq >= email_folder_messages.modseq THEN EXCLUDED.draft ELSE email_folder_messages.draft END,
         deleted = CASE WHEN email_folder_messages.modseq IS NULL OR EXCLUDED.modseq IS NULL
             OR EXCLUDED.modseq >= email_folder_messages.modseq THEN EXCLUDED.deleted ELSE email_folder_messages.deleted END,
         keywords = CASE WHEN email_folder_messages.modseq IS NULL OR EXCLUDED.modseq IS NULL
             OR EXCLUDED.modseq >= email_folder_messages.modseq THEN EXCLUDED.keywords ELSE email_folder_messages.keywords END,
         internal_date = EXCLUDED.internal_date,
         size_bytes = EXCLUDED.size_bytes,
         expunged_at = NULL,
         updated_at = NOW()
       RETURNING *`,
      [
        savedFolder.id,
        message.id,
        account.id,
        userId,
        remoteUidValidity,
        remoteUid,
        remoteModseq,
        flags.seen,
        flags.answered,
        flags.flagged,
        flags.draft,
        flags.deleted,
        JSON.stringify(flags.keywords),
        safeDate(rawMessage.internalDate || rawMessage.receivedAt),
        canonical.sizeBytes
      ]
    )
    location = locationResult.rows[0]
    // A newly inserted canonical row always receives its durable job in this
    // transaction. Replays may recover an eventless row only when its stable
    // Message-ID hash can prove that no linked or legacy event already exists.
    // This keeps old incomplete notification metadata from becoming new push.
    const classificationJob = await client.query(
      `INSERT INTO email_classification_jobs (
         user_id, account_id, email_message_id, notification_eligible
       )
       SELECT $1, $2, $3, $7::boolean
       WHERE ($4::boolean OR $5::char(64) IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM email_events AS event
           WHERE event.user_id = $1
             AND (
               event.email_message_id = $3
               OR (
                 $5::char(64) IS NOT NULL
                 AND event.source_key = $6
                 AND event.message_id_hash = $5::char(64)
               )
             )
         )
       ON CONFLICT (user_id, email_message_id) DO NOTHING
       RETURNING id`,
      [
        userId,
        account.id,
        message.id,
        inserted,
        canonical.messageIdHash,
        source,
        Boolean(notificationEligible)
      ]
    )
    classificationQueued = classificationJob.rowCount > 0
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  const event = {
    userId: String(userId),
    accountId: String(account.id),
    folderId: String(savedFolder.id),
    messageId: String(message.id),
    locationId: String(location.id),
    revision: new Date(location.updated_at || Date.now()).getTime()
  }
  const [mailboxNotification, classificationNotification] = await Promise.allSettled([
    poolInstance.query('SELECT pg_notify($1, $2)', [EMAIL_MAILBOX_CHANGE_CHANNEL, JSON.stringify(event)]),
    classificationQueued
      ? notifyEmailWake(poolInstance.query.bind(poolInstance), EMAIL_CLASSIFICATION_WAKE_CHANNEL, {
          accountId: account.id,
          sourceKey: source
        })
      : Promise.resolve()
  ])
  const notified = mailboxNotification.status === 'fulfilled'
  return {
    account,
    folder: savedFolder,
    message,
    location,
    inserted,
    classificationQueued,
    event,
    notified,
    classificationWakeDelivered: classificationQueued
      ? classificationNotification.status === 'fulfilled'
      : null
  }
}

export async function decryptStoredMailboxMessage(row, { userId, sourceKey }) {
  const context = emailMailboxEncryptionContext(userId, sourceKey)
  const [envelope, content] = await Promise.all([
    decryptEmailPayload(row.envelope_encrypted, { context }),
    decryptEmailPayload(row.content_encrypted, { context })
  ])
  return { envelope, content }
}
