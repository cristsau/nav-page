const DEFAULT_NAV_BASE_URL = 'https://nav.skrskr.net'

const navBaseUrlInput = document.getElementById('navBaseUrlInput')
const saveBtn = document.getElementById('saveBtn')
const openNavBtn = document.getElementById('openNavBtn')
const statusMessage = document.getElementById('statusMessage')

init().catch((error) => {
  setStatus(error.message || '初始化失败', 'error')
})

async function init() {
  const settings = await chrome.storage.sync.get({
    navBaseUrl: DEFAULT_NAV_BASE_URL
  })

  navBaseUrlInput.value = settings.navBaseUrl || DEFAULT_NAV_BASE_URL

  saveBtn.addEventListener('click', handleSave)
  openNavBtn.addEventListener('click', handleOpen)
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value || DEFAULT_NAV_BASE_URL)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('只支持 HTTP 或 HTTPS 地址')
  }

  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''
  return parsed.origin
}

function getOriginPattern(baseUrl) {
  return `${new URL(baseUrl).origin}/*`
}

async function ensureOriginPermission(baseUrl) {
  const origin = getOriginPattern(baseUrl)
  const hasPermission = await chrome.permissions.contains({ origins: [origin] })
  if (hasPermission) return true

  return chrome.permissions.request({ origins: [origin] })
}

async function handleSave() {
  saveBtn.disabled = true
  setStatus('正在验证连接...')

  try {
    const navBaseUrl = normalizeBaseUrl(navBaseUrlInput.value.trim())
    const granted = await ensureOriginPermission(navBaseUrl)
    if (!granted) {
      throw new Error('未授予该站点访问权限，设置没有保存')
    }

    const response = await fetch(`${navBaseUrl}/api/auth/session`, {
      credentials: 'include'
    })

    if (!response.ok) {
      throw new Error(`站点连接失败（HTTP ${response.status}）`)
    }

    await chrome.storage.sync.set({ navBaseUrl })
    navBaseUrlInput.value = navBaseUrl
    setStatus('连接正常，设置已保存。', 'success')
  } catch (error) {
    setStatus(error.message || '地址无效或站点无法连接', 'error')
  } finally {
    saveBtn.disabled = false
  }
}

function handleOpen() {
  try {
    chrome.tabs.create({ url: normalizeBaseUrl(navBaseUrlInput.value.trim()) })
  } catch (error) {
    setStatus(error.message, 'error')
  }
}

function setStatus(message, type = '') {
  statusMessage.textContent = message
  statusMessage.className = type ? `status is-${type}` : 'status'
}
