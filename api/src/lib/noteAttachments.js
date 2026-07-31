const ALLOWED_IMAGE_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp'
])

const MAX_ATTACHMENTS_PER_NOTE = 8
const MAX_ATTACHMENT_NAME_LENGTH = 255
const MAX_ATTACHMENT_URL_LENGTH = 2048

function createValidationError(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function normalizeAllowedOrigin(value) {
  if (!value) return ''

  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.origin
      : ''
  } catch {
    return ''
  }
}

function normalizeTimestamp(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function normalizeUrl(value, allowedOrigin = '') {
  const input = String(value || '').trim()
  if (!input || input.length > MAX_ATTACHMENT_URL_LENGTH) return ''

  try {
    const url = new URL(input)
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || !url.pathname.startsWith('/file/')
      || (allowedOrigin && url.origin !== allowedOrigin)
    ) {
      return ''
    }

    return url.toString()
  } catch {
    return ''
  }
}

function normalizeAttachment(value, options) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const id = String(value.id || '').trim()
  const url = normalizeUrl(value.url, options.allowedOrigin)
  const name = String(value.name || '')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_ATTACHMENT_NAME_LENGTH) || ''
  const mime = String(value.mime || '').trim().toLowerCase()
  const size = Number(value.size)
  const createdAt = normalizeTimestamp(value.createdAt)

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    || !url
    || !name
    || !ALLOWED_IMAGE_TYPES.has(mime)
    || !Number.isSafeInteger(size)
    || size < 1
    || size > options.maxBytes
    || !createdAt
  ) {
    return null
  }

  return {
    id,
    url,
    name,
    mime,
    size,
    createdAt
  }
}

export function getImgBedOrigin(baseUrl) {
  return normalizeAllowedOrigin(baseUrl)
}

export function normalizeNoteAttachments(value, {
  allowedOrigin = '',
  maxBytes = 10 * 1024 * 1024,
  strict = false
} = {}) {
  if (value === undefined || value === null) return []

  if (!Array.isArray(value)) {
    if (strict) {
      throw createValidationError('图片附件数据格式无效')
    }
    return []
  }

  if (value.length > MAX_ATTACHMENTS_PER_NOTE) {
    if (strict) {
      throw createValidationError(`每篇笔记最多添加 ${MAX_ATTACHMENTS_PER_NOTE} 张图片`)
    }
  }

  const options = {
    allowedOrigin: normalizeAllowedOrigin(allowedOrigin),
    maxBytes: Number.isSafeInteger(maxBytes) && maxBytes > 0
      ? maxBytes
      : 10 * 1024 * 1024
  }
  const normalized = []
  const seenIds = new Set()

  for (const attachment of value.slice(0, MAX_ATTACHMENTS_PER_NOTE)) {
    const item = normalizeAttachment(attachment, options)
    if (!item || seenIds.has(item.id)) {
      if (strict) {
        throw createValidationError('图片附件包含无效或重复的数据')
      }
      continue
    }

    seenIds.add(item.id)
    normalized.push(item)
  }

  return normalized
}

export function assertAttachmentsAllowedForEncryption(encrypted, attachments) {
  if (encrypted && attachments.length) {
    throw createValidationError('加密笔记不能添加图片附件；请先移除图片后再启用加密')
  }
}

export function isAllowedImageMime(value) {
  return ALLOWED_IMAGE_TYPES.has(String(value || '').trim().toLowerCase())
}
