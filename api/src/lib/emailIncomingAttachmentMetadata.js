import { createHash } from 'node:crypto'

function boundedText(value, maximum) {
  return String(value ?? '').normalize('NFKC').replace(/[\r\n\u0000]/g, '').trim().slice(0, maximum)
}

function safeSize(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

export function normalizeIncomingAttachmentMetadata(attachment, ordinal) {
  const normalized = {
    ordinal,
    filename: boundedText(attachment?.filename, 500) || `attachment-${ordinal + 1}`,
    contentType: boundedText(attachment?.contentType, 160).toLowerCase() || 'application/octet-stream',
    contentDisposition: boundedText(attachment?.contentDisposition, 32).toLowerCase() || 'attachment',
    contentId: boundedText(attachment?.contentId, 998),
    size: safeSize(attachment?.size ?? attachment?.content?.length)
  }
  const seed = [
    normalized.ordinal,
    normalized.filename,
    normalized.contentType,
    normalized.contentDisposition,
    normalized.contentId,
    normalized.size
  ].join('\u0000')
  return {
    id: createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32),
    ...normalized
  }
}

export function decorateIncomingAttachmentMetadata(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .slice(0, 100)
    .map((attachment, ordinal) => normalizeIncomingAttachmentMetadata(attachment, ordinal))
}

export function safeAttachmentDownloadName(value, fallback = 'attachment.bin') {
  const normalized = boundedText(value, 180)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
  return normalized || fallback
}
