const DEFAULT_NAV_BASE_URL = 'https://nav.skrskr.net'
const DEFAULT_GROUP_NAME = '默认分组'

const titleInput = document.getElementById('titleInput')
const urlInput = document.getElementById('urlInput')
const groupSelect = document.getElementById('groupSelect')
const newGroupInput = document.getElementById('newGroupInput')
const createGroupBtn = document.getElementById('createGroupBtn')
const saveBtn = document.getElementById('saveBtn')
const loginBtn = document.getElementById('loginBtn')
const openOptionsBtn = document.getElementById('openOptionsBtn')
const statusMessage = document.getElementById('statusMessage')
const navBaseUrlText = document.getElementById('navBaseUrlText')
const authStatusText = document.getElementById('authStatusText')

let navBaseUrl = DEFAULT_NAV_BASE_URL
let currentTab = null
let groups = []
let authenticated = false
let busy = false

init().catch((error) => {
  setStatus(error.message || '初始化失败', 'error')
})

async function init() {
  const settings = await chrome.storage.sync.get({
    navBaseUrl: DEFAULT_NAV_BASE_URL
  })

  navBaseUrl = String(settings.navBaseUrl || DEFAULT_NAV_BASE_URL).replace(/\/$/, '')
  navBaseUrlText.textContent = navBaseUrl

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  currentTab = tabs[0] || null

  titleInput.value = currentTab?.title || ''
  urlInput.value = isHttpUrl(currentTab?.url) ? currentTab.url : ''

  loginBtn.addEventListener('click', () => chrome.tabs.create({ url: `${navBaseUrl}/auth` }))
  openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage())
  createGroupBtn.addEventListener('click', handleCreateGroup)
  saveBtn.addEventListener('click', handleSave)
  groupSelect.addEventListener('change', rememberSelectedGroup)
  newGroupInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleCreateGroup()
  })

  authenticated = await loadSession()
  setInteractiveState()

  if (authenticated) {
    await loadGroups()
  } else {
    setStatus('请先登录 DOMO NAV，再回到这里添加。', 'error')
  }
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

async function request(path, options = {}) {
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
    if (response.status === 401) throw new Error('登录状态已失效，请重新登录')
    throw new Error(payload.error || '请求失败')
  }

  return payload
}

async function loadSession() {
  try {
    const payload = await request('/auth/session', { method: 'GET' })
    if (payload.user?.username) {
      authStatusText.textContent = `已登录：${payload.user.username}`
      authStatusText.className = 'auth-status is-success'
      loginBtn.hidden = true
      return true
    }
  } catch {
    // The explicit signed-out state below is more useful than a raw network error here.
  }

  authStatusText.textContent = '未检测到登录状态'
  authStatusText.className = 'auth-status is-error'
  loginBtn.hidden = false
  return false
}

async function loadGroups(preferredId = '') {
  groups = []
  groupSelect.innerHTML = ''
  setStatus('正在加载分组...')

  const payload = await request('/groups', { method: 'GET' })
  groups = payload.groups || []
  const stored = await chrome.storage.sync.get({ lastGroupId: '' })

  if (groups.length === 0) {
    appendGroupOption('', `${DEFAULT_GROUP_NAME}（保存时创建）`)
    setStatus('还没有分组，首次保存会自动创建默认分组。')
    return
  }

  for (const group of groups) {
    appendGroupOption(group.id, group.name)
  }

  const selectedId = preferredId || stored.lastGroupId
  groupSelect.value = groups.some((group) => group.id === selectedId)
    ? selectedId
    : groups[0].id

  await rememberSelectedGroup()
  setStatus('已就绪，可直接保存。', 'success')
}

function appendGroupOption(id, label) {
  const option = document.createElement('option')
  option.value = id
  option.textContent = label
  groupSelect.appendChild(option)
}

async function rememberSelectedGroup() {
  const group = groups.find((item) => item.id === groupSelect.value)
  if (!group) return

  await chrome.storage.sync.set({
    lastGroupId: group.id,
    lastGroupName: group.name
  })
}

async function ensureDefaultGroup() {
  if (groups.length > 0) {
    return groups.find((item) => item.name === DEFAULT_GROUP_NAME) || groups[0]
  }

  const payload = await request('/groups', {
    method: 'POST',
    body: JSON.stringify({
      name: DEFAULT_GROUP_NAME,
      icon: 'D',
      color: '#6b8c7a'
    })
  })

  groups = [payload.group]
  await loadGroups(payload.group.id)
  return payload.group
}

async function handleCreateGroup() {
  const name = newGroupInput.value.trim()
  if (!name || busy || !authenticated) {
    if (!name) setStatus('请输入分组名称', 'error')
    return
  }

  setBusy(true)
  try {
    const payload = await request('/groups', {
      method: 'POST',
      body: JSON.stringify({
        name,
        icon: 'D',
        color: '#6b8c7a'
      })
    })

    newGroupInput.value = ''
    await loadGroups(payload.group.id)
    setStatus(`已创建「${payload.group.name}」`, 'success')
  } catch (error) {
    setStatus(error.message || '创建分组失败', 'error')
  } finally {
    setBusy(false)
  }
}

async function handleSave() {
  const title = titleInput.value.trim()
  const url = urlInput.value.trim()

  if (!title || !url) {
    setStatus('请先确认标题和地址', 'error')
    return
  }

  if (!isHttpUrl(url)) {
    setStatus('仅支持 http 或 https 网页地址', 'error')
    return
  }

  if (busy || !authenticated) return

  setBusy(true)
  setStatus('正在保存...')

  try {
    let group = groups.find((item) => item.id === groupSelect.value)
    group ||= await ensureDefaultGroup()

    const payload = await request('/bookmarks', {
      method: 'POST',
      body: JSON.stringify({
        groupId: group.id,
        title,
        url,
        favicon: currentTab?.favIconUrl || '',
        description: '',
        deduplicate: true
      })
    })

    await chrome.storage.sync.set({
      lastGroupId: group.id,
      lastGroupName: group.name
    })

    setStatus(
      payload.created === false
        ? `「${title}」已在这个分组中`
        : `已添加到「${group.name}」`,
      'success'
    )
  } catch (error) {
    setStatus(error.message || '保存失败，请先登录 DOMO NAV', 'error')
  } finally {
    setBusy(false)
  }
}

function setBusy(value) {
  busy = value
  setInteractiveState()
  saveBtn.textContent = value ? '处理中...' : '添加到 DOMO NAV'
}

function setInteractiveState() {
  saveBtn.disabled = busy || !authenticated
  createGroupBtn.disabled = busy || !authenticated
  groupSelect.disabled = busy || !authenticated
}

function setStatus(message, type = '') {
  statusMessage.textContent = message || ''
  statusMessage.className = type ? `status is-${type}` : 'status'
}
