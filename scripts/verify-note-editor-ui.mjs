// Actual Vue components, synthetic notes/API/clipboard only. No production access.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const { chromium } = createRequire(import.meta.url)(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const origin = 'http://127.0.0.1:4179'
const output = process.env.NAV_NOTE_UI_EVIDENCE
if (!output) throw new Error('A task-scoped evidence directory is required')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true, args: ['--disable-gpu'] })
const checks = []
const pass = (name) => { checks.push(name); console.log(`PASS ${name}`) }
const errors = []
let releaseComment, pendingComment, detailFailure = false
const now = '2026-09-15T02:00:00Z'
const comments = [{ id: 'comment-1', userId: 'test-user', username: 'Design reviewer', body: '把说明留在右侧，正文就能保持专注。', createdAt: now, status: 'open' }, { id: 'comment-2', userId: 'test-user', username: 'Reviewer', body: '已处理的示例讨论', createdAt: now, status: 'resolved' }]
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await context.routeWebSocket('**/*', (socket) => socket.close())
  const handleRoute = async (route) => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    let body = {}
    if (url.pathname === '/api/auth/session') body = { user: null }
    if (url.pathname === '/api/auth/oauth/config') body = { providers: { google: { enabled: false }, wechat: { enabled: false } } }
    if (url.pathname.includes('settings')) body = { value: null }
    if (url.pathname === '/api/dropbox-files/list') body = { entries: [{ id: 'id:note_file', type: 'file', name: '个人示例文件.pdf', path: '/个人示例文件.pdf', mutable: true }, { id: 'id:protected', type: 'folder', name: '备份保护目录', path: '/Apps', mutable: false }], cursor: null, hasMore: false }
    if (/\/collaboration\/notes\/synthetic-ui$/.test(url.pathname)) {
      if (detailFailure) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '示例加载失败，请重试' }) })
      body = { members: [], comments }
    }
    if (url.pathname.endsWith('/comments') && request.method() === 'POST') {
      pendingComment = request.postDataJSON()
      await new Promise((resolve) => { releaseComment = resolve })
      const comment = { id: `comment-${comments.length + 1}`, userId: 'test-user', username: 'Test user', ...pendingComment, createdAt: now, status: 'open' }
      comments.push(comment); body = { comment }
    }
    if (url.pathname.endsWith('/members') && request.method() === 'POST') body = { member: { userId: 'guest-id', ...request.postDataJSON() } }
    if (url.pathname.endsWith('/resolve')) body = { comment: { ...comments[0], status: request.postDataJSON().resolved ? 'resolved' : 'open' } }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  }
  await context.route('**/*', handleRoute)
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15000)
  await page.goto(`${origin}/auth`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => Boolean(document.querySelector('#app')?.__vue_app__))
  const mountHarness = async () => {
    const resources = performance.getEntriesByType('resource').map((item) => item.name)
    const { createApp, ref, h, nextTick } = await import(resources.find((url) => /\/vue\.js\?/.test(url)))
    const { createRouter, createMemoryHistory } = await import(resources.find((url) => /\/vue-router\.js\?/.test(url)))
    const { default: NoteEditor } = await import('/src/modules/whisper/components/NoteEditor.vue')
    const { default: NotePreview } = await import('/src/modules/whisper/components/NotePreview.vue')
    document.querySelector('#app').__vue_app__.unmount()
    // Auth's public shell pins light tokens; the isolated editor needs the normal app theme.
    document.documentElement.classList.remove('public-shell')
    const { applyStyleConfig } = await import('/src/shared/composables/useConfig.js')
    applyStyleConfig()
    const paragraph = (text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })
    const doc = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '完整地址（英文）：' }] },
      paragraph('123 Example Street'), paragraph('Example City, CA 12345'), paragraph('United States'), paragraph(''),
      paragraph('街道：123 Example Street'), paragraph('邮编：12345-6789'), paragraph('IP：192.0.2.1:8443'), paragraph('IPv6：2001:db8::1'),
      { type: 'paragraph', content: [{ type: 'text', text: '测试卡号：' }, { type: 'text', text: '4111 1111', marks: [{ type: 'bold' }] }, { type: 'text', text: ' 1111 1111' }] },
      paragraph('<script>example only</script>'),
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph('城市：Example City')] }, { type: 'tableCell', content: [paragraph('IP：192.0.2.2')] }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: '文档：' }, { type: 'text', text: 'https://example.com/docs', marks: [{ type: 'link', attrs: { href: 'https://example.com/docs' } }] }] }
    ] }
    const plain = doc.content.filter((node) => node.type !== 'table').map((node) => (node.content || []).map((item) => item.text || '').join('')).join('\n')
    const mode = ref('editor'), shown = ref(false), saving = ref(false)
    const note = ref({ id: 'synthetic-ui', numberId: 42, title: '工作资料 · 示例笔记', type: 'memo', content: plain, contentFormat: 'tiptap-json', contentJson: doc, revision: 1, tags: ['资料'], attachments: [], accessRole: 'owner', updatedAt: Date.now() })
    const copies = [], saves = []
    const onCopyValue = async (payload) => { copies.push(payload.value); payload.onResult?.(!window.smartHarness.failCopy) }
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] })
    createApp({ render: () => mode.value === 'editor' ? h(NoteEditor, { show: shown.value, note: note.value, saving: saving.value, autosaveHandler: async (payload) => { saves.push(payload); return { ...note.value, ...payload, revision: payload.revision + 1 } }, onClose: () => { shown.value = false } }) : h(NotePreview, { show: shown.value, note: note.value, onCopyValue, onClose: () => { shown.value = false } }) }).use(router).mount('#app')
    window.smartHarness = {
      copies, saves, note, shown, saving, failCopy: false, original: JSON.stringify(doc),
      async open(nextMode = 'editor', format = 'tiptap-json', role = 'owner') {
        shown.value = false; await nextTick(); mode.value = nextMode
        note.value = { ...note.value, contentFormat: format, accessRole: role }
        shown.value = true; await nextTick()
      }
    }
    shown.value = true
  }
  await page.evaluate(mountHarness)
  await page.getByText(comments[0].body, { exact: true }).waitFor()
  const box = (selector) => page.locator(selector).boundingBox()
  const commentInput = page.getByLabel('评论正文', { exact: true })
  let area = await commentInput.boundingBox(), sidebar = await box('.editor__discussion')
  assert.ok(area.width > sidebar.width - 60 && area.height >= 90)
  assert.ok(sidebar.x > (await box('.editor__writing')).x)
  assert.ok((await box('.editor__type')).height < 60)
  await page.locator('.editor__writing').evaluate((element) => { element.scrollTop = element.scrollHeight })
  const footer = await box('.editor__footer')
  assert.ok(footer.y + footer.height <= 900)
  await page.locator('.editor__writing').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: join(output, 'editor-desktop.png') })
  pass('desktop-two-pane-full-width-composer-compact-controls-fixed-footer')

  await commentInput.fill('正在发布的示例评论')
  await commentInput.press('Control+Enter')
  await page.getByRole('button', { name: '发布中…', exact: true }).waitFor()
  assert.equal(await commentInput.isDisabled(), true)
  assert.equal(pendingComment.body, '正在发布的示例评论')
  assert.equal(await page.evaluate(() => smartHarness.saves.length), 0)
  await page.screenshot({ path: join(output, 'comment-pending.png') })
  releaseComment()
  await page.getByText('评论已发布', { exact: true }).waitFor()
  assert.equal(await commentInput.inputValue(), '')
  await page.locator('.collaboration__comment').first().getByRole('button', { name: '编辑', exact: true }).click()
  await page.locator('.collaboration__comment-edit').press('Escape')
  assert.equal(await page.getByRole('dialog').isVisible(), true)
  assert.equal(await page.locator('.collaboration__comment-edit').count(), 0)
  pass('comment-pending-single-submit-and-editor-shortcuts-isolated')
  await page.locator('.collaboration__sharing summary').click()
  await page.getByLabel('协作者用户名', { exact: true }).fill('example-user')
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByText('example-user', { exact: true }).waitFor()
  await page.getByLabel('显示已解决', { exact: true }).check()
  await page.getByText('已处理的示例讨论', { exact: true }).waitFor()
  pass('invite-and-resolved-discussion-controls-work')
  // Invitation enables the real CRDT path; remount the isolated non-CRDT fixture for layout QA.
  await page.evaluate(() => smartHarness.open())
  await page.getByText(comments[0].body, { exact: true }).waitFor()

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 })
    await page.getByRole('button', { name: '评论', exact: true }).click()
    assert.ok(await commentInput.isVisible())
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
    area = await commentInput.boundingBox()
    sidebar = await box('.editor__discussion')
    assert.ok(area.width >= sidebar.width - 44 && area.y + area.height < 844, JSON.stringify({ width, area, sidebar }))
    if (width === 390) await page.screenshot({ path: join(output, 'comments-mobile.png') })
    await page.getByRole('button', { name: '返回正文', exact: true }).click()
    assert.ok(await page.getByPlaceholder('标题', { exact: true }).isVisible())
    if (width === 390) await page.screenshot({ path: join(output, 'editor-mobile.png') })
  }
  pass('mobile-320-390-tablet-pane-switch-no-horizontal-overflow')
  await page.setViewportSize({ width: 1440, height: 900 })
  const lightSurface = await page.locator('.editor-content').evaluate((element) => getComputedStyle(element).backgroundColor)
  await page.evaluate(async () => { document.documentElement.classList.add('dark'); const { applyStyleConfig } = await import('/src/shared/composables/useConfig.js'); applyStyleConfig() })
  await page.waitForFunction(() => {
    const channels = getComputedStyle(document.querySelector('.editor-content')).backgroundColor.match(/\d+/g).map(Number)
    return channels.slice(0, 3).every((value) => value < 150)
  }, null, { timeout: 3000 }).catch(async (error) => {
    console.log(await page.evaluate(() => ({ classes: document.documentElement.className, token: getComputedStyle(document.documentElement).getPropertyValue('--bg-card'), surface: getComputedStyle(document.querySelector('.editor-content')).backgroundColor })))
    throw error
  })
  assert.notEqual(await page.locator('.editor-content').evaluate((element) => getComputedStyle(element).backgroundColor), lightSurface)
  await page.screenshot({ path: join(output, 'editor-dark.png') })
  await page.evaluate(async () => { document.documentElement.classList.remove('dark'); const { applyStyleConfig } = await import('/src/shared/composables/useConfig.js'); applyStyleConfig() })
  await page.evaluate(() => smartHarness.open('editor', 'tiptap-json', 'viewer'))
  await page.getByText('当前为只读权限，可以查看评论。', { exact: true }).waitFor()
  assert.equal(await commentInput.count(), 0)
  await page.evaluate(() => smartHarness.open())
  await page.evaluate(() => { smartHarness.saving.value = true })
  assert.equal(await page.getByRole('button', { name: '关闭编辑器' }).isDisabled(), true)
  await page.getByRole('dialog').press('Escape')
  assert.equal(await page.getByRole('dialog').isVisible(), true)
  await page.evaluate(() => { smartHarness.saving.value = false })
  detailFailure = true
  await page.evaluate(() => smartHarness.open())
  await page.getByText('示例加载失败，请重试', { exact: true }).waitFor()
  detailFailure = false
  await page.getByRole('button', { name: '重新加载', exact: true }).click()
  await page.getByText(comments[0].body, { exact: true }).waitFor()
  pass('readonly-permission-saving-close-guard-and-load-error-retry')

  for (const format of ['tiptap-json', 'plain']) {
    await page.evaluate((format) => smartHarness.open('preview', format), format)
    const rich = format === 'tiptap-json'
    const card = rich ? page.locator('.note-copy-token[aria-label="复制卡号（仅数字）"]').first() : page.locator('.copyable-token').filter({ hasText: '4111 1111 1111 1111' }).first()
    await card.waitFor()
    if (rich) await page.evaluate(() => { window.richDocumentBeforeCopy = JSON.stringify(document.querySelector('.block-content__surface').pmViewDesc.node.toJSON()) })
    const before = await page.evaluate(() => smartHarness.copies.length)
    await card.hover()
    assert.equal(await page.evaluate(() => smartHarness.copies.length), before)
    await card.click()
    assert.equal(await page.evaluate(() => smartHarness.copies.at(-1)), '4111111111111111')
    await page.getByRole('status').filter({ hasText: '已复制卡号' }).waitFor()
    const address = page.getByRole('button', { name: '复制完整地址', exact: true })
    await address.click()
    assert.equal(await page.evaluate(() => smartHarness.copies.at(-1)), '123 Example Street\nExample City, CA 12345\nUnited States')
    const ip = page.locator(rich ? '.note-copy-token' : '.copyable-token').filter({ hasText: '2001:db8::1' }).first()
    await ip.focus(); await ip.press('Enter')
    assert.equal(await page.evaluate(() => smartHarness.copies.at(-1)), '2001:db8::1')
    if (rich) {
      assert.ok(await page.locator('.block-content strong').count())
      assert.equal(await page.locator('.block-content table').count(), 1)
      assert.equal(await page.evaluate(() => JSON.stringify(smartHarness.note.value.contentJson) === smartHarness.original), true)
      assert.equal(await page.evaluate(() => JSON.stringify(document.querySelector('.block-content__surface').pmViewDesc.node.toJSON()) === window.richDocumentBeforeCopy), true)
      await page.screenshot({ path: join(output, 'smart-copy-desktop.png') })
    }
    await page.evaluate(() => { smartHarness.failCopy = true })
    await ip.click()
    await page.getByText('复制失败，请选中文字手动复制', { exact: true }).waitFor()
    await page.evaluate(() => { smartHarness.failCopy = false })
  }
  pass('rich-and-plain-hover-no-copy-click-keyboard-exact-targets-success-error-receipts')
  pass('rich-format-marks-table-and-note-document-preserved')
  await page.evaluate(() => smartHarness.open('preview'))
  await page.setViewportSize({ width: 320, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.getByRole('button', { name: '复制完整地址', exact: true }).click()
  await page.screenshot({ path: join(output, 'smart-copy-mobile.png') })
  pass('mobile-preview-copy-button-and-feedback-reachable')
  await page.evaluate(() => smartHarness.open('editor'))
  await page.getByRole('button', { name: '从 Dropbox 插入文件', exact: true }).click()
  await page.getByRole('region', { name: '选择 Dropbox 文件', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: /备份保护目录/ }).isDisabled(), true)
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '搜索 Dropbox 文件')
  const cloudPickerBox = await page.getByRole('region', { name: '选择 Dropbox 文件', exact: true }).boundingBox()
  assert.ok(cloudPickerBox.y >= 0 && cloudPickerBox.y + cloudPickerBox.height < 760, 'file picker is scrolled into view above the fixed footer')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.screenshot({ path: join(output, 'note-dropbox-picker-320.png') })
  await page.getByRole('button', { name: /个人示例文件.pdf/ }).click()
  const privateLink = page.locator('.tiptap a').filter({ hasText: '个人示例文件.pdf' })
  await privateLink.waitFor(); assert.equal(await privateLink.getAttribute('href'), origin + '/files?item=id%3Anote_file')
  pass('note-cloud-picker-protected-folder-private-reference-mobile')
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await touchContext.route('**/*', handleRoute)
  await touchContext.routeWebSocket('**/*', (socket) => socket.close())
  const touch = await touchContext.newPage()
  touch.on('pageerror', (error) => errors.push(error.message))
  await touch.goto(`${origin}/auth`, { waitUntil: 'networkidle' })
  await touch.waitForFunction(() => Boolean(document.querySelector('#app')?.__vue_app__))
  await touch.evaluate(mountHarness)
  await touch.evaluate(() => smartHarness.open('preview'))
  const touchAddress = touch.getByRole('button', { name: '复制完整地址', exact: true })
  await touchAddress.tap()
  assert.ok((await touchAddress.boundingBox()).height >= 44)
  assert.match(await touch.evaluate(() => smartHarness.copies.at(-1)), /^123 Example Street\n/)
  assert.equal(await touch.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await touch.screenshot({ path: join(output, 'smart-copy-touch.png') })
  await touchContext.close()
  pass('touch-emulation-tap-to-copy-44px-target-no-overflow')
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'PASS', scope: 'dev60 actual components; synthetic API and clipboard receipts; not production or real clipboard acceptance', checks, browser: browser.version() }, null, 2))
} finally { await browser.close() }
