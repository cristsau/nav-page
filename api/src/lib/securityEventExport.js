export const SECURITY_EVENT_EXPORT_MAX_ROWS = 10_000

const EXPORT_FORMATS = new Set(['csv', 'json'])
const CSV_COLUMNS = Object.freeze([
  ['id', 'id'],
  ['event_type', 'eventType'],
  ['outcome', 'outcome'],
  ['actor_user_id', 'actorUserId'],
  ['subject_user_id', 'subjectUserId'],
  ['resource_type', 'resourceType'],
  ['resource_id', 'resourceId'],
  ['affected_count', 'affectedCount'],
  ['client_fingerprint', 'clientFingerprint'],
  ['user_agent_fingerprint', 'userAgentFingerprint'],
  ['created_at', 'createdAt']
])

export function normalizeSecurityEventExportFormat(value) {
  const format = String(value || '').trim().toLowerCase()
  return EXPORT_FORMATS.has(format) ? format : ''
}

function csvCell(value) {
  if (value === undefined || value === null) return ''
  const normalized = String(value)
  return /[",\r\n]/.test(normalized)
    ? `"${normalized.replaceAll('"', '""')}"`
    : normalized
}

function exportTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now())
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

export function securityEventExportFilename(format, generatedAt = new Date()) {
  const normalizedFormat = normalizeSecurityEventExportFormat(format)
  if (!normalizedFormat) throw new TypeError('Unsupported export format')
  const stamp = exportTimestamp(generatedAt)
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `nav-security-events-${stamp}.${normalizedFormat}`
}

export function serializeSecurityEventExport({
  events,
  format,
  generatedAt = new Date(),
  truncated = false,
  filters = {}
}) {
  const normalizedFormat = normalizeSecurityEventExportFormat(format)
  if (!normalizedFormat) throw new TypeError('Unsupported export format')
  const safeEvents = Array.isArray(events) ? events : []
  const exportedAt = exportTimestamp(generatedAt)

  if (normalizedFormat === 'json') {
    return {
      body: `${JSON.stringify({
        exportedAt,
        truncated: Boolean(truncated),
        filters: {
          eventType: String(filters.eventType || ''),
          outcome: String(filters.outcome || '')
        },
        events: safeEvents
      }, null, 2)}\n`,
      contentType: 'application/json; charset=utf-8'
    }
  }

  const lines = [CSV_COLUMNS.map(([header]) => header).join(',')]
  for (const event of safeEvents) {
    lines.push(CSV_COLUMNS.map(([, key]) => csvCell(event?.[key])).join(','))
  }
  return {
    body: `\uFEFF${lines.join('\r\n')}\r\n`,
    contentType: 'text/csv; charset=utf-8'
  }
}
