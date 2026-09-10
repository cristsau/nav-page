// Build HEAD + only the six auth/approval UI edits. API/Turnstile responses are synthetic;
// no real account, mail, CF challenge or deployed app is exercised by this script.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, copyFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, extname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { checkRegistrationAdminUi } from './check-registration-admin-ui.mjs'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url)), appRoot = join(root, 'app')
const require = createRequire(import.meta.url), appRequire = createRequire(join(appRoot, 'package.json'))
const { chromium } = require(process.env.NAV_PLAYWRIGHT_MODULE || 'playwright')
const { build } = await import(pathToFileURL(appRequire.resolve('vite')))
const { default: vue } = await import(pathToFileURL(appRequire.resolve('@vitejs/plugin-vue')))
const output = await mkdtemp(join(tmpdir(), 'nav-registration-ui-'))
const snapshot = join(output, 'source'), dist = join(snapshot, 'app/dist')
const changed = ['src/modules/auth/AuthView.vue', 'src/modules/auth/EmailAuthForm.vue', 'src/shared/components/BotChallenge.vue', 'src/modules/settings/components/UserManagementSettings.vue', 'src/shared/composables/useAuth.js', 'src/shared/services/authApi.js']
await mkdir(snapshot)
await run('git', ['archive', '--output', join(output, 'app.tar'), 'HEAD', 'app'], { cwd: root, windowsHide: true })
await run('tar', ['-xf', join(output, 'app.tar'), '-C', snapshot], { windowsHide: true })
assert.deepEqual(await readFile(join(snapshot, 'app/package-lock.json')), await readFile(join(appRoot, 'package-lock.json')), 'Dependency lock must match clean baseline')
for (const file of changed) await copyFile(join(appRoot, file), join(snapshot, 'app', file))
await symlink(join(appRoot, 'node_modules'), join(snapshot, 'app/node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
await build({ configFile: false, envFile: false, root: join(snapshot, 'app'), plugins: [vue()], logLevel: 'error',
  resolve: { alias: { '@': join(snapshot, 'app/src') } }, define: { 'import.meta.env.VITE_AUTH_MODE': JSON.stringify('backend') },
  build: { outDir: dist, reportCompressedSize: false } })
console.log('PASS isolated auth-only build')
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const file = resolve(dist, '.' + (['/auth', '/settings', '/'].includes(pathname) ? '/index.html' : decodeURIComponent(pathname)))
    if (!file.startsWith(dist + sep)) { res.writeHead(403); return res.end() }
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream')
    res.end(await readFile(file))
  } catch { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.NAV_BROWSER_PATH, headless: true })
const checks = [], errors = [], layouts = []
const pass = name => { checks.push(name); console.log('PASS ' + name) }
const fixtureId = '11111111-1111-4111-8111-111111111111'
try {
  for (const width of process.env.NAV_UI_WIDTHS ? process.env.NAV_UI_WIDTHS.split(',').map(Number) : [320, 375, 390, 768, 1024, 1440]) for (const theme of ['light', 'dark', 'custom']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce', serviceWorkers: 'block' })
    await context.addInitScript(() => {
      window.PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: async () => true }
      const widgets = new Map(), retired = []; let sequence = 0
      window.cfHarness = { widgets, retired, hold: false, complete() { for (const w of widgets.values()) w.options.callback('synthetic-proof') }, expire() { for (const w of widgets.values()) w.options['expired-callback']() } }
      window.turnstile = {
        render(host, options) {
          if (options['response-field'] !== false) throw new Error('Proof must not enter form DOM')
          const id = String(++sequence), frame = document.createElement('iframe')
          frame.title = 'Local challenge fixture (not live Cloudflare)'
          frame.style.cssText = `border:0;flex-shrink:0;width:${options.size === 'flexible' ? '100%' : '150px'};height:${options.size === 'flexible' ? '65px' : '140px'}`
          frame.srcdoc = '<body style="margin:0;box-sizing:border-box;padding:12px;height:100%;background:#eee;color:#222;border:1px solid #aaa;font:12px system-ui">Local CF layout fixture<br>Not a live challenge</body>'
          host.append(frame); widgets.set(id, { options, frame })
          queueMicrotask(() => { if (!cfHarness.hold) options.callback('synthetic-proof') })
          return id
        },
        remove(id) { const w = widgets.get(id); if (w) { retired.push(w); w.frame.remove(); widgets.delete(id) } },
        reset(id) { const w = widgets.get(id); if (w) queueMicrotask(() => { if (!cfHarness.hold) w.options.callback('synthetic-proof') }) }
      }
    })
    const page = await context.newPage(); page.setDefaultTimeout(10000)
    page.on('pageerror', e => errors.push(e.message))
    let verifyFails = false, emailEnabled = true, registerCalls = 0
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort()
      if (!url.pathname.startsWith('/api/')) return route.continue()
      let body = {}, status = 200
      switch (url.pathname) {
        case '/api/auth/session': body = { user: null }; break
        case '/api/auth/capabilities': body = { password: true, emailLogin: true, emailPasswordReset: true }; break
        case '/api/auth/registration/config': body = { emailVerificationEnabled: emailEnabled, emailRequired: emailEnabled }; break
        case '/api/auth/device-keys/config': body = { enabled: true }; break
        case '/api/auth/bot-guard/config': body = { enabled: true, siteKey: 'synthetic-layout-key' }; break
        case '/api/auth/oauth/config': body = { providers: { google: { enabled: true }, wechat: { enabled: false } } }; break
        case '/api/auth/register':
          registerCalls++; assert.equal(route.request().postDataJSON().turnstileToken, 'synthetic-proof')
          status = 201; body = { request: { id: fixtureId, status: emailEnabled ? 'email_pending' : 'pending', email: emailEnabled ? 'synthetic@example.test' : null } }; break
        case '/api/auth/register/verify': status = verifyFails ? 400 : 200; body = verifyFails ? { error: '验证链接无效或已过期' } : { ok: true, request: { status: 'pending' } }; break
        case '/api/auth/register/resend-verification':
          assert.equal(route.request().postDataJSON().turnstileToken, 'synthetic-proof')
          status = 202; body = { ok: true }; break
        default: body = { value: null, settings: {} }
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    async function layout(stage, maxHeight = 940) {
      const result = await page.evaluate(() => {
        const root = document.documentElement
        const visible = e => e.checkVisibility()
        const frames = [...document.querySelectorAll('.bot-challenge__host iframe')].filter(visible)
        return { height: root.scrollHeight, overflow: root.scrollWidth > innerWidth + 1,
          widgets: frames.length, sizes: [...cfHarness.widgets.values()].map(w => w.options.size),
          clipped: frames.some(e => { const a = e.getBoundingClientRect(), b = e.parentElement.getBoundingClientRect(); return a.left < b.left - 1 || a.right > b.right + 1 || a.bottom > b.bottom + 1 }),
          small: [...document.querySelectorAll('button,input,a,summary')].filter(e => visible(e) && !e.disabled && e.getBoundingClientRect().height < 43.5).map(e => e.tagName),
          storyTop: document.querySelector('.auth-story').getBoundingClientRect().top + scrollY,
          cardTop: document.querySelector('.auth-card').getBoundingClientRect().top + scrollY }
      })
      assert.equal(result.overflow, false, `${width}/${theme}/${stage}: horizontal overflow`)
      assert.equal(result.clipped, false, `${width}/${theme}/${stage}: clipped challenge`)
      assert.ok(result.widgets <= 1, `${stage}: duplicate challenge`)
      assert.deepEqual(result.small, [], `${width}/${theme}/${stage}: small interactive target`)
      if (stage === 'login' && width >= 1024) assert.ok(Math.abs(result.storyTop - result.cardTop) <= 1, 'Desktop columns top aligned')
      if (width >= 375 && result.height > maxHeight) await page.screenshot({ path: join(output, 'layout-failure.png'), fullPage: true })
      if (width >= 375) assert.ok(result.height <= maxHeight, `${width}/${theme}/${stage}: too tall ${result.height}`)
      layouts.push({ width, theme, stage, ...result })
      if ([390, 1440].includes(width) && ['login', 'email_pending', 'pending', 'register'].includes(stage)) await page.screenshot({ path: join(output, `${stage}-${width}-${theme}.png`), fullPage: true })
    }
    await page.goto(origin + '/auth', { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '获取验证码', exact: true }).waitFor()
    if (theme === 'custom') await page.evaluate(() => {
      for (const [key, value] of Object.entries({ '--bg-primary': '#29221e', '--bg-secondary': '#29221e', '--bg-card': '#362c26', '--text-primary': '#f4eee8', '--text-secondary': '#c8b7a2', '--text-muted': '#c8b7a2', '--accent-bg': '#4b3e30', '--border-color': '#655544', '--border-light': '#554638' })) document.documentElement.style.setProperty(key, value)
    })
    await layout('login')
    assert.equal(await page.locator('.verification-resend').count(), 0)
    await page.getByRole('button', { name: '注册', exact: true }).click()
    await page.getByLabel('邮箱', { exact: true }).fill('synthetic@example.test')
    await page.getByLabel('用户名', { exact: true }).fill('synthetic-user')
    await page.getByLabel('密码', { exact: true }).fill('synthetic-password-long')
    await page.getByLabel('确认密码', { exact: true }).fill('synthetic-password-long')
    await layout('register')
    if (width === 390 && theme === 'light') {
      await page.evaluate(() => { cfHarness.hold = true; cfHarness.expire() })
      await page.getByRole('button', { name: '提交注册申请', exact: true }).click()
      await page.getByRole('alert').waitFor(); assert.equal(registerCalls, 0, 'Expired proof fails before request')
      // Resize across both modes, then call a removed widget callback. It must not revive proof.
      await page.setViewportSize({ width: 320, height: 900 })
      await page.waitForFunction(() => [...cfHarness.widgets.values()][0]?.options.size === 'compact')
      await page.evaluate(() => cfHarness.retired.at(-1).options.callback('stale-proof'))
      await page.getByRole('button', { name: '提交注册申请', exact: true }).click(); assert.equal(registerCalls, 0)
      await page.setViewportSize({ width: 390, height: 900 })
      await page.waitForFunction(() => [...cfHarness.widgets.values()][0]?.options.size === 'flexible')
      await page.evaluate(() => { cfHarness.hold = false; cfHarness.complete() })
      pass('responsive widget invalidates proof and ignores retired callbacks')
    }
    await page.getByRole('button', { name: '提交注册申请', exact: true }).click()
    await page.getByRole('heading', { name: '申请已提交，请验证邮箱', exact: true }).waitFor()
    assert.equal(await page.locator('form').count(), 0)
    assert.equal(await page.locator('input[type=password]').count(), 0)
    assert.equal((await page.locator('body').innerText()).includes(fixtureId), false)
    assert.equal(await page.locator('h1').evaluate(e => e === document.activeElement), true)
    await layout('email_pending', 900)
    await page.getByRole('button', { name: '没有收到邮件？重新发送', exact: true }).click()
    await page.getByLabel('注册邮箱', { exact: true }).waitFor()
    await page.getByRole('button', { name: '重发验证邮件', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '如果该邮箱存在' }).waitFor()
    await layout('resend')
    await page.getByRole('button', { name: '返回申请进度', exact: true }).click()
    assert.equal(await page.locator('iframe').count(), 0)
    const link = `${origin}/auth#register-verify?request=${fixtureId}&token=synthetic-proof-never-store`
    await page.goto(link, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: '待管理员审核', exact: true }).waitFor()
    assert.equal(new URL(page.url()).hash, '')
    assert.equal(await page.locator('form').count(), 0)
    await layout('pending', 900)
    verifyFails = true
    // A fresh email link and already-open auth tab must both handle verification.
    await page.goto(origin + '/auth', { waitUntil: 'networkidle' })
    await page.reload({ waitUntil: 'networkidle' })
    await page.goto(link, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: '邮箱验证未完成', exact: true }).waitFor()
    assert.equal(new URL(page.url()).hash, '')
    await layout('expired-link')
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
    assert.doesNotMatch(stored, /synthetic-proof|synthetic-password|synthetic@example/)
    pass(`auth states, one challenge, responsive bounds and proof privacy: ${width}/${theme}`)
    await context.close()
  }
  assert.deepEqual(errors, [])
  for (const name of await checkRegistrationAdminUi({ browser, origin, output })) pass(name)
  const legacy = await run(process.execPath, [join(root, 'scripts/verify-auth-ui.mjs')], { cwd: root, windowsHide: true, timeout: 180000,
    env: { ...process.env, NAV_UI_PREVIEW: origin, NAV_UI_DIST_DIR: dist } })
  const legacyReport = JSON.parse(legacy.stdout.trim().split(/\r?\n/).at(-1))
  pass(`existing email login/reset, fallback and contrast: ${legacyReport.checks} checks`)
  const report = { status: 'PASS', checkedAt: new Date().toISOString(), scope: 'Clean HEAD + six auth/approval UI files, real build/browser. Synthetic API and CF layout/proof lifecycle only; not real mail/CF/device or production acceptance.', changed, checks, layouts, legacyReport, errors }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: 'PASS', checks: checks.length, layouts: layouts.length, output }))
} catch (e) {
  await writeFile(join(output, 'report.json'), JSON.stringify({ status: 'FAIL', checks, layouts, errors, error: e.message }, null, 2))
  console.error('Failure report: ' + join(output, 'report.json')); throw e
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
