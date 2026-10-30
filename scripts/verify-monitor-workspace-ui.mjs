// Real Vue workspace and modal, synthetic APIs (including isolated order writes); never contacts a live NAV.
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
  { ...base, id: 1, name: '合成 CPU 服务器', group: 'A', os: 'Ubuntu 24.04.3 LTS', cpu: 76.5, expiryDays: 22 },
  { ...base, id: 2, name: '合成内存服务器', group: 'B', os: 'Windows Server 2025', memory: 91.2 },
  { ...base, id: 3, name: '合成流量服务器名称较长用于手机布局', group: 'A', os: '', trafficUsed: 900e9, trafficLimit: 0, trafficPercent: null },
  { ...base, id: 4, name: '合成离线服务器', group: 'B', online: false, fresh: false, cpu: 99, memory: 99 }
], alerts: [{ nodeId: 2, kind: 'capacity', text: '合成内存服务器 内存使用率较高' },
  { nodeId: 4, kind: 'offline', text: '合成离线服务器 已离线' }, { nodeId: 1, kind: 'expiry' }], generatedAt: to }
const errors = [], unexpected = [], external = [], checks = []
const record = message => { checks.push(message); console.log(message) }
let browser, payload = structuredClone(original), saveMode = 'ok', orderWrites = []
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
      if (url.pathname === '/api/monitor/admin/nodes' && route.request().method() === 'GET') return route.fulfill({ json: { nodes: payload.nodes } })
      if (url.pathname === '/api/monitor/admin/nodes/order' && route.request().method() === 'PUT') {
        const { ids } = route.request().postDataJSON(); orderWrites.push(ids)
        assert.deepEqual([...ids].sort(), payload.nodes.map(n => n.id).sort())
        if (saveMode === 'fail') return route.fulfill({ status: 500, json: { error: 'synthetic save failure' } })
        payload.nodes = ids.map(id => payload.nodes.find(n => n.id === id))
        if (saveMode === 'lost') return route.abort('failed')
        return route.fulfill({ json: { ok: true } })
      }
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
    assert.equal((await card.locator('.highlight-name').textContent()).trim(), original.nodes[0].name)
    await page.getByRole('button', { name: '下一项资源' }).click()
    await card.getByText('内存占用最高', { exact: true }).waitFor()
    await card.locator('.highlight-name').filter({ hasText: '合成内存服务器' }).waitFor()
    await page.getByRole('button', { name: '下一项资源' }).click()
    await card.getByText('本周期流量最多', { exact: true }).waitFor()
    await card.locator('.highlight-name').filter({ hasText: '合成流量服务器' }).waitFor()
    await card.locator('.highlight-node').click()
    await page.getByRole('dialog', { name: original.nodes[2].name, exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭弹窗' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '下一项资源' }).click()
    await card.getByText('CPU 占用最高', { exact: true }).waitFor()
    await page.getByRole('button', { name: '上一项资源' }).click()
    await card.getByText('本周期流量最多', { exact: true }).waitFor()
    await card.locator('.highlight-name').filter({ hasText: '合成流量服务器' }).waitFor()
    record(`${engine}: three resource pages, wrap both ways, winner detail`)
    assert.match(await page.locator('.alert-summary').textContent(), /已离线/)
    assert.match(await page.locator('#monitor-alerts').textContent(), /内存 91.2%/)
    await page.locator('.alert-preview').first().click()
    await page.getByRole('dialog', { name: original.nodes[3].name, exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭弹窗' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.locator('.attention-item').filter({ hasText: '内存 91.2%' }).click()
    await page.getByRole('dialog', { name: original.nodes[1].name, exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭弹窗' }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    record(`${engine}: explicit alert reasons and direct node links in card and issue strip`)
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const dark of [false, true]) {
        await page.evaluate(dark => window.setTheme(dark), dark)
        await page.evaluate(() => document.fonts.ready)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${engine}/${width}: page overflow`)
        for (const button of await page.locator('.highlight-pager button').all()) {
          const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44)
        }
        const osLayout = await page.locator('.node-row').evaluateAll(rows => rows.map(row => {
          const name = row.querySelector('.node-name'), os = row.querySelector('.node-os'), title = row.querySelector('.node-title')
          const before = name.getBoundingClientRect().height, rowHeight = row.getBoundingClientRect().height
          const rect = os.getBoundingClientRect(), titleRect = title.getBoundingClientRect()
          os.style.display = 'none'
          const unchanged = name.getBoundingClientRect().height === before && row.getBoundingClientRect().height === rowHeight
          os.style.display = ''
          return { unchanged, inside: rect.right <= name.getBoundingClientRect().right + 1, separate: titleRect.right <= rect.left + 1 }
        }))
        assert.ok(osLayout.every(v => v.unchanged && v.inside && v.separate), `${engine}/${width}: OS badge changes layout ${JSON.stringify(osLayout)}`)
        if (width === 1440) assert.ok((await page.locator('.summary').boundingBox()).height <= 190, 'summary too tall')
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
        record(`${engine}: ${width}px ${dark ? 'dark' : 'light'} chart, readout, coverage, modal and touch controls`)
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => window.setTheme(false))
    const rowIds = () => page.locator('.node-row').evaluateAll(rows => rows.map(row => Number(row.dataset.nodeId)))
    const grip = id => page.locator(`[data-node-id="${id}"] .drag-handle`)
    const status = page.locator('.sort-status')
    const waitSaved = async () => { await status.getByText('顺序已保存', { exact: true }).waitFor(); await page.waitForFunction(() => !document.querySelector('.drag-handle').disabled) }
    const reset = async () => { payload = structuredClone(original); saveMode = 'ok'; await page.getByLabel('服务器分组', { exact: true }).selectOption(''); await page.getByLabel('排序', { exact: true }).selectOption('custom'); await page.getByRole('button', { name: '刷新监控' }).click(); await page.waitForFunction(() => document.querySelector('.node-row').dataset.nodeId === '1') }
    await reset()
    // Pointer events exercise the same dedicated handle path in Chromium and WebKit.
    async function drag(fromId, toId, side = 'before') {
      await grip(fromId).scrollIntoViewIfNeeded()
      const a = await grip(fromId).boundingBox(), b = await page.locator(`[data-node-id="${toId}"]`).boundingBox()
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down()
      await page.mouse.move(b.x + 60, b.y + (side === 'before' ? 12 : b.height - 12), { steps: 10 }); await page.mouse.up()
      await waitSaved()
    }
    await drag(3, 1)
    assert.deepEqual(await rowIds(), [3, 1, 2, 4])
    assert.equal(await page.getByRole('dialog').count(), 0)
    await page.reload(); await page.locator('.node-row').first().waitFor()
    assert.deepEqual(await rowIds(), [3, 1, 2, 4])
    await grip(3).focus(); await page.keyboard.press('ArrowDown'); await waitSaved()
    assert.deepEqual(await rowIds(), [1, 3, 2, 4])
    record(`${engine}: drag and keyboard order saved, page reload keeps custom order`)
    await reset()
    await page.getByLabel('服务器分组', { exact: true }).selectOption('A')
    await grip(3).focus(); await page.keyboard.press('ArrowUp'); await waitSaved()
    assert.deepEqual(payload.nodes.map(n => n.id), [3, 2, 1, 4])
    assert.deepEqual(await rowIds(), [3, 1])
    record(`${engine}: filtered reorder preserves hidden servers and their slots`)
    await reset(); saveMode = 'fail'
    await grip(1).focus(); await page.keyboard.press('ArrowDown')
    await status.getByText('排序未保存，已恢复原顺序。请重试。', { exact: true }).waitFor()
    assert.deepEqual(await rowIds(), [1, 2, 3, 4])
    await grip(1).focus()
    saveMode = 'lost'; const beforeLost = orderWrites.length
    await page.keyboard.press('ArrowDown'); await waitSaved()
    assert.deepEqual(await rowIds(), [2, 1, 3, 4]); assert.equal(orderWrites.length, beforeLost + 1)
    record(`${engine}: rejected save restores order; lost response reconciles once without duplicate write`)
    await reset(); payload.nodes = [original.nodes[1], original.nodes[0], original.nodes[2], original.nodes[3]]
    const beforeConflict = orderWrites.length
    await grip(1).focus(); await page.keyboard.press('ArrowDown')
    await status.getByText('服务器顺序已变化，已显示当前顺序，请重新拖动。', { exact: true }).waitFor()
    assert.equal(orderWrites.length, beforeConflict); assert.deepEqual(await rowIds(), [2, 1, 3, 4])
    await reset(); const beforeCancel = orderWrites.length
    const handle = await grip(1).boundingBox()
    await page.mouse.move(handle.x + 20, handle.y + 20); await page.mouse.down(); await page.mouse.move(handle.x + 60, handle.y + 70)
    await page.keyboard.press('Escape'); await page.mouse.up()
    assert.equal(orderWrites.length, beforeCancel); assert.deepEqual(await rowIds(), [1, 2, 3, 4])
    record(`${engine}: stale order rejected before write; Escape cancels drag`)
    // OS comes from reported data, including missing/long values, and adds no height.
    assert.equal(await page.locator('[data-node-id="1"] .node-os').getAttribute('title'), 'Ubuntu 24.04.3 LTS')
    assert.match(await page.locator('[data-node-id="2"] .node-os').textContent(), /Windows/)
    assert.match(await page.locator('[data-node-id="3"] .node-os').textContent(), /未知/)
    record(`${engine}: reported OS and unknown fallback fit beside server name`)
    if (engine === 'chromium') {
      await page.setViewportSize({ width: 390, height: 1000 }); await reset()
      await grip(2).evaluate(el => el.scrollIntoView({ block: 'center' }))
      const a = await grip(2).boundingBox(), b = await page.locator('[data-node-id="1"]').boundingBox()
      const cdp = await context.newCDPSession(page), x = a.x + a.width / 2, y = a.y + a.height / 2
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      for (let step = 1; step <= 10; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (b.x + 80 - x) * step / 10, y: y + (b.y + 12 - y) * step / 10 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await waitSaved(); assert.deepEqual(await rowIds(), [2, 1, 3, 4]); await cdp.detach()
      record(`${engine}: native touch drag on mobile saves without opening details`)
    }
    await reset(); await page.setViewportSize({ width: 1440, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const heightBefore = (await card.boundingBox()).height
    await page.getByRole('button', { name: '下一项资源' }).click()
    await page.waitForFunction(() => document.querySelector('.highlight-content')?.getAnimations().length > 0)
    await page.waitForFunction(() => document.querySelector('.highlight-content') && !document.querySelector('.highlight-content').className.includes('-active'))
    assert.equal((await card.boundingBox()).height, heightBefore)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    record(`${engine}: brief resource transition keeps card height stable; reduced motion supported`)
    // Curated synthetic preview: one concrete expiry alert, desktop and mobile.
    payload = { ...structuredClone(original), nodes: original.nodes.map((n, i) => ({ ...n, name: ['SJC', 'Build-01', 'Edge-SG', 'Edge-JP'][i], online: true, fresh: true, memory: 30, expiryDays: i === 3 ? 22 : null })), alerts: [{ nodeId: 4, kind: 'expiry' }] }
    await page.getByRole('button', { name: '刷新监控' }).click()
    await page.locator('.alert-preview').getByText('22 天后到期', { exact: true }).waitFor()
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 1000 : 900 }); await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: join(output, `${engine}-${width}-preview.png`) })
    }
    // Return resource card to traffic for empty/zero checks below.
    while (!(await card.locator('.highlight-label-full').textContent()).includes('流量')) await page.getByRole('button', { name: '下一项资源' }).click()
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
    record(`${engine}: refresh recomputes winners, empty/unknown distinct from zero, zero alerts`)
    await browser.close(); browser = null
  }
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.deepEqual(external, [])
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'PASS', checks, errors, unexpected, external, productionWrites: 0 }, null, 2))
  console.log(`MONITOR_WORKSPACE_UI_PASS ${checks.length} checks; Chromium/WebKit; synthetic data only`)
} finally { await browser?.close(); await server.close() }
