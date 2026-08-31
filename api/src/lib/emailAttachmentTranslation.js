const TEXT_MIME_PATTERN = /^text\/[a-z0-9!#$&^_.+-]+$/
const STRUCTURED_TEXT_MIME_PATTERN = /^application\/[a-z0-9!#$&^_.+-]+\+(?:json|xml)$/

const STRUCTURED_TEXT_MIME_TYPES = new Set([
  'application/csv',
  'application/json',
  'application/ld+json',
  'application/toml',
  'application/x-ndjson',
  'application/x-yaml',
  'application/xml',
  'application/yaml'
])

const SAFE_TEXT_EXTENSIONS = new Set([
  'csv', 'htm', 'html', 'json', 'jsonl', 'log', 'md', 'markdown',
  'ndjson', 'sql', 'toml', 'tsv', 'txt', 'xml', 'yaml', 'yml'
])

export const EMAIL_ATTACHMENT_TRANSLATION_LIMITS = Object.freeze({
  maximumBytes: 512 * 1024,
  maximumCharacters: 12_000
})

export class EmailAttachmentTranslationError extends Error {
  constructor(message, statusCode, code) {
    super(message)
    this.name = 'EmailAttachmentTranslationError'
    this.statusCode = statusCode
    this.code = code
  }
}

function normalizedMime(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function filenameExtension(value) {
  const name = String(value || '').trim().toLowerCase()
  const match = name.match(/\.([a-z0-9]+)$/)
  return match?.[1] || ''
}

export function isTranslatableEmailAttachmentMetadata(value = {}) {
  const mime = normalizedMime(value.contentType ?? value.type)
  if (TEXT_MIME_PATTERN.test(mime)
    || STRUCTURED_TEXT_MIME_PATTERN.test(mime)
    || STRUCTURED_TEXT_MIME_TYPES.has(mime)) return true

  return mime === 'application/octet-stream'
    && SAFE_TEXT_EXTENSIONS.has(filenameExtension(value.filename ?? value.name))
}

function attachmentError(message, statusCode, code) {
  return new EmailAttachmentTranslationError(message, statusCode, code)
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw attachmentError(
      '附件不是有效的 UTF-8 文本，暂时无法安全翻译',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_INVALID_TEXT'
    )
  }
}

function hasUnsafeBinaryControls(value) {
  const controls = value.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g)?.length || 0
  return controls > Math.max(4, Math.floor(value.length * 0.01))
}

export function extractEmailAttachmentTranslationInput(value = {}, {
  maximumBytes = EMAIL_ATTACHMENT_TRANSLATION_LIMITS.maximumBytes,
  maximumCharacters = EMAIL_ATTACHMENT_TRANSLATION_LIMITS.maximumCharacters
} = {}) {
  const content = value.content
  if (!Buffer.isBuffer(content) || !content.length) {
    throw attachmentError(
      '附件内容为空或不可读取',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_EMPTY'
    )
  }
  if (!isTranslatableEmailAttachmentMetadata(value)) {
    throw attachmentError(
      '仅支持纯文本、Markdown、CSV、JSON、XML 等文本附件；PDF 和 Office 文件暂不支持',
      415,
      'EMAIL_ATTACHMENT_TRANSLATION_UNSUPPORTED_TYPE'
    )
  }
  if (content.length > maximumBytes) {
    throw attachmentError(
      `可翻译的文本附件不能超过 ${Math.floor(maximumBytes / 1024)} KiB`,
      413,
      'EMAIL_ATTACHMENT_TRANSLATION_TOO_LARGE'
    )
  }
  if ((content[0] === 0xff && content[1] === 0xfe)
    || (content[0] === 0xfe && content[1] === 0xff)) {
    throw attachmentError(
      '附件使用了暂不支持的 UTF-16 编码，请先转换为 UTF-8',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_UNSUPPORTED_ENCODING'
    )
  }

  const source = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
    ? content.subarray(3)
    : content
  const text = decodeUtf8(source).replace(/^\uFEFF/, '').trim()
  if (!text) {
    throw attachmentError(
      '附件没有可翻译的文本内容',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_EMPTY'
    )
  }
  if (hasUnsafeBinaryControls(text)) {
    throw attachmentError(
      '附件看起来包含二进制内容，已停止翻译',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_BINARY_CONTENT'
    )
  }
  if (text.length > maximumCharacters) {
    throw attachmentError(
      `可翻译的附件正文不能超过 ${maximumCharacters.toLocaleString('en-US')} 个字符`,
      413,
      'EMAIL_ATTACHMENT_TRANSLATION_TEXT_TOO_LARGE'
    )
  }

  return {
    text,
    filename: String(value.filename || value.name || 'attachment').trim().slice(0, 180) || 'attachment',
    contentType: normalizedMime(value.contentType ?? value.type) || 'text/plain',
    sourceBytes: content.length,
    sourceCharacters: text.length
  }
}
