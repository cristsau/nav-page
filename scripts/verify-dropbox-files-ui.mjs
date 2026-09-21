// Actual Vue view + synthetic API/media. No production or personal cloud access.
import assert from 'node:assert/strict'
import { dropboxContentHash } from '../api/src/lib/dropboxFileUploads.js'
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
const item = (id, name, kind, extra = {}) => ({ id: 'id:' + id, name, path: '/' + name, type: kind === 'folder' ? 'folder' : 'file', kind, ...(kind === 'folder' ? {} : { size: 64, rev: 'abcdef123', modified: '2026-09-19T00:00:00Z', downloadable: true }), mutable: true, officialUrl: 'https://www.dropbox.com/home/' + encodeURIComponent(name), ...extra })
const initial = [item('folder', '旅行手记', 'folder'), item('protected', 'Apps', 'folder', { mutable: false }), item('text', '周末旅行计划.md', 'text'), item('video', '海边随拍.webm', 'video'), item('image', '旅行照片.png', 'image'), item('office', '行程安排.xlsx', 'office')]
let entries = [...initial], conflict = false, disconnected = false, media, saves = 0, uploads = 0
const uploadJobs = new Map()
let chunkCount = 0, chunkDelay = 0, failDelete = false, contentRequests = 0
let persistentUploads = false
let offlineJobs = [], workerOnline = true
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
    if (url.pathname.startsWith('/api/offline-downloads/')) {
      const op = url.pathname.split('/').pop(), body = request.postDataJSON()
      let result = {}
      if (op === 'status') result = { enabled: true, maxBytes: 6 * 1024 ** 3, workerOnline, entries: offlineJobs }
      else if (op === 'add') {
        assert.equal(body.url, 'https://example.com/synthetic.mp4'); assert.equal(body.destination, '/synthetic.mp4')
        offlineJobs.push({ id: 'a'.repeat(32), name: 'synthetic.mp4', destination: body.destination, state: 'queued', intent: 'run', downloaded: 0, size: null, uploaded: 0 })
      } else if (op === 'control') {
        const job = offlineJobs.find(j => j.id === body.id); assert.ok(job)
        job.state = body.command === 'pause' ? 'paused' : body.command === 'cancel' ? 'cancelled' : 'queued'; job.intent = body.command === 'resume' ? 'run' : body.command
      } else if (op === 'clear') offlineJobs = offlineJobs.filter(j => j.state !== 'cancelled')
      else throw Error('Unexpected offline fixture operation')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result), headers: { 'Cache-Control': 'no-store' } })
    }
    if (!url.pathname.startsWith('/api/dropbox-files/')) return route.continue()
    const action = url.pathname.slice('/api/dropbox-files/'.length)
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Cache-Control': 'no-store' } })
    if (action === 'status') return disconnected ? send({ code: 'NOT_CONNECTED' }, 503) : send({ connected: true, textLimit: 1048576, uploadLimit: 50 * 1024 ** 3, chunkSize: 8 * 1024 * 1024, uploadResume: persistentUploads ? 'reselect_after_restart_encrypted' : 'reselect_after_refresh_api_process', deletedFiles: true })
    if (action.startsWith('content/')) {
      contentRequests++
      if (action.endsWith('id%3Avideo') && media) {
        const range = request.headers().range, match = range?.match(/^bytes=(\d+)-(\d*)$/)
        const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1
        return route.fulfill({ status: match ? 206 : 200, contentType: 'video/webm', body: media.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), ...(match ? { 'Content-Range': `bytes ${start}-${end}/${media.length}` } : {}) } })
      }
      return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8a8AAAAASUVORK5CYII=', 'base64') })
    }
    if (action === 'upload/chunk') {
      const job = uploadJobs.get(request.headers()['x-upload-id']), offset = Number(request.headers()['x-upload-offset']), size = request.postDataBuffer().length
      assert.ok(size <= 8 * 1024 * 1024); assert.equal(offset, job.offset); chunkCount++
      if (chunkDelay) await new Promise(resolve => setTimeout(resolve, chunkDelay))
      job.offset += size; return send({ ...job })
    }
    const body = request.postDataJSON(); actions.push({ action, body })
    if (action === 'history') return send({ current: initial[2], entries: [initial[2], { ...initial[2], rev: 'abcdef122' }], limit: 20, recoveryLimit: 20 * 1024 * 1024 })
    if (action === 'history/copy') return send({ item: { ...initial[2], path: body.destination, id: 'id:recovered' } })
    if (action === 'deleted/list') return send({ entries: body.cursor ? [{ path: '/other.txt', name: 'other.txt' }] : [{ path: '/lost.txt', name: 'lost.txt' }], hasMore: !body.cursor, cursor: body.cursor ? null : 'trash-next' })
    if (action === 'deleted/history') return send({ deleted: { path: body.path, name: body.path.slice(1) }, entries: [{ ...item('lost', 'lost.txt', 'text'), downloadToken: 'synthetic-download' }], recoveryLimit: 20 * 1024 * 1024 })
    if (action === 'deleted/copy') { assert.notEqual(body.destination, body.path); return send({ item: item('found', body.destination.slice(1), 'text') }) }
    if (action === 'upload/list') return send({ entries: [...uploadJobs.values()] })
    if (action === 'upload/reattach') { const job = uploadJobs.get(body.uploadId); assert.equal(body.contentHash, job.contentHash); return send({ ...job }) }
    if (action === 'upload/start') { const job = { uploadId: (++uploads).toString(16).padStart(48, '0'), path: body.path, contentHash: body.contentHash, offset: 0, size: body.size, chunkSize: 8 * 1024 * 1024, state: 'uploading' }; uploadJobs.set(job.uploadId, job); return send({ ...job }) }
    if (action === 'upload/status') return send({ ...uploadJobs.get(body.uploadId) })
    if (action === 'upload/finish') { const job = uploadJobs.get(body.uploadId); assert.equal(job.offset, job.size); job.state = 'complete'; return send({ ...job, item: {} }) }
    if (action === 'upload/cancel') { uploadJobs.delete(body.uploadId); return send({ state: 'cancelled' }) }
    if (action === 'list') {
      if (body.cursor) return send({ entries: [item('more', '归档.txt', 'text')], hasMore: false })
      return send({ entries: body.query ? entries.filter(i => i.name.includes(body.query)) : body.path ? [] : entries, hasMore: !body.query && !body.path, cursor: 'OPAQUE_TEST_CURSOR' })
    }
    if (action === 'text/read') return send({ item: initial[2], content: '# 周末旅行\n\n沿海散步，慢慢记录。\n' })
    if (action === 'text/save') { saves++; return conflict ? send({ code: 'FILE_CHANGED' }, 409) : send({ item: { ...initial[2], rev: 'abcdef124' } }) }
    if (action === 'folder') { entries.push(item('new', body.path.slice(1), 'folder')); return send({ item: entries.at(-1) }) }
    if (action === 'move') { entries = entries.map(e => e.id === body.id ? { ...e, name: body.destination.split('/').pop(), path: body.destination } : e); return send({ item: entries.find(e => e.id === body.id) }) }
    if (action === 'copy') { const source = entries.find(e => e.id === body.id); const copied = { ...source, id: source.id + '-copy', path: body.destination }; entries.push(copied); return send({ item: copied }) }
    if (action === 'delete/preview') { const target = entries.find(e => e.id === body.id); return send({ token: 'synthetic-confirm-' + target.id, item: target, descendants: target.type === 'folder' ? 3 : 0, files: target.type === 'folder' ? 2 : 1, bytes: 64 }) }
    if (action === 'delete') {
      assert.equal(body.token, 'synthetic-confirm-' + body.id); assert.equal(body.confirmation, undefined)
      if (failDelete && body.id === 'id:office') return send({ code: 'FILE_CHANGED', error: '文件已变化，请重新确认。' }, 409)
      entries = entries.filter(e => e.id !== body.id); return send({ deleted: true })
    }
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
  await page.getByRole('button', { name: '管理 行程安排.xlsx', exact: true }).click(); await page.getByRole('button', { name: '移动', exact: true }).click()
  await page.locator('.folder-picker').getByRole('button', { name: '旅行归档', exact: true }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click(); await page.getByRole('heading', { name: '操作结果', exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  assert.ok(actions.some(a => a.action === 'move' && a.body.destination === '/旅行归档/行程安排.xlsx')); checks.push('move-explicit-destination')
  await page.getByRole('button', { name: '管理 旅行照片.png', exact: true }).click(); await page.getByRole('button', { name: '删除文件', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.drive-operation-items')?.textContent.includes('旅行照片.png'))
  assert.equal(await page.locator('#drive-value').count(), 0)
  await page.getByRole('button', { name: '确认删除', exact: true }).click(); await page.getByRole('heading', { name: '操作结果', exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  assert.ok(actions.some(a => a.action === 'delete' && a.body.token)); checks.push('one-confirm-delete-no-typing')
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
  const input = page.getByLabel('选择上传文件', { exact: true })
  await input.setInputFiles([{ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') }, { name: 'large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(25 * 1024 * 1024, 42) }])
  await page.waitForFunction(() => [...document.querySelectorAll('.drive-transfer-title>span')].filter(x => x.textContent === '上传完成').length === 2)
  assert.equal(uploads, 2); assert.equal(chunkCount, 5); checks.push('multi-file-25MiB-chunked-upload')
  chunkDelay = 500
  await input.setInputFiles({ name: 'pausable.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(17 * 1024 * 1024) })
  const task = page.locator('.drive-transfers li').filter({ hasText: 'pausable.bin' })
  await task.getByRole('button', { name: '暂停', exact: true }).click(); await task.getByText('已暂停', { exact: true }).waitFor()
  await page.evaluate(() => window.testRouter.push('/settings')); assert.equal(await task.count(), 1)
  await task.getByRole('button', { name: '继续', exact: true }).click(); await task.getByText('上传完成', { exact: true }).waitFor()
  chunkDelay = 0; checks.push('pause-resume-upload-route-guard')
  await page.setViewportSize({ width: 390, height: 900 })
  await page.getByRole('button', { name: '选择文件', exact: true }).click()
  assert.equal(await page.getByRole('checkbox', { name: '选择 Apps', exact: true }).isDisabled(), true)
  await page.getByRole('checkbox', { name: '选择 行程安排.xlsx', exact: true }).check()
  await page.getByRole('checkbox', { name: '选择 旅行手记', exact: true }).check()
  const bar = await page.locator('.drive-batch-bar').boundingBox(); assert.ok(bar.x >= 0 && bar.x + bar.width <= 390 && bar.y + bar.height < 830)
  await page.screenshot({ path: join(output, 'batch-390.png'), fullPage: true })
  await page.locator('.drive-batch-bar').getByRole('button', { name: '删除', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.drive-operation-items li').length === 2)
  assert.match(await page.locator('.drive-operation-items').innerText(), /包含 3 个子项/)
  await page.screenshot({ path: join(output, 'delete-batch-390.png'), fullPage: true })
  failDelete = true
  await page.getByRole('button', { name: '确认删除', exact: true }).click(); await page.getByRole('heading', { name: '操作结果', exact: true }).waitFor()
  assert.match(await page.locator('.drive-dialog').innerText(), /1 项成功，1 项未完成/)
  failDelete = false
  await page.getByRole('button', { name: '重新核对未完成项', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.drive-operation-items li').length === 1)
  assert.match(await page.locator('.drive-operation-items').innerText(), /行程安排/)
  await page.getByRole('button', { name: '确认删除', exact: true }).click(); await page.getByRole('heading', { name: '操作结果', exact: true }).waitFor()
  assert.equal(actions.filter(a => a.action === 'delete' && a.body.id === 'id:folder').length, 1)
  assert.equal(actions.filter(a => a.action === 'delete' && a.body.id === 'id:office').length, 2)
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  await page.getByRole('button', { name: '结束选择', exact: true }).click(); checks.push('batch-selection-folder-preview-partial-failure-mobile-toolbar')
  await page.getByRole('button', { name: '管理 周末旅行计划.md', exact: true }).click(); await page.getByRole('button', { name: '复制', exact: true }).click()
  await page.locator('.folder-picker').getByRole('button', { name: '旅行归档', exact: true }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click(); await page.getByRole('heading', { name: '操作结果', exact: true }).waitFor()
  assert.ok(actions.some(a => a.action === 'copy' && a.body.destination === '/旅行归档/周末旅行计划.md'))
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' }); checks.push('copy-folder-picker-and-retry-failed-only')
  // Presentation-only tools never request file bodies, silently select hidden items or fetch all pages.
  await page.getByRole('button', { name: '清理完成记录', exact: true }).click()
  const beforePresentationReads = contentRequests
  entries = [...initial.map(i => ({ ...i })), item('archive', '旅途.zip', 'file', { size: 2048 })]
  await page.getByRole('button', { name: '刷新文件列表', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.drive-list li').length === 7)
  const listNames = () => page.locator('.drive-file-label strong').allTextContents()
  const originalFolderOrder = (await listNames()).slice(0, 2)
  await page.getByLabel('文件排序', { exact: true }).selectOption('name-desc')
  assert.deepEqual((await listNames()).slice(0, 2), [...originalFolderOrder].reverse())
  await page.getByLabel('文件类型筛选', { exact: true }).selectOption('archive')
  assert.deepEqual(await listNames(), ['旅途.zip'])
  await page.getByLabel('文件类型筛选', { exact: true }).selectOption('audio')
  await page.getByRole('heading', { name: '已加载项目中没有此类型' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '加载更多', exact: true }).isVisible(), true)
  await page.getByLabel('文件类型筛选', { exact: true }).selectOption('document')
  await page.getByRole('button', { name: '加载更多', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.drive-list li').length === 3)
  assert.match(await page.locator('.drive-list-footer').innerText(), /显示 3 \/ 已加载 8/)
  checks.push('sort-filter-loaded-page-scope-and-empty-pagination')
  await page.getByRole('button', { name: '选择文件', exact: true }).click()
  await page.getByRole('checkbox', { name: '选择 周末旅行计划.md', exact: true }).check()
  await page.getByLabel('文件类型筛选', { exact: true }).selectOption('video')
  assert.match(await page.locator('.drive-batch-bar').innerText(), /已选 0 项/)
  await page.getByRole('button', { name: '选择已显示（最多50项）', exact: true }).click()
  assert.equal(await page.locator('.drive-checkbox input:checked').count(), 1)
  assert.equal(await page.getByRole('checkbox', { name: '选择 海边随拍.webm', exact: true }).isChecked(), true)
  await page.getByRole('button', { name: '结束选择', exact: true }).click(); checks.push('filter-clears-selection-and-selects-visible-only')
  await page.getByLabel('文件类型筛选', { exact: true }).selectOption('all')
  await page.getByRole('button', { name: '网格', exact: true }).click()
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await page.getByRole('button', { name: '网格', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'grid overflow ' + width)
    const cards = await page.locator('.drive-grid>li').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().width))
    assert.ok(cards.every(w => w > 80)); await page.screenshot({ path: join(output, `grid-${width}.png`), fullPage: true })
  }
  await page.getByRole('button', { name: '选择文件', exact: true }).click()
  await page.getByRole('checkbox', { name: '选择 周末旅行计划.md', exact: true }).check()
  assert.equal(await page.getByRole('checkbox', { name: '选择 Apps', exact: true }).isDisabled(), true)
  await page.screenshot({ path: join(output, 'grid-select-320.png'), fullPage: true })
  await page.getByRole('button', { name: '结束选择', exact: true }).click(); checks.push('grid-layout-three-widths-and-protected-selection')
  await page.getByRole('button', { name: '管理 周末旅行计划.md', exact: true }).click()
  await page.getByRole('button', { name: '文件详情', exact: true }).click()
  assert.match(await page.locator('.drive-details').innerText(), /64 字节/)
  await page.evaluate(() => { window.copyFixture = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => window.copyFixture.push(value) } }) })
  await page.getByRole('button', { name: '复制文件路径', exact: true }).click()
  await page.getByText('已复制路径', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => window.copyFixture), ['/周末旅行计划.md'])
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('synthetic denied') } })
  await page.getByRole('button', { name: '复制文件名称', exact: true }).click()
  await page.getByText('浏览器未允许复制，请选中下方文字手动复制。', { exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'details-320.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  await page.getByRole('button', { name: '管理 Apps', exact: true }).click(); await page.getByRole('button', { name: '文件详情', exact: true }).click()
  assert.match(await page.locator('.drive-details').innerText(), /未统计（不扫描子目录）/)
  assert.match(await page.locator('.drive-details').innerText(), /包含受保护备份/)
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' }); checks.push('details-readonly-copy-success-denied-folder-unknown')
  assert.equal(contentRequests, beforePresentationReads, 'grid and details must not auto-download content')
  const drag = async (kind = 'file', target = '.drive-surface') => page.evaluate(({ kind, target }) => {
    // Programmatically-created DataTransfer files have no OS Entry. Model that capability explicitly.
    const file = new File(['synthetic drag'], 'dropped.txt', { type: 'text/plain' })
    const dt = { types: ['Files'], dropEffect: 'none', items: [{ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => kind === 'folder' ? { isDirectory: true } : { isFile: true } }] }
    const el = document.querySelector(target)
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true }); Object.defineProperty(over, 'dataTransfer', { value: dt }); el.dispatchEvent(over)
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: dt }); el.dispatchEvent(ev)
    return ev.defaultPrevented
  }, { kind, target })
  await page.locator('.drive-file').filter({ hasText: '周末旅行计划.md' }).click(); await page.getByRole('button', { name: '编辑文本', exact: true }).click(); await page.locator('#drive-editor').fill('SYNTHETIC_DRAG_DRAFT')
  assert.equal(await drag('file', '#drive-editor'), true)
  assert.equal(await page.locator('#drive-editor').inputValue(), 'SYNTHETIC_DRAG_DRAFT')
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click(); await page.getByRole('button', { name: '放弃修改并关闭', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  checks.push('file-drop-does-not-navigate-or-overwrite-editor')
  const beforeDropUploads = uploads
  assert.equal(await drag(), true); await page.getByRole('heading', { name: '确认上传', exact: true }).waitFor()
  assert.equal(uploads, beforeDropUploads)
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' }); assert.equal(uploads, beforeDropUploads)
  await drag('folder'); await page.getByText('暂不支持拖入文件夹，本次未加入队列。请进入文件夹选择其中的文件。', { exact: true }).waitFor(); assert.equal(uploads, beforeDropUploads)
  assert.equal(await drag('file', '.drive-heading'), true); assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByRole('button', { name: '列表', exact: true }).click()
  await page.locator('.drive-file').filter({ hasText: '旅行手记' }).click(); await page.waitForFunction(() => !document.querySelector('.drive-surface').getAttribute('aria-busy') || document.querySelector('.drive-surface').getAttribute('aria-busy') === 'false')
  await drag(); await page.getByRole('heading', { name: '确认上传', exact: true }).waitFor()
  assert.equal(await page.locator('.drive-drop-target').innerText(), '/旅行手记')
  await page.screenshot({ path: join(output, 'drop-confirm-320.png'), fullPage: true })
  await page.getByRole('button', { name: '确认上传 1 个文件', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  await page.locator('.drive-transfers li').filter({ hasText: 'dropped.txt' }).getByText('上传完成', { exact: true }).waitFor()
  assert.equal(uploads, beforeDropUploads + 1); assert.ok(actions.some(a => a.action === 'upload/start' && a.body.path === '/旅行手记/dropped.txt'))
  await page.getByRole('button', { name: '全部文件', exact: true }).click(); await page.waitForSelector('.drive-list li')
  checks.push('drop-confirm-cancel-reject-folder-outside-and-target-binding')
  // Directory selection is a synthetic FileList; no OS picker or personal file access.
  const chooseDirectory = () => page.getByLabel('选择上传文件夹', { exact: true }).evaluate(input => {
    const files = ['Trip/a.txt', 'Trip/photos/b.txt'].map(relative => { const file = new File(['synthetic'], relative.split('/').at(-1)); Object.defineProperty(file, 'webkitRelativePath', { value: relative }); return file })
    Object.defineProperty(input, 'files', { configurable: true, value: files }); input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const foldersBefore = actions.filter(a => a.action === 'folder').length
  await chooseDirectory(); await page.getByRole('heading', { name: '确认上传文件夹', exact: true }).waitFor()
  assert.equal(actions.filter(a => a.action === 'folder').length, foldersBefore)
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  assert.equal(actions.filter(a => a.action === 'folder').length, foldersBefore)
  await chooseDirectory(); await page.getByRole('heading', { name: '确认上传文件夹', exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'folder-confirm-320.png'), fullPage: true })
  await page.getByRole('button', { name: '确认创建并上传', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  await page.locator('.drive-transfers li').filter({ hasText: 'Trip/photos/b.txt' }).getByText('上传完成', { exact: true }).waitFor()
  assert.deepEqual(actions.filter(a => a.action === 'folder').slice(foldersBefore).map(a => a.body.path), ['/Trip', '/Trip/photos'])
  assert.ok(actions.some(a => a.action === 'upload/start' && a.body.path === '/Trip/photos/b.txt'))
  checks.push('directory-confirm-cancel-hierarchy-and-upload')
  await page.getByRole('button', { name: '管理 周末旅行计划.md', exact: true }).click(); await page.getByRole('button', { name: '历史版本', exact: true }).click()
  await page.locator('.drive-history li').nth(1).waitFor()
  assert.match(await page.getByRole('link', { name: '下载版本', exact: true }).nth(1).getAttribute('href'), /rev=abcdef122/)
  await page.getByRole('button', { name: '另存副本', exact: true }).nth(1).click()
  assert.match(await page.locator('#recovery-name').inputValue(), /恢复-/)
  await page.screenshot({ path: join(output, 'history-320.png'), fullPage: true })
  assert.ok(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
  await page.getByRole('button', { name: '确认另存新文件', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  const recovery = actions.find(a => a.action === 'history/copy'); assert.equal(recovery.body.rev, 'abcdef122'); assert.notEqual(recovery.body.destination, initial[2].path)
  checks.push('history-download-revision-and-confirm-new-copy')
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('list', { name: '已删除记录', exact: true }).getByText('lost.txt', { exact: true }).waitFor()
  await page.getByRole('button', { name: '继续加载记录', exact: true }).click()
  await page.getByRole('list', { name: '已删除记录', exact: true }).getByText('other.txt', { exact: true }).waitFor()
  await page.getByRole('button', { name: '查看可用版本', exact: true }).first().click()
  assert.match(await page.getByRole('link', { name: '下载版本', exact: true }).getAttribute('href'), /deleted\/content\/synthetic-download$/)
  await page.getByRole('button', { name: '找回副本', exact: true }).click()
  assert.equal(await page.locator('#deleted-copy-name').inputValue(), 'lost-找回.txt')
  assert.ok(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
  await page.screenshot({ path: join(output, 'deleted-320.png'), fullPage: true })
  await page.getByRole('button', { name: '确认找回新副本', exact: true }).click()
  await page.getByText('已找回为同目录的新副本，未覆盖其他文件。', { exact: true }).waitFor()
  assert.ok(actions.some(a => a.action === 'deleted/copy' && a.body.destination === '/lost-找回.txt'))
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  checks.push('deleted-list-pagination-version-download-new-copy-320')
  // Synthetic persisted capability; real process restart is covered by API tests.
  persistentUploads = true
  const resumeBytes = Buffer.alloc(9 * 1024 * 1024, 23)
  uploadJobs.set('f'.repeat(48), { uploadId: 'f'.repeat(48), path: '/resume.bin', size: resumeBytes.length, offset: 8 * 1024 * 1024, chunkSize: 8 * 1024 * 1024, contentHash: dropboxContentHash(resumeBytes), state: 'uploading' })
  await page.reload(); await page.locator('.drive-transfers li').filter({ hasText: 'resume.bin' }).getByText('等待重选原文件', { exact: true }).waitFor()
  assert.match(await page.locator('.drive-transfers').innerText(), /进度已加密保存，服务器重启后也可续传/)
  checks.push('encrypted-restart-capability-is-distinct-from-memory-mode')
  const resumedRow = page.locator('.drive-transfers li').filter({ hasText: 'resume.bin' })
  await resumedRow.getByRole('button', { name: '重选原文件', exact: true }).click()
  await page.getByLabel('重新选择续传原文件', { exact: true }).setInputFiles({ name: 'resume.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(resumeBytes.length, 24) })
  await resumedRow.getByText('内容不一致，未继续上传。请选择原文件。', { exact: true }).waitFor()
  await resumedRow.getByRole('button', { name: '重选原文件', exact: true }).click()
  await page.getByLabel('重新选择续传原文件', { exact: true }).setInputFiles({ name: 'resume.bin', mimeType: 'application/octet-stream', buffer: resumeBytes })
  await resumedRow.getByText('已暂停', { exact: true }).waitFor()
  await page.screenshot({ path: join(output, 'resume-320.png'), fullPage: true })
  const chunksBeforeResume = chunkCount
  await resumedRow.getByRole('button', { name: '继续', exact: true }).click()
  await resumedRow.getByText('上传完成', { exact: true }).waitFor()
  assert.equal(chunkCount, chunksBeforeResume + 1)
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0)
  checks.push('reload-reselect-reject-changed-content-resume-offset-no-browser-storage')
  await page.getByRole('button', { name: '离线下载', exact: true }).click()
  await page.locator('#offline-url').fill('https://example.com/synthetic.mp4'); await page.locator('#offline-name').focus()
  assert.equal(await page.locator('#offline-name').inputValue(), 'synthetic.mp4')
  await page.getByRole('button', { name: '创建离线任务', exact: true }).click()
  const offlineList = page.getByRole('list', { name: '离线下载任务', exact: true })
  await offlineList.getByText('synthetic.mp4', { exact: true }).waitFor()
  assert.equal(await page.locator('#offline-url').inputValue(), '')
  await offlineList.getByRole('button', { name: '暂停', exact: true }).click(); await offlineList.getByText('已暂停', { exact: true }).waitFor()
  await offlineList.getByRole('button', { name: '继续', exact: true }).click(); await offlineList.getByText('排队中', { exact: true }).waitFor()
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    assert.ok(await page.getByRole('dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
    await page.screenshot({ path: join(output, `offline-${width}.png`), fullPage: true })
  }
  await offlineList.getByRole('button', { name: '取消任务', exact: true }).click()
  assert.equal(offlineJobs[0].state, 'queued')
  await offlineList.getByRole('button', { name: '确认取消', exact: true }).click(); await offlineList.getByText('已取消', { exact: true }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: '清理完成记录', exact: true }).click()
  await page.getByText('还没有任务。下载完成并校验后自动清理服务器暂存文件，不删除 Dropbox 中的文件。', { exact: true }).waitFor()
  workerOnline = false; await page.getByRole('button', { name: '刷新离线任务', exact: true }).click(); await page.getByText('等待下载节点连接', { exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' })
  await page.setViewportSize({ width: 320, height: 900 }); checks.push('offline-create-pause-resume-confirm-cancel-cleanup-disconnected-layout')
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
  // preload=metadata need not fetch a decoded frame until playback is requested.
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1)
  await page.locator('video').evaluate(async v => { v.muted = true; await v.play() }); await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0)
  assert.ok(await page.locator('video').evaluate(v => v.readyState >= 2 && !v.error))
  assert.ok(await page.locator('.drive-footer > *').evaluateAll(elements => elements.every(e => e.scrollWidth <= e.clientWidth + 1)), 'media footer labels must not overflow buttons')
  await page.screenshot({ path: join(output, 'media-320.png'), fullPage: true }); await page.getByRole('button', { name: '关闭弹窗', exact: true }).click(); await page.waitForSelector('[role=dialog]', { state: 'detached' }); checks.push('native-video-decode-play')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await page.screenshot({ path: join(output, 'files-dark-320.png'), fullPage: true }); checks.push('dark-layout')
  disconnected = true; await page.getByRole('button', { name: '刷新文件列表', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.drive-feedback.drive-error')?.textContent.includes('尚未接通'))
  assert.equal(await page.getByRole('button', { name: '上传文件', exact: true }).isDisabled(), true); checks.push('not-connected-fail-closed')
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'PASS', checks, pageErrors: errors, externalRequests: external, realCloudAccess: false }, null, 2))
  console.log(JSON.stringify({ status: 'PASS', checks, realCloudAccess: false }))
} finally { await browser?.close(); await server.close() }
