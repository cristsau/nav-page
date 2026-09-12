// Two real built Vue artifacts + real browser reload/storage/SW, synthetic APIs only.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join, extname, sep } from 'node:path'
import { tmpdir } from 'node:os'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const newDist = resolve('app/dist'), oldDist = resolve(process.env.NAV_OLD_DIST || '')
const extensionRoot = resolve('extension')
const skipExtension = process.env.NAV_SKIP_EXTENSION_UI === '1'
assert.ok(process.env.NAV_OLD_DIST && oldDist !== newDist, 'provide a separate prior build directory')
const oldBuild = JSON.parse(await readFile(join(oldDist, 'version.json'), 'utf8'))
const newBuild = JSON.parse(await readFile(join(newDist, 'version.json'), 'utf8'))
assert.notEqual(oldBuild.buildId, newBuild.buildId)
const output = await mkdtemp(join(tmpdir(), 'nav-app-updates-ui-'))
let activeDist = oldDist, versionMode = 'normal'
const checks = [], errors = [], unexpected = [], frameEvents = []
const user = { id: 'synthetic-update-user', username: 'synthetic-update-user', role: 'admin', status: 'approved' }
const groups = [{ id: 'synthetic-group', name: '合成收藏', order: 0, icon: 'folder' }]
const bookmarks = [{ id: 'synthetic-bookmark', groupId: groups[0].id, title: 'Synthetic retained bookmark', url: 'https://example.test/saved', order: 0, tags: [], healthStatus: 'unchecked' }]
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const sendJson = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/version.json' && versionMode !== 'normal') {
      if (versionMode === '503') return sendJson(res, {}, 503)
      if (versionMode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>login</html>'); return }
      if (versionMode === 'hang') return
    }
    if (path.startsWith('/api/')) {
      if (req.method !== 'GET' && !(req.method === 'PUT' && path === '/api/settings/appConfig')) {
        unexpected.push(`${req.method} ${path}`); return sendJson(res, {}, 403)
      }
      let body = {}
      if (path === '/api/auth/session') body = { user: (req.headers.cookie || '').includes('nav-update-fixture=synthetic-session') ? user : null }
      else if (path === '/api/groups') body = { groups }
      else if (path === '/api/bookmarks') body = { bookmarks }
      else if (path === '/api/notes') body = { notes: [] }
      else if (path.includes('/settings')) body = { value: null, settings: {} }
      else if (path.includes('search-engines')) body = { engines: [] }
      else if (path.includes('notifications')) body = { notifications: [], unreadCount: 0 }
      else if (path === '/api/auth/device-keys/config') body = { enabled: false, configured: false }
      else if (path === '/api/auth/capabilities') body = { emailLogin: false }
      else if (path === '/api/auth/oauth/config') body = { providers: {} }
      else if (path === '/api/auth/oauth/identities') body = { identities: [] }
      else if (path === '/api/auth/sessions') body = { sessions: [] }
      else if (path === '/api/auth/recovery-codes/status') body = { configured: false, activeCodeCount: 0 }
      else if (path === '/api/auth/account/email') body = { verified: false }
      return sendJson(res, body)
    }
    const root = path.startsWith('/__extension/') ? extensionRoot : activeDist
    const relativePath = root === extensionRoot ? path.slice('/__extension'.length) : path
    let file = resolve(root, `.${decodeURIComponent(relativePath)}`)
    if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403); res.end(); return }
    if (!extname(path)) file = join(activeDist, 'index.html')
    const data = await readFile(file)
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(data)
  } catch { res.writeHead(404); res.end('Not found') }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true,
  args: ['--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
let status = 'FAIL'
const pass = (name) => { checks.push(name); console.log(`PASS ${name}`) }
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'allow' })
  await context.addCookies([{ name: 'nav-update-fixture', value: 'synthetic-session', url: origin, httpOnly: true, sameSite: 'Lax' }])
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-bookmark-id="synthetic-bookmark"]').waitFor()
  await page.goto(`${origin}/settings?category=integrations`, { waitUntil: 'domcontentloaded' })
  const panel = page.locator('.app-update-panel')
  await panel.waitFor()
  await page.waitForFunction(() => navigator.serviceWorker.controller)
  await panel.getByRole('button', { name: '检查网页更新', exact: true }).click()
  await panel.getByText('当前网页已是本站发布版本', { exact: true }).waitFor()
  assert.ok((await panel.innerText()).includes(oldBuild.buildId))
  pass('actual-prior-build-version-and-active-service-worker')
  await page.evaluate(async () => {
    localStorage.setItem('nav-update-fixture', 'synthetic-local-setting')
    sessionStorage.setItem('nav-update-fixture', 'synthetic-session-setting')
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('nav-update-fixture', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('records')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('records', 'readwrite')
        tx.objectStore('records').put({ title: 'Synthetic retained draft' }, 'draft')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
      }
    })
  })
  for (const mode of ['503', 'html', 'hang']) {
    versionMode = mode
    await panel.getByRole('button', { name: '检查网页更新', exact: true }).click()
    await panel.getByText('暂时无法确认是否有更新', { exact: true }).waitFor({ timeout: 12_000 })
    assert.equal(await panel.getByRole('button', { name: '检查网页更新', exact: true }).isEnabled(), true)
    assert.equal(await panel.getByText('当前网页已是本站发布版本', { exact: true }).count(), 0)
    pass(`failed-check-is-not-latest-${mode}`)
  }
  versionMode = 'normal'
  await context.setOffline(true)
  await panel.getByRole('button', { name: '检查网页更新', exact: true }).click()
  await panel.getByText('暂时无法确认是否有更新', { exact: true }).waitFor()
  await context.setOffline(false)
  activeDist = newDist
  await panel.getByRole('button', { name: '检查网页更新', exact: true }).click()
  await panel.getByRole('button', { name: '应用更新并刷新' }).waitFor()
  assert.ok((await panel.innerText()).includes(newBuild.buildId))
  pass('offline-retry-and-new-built-artifact-detected')
  let navigations = 0
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) frameEvents.push(frame.url()) })
  // Vue history.replaceState also emits framenavigated; count actual document requests.
  page.on('request', (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++ })
  page.once('dialog', (dialog) => dialog.dismiss())
  await panel.getByRole('button', { name: '应用更新并刷新' }).click()
  await page.waitForFunction(() => !document.querySelector('.app-update-panel button').disabled)
  assert.equal(navigations, 0)
  pass('cancel-update-does-not-refresh')
  for (const width of [320, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await panel.scrollIntoViewIfNeeded()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    for (const button of await panel.locator('button').all()) assert.ok((await button.boundingBox()).height >= 44)
    pass(`version-panel-layout-and-touch-targets-${width}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, 'updates-390.png') })
  page.once('dialog', (dialog) => dialog.accept())
  await panel.getByRole('button', { name: '应用更新并刷新' }).click()
  await page.waitForFunction((id) => document.querySelector('.app-update-panel__version')?.textContent.includes(id), newBuild.buildId)
  assert.equal(navigations, 1)
  await page.waitForFunction(() => document.querySelector('.app-update-panel__status')?.textContent.includes('当前网页已是本站发布版本'))
  assert.ok((await context.cookies()).some((cookie) => cookie.name === 'nav-update-fixture' && cookie.value === 'synthetic-session' && cookie.httpOnly))
  const retained = await page.evaluate(async () => ({
    local: localStorage.getItem('nav-update-fixture'), session: sessionStorage.getItem('nav-update-fixture'),
    draft: await new Promise((resolve, reject) => {
      const request = indexedDB.open('nav-update-fixture', 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, item = db.transaction('records').objectStore('records').get('draft')
        item.onsuccess = () => { db.close(); resolve(item.result) }
        item.onerror = () => { db.close(); reject(item.error) }
      }
    })
  }))
  assert.deepEqual(retained, { local: 'synthetic-local-setting', session: 'synthetic-session-setting', draft: { title: 'Synthetic retained draft' } })
  pass('real-reload-loads-new-build-and-retains-cookie-local-session-indexeddb')
  assert.equal(await page.locator('#settings-browser').count(), 1)
  pass('browser-settings-deep-link-anchor-preserved')
  await panel.scrollIntoViewIfNeeded()
  assert.notEqual(await panel.locator('.btn--primary').count(), 1) // same build has no apply action
  await page.screenshot({ path: join(output, 'updates-current-390.png') })
  // Network failure never sends a logout nor changes the API contracts.
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-bookmark-id="synthetic-bookmark"]').waitFor()
  pass('post-update-authenticated-bookmark-still-visible')
  await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/settings?category=integrations'))
  await panel.waitFor()
  activeDist = oldDist
  await panel.getByRole('button', { name: '检查网页更新', exact: true }).click()
  await panel.getByRole('button', { name: '应用更新并刷新' }).waitFor()
  await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/'))
  await page.getByRole('button', { name: '添加书签', exact: true }).first().click()
  await page.getByPlaceholder('输入书签标题').fill('Synthetic unsaved bookmark')
  const beforeGuard = navigations
  let confirmations = 0
  const rejectUnexpectedConfirmation = async (dialog) => { confirmations++; await dialog.dismiss() }
  page.on('dialog', rejectUnexpectedConfirmation)
  // Deliberately invoke the obscured button: protection must hold even beyond the modal overlay.
  await page.locator('.app-update-notice').getByRole('button', { name: '更新并刷新', exact: true }).evaluate((button) => button.click())
  await page.getByText('收藏或排序尚未完成。请先保存并关闭编辑窗口，再更新。', { exact: true }).waitFor({ state: 'attached' })
  assert.equal(navigations, beforeGuard)
  assert.equal(confirmations, 0)
  assert.equal(await page.getByPlaceholder('输入书签标题').inputValue(), 'Synthetic unsaved bookmark')
  page.off('dialog', rejectUnexpectedConfirmation)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  activeDist = newDist
  pass('actual-bookmark-editor-blocks-refresh-and-keeps-unsaved-text')
  if (!skipExtension) {
  const extensionContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  await extensionContext.addInitScript(() => {
    const settings = { navBaseUrl: 'https://nav.cristsau.cn', lastGroupId: 'synthetic-saved-group' }
    globalThis.__extensionSettings = settings
    globalThis.__updateCalls = 0
    globalThis.chrome = {
      runtime: { getManifest: () => ({ version: '1.2.1' }),
        requestUpdateCheck: (callback) => { globalThis.__updateCalls++; callback('update_available', { version: '1.2.2' }) },
        onUpdateAvailable: { addListener() {} } },
      storage: { sync: { get: async (defaults) => ({ ...defaults, ...settings }), set: async (next) => Object.assign(settings, next) } }
    }
  })
  const extensionPage = await extensionContext.newPage()
  extensionPage.on('pageerror', (error) => errors.push(error.message))
  await extensionPage.goto(`${origin}/__extension/options.html`)
  assert.equal(await extensionPage.locator('#extensionVersion').innerText(), '1.2.1')
  await extensionPage.locator('#navBaseUrlInput').fill('https://example.test')
  await extensionPage.getByRole('button', { name: '检查扩展更新', exact: true }).click()
  await extensionPage.getByText('新版 1.2.2 已可用。请先保存设置并关闭扩展窗口，等待浏览器完成更新。', { exact: true }).waitFor()
  assert.equal(await extensionPage.locator('#navBaseUrlInput').inputValue(), 'https://example.test')
  assert.deepEqual(await extensionPage.evaluate(() => __extensionSettings), { navBaseUrl: 'https://nav.cristsau.cn', lastGroupId: 'synthetic-saved-group' })
  assert.ok(await extensionPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await extensionPage.screenshot({ path: join(output, 'extension-options-390.png'), fullPage: true })
  pass('actual-extension-options-with-mocked-browser-api-keeps-settings-and-unsaved-field')
  await extensionPage.getByRole('button', { name: '检查扩展更新', exact: true }).click()
  assert.equal(await extensionPage.evaluate(() => __updateCalls), 1)
  assert.match(await extensionPage.locator('#updateStatus').innerText(), /刚刚检查过/)
  pass('extension-options-repeat-check-does-not-spam-browser')
  await extensionContext.close()
  }
  assert.deepEqual(unexpected, [])
  assert.deepEqual(errors, [])
  status = 'PASS'
} catch (error) {
  errors.push(error.stack || String(error)); throw error
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ status, scope: 'development two-build Chromium + real SW/reload/storage; synthetic auth/API; not iPhone, store review, real credentials, or production', extensionRuntime: skipExtension ? 'NOT_RUN: web-only release' : 'mocked', oldBuild, newBuild, checks, errors, unexpected, frameEvents }, null, 2))
  await browser.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  console.log(JSON.stringify({ status, checks: checks.length, output }))
}
