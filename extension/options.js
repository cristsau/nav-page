const DEFAULT_NAV_BASE_URL = 'https://nav.skrskr.net'

const navBaseUrlInput = document.getElementById('navBaseUrlInput')
const saveBtn = document.getElementById('saveBtn')
const openNavBtn = document.getElementById('openNavBtn')
const statusMessage = document.getElementById('statusMessage')

init().catch((error) => {
  setStatus(error.message || '初始化失败')
})

async function init() {
  const settings = await chrome.storage.sync.get({
    navBaseUrl: DEFAULT_NAV_BASE_URL
  })

  navBaseUrlInput.value = settings.navBaseUrl || DEFAULT_NAV_BASE_URL

  saveBtn.addEventListener('click', handleSave)
  openNavBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: navBaseUrlInput.value.trim() || DEFAULT_NAV_BASE_URL })
  })
}

async function handleSave() {
  const navBaseUrl = navBaseUrlInput.value.trim() || DEFAULT_NAV_BASE_URL
  await chrome.storage.sync.set({ navBaseUrl })
  setStatus('已保存，扩展会使用这个地址连接 NAV。')
}

function setStatus(message) {
  statusMessage.textContent = message
}
