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
  urlInput.value = currentTab?.url || ''

  loginBtn.addEventListener('click', () => chrome.tabs.create({ url: `${navBaseUrl}/auth` }))
  openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage())
  createGroupBtn.addEventListener('click', handleCreateGroup)
  saveBtn.addEventListener('click', handleSave)

  await loadGroups()
  await loadSession()
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
    throw new Error(payload.error || '请求失败')
  }

  return payload
}

async function loadGroups() {
  groups = []
  groupSelect.innerHTML = ''
  setStatus('正在加载分组...')

  try {
    const payload = await request('/groups', { method: 'GET' })
    groups = payload.groups || []

    if (groups.length === 0) {
      appendGroupOption('', `${DEFAULT_GROUP_NAME}（保存时自动创建）`)
      groupSelect.value = ''
      setStatus('当前还没有分组，保存时会自动创建默认分组。')
      return
    }

    for (const group of groups) {
      appendGroupOption(group.id, group.name)
    }

    groupSelect.value = groups[0].id
    setStatus('分组已加载')
  } catch (error) {
    setStatus(error.message || '无法加载分组，请先登录 DOMO NAV', 'error')
  }
}

async function loadSession() {
  try {
    const payload = await request('/auth/session', { method: 'GET' })
    if (payload.user?.username) {
      authStatusText.textContent = `已登录：${payload.user.username}`
      authStatusText.className = 'auth-status is-success'
      return
    }
  } catch {}

  authStatusText.textContent = '未检测到 DOMO NAV 登录状态，请先打开登录页。'
  authStatusText.className = 'auth-status is-error'
}

function appendGroupOption(id, label) {
  const option = document.createElement('option')
  option.value = id
  option.textContent = label
  groupSelect.appendChild(option)
}

async function ensureDefaultGroup() {
  if (groups.length > 0) {
    return groups.find((item) => item.name === DEFAULT_GROUP_NAME) || groups[0]
  }

  const payload = await request('/groups', {
    method: 'POST',
    body: JSON.stringify({
      name: DEFAULT_GROUP_NAME,
      icon: '📁',
      color: '#6b8c7a'
    })
  })

  const group = payload.group
  groups = [group]
  await loadGroups()
  return group
}

async function handleCreateGroup() {
  const name = newGroupInput.value.trim()
  if (!name) {
    setStatus('请输入分组名称', 'error')
    return
  }

  try {
    const payload = await request('/groups', {
      method: 'POST',
      body: JSON.stringify({
        name,
        icon: '📁',
        color: '#6b8c7a'
      })
    })

    newGroupInput.value = ''
    groups.push(payload.group)
    await loadGroups()
    groupSelect.value = payload.group.id
    setStatus('分组创建成功', 'success')
  } catch (error) {
    setStatus(error.message || '创建分组失败', 'error')
  }
}

async function handleSave() {
  const title = titleInput.value.trim()
  const url = urlInput.value.trim()

  if (!title || !url) {
    setStatus('请先确认标题和地址', 'error')
    return
  }

  saveBtn.disabled = true
  setStatus('正在保存...')

  try {
    let groupId = groupSelect.value

    if (!groupId) {
      const group = await ensureDefaultGroup()
      groupId = group.id
    }

    await request('/bookmarks', {
      method: 'POST',
      body: JSON.stringify({
        groupId,
        title,
        url,
        favicon: currentTab?.favIconUrl || '',
        description: ''
      })
    })

    setStatus('已成功添加到 DOMO NAV', 'success')
  } catch (error) {
    setStatus(error.message || '保存失败，请先登录 DOMO NAV', 'error')
  } finally {
    saveBtn.disabled = false
  }
}

function setStatus(message, type = '') {
  statusMessage.textContent = message || ''
  statusMessage.className = type ? `status is-${type}` : 'status'
}
