// Actual Vue components, synthetic data only. No server or Dropbox credentials.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const output = process.env.NAV_NODE_UI_EVIDENCE
if (!output) throw Error('Evidence directory required')
const appRoot = resolve('app'), req = createRequire(join(appRoot, 'package.json'))
const { createServer } = await import(pathToFileURL(req.resolve('vite')).href)
const { chromium } = createRequire(import.meta.url)(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="test"></main><script type="module">
import {createApp,nextTick} from 'vue';import Offline from '/src/modules/files/OfflineDownloads.vue';import {$isDark} from '/src/shared/composables/useTheme.js';import '/src/styles/reset.css';import '/src/styles/variables.css';
window.theme = async value => {$isDark.value=value;await nextTick()};createApp(Offline).mount('#test');</script><style>body{background:var(--bg-primary);color:var(--text-primary);font-family:system-ui,sans-serif;margin:0}#test{max-width:680px;margin:24px auto;padding:12px}</style></body></html>`
const server = await createServer({ root: appRoot, configFile: join(appRoot, 'vite.config.js'), cacheDir: resolve(output, '../vite-node-cache'),
  server: { host: '127.0.0.1', port: 4189, strictPort: true }, plugins: [{ name: 'offline-node-test', configureServer(vite) { vite.middlewares.use('/__node-test', async (_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml('/__node-test', html)) }) } }] })
let browser
const errors = [], external = [], actions = [], id = 'b'.repeat(32)
let node = { id: null, name: '', address: '', preparing: false, lastSeen: new Date().toISOString(), online: true, ready: false, blockers: { unfinished: 0, cleanup: 0 }, candidates: [] }
let statusFail = false, activationFail = false
await mkdir(output, { recursive: true })
try {
  await server.listen(); browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.hostname !== '127.0.0.1') { external.push(url.origin); return route.abort() }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/offline-downloads/status') return route.fulfill({ status: statusFail ? 503 : 200,
      json: statusFail ? { error: '合成状态读取失败' } : { enabled: true, workerOnline: node.online, maxBytes: 6 * 1024 ** 3, entries: [], media: { bt: false, video: false }, node } })
    assert.equal(url.pathname, '/api/offline-downloads/node')
    const body = request.postDataJSON(); actions.push(body.action)
    if (body.action === 'profile') node = { ...node, name: body.name, address: body.address }
    else if (body.action === 'prepare') node = { ...node, preparing: true }
    else if (body.action === 'cancel') node = { ...node, preparing: false }
    else if (body.action === 'activate') {
      assert.equal(body.id, id); assert.equal(body.oldNodeStopped, true); assert.ok(node.ready)
      if (activationFail) { activationFail = false; return route.fulfill({ status: 409, json: { error: '合成切换检查未通过，请重新核对' } }) }
      node = { ...node, id, name: body.name, address: body.address, preparing: false, online: false, lastSeen: null, candidates: [] }
    } else throw Error('Unexpected mutation')
    return route.fulfill({ status: 200, json: { node } })
  })
  await page.goto('http://127.0.0.1:4189/__node-test')
  const panel = page.getByRole('region', { name: '下载节点管理' })
  await panel.getByRole('button', { name: '下载节点 在线' }).click()
  await panel.getByRole('button', { name: '编辑节点资料' }).click()
  await page.getByLabel('节点名称', { exact: true }).fill('旧下载节点')
  await page.getByLabel('服务器 IP / 域名（可选）', { exact: true }).fill('old.example.test')
  await panel.getByRole('button', { name: '保存资料' }).click()
  await page.getByText('节点资料已保存。', { exact: true }).waitFor()
  await panel.getByRole('button', { name: '收起编辑' }).click()
  await panel.getByRole('button', { name: '准备更换服务器' }).click()
  await page.getByText('已进入更换流程，新任务暂不接收。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '创建离线任务', exact: true }).isEnabled(), false)
  const refresh = page.getByRole('button', { name: '刷新离线任务', exact: true })
  node = { ...node, online: false, blockers: { unfinished: 2, cleanup: 1 }, candidates: [{ id, lastSeen: new Date().toISOString() }] }
  await refresh.click(); await page.getByRole('option', { name: id, exact: true }).waitFor({ state: 'attached' })
  await page.getByLabel('待接入节点', { exact: true }).selectOption(id)
  await page.getByLabel('新节点名称', { exact: true }).fill('新下载节点')
  await page.getByLabel('新服务器 IP / 域名（可选）', { exact: true }).fill('new.example.test')
  await page.getByLabel('我已停止旧节点，并核对新节点编号', { exact: true }).check()
  const activate = page.getByRole('button', { name: '确认切换到新节点', exact: true })
  assert.equal(await activate.isEnabled(), false)
  await page.screenshot({ path: join(output, 'desktop-blocked.png'), fullPage: true })
  node = { ...node, ready: true, blockers: { unfinished: 0, cleanup: 0 } }
  await refresh.click(); await activate.waitFor()
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '确认切换到新节点').disabled)
  activationFail = true; await activate.click(); await page.getByText('合成切换检查未通过，请重新核对', { exact: true }).waitFor()
  assert.equal(actions.filter(action => action === 'activate').length, 1)
  await activate.click(); await page.getByText('已保存新节点选择，等待新节点连接后领取任务。', { exact: true }).waitFor()
  assert.equal(node.id, id)
  statusFail = true; await refresh.click(); await page.getByText('合成状态读取失败', { exact: true }).waitFor()
  assert.equal(await panel.getByRole('button', { name: '准备更换服务器' }).isEnabled(), false)
  statusFail = false; node.online = true; node.lastSeen = new Date().toISOString(); await refresh.click()
  await panel.getByRole('button', { name: '准备更换服务器' }).waitFor()
  for (const dark of [false, true]) {
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(value => window.theme(value), dark)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await page.screenshot({ path: join(output, dark ? 'mobile-dark.png' : 'mobile-light.png'), fullPage: true })
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'PASS', checks: ['profile-save', 'prepare-blocks-new', 'unfinished-cache-block', 'explicit-selection', 'failed-switch-no-retry', 'switch', 'stale-status-disables', 'mobile-light-dark-no-overflow'], actions, externalRequests: external.length, pageErrors: errors.length }, null, 2))
  console.log('OFFLINE_NODE_UI_PASS 8 checks; no external requests; no page errors')
} finally { await browser?.close(); await server.close() }
