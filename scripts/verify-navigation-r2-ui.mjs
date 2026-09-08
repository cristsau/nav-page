// Actual Vue components + synthetic API; local Dexie transactions are real.
// Never point this harness at a deployed site or a personal browser profile.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const origin = 'http://127.0.0.1:4179'
const output = await mkdtemp(join(tmpdir(), 'nav-r2-ui-'))
const checks = []
const passed = (name) => { checks.push(name); console.log(`PASS ${name}`) }
const groups = Array.from({ length: 10 }, (_, index) => ({ id: `group-${index}`, name: `合成分组 ${index}`, order: index, icon: 'folder' }))
const bookmarks = Array.from({ length: 1000 }, (_, index) => ({
  id: `bookmark-${index}`, groupId: groups[Math.floor(index / 100)].id,
  title: index === 0 ? `合成超长标题 ${'VeryLongUnbrokenTitle'.repeat(8)}` : `合成收藏 ${index}`,
  url: index === 0 ? 'https://example.test/Guide?Key=VALUE#Part' : `https://example.test/page/${index}`,
  order: index % 100, healthStatus: index === 0 ? 'protected' : 'unchecked', tags: []
}))
const notes = Array.from({ length: 1000 }, (_, index) => ({
  id: `note-${index}`, kind: 'note', kindLabel: '备忘录', title: `合成笔记 ${index}`,
  snippet: '仅合成可访问内容', href: `/whisper?note=note-${index}`
}))
const user = { id: 'synthetic-r2-user', username: 'synthetic-r2-user', role: 'user', status: 'approved' }
const browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  const errors = []
  let groupSwitchTiming = null
  let searchFailure = false, searchCalls = 0, createCalls = 0, deleteCalls = 0
  let releaseSlow = null, slowSeen = false
  let storedPins = [], pinWriteFailure = false, pinReadFailure = false, pinWrites = 0
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const path = url.pathname.slice(4)
    const method = route.request().method()
    let body = {}, status = 200
    if (path === '/auth/session') body = { user }
    else if (path === '/settings/navigationPinnedGroupsV1') {
      if ((method === 'GET' && pinReadFailure) || (method === 'PUT' && pinWriteFailure)) { status = 503; body = { error: 'synthetic pin failure' } }
      else {
        if (method === 'PUT') { storedPins = route.request().postDataJSON().value; pinWrites++ }
        body = { value: storedPins }
      }
    }
    else if (path === '/groups') body = { groups }
    else if (path === '/bookmarks' && method === 'GET') body = { bookmarks }
    else if (path === '/bookmarks' && method === 'POST') {
      createCalls++
      const input = route.request().postDataJSON()
      const existing = bookmarks.find((item) => item.groupId === input.groupId && item.url === input.url)
      const bookmark = existing || { ...input, id: `created-${createCalls}` }
      if (!existing) bookmarks.push(bookmark)
      body = { bookmark, created: !existing }; status = existing ? 200 : 201
    } else if (path === '/bookmarks/bulk/delete') {
      deleteCalls++; status = 503; body = { error: '合成服务故障，请重试' }
    } else if (path === '/workspace/search') {
      searchCalls++
      const query = url.searchParams.get('q')
      if (query === 'slow') { slowSeen = true; await new Promise((resolve) => { releaseSlow = resolve }) }
      if (searchFailure) { status = 503; body = { error: 'synthetic unavailable' } }
      else body = query === 'none' ? { bookmarks: [], notes: [] } : {
        bookmarks: bookmarks.slice(0, 8).map((item) => ({ ...item, title: `${query} ${item.title}`, kind: 'bookmark', kindLabel: '书签', href: item.url })),
        notes: notes.slice(0, 8)
      }
    } else if (path === '/notes') body = { notes: [] }
    else if (path.includes('settings')) body = { value: null, settings: {} }
    else if (path.includes('search-engines')) body = { engines: [] }
    else if (path.includes('notifications')) body = { notifications: [], unreadCount: 0 }
    else if (path === '/auth/oauth/config') body = { providers: {} }
    else if (path === '/auth/capabilities') body = { emailLogin: false }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.locator('[data-bookmark-id="bookmark-0"]').waitFor()
  const pins = page.getByRole('region', { name: '常用分组' })
  await page.getByRole('button', { name: '固定当前分组', exact: true }).click()
  await pins.getByRole('button', { name: '合成分组 0', exact: true }).waitFor()
  assert.equal(pinWrites, 1)
  await page.reload({ waitUntil: 'networkidle' })
  await pins.getByRole('button', { name: '合成分组 0', exact: true }).waitFor()
  pinWriteFailure = true
  await page.getByRole('button', { name: '取消固定当前组', exact: true }).click()
  await pins.getByRole('alert').waitFor()
  assert.equal(await pins.getByRole('button', { name: '合成分组 0', exact: true }).count(), 1)
  assert.equal(pinWrites, 1)
  pinWriteFailure = false
  pinReadFailure = true
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.getByRole('button', { name: '固定当前分组', exact: true }).isDisabled(), true)
  pinReadFailure = false
  await page.getByRole('button', { name: '重新加载常用分组', exact: true }).click()
  await pins.getByRole('button', { name: '合成分组 0', exact: true }).waitFor()
  passed('pin-persist-reload-and-read-write-failure-keep-original')
  assert.equal(await page.locator('[data-bookmark-id]').count(), 40)
  await page.getByRole('button', { name: '加载更多收藏', exact: true }).click()
  assert.equal(await page.locator('[data-bookmark-id]').count(), 80)
  await page.waitForFunction(() => document.activeElement.closest('[data-bookmark-id]')?.dataset.bookmarkId === 'bookmark-40')
  await page.goto(`${origin}/?bookmark=bookmark-95`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.activeElement.closest('[data-bookmark-id]')?.dataset.bookmarkId === 'bookmark-95')
  assert.equal(await page.locator('[data-bookmark-id]').count(), 100)
  await page.goto(origin, { waitUntil: 'networkidle' })
  await page.locator('[data-bookmark-id="bookmark-0"]').waitFor()
  passed('progressive-render-load-more-and-deep-link-beyond-first-page')
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow ${width}`)
    const search = await page.getByRole('combobox').boundingBox()
    const add = await page.getByRole('button', { name: '添加收藏', exact: true }).boundingBox()
    assert.ok(search.y >= 0 && search.y + search.height < 844, `first screen search ${width}`)
    assert.ok(add.y >= 0 && add.y + add.height < 844 && add.height >= 44, `first screen add ${width}`)
    const menu = page.locator('[data-bookmark-id="bookmark-0"] .bookmark-card__more')
    const box = await menu.boundingBox()
    assert.ok(box?.height >= 44 && box?.width >= 44, `visible menu ${width}`)
    const title = page.locator('[data-bookmark-id="bookmark-0"] .bookmark-card__title')
    assert.equal(await title.evaluate((element) => element.getBoundingClientRect().height <= parseFloat(getComputedStyle(element).lineHeight) * 2 + 1), true)
    passed(`layout-${width}-first-screen-long-title-menu`)
  }
  await page.screenshot({ path: join(output, 'desktop.png') })
  groupSwitchTiming = await page.evaluate(async () => {
    const tabs = Array.from(document.querySelectorAll('.groups-tabs__main'))
    const samples = []
    for (let index = 0; index < 30; index++) {
      const target = (index + 1) % tabs.length
      const started = performance.now()
      tabs[target].click()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!document.querySelector(`[data-bookmark-id="bookmark-${target * 100}"]`)) throw new Error('group switch did not render target')
      samples.push(performance.now() - started)
    }
    const sorted = [...samples].sort((a, b) => a - b)
    return { samples: samples.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
      condition: '1440x844, unthrottled local Edge, synthetic 1000 bookmarks / 10 groups; click to two animation frames; not production INP/LCP' }
  })
  assert.ok(groupSwitchTiming.p95Ms <= 200, `unthrottled group-switch p95: ${groupSwitchTiming.p95Ms}`)
  passed('1000-bookmarks-group-switch-local-p95-budget')
  const menu = page.locator('[data-bookmark-id="bookmark-0"] .bookmark-card__more')
  await menu.click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[role="dialog"]'))), true)
  }
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement.classList.contains('bookmark-card__more'))
  passed('persistent-menu-focus-trap-and-return')

  await page.getByRole('button', { name: '选择', exact: true }).click()
  await page.getByRole('button', { name: '全选当前组', exact: true }).click()
  await page.getByText('已选 100/100 项', { exact: true }).waitFor()
  await page.getByRole('button', { name: '取消全选', exact: true }).click()
  passed('bulk-selection-still-covers-full-group-not-only-rendered-page')
  const selection = page.locator('[data-bookmark-id="bookmark-0"] [role="checkbox"]')
  await selection.click()
  const deleteButton = page.locator('.management-bar').getByRole('button', { name: /删除/ })
  page.once('dialog', async (prompt) => { assert.match(prompt.message(), /1 个书签.*无法撤销/); await prompt.dismiss() })
  await deleteButton.click()
  assert.equal(deleteCalls, 0)
  assert.equal(await selection.getAttribute('aria-checked'), 'true')
  page.once('dialog', (prompt) => prompt.accept())
  await deleteButton.click()
  await page.getByText(/删除失败/).waitFor()
  assert.equal(deleteCalls, 1)
  assert.equal(await selection.getAttribute('aria-checked'), 'true')
  assert.equal(await page.locator('[data-bookmark-id="bookmark-0"]').count(), 1)
  passed('delete-cancel-and-server-failure-preserve-selection')
  await page.getByRole('button', { name: '选择', exact: true }).click()

  const originalGroupOrder = await page.locator('.groups-tabs__name').allTextContents()
  await page.getByRole('button', { name: '排序', exact: true }).click()
  await page.getByRole('button', { name: '下移分组 合成分组 0', exact: true }).click()
  page.once('dialog', (prompt) => prompt.dismiss())
  await page.getByRole('button', { name: '排序', exact: true }).click()
  assert.notDeepEqual(await page.locator('.groups-tabs__name').allTextContents(), originalGroupOrder)
  page.once('dialog', (prompt) => prompt.accept())
  await page.getByRole('button', { name: '排序', exact: true }).click()
  assert.deepEqual(await page.locator('.groups-tabs__name').allTextContents(), originalGroupOrder)
  passed('unsaved-sort-exit-cancel-or-restore-original')

  const query = page.getByRole('combobox')
  await query.fill('sample')
  await page.getByRole('option').first().waitFor()
  assert.equal(await page.getByRole('option').count(), 16)
  await page.getByRole('tab', { name: '笔记', exact: true }).click()
  assert.equal(await page.getByRole('option').count(), 8)
  assert.equal(await page.locator('.workspace-result-item__type').allTextContents().then((items) => items.every((item) => item === '备忘录')), true)
  await page.keyboard.press('ArrowLeft')
  assert.equal(await page.getByRole('tab', { name: '书签', exact: true }).getAttribute('aria-selected'), 'true')
  await query.focus(); await page.keyboard.press('ArrowDown')
  assert.equal(await query.getAttribute('aria-activedescendant'), 'workspace-result-0')
  passed('search-scopes-roving-tabs-and-result-keyboard')

  await query.fill('slow')
  for (let attempt = 0; !slowSeen && attempt < 200; attempt++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(slowSeen, 'synthetic slow request must arrive within 5 seconds')
  await query.fill('')
  releaseSlow()
  await page.waitForResponse((response) => response.url().includes('q=slow'))
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(await page.getByRole('option').count(), 0)
  await page.keyboard.press('ArrowDown')
  assert.equal(await query.getAttribute('aria-activedescendant'), null)
  passed('clear-query-invalidates-in-flight-response')

  searchFailure = true
  await query.fill('retry')
  await page.getByRole('button', { name: '重试搜索', exact: true }).waitFor()
  const beforeRetry = searchCalls
  searchFailure = false
  await page.getByRole('button', { name: '重试搜索', exact: true }).click()
  await page.getByRole('option').first().waitFor()
  assert.equal(searchCalls, beforeRetry + 1)
  assert.equal(await query.inputValue(), 'retry')
  passed('failed-source-retry-keeps-query')
  await query.fill('none')
  await page.getByRole('link', { name: '新增收藏', exact: true }).waitFor()
  await page.getByRole('button', { name: '切换到 Web', exact: true }).click()
  await page.getByText(/点击后才向/).waitFor()
  passed('zero-results-add-and-explicit-web-action')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(output, 'mobile-search.png') })
  for (const theme of ['dark', 'custom']) {
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light' })
    if (theme === 'dark') await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
    else await page.waitForFunction(() => !document.documentElement.classList.contains('dark'))
    if (theme === 'custom') await page.evaluate(() => {
      const values = { '--bg-primary': '#eef5fa', '--bg-secondary': '#e1ecf4', '--bg-card': '#f8fcff', '--text-primary': '#172f45', '--text-secondary': '#3b5267', '--text-muted': '#405870', '--border-color': '#8ca2b5' }
      for (const [name, value] of Object.entries(values)) document.documentElement.style.setProperty(name, value, 'important')
    })
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      for (const tab of await page.getByRole('tab').all()) {
        const id = await tab.getAttribute('id')
        if (!id?.startsWith('search-scope-') || !await tab.isVisible()) continue
        const rect = await tab.boundingBox()
        assert.ok(rect.width >= 44 && rect.height >= 44)
      }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(output, `mobile-search-${theme}.png`) })
    passed(`search-${theme}-tokens-layout-and-tab-targets-5-widths`)
  }

  await page.goto(`${origin}/quick-add?title=synthetic&url=${encodeURIComponent(bookmarks[0].url)}`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '添加到 DOMO NAV', exact: true }).click()
  await page.getByText('该网页已在这个分组中，没有重复添加', { exact: true }).waitFor()
  await page.getByRole('button', { name: '添加到 DOMO NAV', exact: true }).click()
  await page.getByText('该网页已在这个分组中，没有重复添加', { exact: true }).waitFor()
  assert.equal(createCalls, 2)
  assert.equal(bookmarks.length, 1000)
  await page.getByRole('button', { name: '定位已保存收藏', exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.closest('[data-bookmark-id]')?.dataset.bookmarkId === 'bookmark-0')
  passed('quick-add-authoritative-duplicate-and-locate')

  const local = await page.evaluate(async () => {
    const db = await import('/src/shared/db/database.js')
    const previous = db.getCurrentUserId()
    db.setCurrentUserId('isolated-synthetic-dedup')
    try {
      const input = { title: 'synthetic', groupId: 'synthetic-group', url: 'HTTPS://EXAMPLE.test:443/Guide?Key=VALUE#Part', deduplicate: true }
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => db.addBookmark(input, { withOutcome: true })))
      const variant = await db.addBookmark({ ...input, url: 'https://example.test/guide?Key=VALUE#Part' }, { withOutcome: true })
      const queryVariant = await db.addBookmark({ ...input, url: 'https://example.test/Guide?Key=value#Part' }, { withOutcome: true })
      return { created: outcomes.filter((result) => result.created).length, ids: new Set(outcomes.map((result) => result.bookmark.id)).size,
        variant: variant.created, queryVariant: queryVariant.created, count: (await db.getAllBookmarks()).length }
    } finally { db.setCurrentUserId(previous) }
  })
  assert.deepEqual(local, { created: 1, ids: 1, variant: true, queryVariant: true, count: 3 })
  passed('real-indexeddb-20-concurrent-dedup-and-case-variants')
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', scope: 'local actual components; synthetic API; real IndexedDB; no production/SMTP', browser: browser.version(),
    data: { bookmarks: 1000, notes: 1000, initialRenderedBookmarksPerGroup: 40, searchReturnedPerType: 8 }, groupSwitchTiming, checks, output }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await browser.close() }
