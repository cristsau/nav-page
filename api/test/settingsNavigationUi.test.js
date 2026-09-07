import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const readSource = async (relativePath) => fs.readFile(
  fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
  'utf8'
)

test('authenticated routes share one primary navigation shell', async () => {
  const [app, shell, primary, mobile, navigation] = await Promise.all([
    readSource('app/src/App.vue'),
    readSource('app/src/shared/components/AppShell.vue'),
    readSource('app/src/shared/components/PrimaryNavigation.vue'),
    readSource('app/src/shared/components/MobileTabBar.vue'),
    readSource('app/src/shared/navigation/appNavigation.js')
  ])

  assert.match(app, /<AppShell v-if="appShellEnabled">/)
  assert.match(shell, /<PrimaryNavigation\s*\/>/)
  assert.match(shell, /<MobileTabBar\s*\/>/)
  assert.match(primary, /<nav class="primary-header__nav" aria-label="主要页面">/)
  assert.match(mobile, /<nav class="mobile-tabs" aria-label="主要页面">/)
  assert.match(mobile, /min-height:\s*50px/)
  assert.match(navigation, /label:\s*'导航'/)
  assert.match(navigation, /label:\s*'时光'/)
  assert.match(navigation, /label:\s*'图片库'/)
})

test('settings are split into seven lazy categories with desktop and mobile navigation', async () => {
  const [settings, securityCategory, userCategory, systemCategory] = await Promise.all([
    readSource('app/src/modules/settings/Settings.vue'),
    readSource('app/src/modules/settings/categories/SecurityAuditCategory.vue'),
    readSource('app/src/modules/settings/categories/UserManagementCategory.vue'),
    readSource('app/src/modules/settings/categories/SystemIntegrationsCategory.vue')
  ])

  assert.match(settings, /defineAsyncComponent\(\(\) => import\('\.\/categories\/BasicAppearanceCategory\.vue'\)\)/)
  assert.match(settings, /defineAsyncComponent\(\(\) => import\('\.\/categories\/SecurityAuditCategory\.vue'\)\)/)
  assert.match(settings, /基础与外观/)
  assert.match(settings, /搜索与 AI/)
  assert.match(settings, /浏览器与手机/)
  assert.match(settings, /用户管理/)
  assert.match(settings, /登录与系统集成/)
  assert.match(settings, /账号安全与审计/)
  assert.match(settings, /数据与关于/)
  assert.match(settings, /class="category-sidebar"/)
  assert.match(settings, /class="category-tabs"/)
  assert.match(settings, /<KeepAlive[\s\S]*:max="7"/)
  assert.match(settings, /:exclude="\['SecurityAuditCategory', 'UserManagementCategory', 'SystemIntegrationsCategory'\]"/)
  assert.match(securityCategory, /defineOptions\(\{ name: 'SecurityAuditCategory' \}\)/)
  assert.match(userCategory, /defineOptions\(\{ name: 'UserManagementCategory' \}\)/)
  assert.match(systemCategory, /defineOptions\(\{ name: 'SystemIntegrationsCategory' \}\)/)
  assert.doesNotMatch(settings, /import GeneralSettings from/)
  assert.doesNotMatch(settings, /import SecurityAuditSettings from/)
})

test('lazy settings deep links resolve after suspense and category switches return to the top', async () => {
  const [settings, userCategory] = await Promise.all([
    readSource('app/src/modules/settings/Settings.vue'),
    readSource('app/src/modules/settings/categories/UserManagementCategory.vue')
  ])

  assert.match(settings, /const pendingSectionId = ref\(''\)/)
  assert.match(settings, /pendingSectionId\.value = section/)
  assert.match(settings, /else \{\s*pendingSectionId\.value = ''/)
  assert.match(settings, /section === 'browser'\) return 'integrations'/)
  assert.match(settings, /section === 'data'\) return 'data'/)
  assert.match(settings, /<Suspense @resolve="completePendingNavigation\(\{ categoryResolved: true \}\)">/)
  assert.match(settings, /if \(!target && !categoryResolved\) return false/)
  assert.match(settings, /document\.getElementById\('settings-category-title'\)\?\.focus/)
  assert.match(settings, /ref="settingsContentRef"/)
  assert.match(settings, /settingsContentRef\.value\.scrollIntoView/)
  assert.match(userCategory, /id="settings-users"[\s\S]*tabindex="-1"/)
  assert.doesNotMatch(settings, /setTimeout\(resolve, 50\)/)
})

test('shared mobile navigation has one breakpoint and leaves room for transient messages', async () => {
  const [shell, primary, mobile, media, whisper] = await Promise.all([
    readSource('app/src/shared/components/AppShell.vue'),
    readSource('app/src/shared/components/PrimaryNavigation.vue'),
    readSource('app/src/shared/components/MobileTabBar.vue'),
    readSource('app/src/modules/media/MediaLibrary.vue'),
    readSource('app/src/modules/whisper/Whisper.vue')
  ])
  const sharedBreakpoint = /@media \(max-width: 820px\), \(pointer: coarse\) and \(max-width: 1024px\)/

  assert.match(shell, sharedBreakpoint)
  assert.match(primary, sharedBreakpoint)
  assert.match(mobile, sharedBreakpoint)
  assert.match(media, sharedBreakpoint)
  assert.match(whisper, sharedBreakpoint)
  assert.match(primary, /padding: 0 max\(14px, env\(safe-area-inset-right\)\) 0 max\(14px, env\(safe-area-inset-left\)\)/)
  assert.match(media, /\.media-toast \{ bottom: calc\(92px \+ env\(safe-area-inset-bottom\)\)/)
  assert.match(whisper, /\.toast \{[\s\S]*bottom: calc\(92px \+ env\(safe-area-inset-bottom\)\)/)
})

test('settings headings follow a page, category and section hierarchy', async () => {
  const [settings, general, account] = await Promise.all([
    readSource('app/src/modules/settings/Settings.vue'),
    readSource('app/src/modules/settings/components/GeneralSettings.vue'),
    readSource('app/src/modules/settings/components/AccountSecuritySettings.vue')
  ])

  assert.match(settings, /<h1>设置<\/h1>/)
  assert.match(settings, /<h2 id="settings-category-title"/)
  assert.match(general, /<h3 class="settings-section__title">基础设置<\/h3>/)
  assert.match(account, /<h3 class="section-heading__title">账号安全<\/h3>/)
  assert.match(account, /<h4>账户资料<\/h4>/)
})

test('module pages do not duplicate cross-module headers inside the shared shell', async () => {
  const [navigation, media, whisper, settings, modal] = await Promise.all([
    readSource('app/src/modules/navigation/Navigation.vue'),
    readSource('app/src/modules/media/MediaLibrary.vue'),
    readSource('app/src/modules/whisper/Whisper.vue'),
    readSource('app/src/modules/settings/Settings.vue'),
    readSource('app/src/shared/components/Modal.vue')
  ])

  assert.doesNotMatch(navigation, /<header class="header">/)
  assert.doesNotMatch(media, /<header class="media-header">/)
  assert.match(media, /<h1 id="media-title">看见每张图片的去向<\/h1>/)
  assert.doesNotMatch(whisper, /aria-label="返回导航页"/)
  assert.doesNotMatch(whisper, /aria-label="打开图片库"/)
  assert.doesNotMatch(whisper, /<header class="header">/)
  assert.doesNotMatch(settings, /<header class="settings-toolbar">/)
  assert.match(whisper, /<Modal[\s\S]*title="页面设置"/)
  assert.match(modal, /\.modal-overlay \{[\s\S]*z-index: 1000/)
})

test('global save is only offered for categories backed by the shared config', async () => {
  const settings = await readSource('app/src/modules/settings/Settings.vue')

  assert.match(settings, /const showsGlobalSave = computed\(\(\) => \['basic', 'search'\]\.includes/)
  assert.match(settings, /v-if="showsGlobalSave"/)
  assert.match(settings, /globalSaveLabel/)
})
