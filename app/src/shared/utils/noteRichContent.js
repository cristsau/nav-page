export const EMPTY_TIPTAP_DOCUMENT = Object.freeze({
  type: 'doc',
  content: [{ type: 'paragraph' }]
})

export function isTiptapDocument(value) {
  return Boolean(value && typeof value === 'object' && value.type === 'doc' && Array.isArray(value.content))
}

const CLIENT_ALLOWED_NODES = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList',
  'listItem', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'hardBreak',
  'horizontalRule', 'image', 'table', 'tableRow', 'tableHeader', 'tableCell'
])
const CLIENT_ALLOWED_MARKS = new Set([
  'bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'link'
])

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : ''
  } catch {
    return ''
  }
}

export function sanitizeTiptapDocumentForClient(value) {
  if (!isTiptapDocument(value)) return null
  let nodes = 0
  const visit = (rawNode, depth = 0) => {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) return null
    if (depth > 32 || ++nodes > 10_000 || !CLIENT_ALLOWED_NODES.has(rawNode.type)) return null
    const node = { type: rawNode.type }
    if (rawNode.type === 'text') {
      const text = String(rawNode.text || '').slice(0, 24_000)
      if (!text) return null
      node.text = text
      const marks = (Array.isArray(rawNode.marks) ? rawNode.marks : [])
        .slice(0, 16)
        .flatMap((mark) => {
          if (!CLIENT_ALLOWED_MARKS.has(mark?.type)) return []
          if (mark.type !== 'link') return [{ type: mark.type }]
          const href = safeHttpUrl(mark?.attrs?.href)
          return href ? [{ type: 'link', attrs: { href } }] : []
        })
      if (marks.length) node.marks = marks
      return node
    }
    if (rawNode.type === 'heading') {
      const level = Number(rawNode.attrs?.level)
      node.attrs = { level: [1, 2, 3].includes(level) ? level : 2 }
    } else if (rawNode.type === 'paragraph') {
      const textAlign = ['left', 'center', 'right', 'justify'].includes(rawNode.attrs?.textAlign)
        ? rawNode.attrs.textAlign
        : null
      if (textAlign) node.attrs = { textAlign }
    } else if (rawNode.type === 'taskItem') {
      node.attrs = { checked: Boolean(rawNode.attrs?.checked) }
    } else if (rawNode.type === 'image') {
      const src = safeHttpUrl(rawNode.attrs?.src)
      if (!src) return null
      node.attrs = {
        src,
        alt: String(rawNode.attrs?.alt || '').slice(0, 300),
        title: String(rawNode.attrs?.title || '').slice(0, 300)
      }
    } else if (rawNode.type === 'tableCell' || rawNode.type === 'tableHeader') {
      node.attrs = {
        colspan: Math.max(1, Math.min(20, Number(rawNode.attrs?.colspan) || 1)),
        rowspan: Math.max(1, Math.min(100, Number(rawNode.attrs?.rowspan) || 1)),
        colwidth: Array.isArray(rawNode.attrs?.colwidth)
          ? rawNode.attrs.colwidth.map(Number).filter((item) => Number.isFinite(item) && item > 0).slice(0, 20)
          : null
      }
    }
    const content = (Array.isArray(rawNode.content) ? rawNode.content : [])
      .map((child) => visit(child, depth + 1))
      .filter(Boolean)
    if (content.length) node.content = content
    return node
  }
  const document = visit(value)
  if (!document || document.type !== 'doc') return null
  if (!Array.isArray(document.content) || !document.content.length) {
    document.content = [{ type: 'paragraph' }]
  }
  return document
}

export function plainTextToTiptapDocument(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n')
  return {
    type: 'doc',
    content: (lines.length ? lines : ['']).map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {})
    }))
  }
}

export function tiptapDocumentText(value) {
  if (!isTiptapDocument(value)) return ''
  const blocks = []
  const visit = (node, current = []) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'text') current.push(String(node.text || ''))
    if (node.type === 'hardBreak') current.push('\n')
    const children = Array.isArray(node.content) ? node.content : []
    for (const child of children) visit(child, current)
    if (new Set([
      'paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem',
      'taskItem', 'tableRow'
    ]).has(node.type)) {
      const text = current.join('').trimEnd()
      if (text) blocks.push(text)
      current.length = 0
    }
  }
  visit(value, [])
  return blocks.join('\n').trim()
}

export function tiptapDocumentImageUrls(value) {
  if (!isTiptapDocument(value)) return []
  const urls = new Set()
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'image' && typeof node.attrs?.src === 'string' && node.attrs.src) {
      urls.add(node.attrs.src)
    }
    for (const child of Array.isArray(node.content) ? node.content : []) visit(child)
  }
  visit(value)
  return [...urls]
}

export function removeTiptapImages(value, targetUrl) {
  if (!isTiptapDocument(value) || !targetUrl) return value
  const removeFromNode = (node) => {
    if (!node || typeof node !== 'object') return null
    if (node.type === 'image' && node.attrs?.src === targetUrl) return null
    if (!Array.isArray(node.content)) return { ...node }
    const content = node.content.map(removeFromNode).filter(Boolean)
    return { ...node, content }
  }
  const next = removeFromNode(value)
  if (!next?.content?.length) return plainTextToTiptapDocument('')
  return next
}
