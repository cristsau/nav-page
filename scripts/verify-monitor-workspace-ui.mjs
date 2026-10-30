// Real Vue workspace and modal, synthetic read-only APIs; never contacts a live NAV.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const output = process.env.NAV_MONITOR_UI_EVIDENCE
if (!output || !isAbsolute(output)) throw Error('Explicit absolute NAV_MONITOR_UI_EVIDENCE required')
const root = resolve('app'), req = createRequire(join(root, 'package.json'))
const { createServer } = await import(pathToFileURL(req.resolve('vite')).href)
const engines = createRequire(import.meta.url)(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="test"></div><script type="module">
import {createApp,h,nextTick} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';
import View from '/src/modules/monitor/MonitorView.vue';import Shell from '/src/shared/components/AppShell.vue';
import {useAuth} from '/src/shared/composables/useAuth.js';import {$isDark} from '/src/shared/composables/useTheme.js';
import '/src/styles/reset.css';import '/src/styles/variables.css';
useAuth().currentUser.value={id:'synthetic-owner',username:'合成管理员',role:'admin'};
window.setTheme=async dark=>{$isDark.value=dark;await nextTick()};
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/:pathMatch(.*)*',component:View}]});await router.push('/monitor');
createApp({render:()=>h(Shell,null,{default:()=>h(View)})}).use(router).mount('#test');
</script><style>body{background:var(--bg-primary);color:var(--text-primary);font-family:system-ui,sans-serif;margin:0}</style></body></html>`
const server = await createServer({ root, cacheDir: join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 4197, strictPort: true },
  plugins: [{ name: 'monitor-workspace-regression', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      if (request.url?.split('?')[0] !== '/__monitor-regression') return next()
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(await vite.transformIndexHtml(request.url, html))
    })
  } }] })
const now = Date.now(), from = new Date(now - 3600000).toISOString(), to = new Date(now).toISOString()
const carriers = ['联通', '移动', '电信'].map((name, i) => ({ id: ['cu', 'cm', 'ct'][i], name, host: `${['cu', 'cm', 'ct'][i]}.example.invalid`,
  status: 'current', latencyMs: 218 + i, averageMs: 218 + i, lossPercent: 3.5 + i, coverage: 95, rounds: 60, validRounds: 57,
  sent: 5, received: 5, availableFrom: from,
  points: Array.from({ length: 61 }, (_, n) => ({ at: new Date(now - (60 - n) * 60000).toISOString(), ms: n === 30 ? null : 210 + Math.sin(n) * 10, loss: n === 30 ? null : n % 5 })) }))
const base = { online: true, fresh: true, group: '', tags: [], links: [], carriers, cpu: 5, memory: 10, disk: 20, trafficUsed: 100e9,
  trafficLimit: 1000e9, trafficPercent: 10, trafficMode: 'sum', traffic_limit: 1000e9, traffic_mode: 'sum', traffic_reset_day: 1,
  price: 0, currency: 'USD', billing_cycle: 'monthly', expires_at: null, expiryDays: null, provider: '合成供应商', purpose: '界面回归验证',
  os: 'Debian', cores: 2, memoryTotal: 2 * 1024 ** 3, diskTotal: 40 * 1024 ** 3, uptime: 86400, rx: 1024, tx: 2048, services: [], country: 'US' }
const original = { nodes: [
  { ...base, id: 1, name: '合成 CPU 服务器', cpu: 76.5 },
  { ...base, id: 2, name: '合成内存服务器', memory: 91.2 },
  { ...base, id: 3, name: '合成流量服务器名称较长用于手机布局', trafficUsed: 900e9, trafficLimit: 0, trafficPercent: null },
  { ...base, id: 4, name: '合成离线服务器', online: false, fresh: false, cpu: 99, memory: 99 }
], alerts: [{ nodeId: 2, kind: 'capacity', text: '合成内存服务器 内存使用率较高' },
  { nodeId: 4, kind: 'offline', text: '合成离线服务器 已离线' }], generatedAt: to }
const errors = [], unexpected = [], external = [], checks = []
let browser, payload = structuredClone(original)
await mkdir(output, { recursive: true })
try {
  await server.listen()
  for (const engine of (process.env.NAV_UI_ENGINES || 'chromium,webkit').split(',')) {
    browser = await engines[engine].launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(`${engine}: ${error.message}`))
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.hostname !== '127.0.0.1') { external.push(url.origin); return route.abort() }
      if (!url.pathname.startsWith('/api/')) return route.continue()
      if (route.request().method() !== 'GET') { unexpected.push(route.request().method() + ' ' + url.pathname); return route.abort() }
      if (url.pathname === '/api/monitor/overview') return route.fulfill({ json: payload })
      if (url.pathname.endsWith('/carriers')) return route.fulfill({ json: { from, to, step: 60, carriers } })
      if (url.pathname.endsWith('/history')) return route.fulfill({ json: { step: 60, metrics: [] } })
      if (url.pathname.startsWith('/api/notifications')) return route.fulfill({ json: { notifications: [], unreadCount: 0 } })
      unexpected.push(url.pathname); return route.fulfill({ status: 404, json: {} })
    })
    payload = structuredClone(original)
    await page.goto('http://127.0.0.1:4197/__monitor-regression')
    const card = page.locator('.resource-summary')
    await card.getByText('CPU 占用最高', { exact: true }).waitFor()
    assert.equal((await card.locator('.highlight-node').textContent()).trim(), original.nodes[0].name)
    await page.getByRole('button', { name: '下一项资源' }).click()
    await card.getByText('内存占用最高', { exact: true }).waitFor()
    assert.match(await card.locator('.highlight-node').textContent(), /合成内存服务器/)
    await page.getByRole('button', { name: '下一项资源' }).click()
    await card.getByText('本周期流量最多', { exact: true }).waitFor()
    assert.match(await card.locator('.highlight-node').textContent(), /合成流量服务器/)
    await card.locator('.highlight-node').click()
    await page.getByRole('dialog', { name: original.nodes[2].name, exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭弹窗' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '下一项资源' }).click()
    await card.getByText('CPU 占用最高', { exact: true }).waitFor()
    await page.getByRole('button', { name: '上一项资源' }).click()
    await card.getByText('本周期流量最多', { exact: true }).waitFor()
    checks.push(`${engine}: three resource pages, wrap both ways, winner detail`)
    await page.locator('.alert-summary').click()
    await page.waitForFunction(() => document.querySelector('#monitor-alerts').open)
    assert.equal(await page.locator('.alert-summary').getAttribute('aria-expanded'), 'true')
    await page.locator('.alert-list button').first().click()
    await page.getByRole('dialog', { name: original.nodes[1].name, exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭弹窗' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.locator('#monitor-alerts summary').click()
    await page.waitForFunction(() => document.querySelector('.alert-summary').getAttribute('aria-expanded') === 'false')
    checks.push(`${engine}: alert count, expansion, linked node and collapse`)
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const dark of [false, true]) {
        await page.evaluate(dark => window.setTheme(dark), dark)
        await page.evaluate(() => document.fonts.ready)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${engine}/${width}: page overflow`)
        for (const button of await page.locator('.highlight-pager button').all()) {
          const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44)
        }
        if (width === 390 || width === 1440) await page.screenshot({ path: join(output, `${engine}-${width}-${dark ? 'dark' : 'light'}-overview.png`), fullPage: true })
        await card.locator('.highlight-node').click()
        await page.locator('.carrier-card .trend').first().waitFor()
        const geometry = await page.evaluate(() => {
          const box = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height } }
          return [...document.querySelectorAll('.carrier-card')].map(el => ({ card: box(el), trend: box(el.querySelector('.trend')),
            svg: box(el.querySelector('.trend svg')), readout: box(el.querySelector('.readout')), footer: box(el.querySelector('.carrier-footer')) }))
        })
        for (const g of geometry) {
          assert.ok(g.trend.bottom >= g.readout.bottom - 1, `${engine}/${width}: readout exceeds trend ${JSON.stringify(g)}`)
          assert.ok(g.readout.top >= g.svg.bottom - 1, `${engine}/${width}: readout overlaps axis`)
          assert.ok(g.footer.top >= g.trend.bottom, `${engine}/${width}: coverage overlaps trend`)
          assert.ok(g.footer.bottom < g.card.bottom, `${engine}/${width}: coverage exceeds card`)
          assert.ok(g.card.right <= width && g.card.left >= 0, `${engine}/${width}: card overflow`)
        }
        assert.ok(await page.locator('.modal__body').evaluate(el => el.scrollWidth <= el.clientWidth), `${engine}/${width}: modal overflow`)
        const svg = page.locator('.carrier-card .trend svg').first()
        await svg.focus(); await page.keyboard.press('End')
        await page.locator('.carrier-card .readout time').first().waitFor()
        assert.ok(await page.locator('.carrier-card').first().evaluate(el => el.querySelector('.carrier-footer').getBoundingClientRect().top >= el.querySelector('.readout').getBoundingClientRect().bottom))
        await page.keyboard.press('Escape')
        // Escape closes the modal by its shared keyboard contract.
        await page.getByRole('dialog').waitFor({ state: 'hidden' })
        await card.locator('.highlight-node').click()
        await page.locator('.carrier-card .trend').first().waitFor()
        await page.locator('.carrier-card').first().scrollIntoViewIfNeeded()
        if (width === 390 || width === 1440) await page.screenshot({ path: join(output, `${engine}-${width}-${dark ? 'dark' : 'light'}-detail.png`) })
        await page.getByRole('button', { name: '关闭弹窗' }).click()
        await page.getByRole('dialog').waitFor({ state: 'hidden' })
        checks.push(`${engine}: ${width}px ${dark ? 'dark' : 'light'} chart, readout, coverage, modal and touch controls`)
      }
    }
    payload = { ...original, nodes: [], alerts: [] }
    await page.getByRole('button', { name: '刷新监控' }).click()
    await card.getByText('暂无流量数据', { exact: true }).waitFor()
    await page.locator('.alert-summary').getByText('暂无告警', { exact: true }).waitFor()
    assert.equal(await card.locator('.highlight-node').count(), 0)
    await page.getByRole('button', { name: '下一项资源' }).click()
    await card.getByText('暂无实时指标', { exact: true }).waitFor()
    assert.equal(await page.locator('#monitor-alerts').count(), 0)
    payload = { ...original, nodes: [{ ...original.nodes[0], cpu: 0, memory: 0, trafficUsed: 0 }], alerts: [] }
    await page.getByRole('button', { name: '刷新监控' }).click()
    await card.getByText('0.0%', { exact: true }).waitFor()
    checks.push(`${engine}: refresh recomputes winners, empty/unknown distinct from zero, zero alerts`)
    await browser.close(); browser = null
  }
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(external, [])
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'PASS', checks, errors, unexpected, external, productionWrites: 0 }, null, 2))
  console.log(`MONITOR_WORKSPACE_UI_PASS ${checks.length} checks; Chromium/WebKit; synthetic data only`)
} finally { await browser?.close(); await server.close() }
