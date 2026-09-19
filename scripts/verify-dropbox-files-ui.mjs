// Actual Vue view + synthetic API/media. No production or personal cloud access.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
const output = process.env.NAV_FILES_UI_EVIDENCE
if (!output) throw Error('Task-scoped evidence directory required')
const appRoot = resolve('app'), req = createRequire(join(appRoot, 'package.json'))
const { createServer } = await import(pathToFileURL(req.resolve('vite')).href)
const { chromium } = createRequire(import.meta.url)(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="test"></div><script type="module">
import {createApp,h} from 'vue'; import {createRouter,createMemoryHistory,RouterView} from 'vue-router';
import Files from '/src/modules/files/FilesView.vue'; import '/src/styles/reset.css'; import '/src/styles/variables.css'; import '/src/styles/ios.css';
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/files',component:Files},{path:'/settings',component:{template:'<div>Settings fixture</div>'}}]});
window.testRouter=router; await router.push('/files'); await router.isReady(); createApp({render:()=>h(RouterView)}).use(router).mount('#test');window.filesMounted=true;
</script><style>body{margin:0;background:var(--bg-secondary);font-family:system-ui,sans-serif}#test{max-width:1200px;margin:32px auto;padding:0 24px}@media(max-width:640px){#test{margin:16px auto;padding:0 12px}}</style></body></html>`
const server = await createServer({ root: appRoot, configFile: join(appRoot, 'vite.config.js'), server: { host: '127.0.0.1', port: 4187, strictPort: true }, plugins: [{ name: 'files-harness', configureServer(vite) { vite.middlewares.use('/__files-test', async (_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(await vite.transformIndexHtml('/__files-test', html)) }) } }] })
const item = (id, name, kind, extra = {}) => ({ id: 'id:' + id, name, path: '/' + name, type: kind === 'folder' ? 'folder' : 'file', kind, size: 64, rev: 'abcdef123', modified: '2026-09-19T00:00:00Z', downloadable: true, mutable: true, officialUrl: 'https://www.dropbox.com/home/' + encodeURIComponent(name), ...extra })
const initial = [item('folder', '旅行手记', 'folder'), item('protected', 'Apps', 'folder', { mutable: false }), item('text', '周末旅行计划.md', 'text'), item('video', '海边随拍.webm', 'video'), item('image', '旅行照片.png', 'image'), item('office', '行程安排.xlsx', 'office')]
let entries = [...initial], conflict = false, disconnected = false, media, saves = 0, uploads = 0
const checks = [], errors = [], external = [], actions = []
let browser
await mkdir(output, { recursive: true })
try {
  await server.listen(); browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true })
  const page = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.hostname !== '127.0.0.1') { external.push(url.origin); return route.abort() }
    if (!url.pathname.startsWith('/api/dropbox-files/')) return route.continue()
    const action = url.pathname.slice('/api/dropbox-files/'.length)
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Cache-Control': 'no-store' } })
    if (action === 'status') return disconnected ? send({ code: 'NOT_CONNECTED' }, 503) : send({ connected: true, textLimit: 1048576, uploadLimit: 20971520 })
    if (action.startsWith('content/')) {
      if (action.endsWith('id%3Avideo') && media) {
        const range = request.headers().range, match = range?.match(/^bytes=(\d+)-(\d*)$/)
        const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1
        return route.fulfill({ status: match ? 206 : 200, contentType: 'video/webm', body: media.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), ...(match ? { 'Content-Range': `bytes ${start}-${end}/${media.length}` } : {}) } })
      }
      return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8a8AAAAASUVORK5CYII=', 'base64') })
    }
    if (action === 'upload') { uploads++; actions.push({ action, path: decodeURIComponent(request.headers()['x-file-name']) }); return send({ item: {} }) }
    const body = request.postDataJSON(); actions.push({ action, body })
    if (action === 'list') {
      if (body.cursor) return send({ entries: [item('more', '归档.txt', 'text')], hasMore: false })
      return send({ entries: body.query ? entries.filter(i => i.name.includes(body.query)) : body.path ? [] : entries, hasMore: !body.query && !body.path, cursor: 'OPAQUE_TEST_CURSOR' })
    }
    if (action === 'text/read') return send({ item: initial[2], content: '# 周末旅行\n\n沿海散步，慢慢记录。\n' })
    if (action === 'text/save') { saves++; return conflict ? send({ code: 'FILE_CHANGED' }, 409) : send({ item: { ...initial[2], rev: 'abcdef124' } }) }
    if (action === 'folder') { entries.push(item('new', body.path.slice(1), 'folder')); return send({ item: entries.at(-1) }) }
    if (action === 'move') { entries = entries.map(e => e.id === body.id ? { ...e, name: body.destination.split('/').pop(), path: body.destination } : e); return send({ item: entries.find(e => e.id === body.id) }) }
    if (action === 'delete') { entries = entries.filter(e => e.id !== body.id); return send({ deleted: true }) }
    throw Error('Unhandled fixture action')
  })
  await page.goto('http://127.0.0.1:4187/__files-test'); await page.waitForSelector('.drive-list li')
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow ' + width)
    await page.screenshot({ path: join(output, `files-${width}.png`), fullPage: true })
    await page.getByRole('button', { name: '管理 周末旅行计划.md', exact: true }).click()
    const rect = await page.getByRole('dialog').boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1)
    await page.screenshot({ path: join(output, `manage-${width}.png`), fullPage: true })
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
    checks.push('layout-' + width)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: '加载更多', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.drive-list li').length === 7)
  await page.getByRole('textbox', { name: '搜索文件名' }).fill('旅行计划'); await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.drive-list li').length === 1)
  await page.getByRole('button', { name: '清除搜索', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.drive-list li').length === 6)
  checks.push('search-pagination')
  await page.getByRole('button', { name: '管理 Apps', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '重命名', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: '删除文件', exact: true }).count(), 0)
  await page.getByRole('button', { name: '打开', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  await page.getByRole('button', { name: '全部文件', exact: true }).click(); await page.waitForSelector('.drive-list li'); checks.push('protected-folder-and-manage-open')
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click(); await page.locator('#drive-value').fill('新的旅行'); await page.getByRole('button', { name: '确认', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  assert.ok(actions.some(a => a.action === 'folder' && a.body.path === '/新的旅行'))
  await page.getByRole('button', { name: '管理 新的旅行', exact: true }).click(); await page.getByRole('button', { name: '重命名', exact: true }).click(); await page.locator('#drive-value').fill('旅行归档'); await page.getByRole('button', { name: '确认', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' }); checks.push('create-rename')
  await page.getByRole('button', { name: '管理 行程安排.xlsx', exact: true }).click(); await page.getByRole('button', { name: '移动', exact: true }).click(); await page.locator('#drive-value').fill('/旅行归档/行程安排.xlsx'); await page.getByRole('button', { name: '确认', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  assert.ok(actions.some(a => a.action === 'move' && a.body.destination === '/旅行归档/行程安排.xlsx')); checks.push('move-explicit-destination')
  await page.getByRole('button', { name: '管理 旅行照片.png', exact: true }).click(); await page.getByRole('button', { name: '删除文件', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '确认删除', exact: true }).isDisabled(), true)
  await page.locator('#drive-value').fill('wrong'); assert.equal(await page.getByRole('button', { name: '确认删除', exact: true }).isDisabled(), true)
  await page.locator('#drive-value').fill('旅行照片.png'); await page.getByRole('button', { name: '确认删除', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  assert.ok(actions.some(a => a.action === 'delete' && a.body.rev === 'abcdef123')); checks.push('delete-name-confirmation')
  await page.locator('.drive-file').filter({ hasText: '周末旅行计划.md' }).click(); await page.getByRole('button', { name: '编辑文本', exact: true }).click(); await page.locator('#drive-editor').fill('SYNTHETIC_DRAFT')
  await page.evaluate(() => window.testRouter.push('/settings')); assert.equal(await page.locator('#drive-editor').inputValue(), 'SYNTHETIC_DRAFT'); assert.equal(await page.getByRole('dialog').count(), 1)
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  conflict = true; await page.getByRole('button', { name: '保存到 Dropbox', exact: true }).click(); await page.waitForSelector('.drive-dialog [role=alert]')
  assert.equal(await page.locator('#drive-editor').inputValue(), 'SYNTHETIC_DRAFT'); assert.match(await page.locator('.drive-dialog [role=alert]').innerText(), /当前草稿仍保留/)
  conflict = false; await page.getByRole('button', { name: '保存到 Dropbox', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.drive-field-label').textContent.includes('与 Dropbox 一致'))
  assert.equal(saves, 2); checks.push('text-conflict-keeps-draft-and-route-guard')
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); const footer = await page.locator('.drive-footer').boundingBox()
    assert.ok(footer.y + footer.height <= 900 && footer.x + footer.width <= width + 1, 'editor footer visible ' + width)
    await page.screenshot({ path: join(output, `editor-${width}.png`), fullPage: true })
  }
  await page.locator('#drive-editor').fill('UNSAVED_FINAL'); await page.getByRole('button', { name: '关闭编辑', exact: true }).click(); await page.getByRole('button', { name: '放弃修改并关闭', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  checks.push('editor-layout-discard')
  const input = page.getByLabel('选择上传文件')
  await input.setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') }); await page.waitForFunction(() => document.querySelector('.drive-feedback[role=status]')?.textContent.includes('上传完成'))
  await input.setInputFiles({ name: 'large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(20971521) }); await page.waitForSelector('.drive-feedback.drive-error')
  assert.equal(uploads, 1); checks.push('upload-and-limit')
  // Generate a tiny, non-personal WebM in the browser, then test native decoding.
  media = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const ctx = canvas.getContext('2d'), stream = canvas.captureStream(10), chunks = []
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
    const done = new Promise(resolve => { recorder.ondataavailable = e => chunks.push(e.data); recorder.onstop = resolve }); recorder.start()
    for (let i = 0; i < 8; i++) { ctx.fillStyle = i % 2 ? '#6266cd' : '#9eacd0'; ctx.fillRect(0, 0, 320, 180); await new Promise(r => setTimeout(r, 100)) }
    recorder.stop(); await done; stream.getTracks().forEach(t => t.stop()); return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))
  }))
  await page.locator('.drive-file').filter({ hasText: '海边随拍.webm' }).click()
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
  await page.locator('video').evaluate(async v => { v.muted = true; await v.play() }); await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0)
  assert.ok(await page.locator('.drive-footer > *').evaluateAll(elements => elements.every(e => e.scrollWidth <= e.clientWidth + 1)), 'media footer labels must not overflow buttons')
  await page.screenshot({ path: join(output, 'media-320.png'), fullPage: true }); await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' }); checks.push('native-video-decode-play')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await page.screenshot({ path: join(output, 'files-dark-320.png'), fullPage: true }); checks.push('dark-layout')
  disconnected = true; await page.getByRole('button', { name: '刷新文件列表', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.drive-feedback.drive-error')?.textContent.includes('尚未接通'))
  assert.equal(await page.getByRole('button', { name: '上传文件', exact: true }).isDisabled(), true); checks.push('not-connected-fail-closed')
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'PASS', checks, pageErrors: errors, externalRequests: external, realCloudAccess: false }, null, 2))
  console.log(JSON.stringify({ status: 'PASS', checks, realCloudAccess: false }))
} finally { await browser?.close(); await server.close() }
