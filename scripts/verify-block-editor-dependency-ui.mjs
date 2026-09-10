// Real BlockEditor and bundled Tiptap in an isolated browser. No user profile,
// real account, remote API, collaboration connection, or image upload is used.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer as createNetServer } from 'node:net'

const root = fileURLToPath(new URL('../', import.meta.url))
const appRoot = join(root, 'app')
const appRequire = createRequire(new URL('../app/package.json', import.meta.url))
const { createServer } = await import(new URL('../app/node_modules/vite/dist/node/index.js', import.meta.url))
const { default: vue } = await import(pathToFileURL(appRequire.resolve('@vitejs/plugin-vue')))
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const output = await mkdtemp(join(tmpdir(), 'nav-block-editor-deps-'))
const socket = createNetServer()
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const server = await createServer({
  configFile: false, envFile: false, root: appRoot, plugins: [vue()], logLevel: 'error',
  resolve: { alias: { '@': join(appRoot, 'src') } },
  server: { host: '127.0.0.1', port, strictPort: true, open: false, proxy: {} }
})
let browser
const checks = []
const passed = (name) => { checks.push(name); console.log(`PASS ${name}`) }
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true })
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' })
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const body = url.pathname === '/api/auth/session' ? { user: null }
      : url.pathname === '/api/auth/oauth/config' ? { providers: {} } : { value: null }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/auth`, { waitUntil: 'networkidle' })
  await page.evaluate(async () => {
    const vueUrl = performance.getEntriesByType('resource').map((item) => item.name).find((url) => /\/vue\.js\?/.test(url))
    if (!vueUrl) throw new Error('Actual Vue runtime not found')
    const { createApp, h, ref, nextTick } = await import(vueUrl)
    const { default: BlockEditor } = await import('/src/modules/whisper/components/BlockEditor.vue')
    document.querySelector('#app').__vue_app__.unmount()
    const model = ref({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic note' }] }] })
    const editor = ref(null)
    const shown = ref(true)
    const disabled = ref(false)
    let imageRequests = 0
    createApp({ setup: () => () => shown.value ? h(BlockEditor, {
      ref: editor, modelValue: model.value, disabled: disabled.value, realtime: false,
      'onUpdate:modelValue': (value) => { model.value = value },
      onRequestImage: () => { imageRequests++ }
    }) : null }).mount('#app')
    window.blockHarness = {
      model, editor, disabled, imageRequests: () => imageRequests,
      async remount() { shown.value = false; await nextTick(); shown.value = true; await nextTick() }
    }
  })
  const surface = page.locator('.tiptap[contenteditable]')
  await surface.waitFor()
  assert.equal(await surface.innerText(), 'Synthetic note')
  await surface.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(' with new text')
  assert.equal(await page.evaluate(() => blockHarness.editor.value.getText()), 'Synthetic note with new text')
  passed('actual-component-typing-updates-tiptap-json')

  await page.keyboard.press('ControlOrMeta+A')
  await page.getByRole('button', { name: '粗体', exact: true }).click()
  assert.ok(await surface.locator('strong').count())
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  assert.equal(await surface.locator('strong').count(), 0)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  assert.ok(await surface.locator('strong').count())
  passed('formatting-undo-redo-preserve-text')

  await page.getByLabel(/内容块类型/).selectOption('2')
  assert.ok(await surface.locator('h2').count())
  await page.evaluate(() => blockHarness.editor.value.replaceText('Table test'))
  await surface.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.getByRole('button', { name: '插入表格', exact: true }).click()
  assert.equal(await surface.locator('tr').count(), 3)
  await page.getByRole('button', { name: '在后方添加表格行', exact: true }).click()
  assert.equal(await surface.locator('tr').count(), 4)
  passed('heading-and-table-row-commands')

  await page.evaluate(() => blockHarness.editor.value.replaceText('Task test'))
  await surface.click()
  await page.getByRole('button', { name: '待办列表', exact: true }).click()
  await surface.locator('input[type=checkbox]').check()
  assert.equal(await page.evaluate(() => blockHarness.editor.value.getJSON().content[0].content[0].attrs.checked), true)
  passed('task-list-checkbox-roundtrip')

  await page.evaluate(() => blockHarness.editor.value.replaceText(''))
  await surface.click()
  await page.keyboard.press('/')
  await page.getByRole('listbox', { name: '插入内容块' }).waitFor()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('Slash heading')
  assert.equal(await surface.locator('h1').innerText(), 'Slash heading')
  passed('slash-keyboard-menu-creates-heading')

  await page.getByRole('button', { name: '上传并插入图片', exact: true }).click()
  assert.equal(await page.evaluate(() => blockHarness.imageRequests()), 1)
  const before = await page.evaluate(() => blockHarness.editor.value.getJSON())
  await page.evaluate(() => blockHarness.remount())
  await surface.waitFor()
  assert.deepEqual(await page.evaluate(() => blockHarness.editor.value.getJSON()), before)
  await page.evaluate(() => { blockHarness.disabled.value = true })
  await page.waitForFunction(() => document.querySelector('.tiptap')?.getAttribute('contenteditable') === 'false')
  assert.equal(await page.getByRole('button', { name: '粗体', exact: true }).isDisabled(), true)
  passed('image-intent-json-remount-and-readonly')

  for (const width of [390, 1100]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  }
  passed('mobile-desktop-no-page-overflow')
  assert.deepEqual(errors, [])
  const version = JSON.parse(await readFile(join(appRoot, 'node_modules/@tiptap/core/package.json'), 'utf8')).version
  const report = { status: 'PASS', checkedAt: new Date().toISOString(), sourceRoot: root, tiptap: version, browser: browser.version(), checks,
    scope: 'Actual component and Tiptap; synthetic document; no production API, SMTP, image upload or real-time collaboration acceptance.' }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, output }))
} catch (error) {
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'FAIL', checkedAt: new Date().toISOString(), checks, error: error.message }, null, 2) + '\n')
  console.error(`Failure report: ${join(output, 'report.json')}`)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
