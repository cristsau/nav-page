import { Worker } from 'node:worker_threads'

const DOCUMENT_MIME_TYPES = new Map([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx']
])

const DOCUMENT_EXTENSIONS = new Map([
  ['pdf', 'pdf'],
  ['docx', 'docx'],
  ['pptx', 'pptx'],
  ['xlsx', 'xlsx']
])

export const EMAIL_DOCUMENT_EXTRACTION_LIMITS = Object.freeze({
  maximumBytes: 8 * 1024 * 1024,
  maximumCharacters: 12_000,
  maximumArchiveEntries: 512,
  maximumArchiveUncompressedBytes: 32 * 1024 * 1024,
  maximumArchiveEntryBytes: 8 * 1024 * 1024,
  maximumCompressionRatio: 100,
  maximumPages: 200,
  maximumSlides: 200,
  maximumSheets: 64,
  maximumXmlNodes: 50_000,
  maximumCells: 20_000,
  timeoutMs: 5_000
})

export class EmailDocumentExtractionError extends Error {
  constructor(message, statusCode = 422, code = 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID') {
    super(message)
    this.name = 'EmailDocumentExtractionError'
    this.statusCode = statusCode
    this.code = code
  }
}

function normalizedMime(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase()
}

function filenameExtension(value) {
  const match = String(value || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] || ''
}

export function emailDocumentFormatForMetadata(value = {}) {
  const mime = normalizedMime(value.contentType ?? value.type)
  const extension = filenameExtension(value.filename ?? value.name)
  const mimeFormat = DOCUMENT_MIME_TYPES.get(mime) || ''
  const extensionFormat = DOCUMENT_EXTENSIONS.get(extension) || ''
  if (mimeFormat && extensionFormat && mimeFormat !== extensionFormat) return ''
  if (mimeFormat) return mimeFormat
  if (!mime || mime === 'application/octet-stream') return extensionFormat
  return ''
}

export function isExtractableEmailDocumentMetadata(value = {}) {
  return Boolean(emailDocumentFormatForMetadata(value))
}

function documentError(message, statusCode, code) {
  return new EmailDocumentExtractionError(message, statusCode, code)
}

function normalizePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback
  return Math.min(parsed, maximum)
}

function workerLimits(options = {}) {
  const defaults = EMAIL_DOCUMENT_EXTRACTION_LIMITS
  return {
    maximumCharacters: normalizePositiveInteger(options.maximumCharacters, defaults.maximumCharacters, defaults.maximumCharacters),
    maximumArchiveEntries: normalizePositiveInteger(options.maximumArchiveEntries, defaults.maximumArchiveEntries, defaults.maximumArchiveEntries),
    maximumArchiveUncompressedBytes: normalizePositiveInteger(options.maximumArchiveUncompressedBytes, defaults.maximumArchiveUncompressedBytes, defaults.maximumArchiveUncompressedBytes),
    maximumArchiveEntryBytes: normalizePositiveInteger(options.maximumArchiveEntryBytes, defaults.maximumArchiveEntryBytes, defaults.maximumArchiveEntryBytes),
    maximumCompressionRatio: normalizePositiveInteger(options.maximumCompressionRatio, defaults.maximumCompressionRatio, defaults.maximumCompressionRatio),
    maximumPages: normalizePositiveInteger(options.maximumPages, defaults.maximumPages, defaults.maximumPages),
    maximumSlides: normalizePositiveInteger(options.maximumSlides, defaults.maximumSlides, defaults.maximumSlides),
    maximumSheets: normalizePositiveInteger(options.maximumSheets, defaults.maximumSheets, defaults.maximumSheets),
    maximumXmlNodes: normalizePositiveInteger(options.maximumXmlNodes, defaults.maximumXmlNodes, defaults.maximumXmlNodes),
    maximumCells: normalizePositiveInteger(options.maximumCells, defaults.maximumCells, defaults.maximumCells)
  }
}

function sanitizeSourceUnits(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, EMAIL_DOCUMENT_EXTRACTION_LIMITS.maximumPages).map((item, index) => ({
    type: String(item?.type || 'section').trim().slice(0, 24) || 'section',
    label: String(item?.label || `来源 ${index + 1}`).trim().slice(0, 180) || `来源 ${index + 1}`,
    index: Number.isSafeInteger(Number(item?.index)) ? Number(item.index) : index + 1,
    characters: Math.max(0, Math.min(Number(item?.characters) || 0, EMAIL_DOCUMENT_EXTRACTION_LIMITS.maximumCharacters))
  }))
}

export async function extractEmailDocumentText(value = {}, options = {}) {
  const content = value.content
  if (!Buffer.isBuffer(content) || !content.length) {
    throw documentError(
      '附件内容为空或不可读取',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_EMPTY'
    )
  }
  const format = emailDocumentFormatForMetadata(value)
  if (!format) {
    throw documentError(
      '附件类型与文件扩展名不一致，或不是受支持的 PDF/Office Open XML 文档',
      415,
      'EMAIL_ATTACHMENT_TRANSLATION_UNSUPPORTED_TYPE'
    )
  }
  const maximumBytes = normalizePositiveInteger(
    options.maximumBytes,
    EMAIL_DOCUMENT_EXTRACTION_LIMITS.maximumBytes,
    EMAIL_DOCUMENT_EXTRACTION_LIMITS.maximumBytes
  )
  if (content.length > maximumBytes) {
    throw documentError(
      `可提取的 PDF/Office 附件不能超过 ${Math.floor(maximumBytes / 1024 / 1024)} MiB`,
      413,
      'EMAIL_ATTACHMENT_TRANSLATION_TOO_LARGE'
    )
  }

  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs,
    EMAIL_DOCUMENT_EXTRACTION_LIMITS.timeoutMs,
    10_000
  )
  const transferable = Uint8Array.from(content)
  const worker = new Worker(new URL('./emailDocumentTextWorker.js', import.meta.url), {
    workerData: {
      content: transferable.buffer,
      format,
      limits: workerLimits(options)
    },
    transferList: [transferable.buffer],
    resourceLimits: {
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 32,
      codeRangeSizeMb: 32,
      stackSizeMb: 4
    }
  })

  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.removeAllListeners()
      callback()
    }
    const timer = setTimeout(() => {
      void worker.terminate()
      finish(() => reject(documentError(
        '文档安全提取超时，已终止解析',
        408,
        'EMAIL_ATTACHMENT_TRANSLATION_TIMEOUT'
      )))
    }, timeoutMs)
    timer.unref?.()

    worker.once('message', (message) => {
      finish(() => {
        if (!message?.ok) {
          reject(documentError(
            String(message?.message || '文档无法安全解析'),
            Number(message?.statusCode) || 422,
            String(message?.code || 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID')
          ))
          return
        }
        const text = String(message.text || '').trim()
        if (!text || text.length > EMAIL_DOCUMENT_EXTRACTION_LIMITS.maximumCharacters) {
          reject(documentError(
            text ? '文档提取结果超过安全字符上限' : '文档没有可翻译的文本层',
            text ? 413 : 422,
            text
              ? 'EMAIL_ATTACHMENT_TRANSLATION_TEXT_TOO_LARGE'
              : 'EMAIL_ATTACHMENT_TRANSLATION_NO_TEXT_LAYER'
          ))
          return
        }
        resolve({
          text,
          format: String(message.format || format),
          sourceUnits: sanitizeSourceUnits(message.sourceUnits),
          extractedCharacters: text.length
        })
      })
    })
    worker.once('error', (error) => {
      finish(() => reject(documentError(
        error?.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? '文档解析超过内存上限，已安全终止'
          : '文档解析进程异常终止',
        error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 413 : 422,
        error?.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? 'EMAIL_ATTACHMENT_TRANSLATION_RESOURCE_LIMIT'
          : 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID'
      )))
    })
    worker.once('exit', (code) => {
      if (settled) return
      finish(() => reject(documentError(
        `文档解析进程提前退出（${code}）`,
        422,
        'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID'
      )))
    })
  })
}
