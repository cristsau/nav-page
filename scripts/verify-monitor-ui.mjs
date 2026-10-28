// NAV Vue view + pinned upstream React builds. Synthetic local API only.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join, extname, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
const output = process.env.NAV_MONITOR_UI_EVIDENCE
if (!output || !process.env.NAV_MONITOR_ADMIN_DIST || !process.env.NAV_MONITOR_THEME_DIST) throw Error('Explicit evidence and built upstream paths required')
const root = resolve('app'), req = createRequire(join(root, 'package.json'))
const { createServer } = await import(pathToFileURL(req.resolve('vite')).href)
const { chromium } = createRequire(import.meta.url)(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="test"></div><script type="module">import {createApp,nextTick,h} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';import View from '/src/modules/monitor/MonitorView.vue';import Shell from '/src/shared/components/AppShell.vue';import {useAuth} from '/src/shared/composables/useAuth.js';import {$isDark} from '/src/shared/composables/useTheme.js';import '/src/styles/reset.css';import '/src/styles/variables.css';const auth=useAuth();auth.currentUser.value={id:'synthetic-owner',username:'合成管理员',role:'admin'};window.theme=async value=>{$isDark.value=value;await nextTick()};const router=createRouter({history:createMemoryHistory(),routes:[{path:'/:pathMatch(.*)*',component:View}]});await router.push('/monitor');const app=createApp({render:()=>h(Shell,null,{default:()=>h(View)})});app.use(router);app.mount('#test');window.unmount=()=>app.unmount();</script><style>body{background:var(--bg-primary);color:var(--text-primary);font-family:system-ui,sans-serif;margin:0}</style></body></html>`
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = await createServer({ root, cacheDir: resolve(output, '../vite-monitor-cache'), server: { host: '127.0.0.1', port: 4190, strictPort: true }, plugins: [{ name: 'monitor-harness', configureServer(vite) {
  vite.middlewares.use(async (request, response, next) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/__monitor-test') { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(url.pathname, html)); return }
    if (!url.pathname.startsWith('/monitor-app/') || url.pathname.startsWith('/monitor-app/api/')) return next()
    const admin = url.pathname.startsWith('/monitor-app/admin'), base = resolve(admin ? process.env.NAV_MONITOR_ADMIN_DIST : process.env.NAV_MONITOR_THEME_DIST)
    const part = url.pathname.slice(admin ? '/monitor-app/admin'.length : '/monitor-app'.length)
    const path = resolve(base, '.' + part)
    if (path !== base && !path.startsWith(base + sep)) { response.statusCode = 400; response.end(); return }
    let file = path
    try { if (!(await stat(file)).isFile()) file = join(base, 'index.html') } catch { if (extname(path)) { response.statusCode = 404; response.end(); return } file = join(base, 'index.html') }
    response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); response.end(await readFile(file))
  })
} }] })
const node = { id: 1, name: '合成 OVH 节点', sort: 0, public: false, online: false, country: '', group: '测试', last_seen: 0, last_seen_ago: null, metrics: null, os: 'Debian', kernel: '6.1', arch: 'amd64', virt: 'kvm', cpu_name: 'Synthetic CPU', cpu_cores: 1, mem_total: 2 * 1024 ** 3, swap_total: 0, disk_total: 20 * 1024 ** 3, agent_version: '1.5.1', price: 0, currency: 'USD', billing_cycle: 'monthly', expires_at: null, traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0, hostname: 'synthetic', ip: '192.0.2.10', remark: '', notify: false, addresses: [] }
const errors = [], external = [], unexpected = [], requests = []
let browser, failStatus = false, revoked = false
await mkdir(output, { recursive: true })
try {
  await server.listen(); browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1') { external.push(url.origin); return route.abort() }
    if (url.pathname === '/api/monitor/status') return route.fulfill({ status: failStatus ? 503 : 200, json: failStatus ? { error: '合成监控暂不可用' } : { enabled: true, connected: true, path: '/monitor-app/', login: 'nav' } })
    if (url.pathname.startsWith('/api/notifications')) return route.fulfill({ json: { notifications: [], unreadCount: 0 } })
    if (url.pathname.startsWith('/api/')) { unexpected.push(url.pathname); return route.abort() }
    if (!url.pathname.startsWith('/monitor-app/api/')) return route.continue()
    requests.push(url.pathname)
    if (revoked) return route.fulfill({ status: 401, json: { error: '会话已失效' } })
    const path = url.pathname.slice('/monitor-app/api'.length)
    const values = {
      '/me': { authed: true, github: false, site_name: 'NAV 合成监控', public_page: false, site: 'https://node.cvv.gr', history_days: 30 },
      '/nodes': { nodes: [node], admin: true }, '/themes/default/config': {},
      '/nodes/1/metrics': { metrics: [], ping: [], probes: {}, loss: {} },
      '/version': { hub: '1.5.1', hub_latest: '1.5.1', agent_latest: '1.5.1', notice: false },
      '/settings': {}, '/sessions': [], '/ping-tasks': [],
      '/db': { size: 4096, wal: 0, free: 0, retention: 30, oldest_ago: null, rows: {}, path: '/synthetic/monitor.db' }
    }
    if (!(path in values)) { unexpected.push(path); return route.fulfill({ status: 404, json: {} }) }
    return route.fulfill({ json: values[path] })
  })
  await page.goto('http://127.0.0.1:4190/__monitor-test')
  const iframe = page.frameLocator('iframe'), content = page.locator('iframe')
  await iframe.getByRole('heading', { name: node.name, exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('iframe').classList.contains('is-loading'))
  assert.equal(await iframe.getByText('登录', { exact: true }).count(), 0)
  await page.screenshot({ path: join(output, 'overview-desktop.png'), fullPage: true })
  await iframe.getByRole('link', { name: '进入后台' }).click()
  await page.waitForFunction(() => document.querySelector('.monitor-tools button:nth-child(2)').getAttribute('aria-pressed') === 'true')
  await page.getByRole('button', { name: '总览', exact: true }).click()
  await iframe.getByRole('heading', { name: node.name, exact: true }).waitFor()
  await iframe.getByRole('button', { name: /合成 OVH 节点/ }).click()
  await page.waitForFunction(() => document.querySelector('iframe').contentWindow.location.pathname.endsWith('/monitor-app/node/1'))
  await iframe.getByText('CPU', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: '管理', exact: true }).click()
  await iframe.getByRole('button', { name: '安全', exact: true }).waitFor()
  await iframe.getByRole('button', { name: '安全', exact: true }).click()
  await iframe.getByRole('heading', { name: '使用 NAV 管理员身份', exact: true }).waitFor()
  assert.ok(await content.evaluate(el => el.contentWindow.location.pathname.startsWith('/monitor-app/admin/')))
  await page.screenshot({ path: join(output, 'admin-desktop.png'), fullPage: true })
  await iframe.getByRole('button', { name: '数据', exact: true }).click()
  await iframe.getByRole('button', { name: '导入备份', exact: true }).waitFor()
  assert.ok(await iframe.getByRole('button', { name: '导入备份', exact: true }).isDisabled())
  failStatus = true; await page.getByRole('button', { name: '重新加载监控', exact: true }).click()
  await page.getByText('合成监控暂不可用', { exact: true }).waitFor(); assert.equal(await content.count(), 0)
  failStatus = false; await page.getByRole('button', { name: '重试', exact: true }).click()
  await iframe.getByRole('button', { name: '安全', exact: true }).waitFor()
  revoked = true; await page.getByRole('button', { name: '总览', exact: true }).click()
  await page.getByText('监控访问权限已失效，请确认 NAV 登录状态后重试。', { exact: true }).waitFor()
  assert.equal(await content.count(), 0); revoked = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await iframe.getByRole('heading', { name: node.name, exact: true }).waitFor()
  for (const dark of [false, true]) {
    await page.setViewportSize({ width: 320, height: 780 }); await page.evaluate(value => window.theme(value), dark)
    await page.waitForFunction(value => document.querySelector('iframe').contentDocument.documentElement.classList.contains('dark') === value, dark)
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.mobile-tabs').getBoundingClientRect().bottom <= innerHeight, null, { timeout: 5000 })
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, header: [...document.querySelectorAll('.monitor-header,.monitor-tools,.monitor-header>div')].map(el=>({class:el.className,width:el.getBoundingClientRect().width,left:el.getBoundingClientRect().left,flexWrap:getComputedStyle(el).flexWrap,display:getComputedStyle(el).display,position:getComputedStyle(el).position,gap:getComputedStyle(el).gap,margin:getComputedStyle(el).margin})), overflow: [...document.querySelectorAll('body *')].filter(el => { const box = el.getBoundingClientRect(); return box.width && box.right > innerWidth + 1 }).slice(0, 8).map(el => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right })) }))
    await page.screenshot({ path: join(output, 'shell-geometry.png') })
    assert.ok(geometry.scroll <= geometry.width, JSON.stringify(geometry))
    assert.ok(await content.evaluate(el => el.contentDocument.documentElement.scrollWidth <= el.contentWindow.innerWidth))
    const dock = page.locator('.mobile-tabs')
    assert.equal(await dock.getByRole('link').count(), 6)
    assert.equal(await dock.getByRole('link', { name: '监控', exact: true }).getAttribute('aria-current'), 'page')
    for (const target of await dock.getByRole('link').all()) { const box = await target.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44) }
    await page.screenshot({ path: join(output, dark ? 'mobile-dark.png' : 'mobile-light.png') })
  }
  await page.evaluate(() => window.unmount()); const before = requests.length
  await page.waitForTimeout(5500); assert.equal(requests.length, before)
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(unexpected, [])
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'PASS', checks: ['original-overview', 'native-detail-route', 'admin-inner-route', 'NAV-login-indicator', 'restore-disabled', 'status-error-retry', 'revoked-session-unloads', '320px-light-dark', 'AppShell-six-touch-targets', 'unmount-stops-polling'], externalRequests: external.length, pageErrors: errors.length, unexpectedRequests: unexpected.length }, null, 2))
  console.log('MONITOR_UI_PASS 10 checks; actual Vue/React builds; synthetic only')
} finally { await browser?.close(); await server.close() }
