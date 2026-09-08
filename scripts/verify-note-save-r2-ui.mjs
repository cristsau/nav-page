// Isolated actual NoteEditor + memory router. All save receipts are synthetic.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const origin = 'http://127.0.0.1:4179'
const output = await mkdtemp(join(tmpdir(), 'nav-note-save-r2-'))
const browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true })
const checks = []
const passed = (name) => { checks.push(name); console.log(`PASS ${name}`) }
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    let body = {}
    if (url.pathname === '/api/auth/session') body = { user: null }
    if (url.pathname === '/api/auth/oauth/config') body = { providers: { google: { enabled: false }, wechat: { enabled: false } } }
    if (url.pathname.includes('settings')) body = { value: null }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto(`${origin}/auth`, { waitUntil: 'networkidle' })
  await page.evaluate(async () => {
    const resources = performance.getEntriesByType('resource').map((item) => item.name)
    const vueUrl = resources.find((url) => /\/vue\.js\?/.test(url))
    const routerUrl = resources.find((url) => /\/vue-router\.js\?/.test(url))
    if (!vueUrl || !routerUrl) throw new Error('Vite Vue/router runtime was not found')
    const { createApp, ref, h, nextTick } = await import(vueUrl)
    const { createRouter, createMemoryHistory, RouterView } = await import(routerUrl)
    const { default: NoteEditor } = await import('/src/modules/whisper/components/NoteEditor.vue')
    document.querySelector('#app').__vue_app__.unmount()
    const shown = ref(false)
    const note = ref({ id: 'synthetic-note', title: 'Initial', type: 'memo', content: 'Synthetic body', revision: 1, tags: [], attachments: [], accessRole: 'owner' })
    const calls = []
    const save = (payload) => new Promise((resolve, reject) => calls.push({ payload, resolve, reject }))
    const EditorHost = { setup: () => () => h(NoteEditor, { show: shown.value, note: note.value, autosaveHandler: save, onClose: () => { shown.value = false } }) }
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: EditorHost }, { path: '/away', component: { render: () => h('p', 'Away') } }] })
    const app = createApp({ render: () => h(RouterView) })
    app.use(router); await router.push('/'); await router.isReady(); app.mount('#app')
    window.noteHarness = {
      calls, shown, router,
      async reopen(syncState = 'synced') { shown.value = false; await nextTick(); note.value = { ...note.value, syncState }; shown.value = true; await nextTick() },
      resolve(index, extra = {}) { const call = calls[index]; call.resolve({ ...note.value, ...call.payload, revision: call.payload.revision + 1, ...extra }) },
      reject(index, status = 503) { calls[index].reject(Object.assign(new Error('Synthetic save failure'), { status })) }
    }
    shown.value = true
  })
  const title = page.getByPlaceholder('标题', { exact: true })
  await title.waitFor()
  await page.getByText('已保存到云端', { exact: true }).waitFor()
  await title.fill('First edit')
  await page.waitForFunction(() => noteHarness.calls.length === 1)
  await title.fill('Second edit while saving')
  // Longer than the debounce: there must still be only one unresolved write.
  await page.waitForTimeout(1500)
  assert.equal(await page.evaluate(() => noteHarness.calls.length), 1)
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
  await page.evaluate(() => noteHarness.resolve(0))
  await page.waitForFunction(() => noteHarness.calls.length === 2)
  assert.deepEqual(await page.evaluate(() => noteHarness.calls.slice(0, 2).map((call) => [call.payload.title, call.payload.revision])), [['First edit', 1], ['Second edit while saving', 2]])
  await page.evaluate(() => noteHarness.resolve(1))
  await page.getByText('已保存到云端', { exact: true }).waitFor()
  passed('serialized-autosave-preserves-new-input-and-revision')

  await title.fill('Offline edit')
  await page.waitForFunction(() => noteHarness.calls.length === 3)
  await page.evaluate(() => noteHarness.resolve(2, { syncState: 'pending' }))
  await page.getByText('已保存在本机，待同步到云端', { exact: true }).waitFor()
  passed('local-outbox-receipt-never-labeled-cloud-saved')

  await title.fill('Transient error draft')
  await page.waitForFunction(() => noteHarness.calls.length === 4)
  await page.evaluate(() => noteHarness.reject(3))
  await page.getByRole('button', { name: '重试保存', exact: true }).click()
  await page.waitForFunction(() => noteHarness.calls.length === 5)
  assert.equal(await title.inputValue(), 'Transient error draft')
  await page.evaluate(() => noteHarness.resolve(4))
  await page.getByText('已保存到云端', { exact: true }).waitFor()
  passed('transient-error-explicit-retry-keeps-draft')

  await title.fill('Conflict draft')
  await page.waitForFunction(() => noteHarness.calls.length === 6)
  await page.evaluate(() => noteHarness.reject(5, 409))
  await page.getByText(/当前草稿保留在编辑器中/).waitFor()
  await title.fill('Conflict draft retained')
  await page.waitForTimeout(1500)
  assert.equal(await page.evaluate(() => noteHarness.calls.length), 6)
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
  page.once('dialog', (prompt) => prompt.dismiss())
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await title.inputValue(), 'Conflict draft retained')
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.syntheticClipboard = text } } }))
  await page.getByRole('button', { name: '复制当前草稿', exact: true }).click()
  assert.match(await page.evaluate(() => window.syntheticClipboard), /Conflict draft retained/)
  await page.getByText(/已复制标题和正文/).waitFor()
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    const copy = await page.getByRole('button', { name: '复制当前草稿', exact: true }).boundingBox()
    assert.ok(copy.height >= 44 && copy.y >= 0 && copy.y + copy.height <= 844, `reachable recovery action ${width}`)
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: '取消', exact: true }).focus()
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[role="dialog"]'))), true)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(output, 'conflict-mobile.png') })
  passed('conflict-no-overwrite-and-cancel-close-keeps-draft')
  passed('recovery-actions-44px-reachable-and-focus-contained-4-widths')

  await page.evaluate(() => noteHarness.reopen())
  await title.fill('Route first')
  await page.waitForFunction(() => noteHarness.calls.length === 7)
  await title.fill('Route final')
  await page.evaluate(() => { noteHarness.router.push('/away') })
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => noteHarness.router.currentRoute.value.path), '/')
  await page.evaluate(() => noteHarness.resolve(6))
  await page.waitForFunction(() => noteHarness.calls.length === 8)
  assert.equal(await page.evaluate(() => noteHarness.calls[7].payload.title), 'Route final')
  await page.evaluate(() => noteHarness.resolve(7))
  await page.getByText('Away', { exact: true }).waitFor()
  passed('route-leave-waits-for-in-flight-and-latest-draft')
  await page.evaluate(async () => { await noteHarness.router.push('/'); await noteHarness.reopen() })
  await title.fill('Missing receipt draft')
  await page.waitForFunction(() => noteHarness.calls.length === 9)
  await page.evaluate(() => noteHarness.calls[8].resolve(null))
  await page.getByText(/未收到保存确认/).waitFor()
  assert.equal(await title.inputValue(), 'Missing receipt draft')
  passed('missing-save-receipt-keeps-unsaved-draft')
  assert.deepEqual(errors, [])
  const report = { status: 'PASS', scope: 'actual editor and router; synthetic save receipts; no backend/real sync', browser: browser.version(), checks, output }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await browser.close() }
