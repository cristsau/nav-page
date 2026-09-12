// Development-host only. All account, bookmark and settings responses are synthetic.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve, join, extname, sep } from 'node:path'
import { hostname } from 'node:os'
import { chromium } from 'file:///D:/DomoDev/nav-store-20260911/harness/node_modules/playwright/index.mjs'
assert.equal(hostname().toUpperCase(), 'WIN-KBP9PCRLBCT')
const dist = resolve(process.argv[2] || 'D:/DomoDev/nav-store-20260911/ci-dist')
const baseline = process.argv.includes('--baseline')
const live = process.argv.includes('--live')
const badStyle = process.argv.includes('--bad-style')
const tag = `${live ? 'live-' : ''}${badStyle ? 'null-style-' : ''}${baseline ? 'baseline' : 'fixed'}`
console.log(JSON.stringify({ mode: tag, badStyle, baseline, live }))
const out = process.env.NAV_NAVIGATION_EVIDENCE_ROOT || 'D:/DomoDev/nav-recovery-20260911/evidence'
await mkdir(out, { recursive: true })
const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' }
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    const file = resolve(dist, '.' + (path === '/' ? '/index.html' : decodeURIComponent(path)))
    assert.ok(file.startsWith(dist + sep))
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = live ? 'https://nav.cristsau.cn' : `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu'] })
const reports = []
try {
  for (const [width, height] of [[1440, 900], [768, 900], [390, 844], [320, 640]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(12000)
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED')) errors.push(message.text()) })
    const groups = [{ id: 'group-one', name: 'Sample', icon: 'heart', color: '#886644', order: 0 }]
    const bookmarks = Array.from({ length: 6 }, (_, i) => ({ id: `sample-${i}`, groupId: 'group-one', title: `Example ${i + 1}`, url: `https://example.test/${i}`, description: '', tags: [], order: i, healthStatus: i === 0 ? 'broken' : 'ok', healthCheckedAt: '2026-09-11T06:00:00.000Z', healthFailureCount: i === 0 ? 2 : 0 }))
    const settings = new Map()
    if (badStyle) settings.set('appConfig', { style: null })
    const writes = []
    let failSave = false
    let failLoad = false
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin) return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      let body = {}
      if (url.pathname === '/api/auth/session') body = { user: { id: 'synthetic-navigation-user', username: 'synthetic', role: 'user', status: 'approved' } }
      else if (url.pathname.startsWith('/api/settings/')) {
        const key = decodeURIComponent(url.pathname.slice('/api/settings/'.length))
        if (key === 'navigationHealthDismissalsV1' && ((request.method() === 'PUT' && failSave) || (request.method() === 'GET' && failLoad))) {
          return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic unavailable"}' })
        }
        if (request.method() === 'PUT') { settings.set(key, request.postDataJSON().value); writes.push(url.pathname) }
        body = { value: settings.get(key) ?? null }
      } else if (url.pathname.includes('/notifications')) body = { notifications: [], unreadCount: 0 }
      else if (url.pathname === '/api/groups') body = { groups }
      else if (url.pathname === '/api/bookmarks') body = { bookmarks }
      if (!['GET', 'HEAD', 'PUT'].includes(request.method())) throw new Error(`Unexpected mutation: ${request.method()} ${url.pathname}`)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto(origin + '/', { waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: /Sample/ }).waitFor()
    const state = await page.evaluate(() => ({
      cards: document.querySelectorAll('[data-bookmark-id]').length,
      grid: document.querySelector('.bookmarks-container')?.getBoundingClientRect().toJSON(),
      gridStyle: document.querySelector('.bookmarks-container') && getComputedStyle(document.querySelector('.bookmarks-container')).display
    }))
    await page.screenshot({ path: join(out, `${tag}-${width}.png`), fullPage: true })
    reports.push({ width, state, errors })
    console.log(JSON.stringify({ width, state, errors: [...new Set(errors.map(e => e.split('\n')[0]))] }))
    if (!baseline) {
      assert.deepEqual(errors, [])
      assert.equal(state.cards, 6)
      assert.ok(state.grid?.height >= 100)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      await page.getByRole('button', { name: '消除本轮提示', exact: true }).click()
      await page.getByRole('button', { name: '恢复提示', exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: '恢复提示', exact: true }).evaluate(e => e === document.activeElement), true)
      assert.equal(await page.locator('.health-issues').count(), 0)
      assert.equal(await page.locator('[data-bookmark-id]').count(), 6)
      assert.equal(bookmarks[0].healthStatus, 'broken')
      await page.reload({ waitUntil: 'networkidle' })
      assert.equal(await page.locator('.health-issues').count(), 0)
      await page.getByRole('button', { name: '恢复提示', exact: true }).click()
      await page.locator('.health-issues').waitFor()
      await page.getByRole('button', { name: '查看清单', exact: true }).click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      await page.screenshot({ path: join(out, `${tag}-expanded-${width}.png`), fullPage: true })
      await page.getByRole('button', { name: '消除 Example 1 的本轮提示', exact: true }).click()
      await page.getByRole('button', { name: '恢复提示', exact: true }).waitFor()
      await page.screenshot({ path: join(out, `${tag}-dismissed-${width}.png`), fullPage: true })
      bookmarks[0].healthCheckedAt = '2026-09-11T08:00:00.000Z'
      await page.reload({ waitUntil: 'networkidle' })
      await page.locator('.health-issues').waitFor()
      failSave = true
      await page.getByRole('button', { name: '消除本轮提示', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: '消除记录保存失败' }).waitFor()
      assert.equal(await page.locator('.health-issues').count(), 1)
      failSave = false; failLoad = true
      await page.reload({ waitUntil: 'networkidle' })
      assert.equal(await page.getByRole('button', { name: '消除本轮提示', exact: true }).isDisabled(), true)
      failLoad = false
      await page.getByRole('button', { name: '重试加载', exact: true }).click()
      await page.waitForFunction(() => [...document.querySelectorAll('.health-issues__actions button')].some(button => button.textContent.includes('消除本轮提示') && !button.disabled))
      await page.getByRole('button', { name: '消除本轮提示', exact: true }).focus()
      await page.getByRole('button', { name: '消除本轮提示', exact: true }).press('Enter')
      await page.getByRole('button', { name: '恢复提示', exact: true }).waitFor()
      assert.ok(writes.every(path => ['/api/settings/navigationHealthDismissalsV1', '/api/settings/appConfig'].includes(path)))
      assert.equal(await page.locator('[data-bookmark-id]').count(), 6)
      reports.at(-1).dismissals = 'all/individual/persistence/restore/new-result/save-error/load-error/keyboard PASS; no bookmark mutation'
    }
    await context.close()
  }
} finally { await browser.close(); await new Promise(r => server.close(r)) }
await writeFile(join(out, `${tag}.json`), JSON.stringify({ host: hostname(), dist, mode: tag, badStyle, baseline, live, checkedAt: new Date().toISOString(), realAccount: false, reports }, null, 2))
