import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const sourceFile = (path) => fs.readFile(
  fileURLToPath(new URL(`../../app/src/${path}`, import.meta.url)),
  'utf8'
)

test('shared modal traps focus, supports initial focus and restores the opener', async () => {
  const source = await sourceFile('shared/components/Modal.vue')
  const contentStyle = source.match(/\.modal-content\s*\{([\s\S]*?)\}/)?.[1] || ''
  const headerStyle = source.match(/\.modal__header\s*\{([\s\S]*?)\}/)?.[1] || ''
  const bodyStyle = source.match(/\.modal__body\s*\{([\s\S]*?)\}/)?.[1] || ''
  const footerStyle = source.match(/\.modal__footer\s*\{([\s\S]*?)\}/)?.[1] || ''

  assert.match(source, /initialFocusSelector/)
  assert.match(source, /@keydown\.tab="trapFocus"/)
  assert.match(source, /e\.key === 'Escape'/)
  assert.match(source, /returnFocusElement = document\.activeElement/)
  assert.match(source, /target\?\.isConnected/)
  assert.match(source, /aria-modal="true"/)
  assert.match(source, /:aria-labelledby="title \? titleId : undefined"/)
  assert.match(source, /width: 44px;\s*height: 44px;/)
  assert.match(contentStyle, /display:\s*flex;/)
  assert.match(contentStyle, /flex-direction:\s*column;/)
  assert.match(contentStyle, /overflow:\s*hidden;/)
  assert.doesNotMatch(contentStyle, /overflow-y:\s*auto;/)
  assert.match(headerStyle, /flex:\s*0 0 auto;/)
  assert.match(bodyStyle, /flex:\s*1 1 auto;/)
  assert.match(bodyStyle, /min-height:\s*0;/)
  assert.match(bodyStyle, /overflow-y:\s*auto;/)
  assert.match(footerStyle, /flex:\s*0 0 auto;/)
})

test('time settings, search and command palette expose correct accessible names', async () => {
  const [whisper, commands] = await Promise.all([
    sourceFile('modules/whisper/Whisper.vue'),
    sourceFile('shared/components/CommandPalette.vue')
  ])

  assert.match(whisper, /<Modal[\s\S]*title="页面设置"/)
  assert.match(whisper, /aria-label="搜索标题、正文或标签"/)
  assert.doesNotMatch(whisper, /class="settings-modal"/)
  assert.match(commands, /aria-label="搜索命令"/)
  assert.match(commands, /<kbd aria-hidden="true">Esc<\/kbd>/)
})

test('group fields have programmatic labels and touch-first controls keep 44px targets', async () => {
  const [form, variables, navItem, navGroup] = await Promise.all([
    sourceFile('modules/navigation/components/AddToNav.vue'),
    sourceFile('styles/variables.css'),
    sourceFile('modules/navigation/components/NavItem.vue'),
    sourceFile('modules/navigation/components/NavGroup.vue')
  ])

  assert.match(form, /for="group-name-field"[\s\S]*id="group-name-field"/)
  assert.match(form, /for="group-color-field"[\s\S]*id="group-color-field"/)
  assert.match(variables, /\(any-pointer: coarse\)[\s\S]*\[role='button'\][\s\S]*min-width: 44px !important;[\s\S]*min-height: 44px !important;/)
  assert.match(navItem, /class="mobile-action-sheet"[\s\S]*aria-modal="true"/)
  assert.match(navItem, /@keydown\.tab="trapMobileActionFocus"/)
  assert.match(navItem, /\.mobile-action-overlay\s*\{[\s\S]*?align-items: center;/)
  assert.match(navItem, /@media \(max-width: 640px\)[\s\S]*?\.mobile-action-overlay\s*\{[\s\S]*?align-items: flex-end;/)
  assert.match(navGroup, /\.group-action-overlay\s*\{[\s\S]*?align-items: center;/)
  assert.match(navGroup, /@media \(max-width: 640px\)[\s\S]*?\.group-action-overlay\s*\{[\s\S]*?align-items: flex-end;/)
  assert.match(navItem, /<Transition name="bookmark-action-dialog">/)
  assert.match(navGroup, /<Transition name="group-action-dialog">/)
})

test('new navigation and media empty states only promise implemented actions', async () => {
  const [navigation, navGroup, browserSettings, dataSettings, media] = await Promise.all([
    sourceFile('modules/navigation/Navigation.vue'),
    sourceFile('modules/navigation/components/NavGroup.vue'),
    sourceFile('modules/settings/categories/BrowserMobileCategory.vue'),
    sourceFile('modules/settings/categories/DataAboutCategory.vue'),
    sourceFile('modules/media/MediaLibrary.vue')
  ])

  assert.match(navigation, /v-if="groups\.length" class="management-heading"/)
  assert.match(navGroup, /创建第一个分组/)
  assert.match(navGroup, /导入 NAV JSON/)
  assert.match(navGroup, /安装快速收藏扩展/)
  assert.doesNotMatch(navGroup, /浏览器原生书签|推荐分组模板/)
  assert.match(browserSettings, /id="settings-browser"/)
  assert.match(dataSettings, /id="settings-data"/)
  assert.match(media, /!images\.length && libraryIsEmpty/)
  assert.match(media, /图片库还是空的/)
  assert.match(media, /没有匹配的图片/)
  assert.match(media, /@click="resetFilters"/)
})
