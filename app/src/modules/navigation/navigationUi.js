export const GROUP_ICON_OPTIONS = [
  { name: 'folder', label: '综合' },
  { name: 'briefcase', label: '工作' },
  { name: 'code', label: '开发' },
  { name: 'book', label: '学习' },
  { name: 'palette', label: '创作' },
  { name: 'browser', label: '网页' },
  { name: 'command', label: '工具' },
  { name: 'note', label: '资料' },
  { name: 'pin', label: '收藏' },
  { name: 'heart', label: '生活' },
  { name: 'sparkles', label: 'AI' },
  { name: 'compass', label: '探索' }
]

const GROUP_ICON_NAMES = new Set(GROUP_ICON_OPTIONS.map((option) => option.name))

const GROUP_ICON_KEYWORDS = [
  { pattern: /ai|智能|模型|助手/i, icon: 'sparkles' },
  { pattern: /工作|办公|项目|office|work/i, icon: 'briefcase' },
  { pattern: /开发|代码|编程|github|code|dev/i, icon: 'code' },
  { pattern: /学习|阅读|课程|知识|study|learn|book/i, icon: 'book' },
  { pattern: /设计|创作|图片|灵感|design|art|image/i, icon: 'palette' },
  { pattern: /网页|网站|浏览|web|site|browser/i, icon: 'browser' },
  { pattern: /工具|效率|tool|utility/i, icon: 'command' },
  { pattern: /文档|资料|笔记|note|document/i, icon: 'note' },
  { pattern: /收藏|稍后|favorite|star|pin/i, icon: 'pin' },
  { pattern: /生活|健康|娱乐|life|health/i, icon: 'heart' },
  { pattern: /探索|发现|旅行|explore|travel/i, icon: 'compass' }
]

function stableTextHash(value) {
  let hash = 2166136261

  for (const character of String(value || '')) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function compactHostname(hostname) {
  const normalized = String(hostname || '').replace(/^\[|\]$/g, '').replace(/^www\./i, '')
  if (!normalized.includes(':') || normalized.length <= 28) {
    return normalized
  }

  const parts = normalized.split(':').filter(Boolean)
  if (parts.length < 3) {
    return normalized
  }

  return `[${parts.slice(0, 2).join(':')}:…:${parts[parts.length - 1]}]`
}

function resolveBookmarkMonogram(hostname, title) {
  const normalizedHost = String(hostname || '').replace(/^\[|\]$/g, '').replace(/^www\./i, '')
  if (normalizedHost.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalizedHost)) {
    return 'IP'
  }

  const firstHostLabel = normalizedHost.split('.')[0]
  const source = firstHostLabel && !firstHostLabel.startsWith('xn--')
    ? firstHostLabel
    : String(title || '')
  const chunks = source.match(/[\p{L}\p{N}]+/gu) || []

  if (chunks.length > 1) {
    return chunks
      .slice(0, 2)
      .map((chunk) => Array.from(chunk)[0])
      .join('')
      .toLocaleUpperCase()
  }

  const characters = Array.from(chunks[0] || source).filter((character) => /[\p{L}\p{N}]/u.test(character))
  return characters.slice(0, 2).join('').toLocaleUpperCase() || 'NA'
}

export function resolveBookmarkPresentation(bookmark = {}) {
  const rawUrl = String(bookmark.url || '')
  const title = String(bookmark.title || '')
  let hostname = ''
  let subtitle = ''
  let fullSubtitle = ''

  try {
    const url = new URL(rawUrl)
    hostname = url.hostname.replace(/^www\./i, '')
    const pathSegments = url.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 2)
      .map((segment) => decodePathSegment(segment).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const compactPath = pathSegments.length ? `/${pathSegments.join('/')}` : ''
    subtitle = `${compactHostname(hostname)}${compactPath}`
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    fullSubtitle = url.toString()
  } catch {
    subtitle = rawUrl ? '网址格式无效' : '未提供网址'
    fullSubtitle = subtitle
  }

  const identity = hostname || rawUrl || title || 'bookmark'
  const hash = stableTextHash(identity.toLocaleLowerCase())

  return {
    hash,
    hue: hash % 360,
    monogram: resolveBookmarkMonogram(hostname, title),
    subtitle: subtitle || '未提供网址',
    fullSubtitle: fullSubtitle || subtitle || '未提供网址'
  }
}

export function resolveGroupIcon(icon, groupName = '') {
  const normalizedIcon = String(icon || '').trim().toLowerCase()
  if (GROUP_ICON_NAMES.has(normalizedIcon)) {
    return normalizedIcon
  }

  const searchableText = `${groupName} ${icon || ''}`
  return GROUP_ICON_KEYWORDS.find(({ pattern }) => pattern.test(searchableText))?.icon || 'folder'
}

export function resolveBookmarkAiProvider(config) {
  const generativeProvider = resolveBookmarkGenerativeAiProvider(config)
  if (generativeProvider) {
    return generativeProvider
  }

  const providers = config?.search?.providers || {}
  const brave = providers.brave || {}

  if (
    brave.enabled
    && (
      brave.apiKeyConfigured
      || Boolean(String(brave.apiKey || '').trim())
    )
  ) {
    return 'brave'
  }

  return ''
}

export function resolveBookmarkGenerativeAiProvider(config) {
  const providers = config?.search?.providers || {}
  const chatgpt = providers.chatgpt || {}
  const chatgptHasKey = chatgpt.apiKeyConfigured
    || Boolean(String(chatgpt.apiKey || '').trim())
  const chatgptUsesProxy = String(chatgpt.mode || '').trim().toLowerCase() === 'proxy'
    || Boolean(String(chatgpt.cliProxyBaseUrl || '').trim())

  if (chatgpt.enabled && (chatgptHasKey || chatgptUsesProxy)) {
    return 'chatgpt'
  }

  return ''
}

export function isCurrentBookmarkTagSave({
  requestId,
  currentRequestId,
  bookmarkId,
  currentBookmarkId,
  panelOpen
}) {
  return Boolean(
    panelOpen
    && bookmarkId
    && requestId === currentRequestId
    && bookmarkId === currentBookmarkId
  )
}

export function sanitizeBookmarkUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol)) return ''

    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

export function buildBookmarkAiPrompt(bookmark, providerId = 'chatgpt') {
  const title = String(bookmark?.title || '未命名书签').trim()
  const description = String(bookmark?.description || '').trim()
  const safeUrl = sanitizeBookmarkUrl(bookmark?.url)

  if (providerId === 'brave') {
    let host = ''
    try {
      host = new URL(safeUrl).hostname
    } catch {
      // The title alone is still a useful fallback search query.
    }
    return [title, host, '主要功能 使用指南'].filter(Boolean).join(' ')
  }

  return [
    '请作为导航整理助手分析下面的网页书签。',
    '只依据提供的标题、现有描述和网址判断，不要声称已经读取或核验网页正文。',
    '请用简洁中文，严格按“用途判断 / 推荐标签 / 可执行建议”三部分回答。',
    '推荐标签给出 3 至 5 个短标签；无法访问页面时要明确说明，并仅根据现有信息判断。',
    `标题：${title}`,
    description ? `现有描述：${description}` : '现有描述：无',
    safeUrl ? `网址：${safeUrl}` : '网址：未提供'
  ].join('\n')
}
