const DEFAULT_NAV_BASE_URL = 'https://nav.skrskr.net'
const DEFAULT_GROUP_NAME = '默认分组'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'nav-add-default',
    title: '添加到 DOMO NAV 默认分组',
    contexts: ['page', 'link']
  })

  chrome.contextMenus.create({
    id: 'nav-open-quick-add',
    title: '打开 DOMO NAV 后选择分组再添加',
    contexts: ['page', 'link']
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const pageUrl = info.linkUrl || info.pageUrl || tab?.url
  const pageTitle = tab?.title || info.selectionText || '未命名页面'

  if (!pageUrl) return

  if (info.menuItemId === 'nav-add-default') {
    try {
      await addBookmarkToDefaultGroup({
        url: pageUrl,
        title: pageTitle,
        favicon: tab?.favIconUrl || ''
      })

      notify('DOMO NAV', '已添加到默认分组')
    } catch (error) {
      notify('DOMO NAV', error.message || '添加失败，请先登录 DOMO NAV')
    }
  }

  if (info.menuItemId === 'nav-open-quick-add') {
    const { navBaseUrl } = await getConfig()
    const targetUrl = `${navBaseUrl.replace(/\/$/, '')}/quick-add?url=${encodeURIComponent(pageUrl)}&title=${encodeURIComponent(pageTitle)}&favicon=${encodeURIComponent(tab?.favIconUrl || '')}`
    chrome.tabs.create({ url: targetUrl })
  }
})

async function getConfig() {
  const data = await chrome.storage.sync.get({
    navBaseUrl: DEFAULT_NAV_BASE_URL
  })

  return {
    navBaseUrl: String(data.navBaseUrl || DEFAULT_NAV_BASE_URL).replace(/\/$/, '')
  }
}

async function request(path, options = {}) {
  const { navBaseUrl } = await getConfig()
  const response = await fetch(`${navBaseUrl}/api${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  })

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() }

  if (!response.ok) {
    throw new Error(payload.error || '请求失败')
  }

  return payload
}

async function fetchGroups() {
  const payload = await request('/groups', { method: 'GET' })
  return payload.groups || []
}

async function createGroup(name) {
  const payload = await request('/groups', {
    method: 'POST',
    body: JSON.stringify({
      name,
      icon: '📁',
      color: '#6b8c7a'
    })
  })

  return payload.group
}

async function createBookmark(bookmark) {
  const payload = await request('/bookmarks', {
    method: 'POST',
    body: JSON.stringify(bookmark)
  })

  return payload.bookmark
}

async function ensureDefaultGroup() {
  const groups = await fetchGroups()
  if (groups.length > 0) {
    const existingDefault = groups.find((group) => group.name === DEFAULT_GROUP_NAME)
    return existingDefault || groups[0]
  }

  return createGroup(DEFAULT_GROUP_NAME)
}

async function addBookmarkToDefaultGroup({ url, title, favicon }) {
  const group = await ensureDefaultGroup()
  return createBookmark({
    groupId: group.id,
    title,
    url,
    favicon,
    description: ''
  })
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s9yv1gAAAAASUVORK5CYII=',
    title,
    message
  })
}
