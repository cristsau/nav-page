const MAX_RICH_CONTENT_BYTES = 512 * 1024
const MAX_RICH_CONTENT_NODES = 10_000
const MAX_RICH_CONTENT_DEPTH = 32
const MAX_TEXT_NODE_LENGTH = 24_000
const ALLOWED_NODE_TYPES = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList',
  'listItem', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'hardBreak',
  'horizontalRule', 'image', 'table', 'tableRow', 'tableHeader', 'tableCell'
])
const ALLOWED_MARK_TYPES = new Set([
  'bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'link'
])
const BLOCK_NODE_TYPES = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'taskList',
  'blockquote', 'codeBlock', 'horizontalRule', 'image', 'table'
])
const ALLOWED_CHILD_TYPES = new Map([
  ['doc', BLOCK_NODE_TYPES],
  ['paragraph', new Set(['text', 'hardBreak'])],
  ['heading', new Set(['text', 'hardBreak'])],
  ['bulletList', new Set(['listItem'])],
  ['orderedList', new Set(['listItem'])],
  ['listItem', BLOCK_NODE_TYPES],
  ['taskList', new Set(['taskItem'])],
  ['taskItem', BLOCK_NODE_TYPES],
  ['blockquote', BLOCK_NODE_TYPES],
  ['codeBlock', new Set(['text'])],
  ['table', new Set(['tableRow'])],
  ['tableRow', new Set(['tableHeader', 'tableCell'])],
  ['tableHeader', BLOCK_NODE_TYPES],
  ['tableCell', BLOCK_NODE_TYPES],
  ['text', new Set()],
  ['hardBreak', new Set()],
  ['horizontalRule', new Set()],
  ['image', new Set()]
])

function safeHttpUrl(value, { allowedOrigin = '' } = {}) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    if (url.username || url.password) return ''
    if (allowedOrigin && url.origin !== allowedOrigin) return ''
    return url.toString()
  } catch {
    return ''
  }
}

function sanitizeMarks(value) {
  if (!Array.isArray(value)) return undefined
  const marks = []
  for (const rawMark of value.slice(0, 16)) {
    const type = String(rawMark?.type || '')
    if (!ALLOWED_MARK_TYPES.has(type)) continue
    const mark = { type }
    if (type === 'link') {
      const href = safeHttpUrl(rawMark?.attrs?.href)
      if (!href) continue
      mark.attrs = {
        href,
        target: '_blank',
        rel: 'noopener noreferrer nofollow'
      }
    }
    marks.push(mark)
  }
  return marks.length ? marks : undefined
}

function sanitizeNodeAttrs(type, value, options) {
  const attrs = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  if (type === 'heading') {
    const level = Number(attrs.level)
    return { level: [1, 2, 3].includes(level) ? level : 2 }
  }
  if (type === 'paragraph') {
    const textAlign = new Set(['left', 'center', 'right', 'justify']).has(attrs.textAlign)
      ? attrs.textAlign
      : null
    return textAlign ? { textAlign } : undefined
  }
  if (type === 'taskItem') return { checked: Boolean(attrs.checked) }
  if (type === 'image') {
    const src = safeHttpUrl(attrs.src, { allowedOrigin: options.allowedImageOrigin })
    if (!src) throw new TypeError('Rich content contains an unapproved image URL')
    return {
      src,
      alt: String(attrs.alt || '').slice(0, 300),
      title: String(attrs.title || '').slice(0, 300)
    }
  }
  if (type === 'tableCell' || type === 'tableHeader') {
    const colspan = Math.max(1, Math.min(20, Number(attrs.colspan) || 1))
    const rowspan = Math.max(1, Math.min(100, Number(attrs.rowspan) || 1))
    const colwidth = Array.isArray(attrs.colwidth)
      ? attrs.colwidth.map(Number).filter((item) => Number.isFinite(item) && item > 0).slice(0, 20)
      : null
    return { colspan, rowspan, colwidth: colwidth?.length ? colwidth : null }
  }
  return undefined
}

export function sanitizeTiptapDocument(value, {
  allowedImageOrigin = ''
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'doc') {
    throw new TypeError('contentJson must be a Tiptap document')
  }
  let nodeCount = 0
  const sanitizeNode = (rawNode, depth, parentType = null) => {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
      throw new TypeError('Rich content contains an invalid node')
    }
    if (depth > MAX_RICH_CONTENT_DEPTH || ++nodeCount > MAX_RICH_CONTENT_NODES) {
      throw new TypeError('Rich content is too complex')
    }
    const type = String(rawNode.type || '')
    if (!ALLOWED_NODE_TYPES.has(type)) {
      throw new TypeError(`Unsupported rich content node: ${type || 'unknown'}`)
    }
    if (parentType && !ALLOWED_CHILD_TYPES.get(parentType)?.has(type)) {
      throw new TypeError(`Rich content node ${type} is not allowed inside ${parentType}`)
    }
    const node = { type }
    if (type === 'text') {
      node.text = String(rawNode.text || '').slice(0, MAX_TEXT_NODE_LENGTH)
      if (!node.text) return null
      const marks = sanitizeMarks(rawNode.marks)
      if (marks) node.marks = marks
      return node
    }

    const attrs = sanitizeNodeAttrs(type, rawNode.attrs, { allowedImageOrigin })
    if (attrs) node.attrs = attrs
    if (Array.isArray(rawNode.content)) {
      const children = rawNode.content
        .map((child) => sanitizeNode(child, depth + 1, type))
        .filter(Boolean)
      if (children.length) node.content = children
    } else if (rawNode.content !== undefined) {
      throw new TypeError('Rich content node content must be an array')
    }
    return node
  }

  const document = sanitizeNode(value, 0)
  if (!Array.isArray(document.content) || !document.content.length) {
    document.content = [{ type: 'paragraph' }]
  }
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_RICH_CONTENT_BYTES) {
    throw new TypeError('Rich content exceeds 512 KB')
  }
  return document
}

export function plainTextToTiptapDocument(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n')
  return {
    type: 'doc',
    content: (lines.length ? lines : ['']).map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line.slice(0, MAX_TEXT_NODE_LENGTH) }] } : {})
    }))
  }
}

export function tiptapDocumentText(value) {
  const output = []
  const visit = (node, line) => {
    if (node?.type === 'text') line.push(String(node.text || ''))
    if (node?.type === 'hardBreak') line.push('\n')
    for (const child of Array.isArray(node?.content) ? node.content : []) visit(child, line)
    if (new Set([
      'paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem',
      'taskItem', 'tableRow'
    ]).has(node?.type)) {
      const text = line.join('').trimEnd()
      if (text) output.push(text)
      line.length = 0
    }
  }
  visit(value, [])
  return output.join('\n').trim()
}

export function normalizeContentFormat(value, fallback = 'plain') {
  const format = String(value || fallback).trim().toLowerCase()
  return format === 'tiptap-json' ? 'tiptap-json' : 'plain'
}

export function normalizeEncryptedRichDocument(value, fallback = null) {
  if (value === undefined) return fallback
  if (value === null || value === '') return null
  const encrypted = String(value)
  if (Buffer.byteLength(encrypted, 'utf8') > 1024 * 1024) {
    throw new TypeError('Encrypted rich content exceeds 1 MB')
  }
  return encrypted
}

export function tiptapDocumentImageUrls(value) {
  const urls = []
  const visit = (node) => {
    if (node?.type === 'image' && node?.attrs?.src) {
      urls.push(String(node.attrs.src))
    }
    for (const child of Array.isArray(node?.content) ? node.content : []) visit(child)
  }
  visit(value)
  return [...new Set(urls)]
}

export function assertTiptapImagesAttached(value, attachments = []) {
  const attached = new Set(
    (Array.isArray(attachments) ? attachments : [])
      .map((attachment) => String(attachment?.url || ''))
      .filter(Boolean)
  )
  const missing = tiptapDocumentImageUrls(value).find((url) => !attached.has(url))
  if (missing) {
    throw new TypeError('Rich content image must be present in note attachments')
  }
}
