// Real Vue component; synthetic backup metadata, no production or Dropbox access.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { createBackupStatus } from './dropbox/backup-status.mjs'
import { sanitizeDropboxBackupStatus } from '../api/src/lib/dropboxBackupStatus.js'

const output = process.env.NAV_DROPBOX_UI_EVIDENCE
if (!output) throw new Error('Task-scoped evidence directory required')
const appRoot = resolve('app')
const requireApp = createRequire(join(appRoot, 'package.json'))
const { createServer } = await import(pathToFileURL(requireApp.resolve('vite')).href)
const { chromium } = createRequire(import.meta.url)(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const report = createBackupStatus({ config: { allowLocalPrune: true },
  localPlan: { keep: [1, 2, 3].map(i => ({ name: `nav-2026091${i}T020000Z-nogit`, bytes: 120_000_000 + i })), remove: [] } })
const initial = sanitizeDropboxBackupStatus(report)
const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="test"></div><script type="module">
import { createApp, h, ref, nextTick } from 'vue';
import Panel from '/src/modules/settings/components/DropboxBackupSettings.vue';
import '/src/styles/reset.css'; import '/src/styles/variables.css'; import '/src/styles/ios.css';
const state = ref(${JSON.stringify(initial)}); const loading = ref(false); window.refreshCount = 0;
window.setBackupState = async (value) => {state.value = value; await nextTick()};
window.setBackupLoading = async (value) => {loading.value = value; await nextTick()};
createApp({render: () => h(Panel, {state:state.value, loading:loading.value, onRefresh:() => window.refreshCount++})}).mount('#test');
window.backupMounted = true;</script><style>body{margin:0;padding:20px;background:var(--bg-secondary);font-family:system-ui,sans-serif}#test{max-width:960px;margin:auto}@media(max-width:640px){body{padding:10px}}</style></body></html>`
const server = await createServer({ root: appRoot, configFile: join(appRoot, 'vite.config.js'),
  server: { host: '127.0.0.1', port: 4186, strictPort: true },
  plugins: [{ name: 'dropbox-ui-harness', configureServer(vite) {
    vite.middlewares.use('/__backup-status-test', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(await vite.transformIndexHtml('/__backup-status-test', html))
    })
  } }] })
await mkdir(output, { recursive: true })
let browser
const checks = [], errors = [], externalRequests = []
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true })
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname !== '127.0.0.1') {
      externalRequests.push(route.request().url()); return route.abort()
    }
    return route.continue()
  })
  await page.goto('http://127.0.0.1:4186/__backup-status-test')
  await page.waitForFunction(() => window.backupMounted)
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.locator('.dropbox-record-list li').count(), 3)
    await page.locator('summary').click()
    assert.equal(await page.locator('.dropbox-readiness li').count(), 4)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`)
    assert.ok(await page.locator('.dropbox-intro').evaluate(e => e.getBoundingClientRect().width) >= 200, `heading squeezed at ${width}`)
    await page.screenshot({ path: join(output, `status-${width}.png`), fullPage: true })
    await page.locator('summary').click()
    checks.push(`layout-${width}`)
  }
  await page.getByRole('button', { name: 'Dropbox', exact: true }).click()
  assert.match(await page.locator('.dropbox-empty').innerText(), /暂无云备份记录/)
  await page.getByRole('button', { name: '刷新记录' }).click()
  assert.equal(await page.evaluate(() => window.refreshCount), 1)
  await page.evaluate(() => window.setBackupLoading(true))
  assert.equal(await page.getByRole('button', { name: '读取中' }).isDisabled(), true)
  await page.evaluate(() => window.setBackupLoading(false))
  checks.push('tabs-refresh-and-loading')
  await page.evaluate(value => window.setBackupState(value), { ...initial, state: 'stale' })
  assert.match(await page.locator('.dropbox-notice').innerText(), /不代表当前状态/)
  checks.push('stale-not-success')
  await page.evaluate(() => window.setBackupState({ state: 'invalid_report', report: null }))
  assert.match(await page.locator('.dropbox-notice').innerText(), /状态需检查/)
  await page.evaluate(() => window.setBackupState(null))
  assert.match(await page.locator('.dropbox-notice').innerText(), /不等于没有备份/)
  assert.match(await page.locator('.dropbox-metrics').innerText(), /未知/)
  checks.push('invalid-and-missing-not-zero-success')
  await page.evaluate(value => { document.documentElement.setAttribute('data-theme', 'dark'); return window.setBackupState(value) }, initial)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: '服务器', exact: true }).click()
  await page.screenshot({ path: join(output, 'status-dark.png'), fullPage: true })
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
  checks.push('no-page-errors-or-external-requests')
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'PASS', checks, productionAccess: false, data: 'synthetic' }, null, 2))
  console.log(JSON.stringify({ status: 'PASS', checks }))
} finally { await browser?.close(); await server.close() }
