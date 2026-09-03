import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const appSource = (relativePath) => readFile(
  new URL(`../../app/${relativePath}`, import.meta.url),
  'utf8'
)

function routeBlock(source, path) {
  const escapedPath = path.replaceAll('/', '\\/')
  return source.match(new RegExp(
    `\\{\\s*path: '${escapedPath}',[\\s\\S]*?skipSession: true\\s*\\n\\s*\\}\\s*\\n\\s*\\}`
  ))?.[0] || ''
}

test('about and privacy routes are public and bypass session and local database startup', async () => {
  const [router, auth, main] = await Promise.all([
    appSource('src/router/index.js'),
    appSource('src/shared/composables/useAuth.js'),
    appSource('src/main.js')
  ])

  const aboutRoute = routeBlock(router, '/about')
  const privacyRoute = routeBlock(router, '/privacy')

  assert.match(aboutRoute, /AboutView\.vue/)
  assert.match(privacyRoute, /PrivacyView\.vue/)
  for (const block of [aboutRoute, privacyRoute]) {
    assert.match(block, /public: true/)
    assert.match(block, /publicShell: true/)
    assert.match(block, /skipSession: true/)
  }

  const skipIndex = router.indexOf('if (!shouldResolveSession)')
  const sessionIndex = router.indexOf('await initAuth()')
  assert.ok(skipIndex >= 0)
  assert.ok(sessionIndex > skipIndex)
  assert.match(router.slice(skipIndex, sessionIndex), /return true/)

  assert.match(auth, /window\.location\.pathname === '\/about'/)
  assert.match(auth, /window\.location\.pathname === '\/privacy'/)
  assert.match(main, /STATIC_PUBLIC_ENTRY_PATHS = new Set\([\s\S]*'\/about'[\s\S]*'\/privacy'/)
  assert.match(main, /if \(shouldBootstrapLocalSystem\(\)\) \{\s*await bootstrapSystem\(\)/)
})

test('about page identifies DOMO NAV and prominently links its privacy policy', async () => {
  const source = await appSource('src/modules/public/AboutView.vue')

  assert.match(source, /<article[\s\S]*aria-labelledby="about-title"/)
  assert.match(source, /<h1 id="about-title">DOMO NAV<\/h1>/)
  assert.match(source, /自托管的网址导航与个人工作入口服务/)
  assert.match(source, /用于集中管理常用网站、工具和个人导航内容/)
  assert.match(source, /to="\/privacy"[\s\S]*查看隐私政策/)
  assert.match(source, /Google 登录/)
  assert.match(source, /openid/)
  assert.match(source, /email/)
  assert.match(source, /profile/)
  assert.match(source, /不请求、不读取也不处理用户的 Gmail 邮件/)
  assert.match(source, /Google Drive 文件/)
  assert.match(source, /Google 联系人/)
  assert.match(source, /Google 日历内容/)
  assert.match(source, /@media \(max-width: 820px\)/)
  assert.doesNotMatch(source, /useAuth|fetch\(|\/api\//)
})

test('privacy policy is responsive HTML and covers the complete Google data lifecycle', async () => {
  const source = await appSource('src/modules/public/PrivacyView.vue')

  assert.match(source, /<article[\s\S]*aria-labelledby="privacy-title"/)
  assert.match(source, /DOMO NAV 隐私政策/)
  assert.match(source, /datetime="2026-09-02">2026年9月2日/)
  assert.match(source, /Google 账号唯一身份标识/)
  assert.match(source, /Google 账号邮箱地址/)
  assert.match(source, /用户显示名称/)
  assert.match(source, /用户头像/)
  assert.match(source, /身份验证、账号绑定和登录/)
  assert.match(source, /数据用途/)
  assert.match(source, /数据共享/)
  assert.match(source, /数据存储和安全/)
  assert.match(source, /数据保留和删除/)
  assert.match(source, /解除绑定和撤销授权/)
  assert.match(source, /申请查询或删除相关数据/)
  assert.match(source, /mailto:cristsaudomo@gmail\.com/)
  assert.match(source, /不申请、不访问也不读取/)
  assert.match(source, /Gmail 邮件内容/)
  assert.match(source, /Google Drive 文件/)
  assert.match(source, /Google 联系人/)
  assert.match(source, /Google 日历/)
  assert.match(source, /@media \(max-width: 560px\)/)
  assert.doesNotMatch(source, /<img|<iframe|<embed|<object|\.pdf|docs\.google\.com/i)
  assert.doesNotMatch(source, /useAuth|fetch\(|\/api\//)
})

test('login page and public layout expose stable about, privacy and contact links', async () => {
  const [authView, layout] = await Promise.all([
    appSource('src/modules/auth/AuthView.vue'),
    appSource('src/modules/public/PublicPageLayout.vue')
  ])

  assert.match(authView, /<nav class="auth-public-links"/)
  assert.match(authView, /<RouterLink to="\/about">关于 DOMO NAV<\/RouterLink>/)
  assert.match(authView, /<RouterLink to="\/privacy">隐私政策<\/RouterLink>/)
  assert.match(layout, /<main id="public-page-content"/)
  assert.match(layout, /mailto:cristsaudomo@gmail\.com/)
  assert.match(layout, /@media \(max-width: 680px\)/)
  assert.match(layout, /\.public-footer a \{\s*min-height: 44px;/)
  assert.match(await appSource('src/modules/public/PrivacyView.vue'), /\.privacy-toc a \{\s*min-height: 44px;/)
})

test('production web server keeps public page navigation inside the SPA fallback', async () => {
  const nginx = await readFile(new URL('../../ovh/nginx.conf', import.meta.url), 'utf8')

  assert.match(nginx, /location \/ \{[\s\S]*try_files \$uri \$uri\/ \/index\.html;/)
  assert.doesNotMatch(nginx, /location\s+=\s+\/(?:about|privacy)[\s\S]*\/auth/)
})
