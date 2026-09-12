// Local built Vue, synthetic account/bookmarks and viewport events only.
// A Chromium fixture cannot reproduce the iPhone WebKit compositor defect.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const origin = process.env.NAV_UI_PREVIEW || 'http://127.0.0.1:4178'
assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin), 'local preview only')
const output = await mkdtemp(join(tmpdir(), 'nav-mobile-dock-'))
const browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true,
  args: ['--disable-gpu', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
const checks = [], errors = [], unexpected = []
let status = 'FAIL'
const user = { id: 'synthetic-dock-user', username: 'synthetic-dock-user', role: 'admin', status: 'approved' }
const groups = [{ id: 'synthetic-group', name: '合成收藏', order: 0, icon: 'folder' }]
const bookmarks = Array.from({ length: 4 }, (_, i) => ({ id: `synthetic-bookmark-${i}`, groupId: groups[0].id,
  title: i === 3 ? 'Example Client System | Order #123456 Long Title' : `合成书签 ${i + 1}`,
  url: `https://example.test/dashboard/orders/${i}`, order: i, tags: ['技术社区', '工具'], healthStatus: 'unchecked' }))
function passed(name) { checks.push(name); console.log(`PASS ${name}`) }
async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function bottomCheck(page, gap = 10) {
  await page.waitForFunction(gap => {
    const dock = document.querySelector('.mobile-tabs')
    return dock && !dock.inert && getComputedStyle(dock).visibility === 'visible'
      && Math.abs(dock.getBoundingClientRect().bottom - (innerHeight - gap)) < 2
  }, gap)
  const result = await page.evaluate(() => {
    const nav = document.querySelector('.mobile-tabs'), rect = nav.getBoundingClientRect()
    return { top: rect.top, height: rect.height, reserve: parseFloat(getComputedStyle(document.querySelector('.app-shell__content')).paddingBottom),
      rootChild: nav.parentElement === document.body, overflow: document.documentElement.scrollWidth > innerWidth + 1,
      hit: nav.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) }
  })
  assert.ok(result.rootChild && result.hit && !result.overflow)
  assert.ok(result.reserve >= result.height + gap + 11)
}
try {
 const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
   reducedMotion: 'reduce', serviceWorkers: 'block' })
 await context.addInitScript(() => {
   const values = {}, viewport = new EventTarget()
   for (const [key, fallback] of Object.entries({ height: () => innerHeight, width: () => innerWidth, offsetTop: () => 0, offsetLeft: () => 0, scale: () => 1 }))
     Object.defineProperty(viewport, key, { get: () => values[key] ?? fallback() })
   Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
   window.__dockViewport = next => { Object.assign(values, next); viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll')) }
   Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
 })
 await context.route('**/*', async route => {
   const request = route.request(), url = new URL(request.url()), path = url.pathname.slice(4)
   if (url.origin !== origin) return route.abort()
   if (!url.pathname.startsWith('/api/')) return route.continue()
   if (request.method() !== 'GET' && !(request.method() === 'PUT' && path === '/settings/appConfig')) {
     unexpected.push(request.method() + ' ' + path); return route.fulfill({ status: 403, json: {} })
   }
   let body = {}
   if (path === '/auth/session') body = { user }
   else if (path === '/groups') body = { groups }
   else if (path === '/bookmarks') body = { bookmarks }
   else if (path === '/notes') body = { notes: [] }
   else if (path.includes('settings')) body = { value: null, settings: {} }
   else if (path.includes('search-engines')) body = { engines: [] }
   else if (path.includes('notifications')) body = { notifications: [], unreadCount: 0 }
   else if (path === '/auth/device-keys/config') body = { enabled: false, configured: false }
   else if (path === '/auth/capabilities') body = { emailLogin: false }
   else if (path === '/auth/oauth/config') body = { providers: {} }
   else if (path === '/auth/oauth/identities') body = { identities: [] }
   else if (path === '/auth/sessions') body = { sessions: [] }
   else if (path === '/auth/recovery-codes/status') body = { configured: false, activeCodeCount: 0 }
   else if (path === '/auth/account/email') body = { verified: false }
   await route.fulfill({ status: 200, json: body })
 })
 const page = await context.newPage()
 page.on('pageerror', error => errors.push(error.message))
 await page.goto(origin, { waitUntil: 'domcontentloaded' })
 await page.locator('[data-bookmark-id="synthetic-bookmark-3"]').waitFor()
 for (const width of [320, 375, 390, 430, 768]) {
   await page.setViewportSize({ width, height: 844 })
   await frames(page)
   await page.evaluate(() => scrollTo(0, 0)); await bottomCheck(page)
   await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await bottomCheck(page)
   const footer = await page.locator('.page-footer').boundingBox(), dock = await page.locator('.mobile-tabs').boundingBox()
   assert.ok(footer.y + footer.height < dock.y, 'footer clears dock at document end')
   const mainPadding = await page.locator('.main').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom))
   assert.ok(dock.y - (footer.y + footer.height) <= mainPadding + 14, `no duplicate blank footer reserve at ${width}`)
   assert.equal(await page.locator('.bookmark-card__title').first().evaluate(el => getComputedStyle(el).textAlign), 'left')
   passed(`scroll-top-bottom-and-long-title-${width}`)
 }
 await page.setViewportSize({ width: 390, height: 844 }); await bottomCheck(page)
 const search = page.getByRole('combobox')
 await search.focus()
 await page.evaluate(() => __dockViewport({ height: 520, offsetTop: 70 }))
 await page.waitForFunction(() => {
   const dock = document.querySelector('.mobile-tabs')
   return dock.inert && getComputedStyle(dock).visibility === 'hidden'
 })
 assert.equal(await page.locator('.mobile-tabs').isVisible(), false)
 assert.equal(await search.evaluate(el => document.activeElement === el), true)
 passed('keyboard-hides-inert-dock-without-stealing-focus')
 // Keep the broken visual metrics AFTER blur: the actual dynamic viewport is full height.
 await search.evaluate(el => el.blur()); await bottomCheck(page)
 assert.equal(await page.locator('.mobile-tabs').isVisible(), true)
 await page.evaluate(() => { window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
 await bottomCheck(page); passed('blur-and-return-with-stale-visual-viewport')
 await page.evaluate(() => __dockViewport({ height: null, offsetTop: 0 }))
 await page.setViewportSize({ width: 844, height: 390 }); await bottomCheck(page)
 await page.setViewportSize({ width: 390, height: 740 }); await bottomCheck(page)
 await page.setViewportSize({ width: 390, height: 844 }); await bottomCheck(page)
 passed('landscape-portrait-and-toolbar-height-changes')
 const normalHeight = (await page.locator('.mobile-tabs').boundingBox()).height
 const enlarged = await page.addStyleTag({ content: '.mobile-tabs a {font-size:24px!important;line-height:1.6!important}' })
 await page.waitForFunction(() => getComputedStyle(document.querySelector('.mobile-tabs a')).fontSize === '24px')
 await frames(page)
 await bottomCheck(page)
 assert.ok((await page.locator('.mobile-tabs').boundingBox()).height > normalHeight)
 await enlarged.evaluate(el => el.remove()); await bottomCheck(page)
 passed('enlarged-navigation-text-updates-real-reserve')
 // Protect against containing blocks introduced by page transitions/theme layers.
 await page.locator('.app').evaluate(el => { el.style.transform = 'translateZ(0)'; el.style.filter = 'opacity(1)' })
 await bottomCheck(page)
 await page.locator('.app').evaluate(el => { el.style.transform = ''; el.style.filter = '' })
 passed('dock-outside-app-transforms-and-filters')
 // Synthetic home-indicator inset, not a claim of physical Safari safe-area testing.
 await page.locator('.mobile-tabs-viewport').evaluate(el => el.style.paddingBottom = '34px')
 await bottomCheck(page, 34)
 await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
 await page.screenshot({ path: join(output, 'navigation-390-light.png') })
 const lightBackground = await page.locator('.mobile-tabs').evaluate(el => getComputedStyle(el).backgroundColor)
 await page.emulateMedia({ colorScheme: 'dark' })
 await page.waitForFunction(light => document.documentElement.classList.contains('dark') && getComputedStyle(document.querySelector('.mobile-tabs')).backgroundColor !== light, lightBackground)
 await bottomCheck(page, 34)
 await page.screenshot({ path: join(output, 'navigation-390-dark.png') })
 await page.emulateMedia({ colorScheme: 'light' })
 await page.waitForFunction(() => !document.documentElement.classList.contains('dark'))
 passed('safe-area-34-and-light-dark-preview')
 await page.goto(origin + '/settings?category=security', { waitUntil: 'domcontentloaded' })
 await page.locator('.device-key-settings').waitFor(); await bottomCheck(page)
 await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await bottomCheck(page)
 await page.screenshot({ path: join(output, 'security-390.png') })
 passed('settings-route-retains-dock-and-reserve')
 await page.setViewportSize({ width: 1440, height: 900 })
 await page.waitForFunction(() => !document.documentElement.style.getPropertyValue('--mobile-tabs-space'))
 assert.equal(await page.locator('.mobile-tabs').isVisible(), false)
 passed('desktop-removes-mobile-reserve')
 await page.goto(origin + '/about', { waitUntil: 'domcontentloaded' })
 await page.waitForFunction(() => !document.querySelector('.mobile-tabs') && !document.querySelector('.mobile-tabs-viewport'))
 assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-tabs-space')), '')
 passed('public-route-unmount-cleans-probe-and-reserve')
 assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
 await context.close()
 status = 'PASS'
 console.log(JSON.stringify({ status: 'PASS', checks: checks.length, output }))
} finally {
 await writeFile(join(output, 'report.json'), JSON.stringify({ status, scope: 'local Vue + mocked API/visual viewport, NOT physical iPhone', checks, errors, unexpected }, null, 2))
 await browser.close()
}
