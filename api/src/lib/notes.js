import { normalizeNoteAttachments } from './noteAttachments.js'

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

function toPublicDateOnly(value) {
  if (!value) return null

  const rawValue = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return rawValue
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  return new Date(date.getTime() + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 10)
}

export function mapShare(record) {
  if (!record) return null

  return {
    id: record.id,
    noteId: record.note_id,
    code: record.code,
    expireAt: record.expire_at,
    viewCount: record.view_count,
    createdAt: record.created_at
  }
}

export function mapPublicShare(record) {
  if (!record) return null

  return {
    date: toPublicDateOnly(record.created_at)
  }
}

export function mapPublicNote(record, {
  allowedAttachmentOrigin = ''
} = {}) {
  if (!record) return null

  const attachments = allowedAttachmentOrigin
    ? normalizeNoteAttachments(record.attachments, {
        allowedOrigin: allowedAttachmentOrigin,
        maxBytes: Number.MAX_SAFE_INTEGER
      }).map(({ url, name }) => ({
        url,
        name
      }))
    : []

  return {
    title: String(record.title || ''),
    content: String(record.content || ''),
    tags: Array.isArray(record.tags)
      ? record.tags
          .map((tag) => String(tag || '').trim())
          .filter(Boolean)
      : [],
    attachments,
    entryDate: toPublicDateOnly(record.entry_date)
  }
}

export function mapNote(record) {
  if (!record) return null

  const shareEnabled = Boolean(record.share_id || record.share_code)

  return {
    id: record.id,
    numberId: record.number_id === null || record.number_id === undefined
      ? null
      : Number(record.number_id),
    type: record.type,
    title: record.title,
    content: record.content,
    encrypted: record.encrypted,
    password: '',
    pinned: record.pinned,
    tags: Array.isArray(record.tags) ? record.tags : [],
    attachments: normalizeNoteAttachments(record.attachments, {
      maxBytes: Number.MAX_SAFE_INTEGER
    }),
    entryDate: record.entry_date || '',
    mood: record.mood || '',
    dueAt: record.due_at || null,
    remindBeforeMinutes: Number(record.remind_before_minutes || 0),
    completed: Boolean(record.completed),
    revision: Number(record.revision || 1),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    share: {
      enabled: shareEnabled,
      id: record.share_id || '',
      code: record.share_code || '',
      expireAt: record.share_expire_at || null,
      viewCount: record.share_view_count || 0
    }
  }
}
