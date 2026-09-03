import {
  getImgBedOrigin,
  normalizeNoteAttachments
} from './noteAttachments.js'

const MANAGED_META_NAMES = new Set([
  'description',
  'referrer',
  'robots',
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image'
])

const MANAGED_META_PROPERTIES = new Set([
  'og:title',
  'og:description',
  'og:type',
  'og:url',
  'og:image',
  'og:site_name'
])

function getHtmlAttribute(tag, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = String(tag).match(
    new RegExp(`\\s${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  )

  return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? '')
    .trim()
    .toLowerCase()
}

function removeManagedHeadElements(head) {
  return head
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, (tag) => {
      const name = getHtmlAttribute(tag, 'name')
      const property = getHtmlAttribute(tag, 'property')
      return MANAGED_META_NAMES.has(name) || MANAGED_META_PROPERTIES.has(property)
        ? ''
        : tag
    })
    .replace(/<link\b[^>]*>/gi, (tag) => {
      const rel = getHtmlAttribute(tag, 'rel')
        .split(/\s+/)
        .filter(Boolean)
      return rel.includes('canonical') ? '' : tag
    })
}

function normalizeMetadataText(value, fallback, maxLength) {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return fallback
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

function buildMetadataTags(metadata) {
  const title = escapeHtml(metadata.title)
  const description = escapeHtml(metadata.description)
  const canonicalUrl = escapeHtml(metadata.canonicalUrl)
  const imageUrl = escapeHtml(metadata.imageUrl)
  const siteName = escapeHtml(metadata.siteName || 'DOMO NAV')

  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="robots" content="noindex, noarchive, nofollow">',
    `<link rel="canonical" href="${canonicalUrl}">`,
    '<meta property="og:type" content="article">',
    `<meta property="og:site_name" content="${siteName}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${canonicalUrl}">`,
    `<meta property="og:image" content="${imageUrl}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${imageUrl}">`
  ].join('\n    ')
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function normalizePublicAppOrigin(value, {
  production = false
} = {}) {
  const input = String(value || '').trim()
  if (!input) {
    if (production) {
      throw new Error('NAV_PUBLIC_APP_ORIGIN is required in production')
    }
    return 'http://localhost:5174'
  }

  let url
  try {
    url = new URL(input)
  } catch {
    throw new Error('NAV_PUBLIC_APP_ORIGIN must be an absolute URL origin')
  }

  const isLocalDevelopment = !production
    && url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)

  if (
    (url.protocol !== 'https:' && !isLocalDevelopment)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('NAV_PUBLIC_APP_ORIGIN must be a bare HTTPS origin')
  }

  return url.origin
}

export function createPublicShareMetadata(record, {
  appOrigin,
  imgBedBaseUrl = ''
}) {
  const titleText = normalizeMetadataText(record?.title, '公开分享', 90)
  const title = `${titleText} · DOMO NAV`
  const description = normalizeMetadataText(
    record?.content,
    `阅读《${titleText}》`,
    160
  )
  const code = String(record?.code || '').trim()
  const canonicalUrl = new URL(
    `/share/${encodeURIComponent(code)}`,
    appOrigin
  ).href
  const allowedImageOrigin = getImgBedOrigin(imgBedBaseUrl)
  const attachments = allowedImageOrigin
    ? normalizeNoteAttachments(record?.attachments, {
        allowedOrigin: allowedImageOrigin,
        maxBytes: Number.MAX_SAFE_INTEGER
      })
    : []
  const imageUrl = attachments[0]?.url
    || new URL('/brand/cristsau-lockup-v2.png', appOrigin).href

  return {
    title,
    description,
    canonicalUrl,
    imageUrl,
    siteName: 'DOMO NAV'
  }
}

export function createUnavailableShareMetadata(code, {
  appOrigin,
  serviceUnavailable = false
}) {
  const normalizedCode = String(code || '').trim()
  const canonicalPath = /^[A-Za-z0-9]{8}$/.test(normalizedCode)
    ? `/share/${encodeURIComponent(normalizedCode)}`
    : '/'
  const canonicalUrl = new URL(
    canonicalPath,
    appOrigin
  ).href

  return {
    title: serviceUnavailable
      ? '暂时无法打开 · DOMO NAV'
      : '分享不可用 · DOMO NAV',
    description: serviceUnavailable
      ? '分享服务暂时不可用，请稍后重试。'
      : '链接可能不存在、已经过期，或已被分享者撤销。',
    canonicalUrl,
    imageUrl: new URL('/brand/cristsau-lockup-v2.png', appOrigin).href,
    siteName: 'DOMO NAV'
  }
}

export function injectPublicShareMetadata(indexHtml, metadata) {
  const html = String(indexHtml || '')
  const openHead = /<head\b[^>]*>/i.exec(html)
  if (!openHead) {
    throw new Error('Frontend index is missing a head element')
  }

  const headStart = openHead.index + openHead[0].length
  const closeHead = /<\/head\s*>/i.exec(html.slice(headStart))
  if (!closeHead) {
    throw new Error('Frontend index is missing a closing head element')
  }

  const headEnd = headStart + closeHead.index
  const cleanedHead = removeManagedHeadElements(html.slice(headStart, headEnd))
    .trim()
  const metadataTags = buildMetadataTags(metadata)
  const nextHead = cleanedHead
    ? `\n    ${metadataTags}\n    ${cleanedHead}\n  `
    : `\n    ${metadataTags}\n  `

  return `${html.slice(0, headStart)}${nextHead}${html.slice(headEnd)}`
}

export function createStandaloneUnavailablePage() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex, noarchive, nofollow">',
    '<title>暂时无法打开 · DOMO NAV</title>',
    '</head>',
    '<body><main><h1>暂时无法打开</h1><p>分享服务暂时不可用，请稍后重试。</p></main></body>',
    '</html>'
  ].join('')
}
