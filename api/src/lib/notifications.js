import { query } from '../db/index.js'

const EVENT_TYPE_PATTERN = /^[a-z0-9_.-]+$/
const SOURCE_TYPE_PATTERN = /^[a-z0-9_.-]+$/

function normalizeText(value, maximum = 1000) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
}

function normalizeActionUrl(value) {
  const url = normalizeText(value, 1000)
  if (!url) return ''
  if (!url.startsWith('/') || url.startsWith('//')) throw new TypeError('Notification action URL is invalid')
  return url
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

export function mapNotification(row, detail = null) {
  return {
    id: row.id,
    eventType: row.event_type,
    title: row.title,
    summary: row.summary || '',
    sourceType: row.source_type || '',
    sourceId: row.source_id || '',
    actionUrl: row.action_url || '',
    sensitive: row.sensitive === true,
    metadata: row.metadata || {},
    detail,
    readAt: row.read_at || null,
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function createNotification({
  userId,
  eventType,
  title,
  summary = '',
  sourceType = null,
  sourceId = null,
  actionUrl = '',
  dedupeKey = null,
  sensitive = true,
  pushEnabled = true,
  metadata = {},
  expiresAt = null,
  queryFn = query
}) {
  const normalizedEventType = normalizeText(eventType, 80).toLowerCase()
  const normalizedSourceType = sourceType
    ? normalizeText(sourceType, 48).toLowerCase()
    : null
  const normalizedTitle = normalizeText(title, 240)
  const normalizedDedupeKey = dedupeKey ? normalizeText(dedupeKey, 300) : null
  if (!userId || !EVENT_TYPE_PATTERN.test(normalizedEventType)) {
    throw new TypeError('Notification user and event type are required')
  }
  if (normalizedSourceType && !SOURCE_TYPE_PATTERN.test(normalizedSourceType)) {
    throw new TypeError('Notification source type is invalid')
  }
  if (!normalizedTitle) throw new TypeError('Notification title is required')

  const { rows } = await queryFn(
    `
      INSERT INTO notifications (
        user_id, event_type, title, summary, source_type, source_id,
        action_url, dedupe_key, sensitive, push_enabled, metadata, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
      ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        source_type = EXCLUDED.source_type,
        source_id = EXCLUDED.source_id,
        action_url = EXCLUDED.action_url,
        sensitive = EXCLUDED.sensitive,
        push_enabled = EXCLUDED.push_enabled,
        metadata = EXCLUDED.metadata,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
      RETURNING *
    `,
    [
      userId,
      normalizedEventType,
      normalizedTitle,
      normalizeText(summary, 1000),
      normalizedSourceType,
      sourceId ? normalizeText(sourceId, 300) : null,
      normalizeActionUrl(actionUrl),
      normalizedDedupeKey,
      Boolean(sensitive),
      Boolean(pushEnabled),
      JSON.stringify(normalizeMetadata(metadata)),
      expiresAt
    ]
  )
  return rows[0]
}

export async function createAdminNotifications(payload, { queryFn = query } = {}) {
  const admins = await queryFn(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'approved' ORDER BY created_at ASC`
  )
  const results = []
  for (const admin of admins.rows) {
    results.push(await createNotification({ ...payload, userId: admin.id, queryFn }))
  }
  return results
}
