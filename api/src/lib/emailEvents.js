import { query } from '../db/index.js'
import { buildEmailSignatures, classifyEmail, fallbackEmailClassification } from './emailClassifier.js'
import { decryptEmailPayload, encryptEmailPayload } from './emailCrypto.js'
import { createNotification } from './notifications.js'

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const SOURCE_KEY_PATTERN = /^[a-z0-9_.-]+$/

function normalizeText(value, maximum) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maximum)
}

function normalizeInboundEmail(email = {}) {
  const receivedAt = new Date(email.receivedAt || Date.now())
  if (Number.isNaN(receivedAt.getTime())) throw new TypeError('Email received time is invalid')
  return {
    messageId: normalizeText(email.messageId, 998),
    mailboxUid: Number.isSafeInteger(Number(email.mailboxUid)) && Number(email.mailboxUid) > 0
      ? Number(email.mailboxUid)
      : null,
    senderName: normalizeText(email.senderName, 320),
    senderAddress: normalizeText(email.senderAddress, 320).toLowerCase(),
    recipient: normalizeText(email.recipient, 1000),
    subject: normalizeText(email.subject || '(无主题)', 500),
    text: normalizeText(email.text, 120_000),
    receivedAt: receivedAt.toISOString()
  }
}

function encryptionContext(userId, sourceKey) {
  return `${String(userId || '')}:${String(sourceKey || '')}`
}

async function decryptPrevious(row, userId, logger) {
  if (!row) return null
  try {
    const content = await decryptEmailPayload(row.content_encrypted, {
      context: encryptionContext(userId, row.source_key)
    })
    return {
      ...content,
      id: row.id,
      tier: Number(row.tier),
      stateSignature: row.state_signature
    }
  } catch (error) {
    logger?.warn?.({ emailEventId: row.id }, 'previous email event could not be decrypted for deduplication')
    return null
  }
}

async function ensureTierOneNotification(row, userId, queryFn) {
  if (
    !row
    || Number(row.tier) !== 1
    || row.duplicate_of
    || row.notified_at
  ) return false
  await createNotification({
    userId,
    eventType: 'email.tier1',
    title: '你有一封需要立即核对的重要邮件',
    summary: '完整原因和建议仅在登录 DOMO NAV 后显示。',
    sourceType: 'email',
    sourceId: row.id,
    actionUrl: `/assistant?email=${encodeURIComponent(row.id)}`,
    dedupeKey: `email:${row.event_signature}:${row.state_signature}`,
    sensitive: true,
    pushEnabled: true,
    metadata: { tier: 1, urgency: row.urgency },
    queryFn
  })
  await queryFn(
    'UPDATE email_events SET notified_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2',
    [row.id, userId]
  )
  return true
}

export async function processInboundEmail({
  userId,
  sourceKey,
  email: rawEmail,
  logger = null,
  queryFn = query
}) {
  const normalizedSourceKey = String(sourceKey || '').trim().toLowerCase()
  if (!SOURCE_KEY_PATTERN.test(normalizedSourceKey) || normalizedSourceKey.length > 80) {
    throw new TypeError('Email source key is invalid')
  }
  const email = normalizeInboundEmail(rawEmail)
  const provisional = buildEmailSignatures(email, fallbackEmailClassification(email))
  const existingMessage = await queryFn(
    `SELECT id, tier, urgency, event_signature, state_signature, duplicate_of,
            notified_at, received_at
     FROM email_events
     WHERE user_id = $1 AND source_key = $2 AND message_id_hash = $3
     LIMIT 1`,
    [userId, normalizedSourceKey, provisional.messageIdHash]
  )
  if (existingMessage.rows[0]) {
    await ensureTierOneNotification(existingMessage.rows[0], userId, queryFn)
    return { inserted: false, duplicate: true, event: null }
  }
  const previousResult = await queryFn(
    `
      SELECT id, source_key, tier, state_signature, content_encrypted
      FROM email_events
      WHERE user_id = $1 AND deterministic_signature = $2
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `,
    [userId, provisional.deterministicSignature]
  )
  const previous = await decryptPrevious(previousResult.rows[0], userId, logger)
  const classification = await classifyEmail({ userId, email, previous, logger })
  const signatures = buildEmailSignatures(email, classification)

  let canonicalPreviousRow = previousResult.rows[0] || null
  if (!canonicalPreviousRow || signatures.eventSignature !== provisional.eventSignature) {
    const byEvent = await queryFn(
      `SELECT id, source_key, tier, state_signature, content_encrypted
       FROM email_events
       WHERE user_id = $1 AND event_signature = $2
       ORDER BY received_at DESC, id DESC LIMIT 1`,
      [userId, signatures.eventSignature]
    )
    canonicalPreviousRow = byEvent.rows[0] || canonicalPreviousRow
  }
  const duplicate = Boolean(
    canonicalPreviousRow
    && (
      classification.duplicateOfPrevious
      || classification.stateChanged === false
      || canonicalPreviousRow.state_signature === signatures.stateSignature
    )
  )
  const content = {
    senderName: email.senderName,
    senderAddress: email.senderAddress,
    recipient: email.recipient,
    subject: email.subject,
    text: email.text,
    reason: classification.reason,
    suggestedAction: classification.suggestedAction,
    urgency: classification.urgency
  }
  const encrypted = await encryptEmailPayload(content, {
    context: encryptionContext(userId, normalizedSourceKey)
  })
  const { rows } = await queryFn(
    `
      INSERT INTO email_events (
        user_id, source_key, mailbox_uid, message_id_hash, sender_hash,
        received_at, tier, urgency, deterministic_signature,
        event_signature, state_signature, duplicate_of,
        classification_status, provider, model, content_encrypted
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16
      )
      ON CONFLICT (user_id, source_key, message_id_hash) DO NOTHING
      RETURNING *
    `,
    [
      userId,
      normalizedSourceKey,
      email.mailboxUid,
      signatures.messageIdHash,
      signatures.senderHash,
      email.receivedAt,
      classification.tier,
      classification.urgency,
      signatures.deterministicSignature,
      signatures.eventSignature,
      signatures.stateSignature,
      duplicate ? canonicalPreviousRow.id : null,
      classification.classificationStatus,
      classification.provider || null,
      classification.model || null,
      encrypted
    ]
  )
  const inserted = rows[0]
  if (!inserted) return { inserted: false, duplicate: true, event: null }

  await ensureTierOneNotification(inserted, userId, queryFn)

  return {
    inserted: true,
    duplicate,
    event: {
      id: inserted.id,
      tier: Number(inserted.tier),
      urgency: inserted.urgency,
      receivedAt: inserted.received_at
    }
  }
}

function mapEmailDetail(row, content, { includeBody = false } = {}) {
  return {
    id: row.id,
    tier: Number(row.tier),
    urgency: row.urgency,
    senderName: content.senderName || '',
    senderAddress: content.senderAddress || '',
    subject: content.subject || '(无主题)',
    body: includeBody ? String(content.text || '') : undefined,
    bodyPreview: String(content.text || '').slice(0, 1200),
    reason: content.reason || '',
    suggestedAction: content.suggestedAction || '',
    duplicate: Boolean(row.duplicate_of),
    classificationStatus: row.classification_status,
    receivedAt: row.received_at,
    createdAt: row.created_at
  }
}

export async function getEmailNotificationDetails(userId, ids, { queryFn = query } = {}) {
  const safeIds = [...new Set((ids || []).map(String).filter((id) => UUID_PATTERN.test(id)))].slice(0, 100)
  const mapped = new Map()
  if (!safeIds.length) return mapped
  const { rows } = await queryFn(
    `SELECT id, source_key, tier, urgency, duplicate_of, classification_status,
            received_at, created_at, content_encrypted
     FROM email_events WHERE user_id = $1 AND id = ANY($2::uuid[])`,
    [userId, safeIds]
  )
  for (const row of rows) {
    try {
      mapped.set(String(row.id), mapEmailDetail(row, await decryptEmailPayload(
        row.content_encrypted,
        { context: encryptionContext(userId, row.source_key) }
      )))
    } catch {
      mapped.set(String(row.id), {
        id: row.id,
        tier: Number(row.tier),
        urgency: row.urgency,
        subject: '邮件内容暂时无法解密',
        reason: '请检查服务器邮件加密密钥配置。',
        suggestedAction: '联系管理员检查密钥文件。',
        receivedAt: row.received_at
      })
    }
  }
  return mapped
}

export async function searchEmailSources(userId, search, { limit = 5, queryFn = query } = {}) {
  const needle = String(search || '').normalize('NFKC').trim().toLowerCase()
  if (!needle) return []
  const broadActionQuery = /(今天|今日|待办|处理|重要|紧急|邮件|提醒|what.*(?:today|todo|important))/iu.test(needle)
  const { rows } = await queryFn(
    `SELECT id, source_key, tier, urgency, duplicate_of, classification_status,
            received_at, created_at, content_encrypted
     FROM email_events
     WHERE user_id = $1
     ORDER BY received_at DESC, id DESC
     LIMIT 200`,
    [userId]
  )
  const results = []
  for (const row of rows) {
    try {
      const content = await decryptEmailPayload(row.content_encrypted, {
        context: encryptionContext(userId, row.source_key)
      })
      const haystack = `${content.senderName || ''} ${content.senderAddress || ''} ${content.subject || ''} ${content.reason || ''} ${content.suggestedAction || ''}`.toLowerCase()
      if (!broadActionQuery && !haystack.includes(needle)) continue
      if (broadActionQuery && ![1, 2].includes(Number(row.tier))) continue
      results.push({
        id: row.id,
        kind: 'email',
        kindLabel: `邮件 Tier ${Number(row.tier)}`,
        title: content.subject || '(无主题)',
        snippet: `${content.reason || ''} ${content.suggestedAction || ''}`.trim(),
        href: `/assistant?email=${encodeURIComponent(row.id)}`,
        matchReasons: ['邮件标题或分类结果匹配']
      })
      if (results.length >= limit) break
    } catch {}
  }
  return results
}

export async function getEmailEventForUser(userId, id, { queryFn = query } = {}) {
  if (!UUID_PATTERN.test(String(id || ''))) return null
  const { rows } = await queryFn(
    `SELECT id, source_key, tier, urgency, duplicate_of, classification_status,
            received_at, created_at, content_encrypted
     FROM email_events WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, userId]
  )
  if (!rows[0]) return null
  return mapEmailDetail(
    rows[0],
    await decryptEmailPayload(rows[0].content_encrypted, {
      context: encryptionContext(userId, rows[0].source_key)
    }),
    { includeBody: true }
  )
}
