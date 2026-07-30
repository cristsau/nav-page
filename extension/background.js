const DEFAULT_NAV_BASE_URL = 'https://nav.skrskr.net'
const DEFAULT_GROUP_NAME = '默认分组'
const QUICK_ADD_MENU_ID = 'nav-add-last-group'
const PICK_GROUP_MENU_ID = 'nav-open-quick-add'

chrome.runtime.onInstalled.addListener(setupContextMenus)
chrome.runtime.onStartup.addListener(setupContextMenus)

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.lastGroupName || changes.navBaseUrl)) {
    setupContextMenus()
  }
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const page = getPageDetails(info, tab)
  if (!page) {
    await showBadge('!', '#b42318', '当前页面不能收藏')
    return
  }

  if (info.menuItemId === QUICK_ADD_MENU_ID) {
    await quickAdd(page)
  }

  if (info.menuItemId === PICK_GROUP_MENU_ID) {
    const { navBaseUrl } = await getConfig()
    const targetUrl = new URL('/quick-add', navBaseUrl)
    targetUrl.searchParams.set('url', page.url)
    targetUrl.searchParams.set('title', page.title)
    targetUrl.searchParams.set('favicon', page.favicon)
    await chrome.tabs.create({ url: targetUrl.toString() })
  }
})

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'quick-add-last-group') return

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const page = getPageDetails({}, tab)

  if (!page) {
    await showBadge('!', '#b42318', '当前页面不能收藏')
    return
  }

  await quickAdd(page)
})

async function setupContextMenus() {
  await chrome.contextMenus.removeAll()
  const { lastGroupName } = await chrome.storage.sync.get({
    lastGroupName: DEFAULT_GROUP_NAME
  })

  chrome.contextMenus.create({
    id: QUICK_ADD_MENU_ID,
    title: `一键收藏到「${lastGroupName || DEFAULT_GROUP_NAME}」`,
    contexts: ['page', 'link']
  })

  chrome.contextMenus.create({
    id: PICK_GROUP_MENU_ID,
    title: '打开 DOMO NAV 并选择分组',
    contexts: ['page', 'link']
  })
}

function getPageDetails(info, tab) {
  const url = info.linkUrl || info.pageUrl || tab?.url || ''

  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
  } catch {
    return null
  }

  return {
    url,
    title: tab?.title || info.selectionText || new URL(url).hostname,
    favicon: tab?.favIconUrl || ''
  }
}

async function quickAdd(page) {
  await showBadge('…', '#52675a', '正在添加到 DOMO NAV')

  try {
    const result = await addBookmarkToLastGroup(page)
    await showBadge(
      result.created === false ? '=' : 'OK',
      result.created === false ? '#7b6a35' : '#287a4b',
      result.created === false ? '该网页已在这个分组中' : `已添加到「${result.group.name}」`
    )
  } catch (error) {
    await showBadge('!', '#b42318', error.message || '添加失败，请先登录 DOMO NAV')
  }
}

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
    if (response.status === 401) {
      throw new Error('请先登录 DOMO NAV')
    }
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
      icon: 'D',
      color: '#6b8c7a'
    })
  })

  return payload.group
}

async function createBookmark(bookmark) {
  return request('/bookmarks', {
    method: 'POST',
    body: JSON.stringify({
      ...bookmark,
      deduplicate: true
    })
  })
}

async function resolveLastGroup() {
  const groups = await fetchGroups()
  const stored = await chrome.storage.sync.get({
    lastGroupId: '',
    lastGroupName: DEFAULT_GROUP_NAME
  })

  let group = groups.find((item) => item.id === stored.lastGroupId)
  group ||= groups.find((item) => item.name === stored.lastGroupName)
  group ||= groups.find((item) => item.name === DEFAULT_GROUP_NAME)
  group ||= groups[0]
  group ||= await createGroup(DEFAULT_GROUP_NAME)

  await chrome.storage.sync.set({
    lastGroupId: group.id,
    lastGroupName: group.name
  })

  return group
}

async function addBookmarkToLastGroup({ url, title, favicon }) {
  const group = await resolveLastGroup()
  const result = await createBookmark({
    groupId: group.id,
    title,
    url,
    favicon,
    description: ''
  })

  return {
    ...result,
    group
  }
}

async function showBadge(text, color, title) {
  await chrome.action.setBadgeBackgroundColor({ color })
  await chrome.action.setBadgeText({ text })
  await chrome.action.setTitle({ title })

  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' })
    chrome.action.setTitle({ title: '添加到 DOMO NAV' })
  }, 2600)
}
