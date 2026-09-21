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
import {$isDark} from '/src/shared/composables/useTheme.js'; window.setTestTheme = async dark => {$isDark.value = dark; await nextTick()};
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
let control = { connected: false }, posts = [], rejectOnce = false
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true })
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname !== '127.0.0.1') {
      externalRequests.push(route.request().url()); return route.abort()
    }
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/api/admin/integrations/dropbox-backup/')) {
      const body = route.request().postDataJSON()
      if (path.endsWith('/jobs')) {
        posts.push(body)
        if (rejectOnce) { rejectOnce = false; return route.fulfill({ status: 503, json: { error: '请求结果尚未确认' } }) }
        control.jobs.unshift({ ...body, pointId: body.pointId || null, source: 'manual', state: 'queued', stage: 'queued', code: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        control.busy = true
        return route.fulfill({ status: 202, json: { accepted: true, id: body.id } })
      }
      if (path.endsWith('/schedule')) {
        control.schedule = { ...control.schedule, enabled: body.enabled, active: body.enabled, time: body.time }; control.revision++
        return route.fulfill({ json: { saved: true } })
      }
      return route.fulfill({ json: control })
    }
    return route.continue()
  })
  await page.goto('http://127.0.0.1:4186/__backup-status-test')
  await page.waitForFunction(() => window.backupMounted)
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.locator('.dropbox-record-list li').count(), 3)
    await page.locator('.dropbox-readiness summary').click()
    await page.locator('.dropbox-retention summary').click()
    assert.match(await page.locator('.dropbox-retention').innerText(), /只查看，不执行删除/)
    assert.equal(await page.locator('.dropbox-readiness li').count(), 4)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`)
    assert.ok(await page.locator('.dropbox-intro').evaluate(e => e.getBoundingClientRect().width) >= 200, `heading squeezed at ${width}`)
    await page.screenshot({ path: join(output, `status-${width}.png`), fullPage: true })
    await page.locator('.dropbox-readiness summary').click()
    await page.locator('.dropbox-retention summary').click()
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
  const cloudPoints = [1, 2, 3].map(i => ({ id: String(i).repeat(32), bytes: 1234, state: i === 2 ? 'restore_verified' : 'download_verified',
    createdAt: `2026-09-${10 + i}T00:00:00Z`, remoteId: 'id:fixture' + i, rev: 'abcdef123', sha256: 'a'.repeat(64), contentHash: 'b'.repeat(64), manifestHash: 'c'.repeat(64),
    ...(i === 2 ? { restoreReceiptHash: 'd'.repeat(64), restoredAt: '2026-09-20T00:00:00Z' } : {}) }))
  const retentionState = sanitizeDropboxBackupStatus(createBackupStatus({ config: {}, ledger: { version: 1, points: cloudPoints, pending: [] } }))
  await page.evaluate(value => window.setBackupState(value), retentionState)
  assert.equal(await page.getByRole('progressbar', { name: '已登记的备份预算使用率' }).count(), 1)
  assert.match(await page.locator('.dropbox-latest').innerText(), /最近云备份/)
  assert.match(await page.locator('.dropbox-readiness').textContent(), /由本人保管/)
  checks.push('budget-meter-last-cloud-record-and-neutral-owner-key-status')
  await page.locator('.dropbox-retention summary').click()
  assert.equal(await page.locator('.dropbox-retention li').count(), 1)
  assert.match(await page.locator('.dropbox-retention').innerText(), /下一次备份前的候选/)
  assert.match(await page.locator('.dropbox-metrics').innerText(), /自动轮换未开启/)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(output, 'retention-320.png'), fullPage: true })
  const blockedState = sanitizeDropboxBackupStatus(createBackupStatus({ config: {}, ledger: { version: 1, points: cloudPoints, pending: [], pendingDeletes: [{ id: cloudPoints[0].id, remoteId: cloudPoints[0].remoteId, rev: cloudPoints[0].rev, createdAt: new Date().toISOString() }] } }))
  await page.evaluate(value => window.setBackupState(value), blockedState)
  assert.match(await page.locator('.dropbox-warning').innerText(), /不会自动重试删除/)
  assert.equal(await page.locator('.dropbox-retention li').count(), 0)
  checks.push('retention-preview-candidates-and-ambiguous-delete-blocked-without-actions')
  await page.evaluate(value => window.setBackupState(value), { ...initial, state: 'stale' })
  assert.match(await page.locator('.dropbox-notice').innerText(), /不代表当前状态/)
  checks.push('stale-not-success')
  await page.evaluate(() => window.setBackupState({ state: 'invalid_report', report: null }))
  assert.match(await page.locator('.dropbox-notice').innerText(), /状态需检查/)
  await page.evaluate(() => window.setBackupState(null))
  assert.match(await page.locator('.dropbox-notice').innerText(), /不等于没有备份/)
  assert.match(await page.locator('.dropbox-metrics').innerText(), /未知/)
  checks.push('invalid-and-missing-not-zero-success')
  control = { connected: true, revision: 0, timezone: 'Asia/Shanghai', busy: false, reviewRequired: false, jobs: [],
    capabilities: { backup: true, verify: true, download: true, schedule: false },
    schedule: { enabled: false, active: false, time: '03:45', blockedReason: 'SCHEDULE_GATE_CLOSED' } }
  await page.evaluate(value => window.setBackupState(value), retentionState)
  await page.getByRole('button', { name: '刷新任务', exact: true }).click()
  await page.getByRole('button', { name: '立即备份', exact: true }).click()
  assert.equal(posts.length, 0)
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(posts.length, 0)
  await page.getByRole('button', { name: '立即备份', exact: true }).click()
  await page.getByRole('button', { name: '确认执行', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.backup-jobs')?.textContent.includes('排队中'))
  assert.equal(posts.length, 1); assert.equal(await page.getByRole('button', { name: '任务执行中', exact: true }).isDisabled(), true)
  control.jobs[0].state = 'succeeded'; control.jobs[0].stage = 'completed'; control.busy = false
  await page.getByRole('button', { name: '刷新任务', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.backup-jobs')?.textContent.includes('已完成'))
  checks.push('manual-confirm-cancel-queue-busy-and-completion')
  await page.getByRole('button', { name: '定时设置', exact: true }).click()
  assert.equal(await page.getByRole('checkbox', { name: '开启每日备份' }).isDisabled(), true)
  await page.locator('input[type=time]').fill('04:20')
  await page.getByRole('button', { name: '保存设置' }).click()
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'))
  assert.equal(control.schedule.enabled, false); assert.equal(control.schedule.time, '04:20')
  checks.push('schedule-draft-save-and-restore-gate')
  await page.locator('.backup-downloads summary').click()
  await page.locator('.backup-downloads').getByRole('button', { name: '校验', exact: true }).first().click()
  rejectOnce = true
  await page.getByRole('button', { name: '确认执行', exact: true }).click()
  await page.getByRole('button', { name: '以同一编号重新发送' }).waitFor()
  const retryId = posts.at(-1).id
  assert.match(await page.getByRole('dialog').innerText(), /请求结果尚未确认/)
  await page.getByRole('button', { name: '以同一编号重新发送' }).click()
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'))
  assert.equal(posts.at(-1).id, retryId)
  control.jobs[0].state = 'failed'; control.jobs[0].stage = 'stopped'; control.jobs[0].code = 'VERIFICATION_FAILED'; control.busy = false
  await page.getByRole('button', { name: '刷新任务', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.backup-jobs')?.textContent.includes('密文校验失败'))
  checks.push('unknown-request-retains-idempotency-key-and-failed-job-feedback')
  await page.locator('.backup-downloads').getByRole('button', { name: '下载', exact: true }).first().click()
  assert.match(await page.getByRole('link', { name: '下载密文' }).getAttribute('href'), /\/ciphertext\/[a-f0-9]{32}$/)
  assert.match(await page.getByRole('dialog').innerText(), /不在|独立保存/)
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  checks.push('ciphertext-only-authenticated-download-confirmation')
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: join(output, `actions-${width}.png`), fullPage: true })
  }
  control.reviewRequired = true; control.jobs[0].state = 'review'; control.jobs[0].code = 'BACKUP_REVIEW_REQUIRED'
  await page.getByRole('button', { name: '刷新任务', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.backup-actions')?.textContent.includes('不会自动重试'))
  assert.equal(await page.getByRole('button', { name: '立即备份', exact: true }).isDisabled(), true)
  checks.push('responsive-actions-and-unknown-result-block')
  const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.evaluate(async value => { await window.setTestTheme(true); await window.setBackupState(value) }, initial)
  await page.waitForFunction(light => getComputedStyle(document.body).backgroundColor !== light, lightBackground)
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), lightBackground, 'dark theme must change computed colors')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: '服务器', exact: true }).click()
  await page.screenshot({ path: join(output, 'status-dark.png'), fullPage: true, animations: 'disabled' })
  checks.push('dark-theme-computed-colors')
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
  checks.push('no-page-errors-or-external-requests')
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'PASS', checks, productionAccess: false, data: 'synthetic' }, null, 2))
  console.log(JSON.stringify({ status: 'PASS', checks }))
} finally { await browser?.close(); await server.close() }
