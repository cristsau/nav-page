import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  buildBookmarkAiPrompt,
  resolveBookmarkAiProvider,
  resolveBookmarkPresentation,
  resolveGroupIcon,
  sanitizeBookmarkUrl
} from '../../app/src/modules/navigation/navigationUi.js'
import {
  buildBookmarkOrderMap,
  buildNavigationReorderPayload,
  MAX_MANAGED_BOOKMARKS,
  moveId,
  moveIdBefore,
  resolveBookmarkHealthPresentation,
  selectManagementIds,
  sameIdOrder,
  toggleManagementSelection
} from '../../app/src/modules/navigation/navigationManagement.js'

test('legacy group text and emoji are converted to supported Lucide icons', () => {
  assert.equal(resolveGroupIcon('briefcase', '工作'), 'briefcase')
  assert.equal(resolveGroupIcon('💻', '开发工具'), 'code')
  assert.equal(resolveGroupIcon('⭐', '我的收藏'), 'pin')
  assert.equal(resolveGroupIcon('D', '未分类'), 'folder')
})

test('bookmark AI provider prioritizes the configured ChatGPT backend', () => {
  const config = {
    search: {
      providers: {
        brave: { enabled: true, apiKeyConfigured: true },
        chatgpt: { enabled: true, apiKeyConfigured: true }
      }
    }
  }

  assert.equal(resolveBookmarkAiProvider(config), 'chatgpt')
  assert.equal(resolveBookmarkAiProvider({ search: { providers: {} } }), '')
})

test('bookmark AI ignores retired providers and skips enabled providers that are not ready', () => {
  const config = {
    search: {
      providers: {
        chatgpt: { enabled: true, apiKeyConfigured: false },
        openclaw: {
          enabled: true,
          endpoint: 'https://openclaw.example.test/v1/chat/completions'
        },
        brave: { enabled: true, apiKeyConfigured: true }
      }
    }
  }

  assert.equal(resolveBookmarkAiProvider(config), 'brave')
})

test('bookmark URL sent for AI analysis excludes credentials, query and fragment', () => {
  assert.equal(
    sanitizeBookmarkUrl('https://user:secret@example.com/docs?id=token#private'),
    'https://example.com/docs'
  )
  assert.equal(sanitizeBookmarkUrl('javascript:alert(1)'), '')
})

test('bookmark presentation is stable, useful and does not reveal URL secrets', () => {
  const bookmark = {
    title: 'Linux DO 公告',
    url: 'https://user:secret@linux.do/c/announcements/42?token=private#staff'
  }
  const first = resolveBookmarkPresentation(bookmark)
  const second = resolveBookmarkPresentation(bookmark)

  assert.equal(first.hue, second.hue)
  assert.equal(first.monogram, 'LI')
  assert.equal(first.subtitle, 'linux.do/c/announcements')
  assert.equal(first.fullSubtitle, 'https://linux.do/c/announcements/42')
  assert.doesNotMatch(JSON.stringify(first), /secret|private|staff/)
  assert.equal(
    resolveBookmarkPresentation({ title: '坏链接', url: 'not a url?token=secret' }).subtitle,
    '网址格式无效'
  )
})

test('bookmark AI prompt contains actionable structure and only the sanitized URL', () => {
  const prompt = buildBookmarkAiPrompt({
    title: '产品文档',
    description: '团队使用说明',
    url: 'https://example.com/guide?api_key=secret#admin'
  })

  assert.match(prompt, /用途判断/)
  assert.match(prompt, /推荐标签/)
  assert.match(prompt, /不要声称已经读取或核验网页正文/)
  assert.match(prompt, /https:\/\/example\.com\/guide/)
  assert.doesNotMatch(prompt, /api_key|secret|#admin/)
})

test('bookmark AI setup action selects and focuses the lazy search settings section', async () => {
  const [navigation, settings, searchCategory] = await Promise.all([
    fs.readFile(
      fileURLToPath(new URL('../../app/src/modules/navigation/Navigation.vue', import.meta.url)),
      'utf8'
    ),
    fs.readFile(
      fileURLToPath(new URL('../../app/src/modules/settings/Settings.vue', import.meta.url)),
      'utf8'
    ),
    fs.readFile(
      fileURLToPath(new URL('../../app/src/modules/settings/categories/SearchAiCategory.vue', import.meta.url)),
      'utf8'
    )
  ])

  assert.match(navigation, /query:\s*\{\s*section:\s*'search'\s*\}/)
  assert.match(settings, /section === 'search'\) return 'search'/)
  assert.match(searchCategory, /id="settings-search"/)
  assert.match(settings, /pendingSectionId\.value = section/)
  assert.match(settings, /<Suspense @resolve="completePendingNavigation\(\{ categoryResolved: true \}\)">/)
  assert.match(settings, /scrollIntoView/)
})

test('navigation management keeps complete deterministic orders for buttons and drag', () => {
  assert.deepEqual(moveId(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
  assert.deepEqual(moveId(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c'])
  assert.deepEqual(moveIdBefore(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c'])
  assert.deepEqual(moveIdBefore(['a', 'b', 'c'], 'b', 'b'), ['a', 'b', 'c'])
  assert.equal(sameIdOrder(['a', 'b'], ['a', 'b']), true)
  assert.equal(sameIdOrder(['a', 'b'], ['b', 'a']), false)

  assert.deepEqual(
    buildBookmarkOrderMap(
      [
        { id: 'a', groupId: 'one' },
        { id: 'b', groupId: 'two' },
        { id: 'c', groupId: 'one' }
      ],
      [{ id: 'one' }, { id: 'two' }]
    ),
    { one: ['a', 'c'], two: ['b'] }
  )

  assert.deepEqual(
    buildNavigationReorderPayload(
      ['two', 'one'],
      { one: ['a', 'c'], two: ['b'] }
    ),
    {
      groupIds: ['two', 'one'],
      bookmarkOrders: [
        { groupId: 'two', ids: ['b'] },
        { groupId: 'one', ids: ['a', 'c'] }
      ]
    }
  )
})

test('navigation management caps one bulk operation at the backend contract of 100', () => {
  const allIds = Array.from({ length: MAX_MANAGED_BOOKMARKS + 1 }, (_, index) => `id-${index}`)
  const selected = selectManagementIds(allIds)

  assert.equal(selected.ids.length, MAX_MANAGED_BOOKMARKS)
  assert.equal(selected.limited, true)
  assert.deepEqual(selected.ids, allIds.slice(0, MAX_MANAGED_BOOKMARKS))

  const blocked = toggleManagementSelection(selected.ids, allIds.at(-1))
  assert.equal(blocked.limited, true)
  assert.deepEqual(blocked.ids, selected.ids)

  const removed = toggleManagementSelection(selected.ids, selected.ids[0])
  assert.equal(removed.limited, false)
  assert.equal(removed.ids.length, MAX_MANAGED_BOOKMARKS - 1)
})

test('bookmark health presentation never labels protected links as broken', () => {
  assert.deepEqual(
    resolveBookmarkHealthPresentation({
      healthStatus: 'protected',
      healthHttpStatus: 403,
      healthCheckedAt: '2026-08-01T00:00:00.000Z'
    }),
    {
      label: '需登录',
      tone: 'info',
      status: 'protected',
      httpStatus: 403,
      checkedAt: '2026-08-01T00:00:00.000Z',
      errorCode: ''
    }
  )
  assert.equal(resolveBookmarkHealthPresentation({ healthStatus: 'broken' }).tone, 'error')
  assert.equal(resolveBookmarkHealthPresentation({ healthStatus: 'unchecked' }), null)
})

test('navigation bookmark cards mount directly without transition wrappers', async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL('../../app/src/modules/navigation/components/NavGroup.vue', import.meta.url)),
    'utf8'
  )
  const gridSource = source.match(/<!-- 书签网格 -->[\s\S]*?<!-- 空状态 -->/)?.[0] || ''

  assert.match(gridSource, /<div class="bookmarks-container">\s*<div\s+class="bookmarks-grid"/)
  assert.match(
    gridSource,
    /<NavItem\s+v-for="\(bookmark, bookmarkIndex\) in visibleBookmarks"[\s\S]*?:key="bookmark\.id"/
  )
  assert.match(gridSource, /class="bookmark-card bookmark-card--add"[\s\S]*添加书签/)
  assert.doesNotMatch(gridSource, /<Transition(?:Group)?\b/)
  assert.doesNotMatch(gridSource, /<Transition\b[^>]*mode="out-in"/)
  assert.doesNotMatch(gridSource, /:key="activeGroup\?\.id"/)
  assert.doesNotMatch(source, /(?:tab-slide|list)-(?:enter|leave)/)
  assert.match(source, /activeBookmarks\.value\.slice\(0, visibleCount\.value\)/)
  assert.match(source, /:sort-count="activeBookmarks.length"/)
})

test('navigation management calls the exact bulk and health backend contracts', async () => {
  const source = await fs.readFile(
    fileURLToPath(new URL('../../app/src/shared/services/navigationApi.js', import.meta.url)),
    'utf8'
  )

  assert.match(source, /request\('\/bookmarks\/bulk\/move',[\s\S]*JSON\.stringify\(\{ ids, targetGroupId \}\)/)
  assert.match(source, /request\('\/bookmarks\/bulk\/delete',[\s\S]*JSON\.stringify\(\{ ids \}\)/)
  assert.match(source, /request\('\/bookmarks\/health-check',[\s\S]*JSON\.stringify\(\{ ids \}\)/)
  assert.match(source, /request\('\/navigation\/reorder',[\s\S]*JSON\.stringify\(\{ groupIds, bookmarkOrders \}\)/)
})

test('navigation management exposes mutually exclusive accessible controls and complete reorder saves', async () => {
  const [navigation, navGroup, navItem, useDB, database] = await Promise.all([
    fs.readFile(
      fileURLToPath(new URL('../../app/src/modules/navigation/Navigation.vue', import.meta.url)),
      'utf8'
    ),
    fs.readFile(
      fileURLToPath(new URL('../../app/src/modules/navigation/components/NavGroup.vue', import.meta.url)),
      'utf8'
    ),
    fs.readFile(
      fileURLToPath(new URL('../../app/src/modules/navigation/components/NavItem.vue', import.meta.url)),
      'utf8'
    ),
    fs.readFile(
      fileURLToPath(new URL('../../app/src/shared/composables/useDB.js', import.meta.url)),
      'utf8'
    ),
    fs.readFile(
      fileURLToPath(new URL('../../app/src/shared/db/database.js', import.meta.url)),
      'utf8'
    )
  ])

  assert.match(navigation, /managementMode\.value === mode \? '' : mode/)
  assert.match(navigation, /toggleManagementSelection\(selectedBookmarkIds\.value, bookmark\.id\)/)
  assert.match(navigation, /已选择前 \$\{MAX_MANAGED_BOOKMARKS\} 项/)
  assert.match(navigation, /:aria-pressed="managementMode === 'select'"/)
  assert.match(navigation, /:aria-pressed="managementMode === 'sort'"/)
  const saveSortSource = navigation.match(
    /async function handleSaveSort\(\)[\s\S]*?\n}\n\nfunction handleCancelSort/
  )?.[0] || ''
  assert.match(saveSortSource, /buildNavigationReorderPayload/)
  assert.match(saveSortSource, /reorderNavigationItems\(payload\.groupIds, payload\.bookmarkOrders\)/)
  assert.doesNotMatch(saveSortSource, /reorderGroupItems|reorderBookmarkItems/)
  assert.match(saveSortSource, /await loadData\(\)/)
  assert.match(saveSortSource, /可能与其他页面更新冲突；已重新加载最新顺序/)
  assert.match(navigation, /\.management-bar select \{\s*min-height: 44px/)

  assert.match(navItem, /role="checkbox"/)
  assert.match(navItem, /:aria-checked="selected"/)
  assert.match(navItem, /resolveBookmarkHealthPresentation/)

  assert.match(useDB, /selectedIds\.slice\(index, index \+ 20\)/)
  assert.match(useDB, /MAX_BULK_BOOKMARK_IDS = 100/)
  assert.match(useDB, /assertBulkLimit\(selectedIds\)/)
  assert.match(useDB, /链接健康检查仅服务器账号支持/)
  assert.match(useDB, /reorderBookmarks/)
  assert.match(useDB, /async function reorderAll\(groupIds, bookmarkOrders\)/)
  assert.match(useDB, /await reorderBackendNavigation\(groupIds, bookmarkOrders\)/)
  assert.match(useDB, /await reorderLocalNavigation\(groupIds, bookmarkOrders\)/)
  assert.match(useDB, /await deleteBookmarks\(selectedIds\)/)
  assert.match(database, /db\.transaction\('rw', db\.bookmarks,[\s\S]*db\.bookmarks\.bulkDelete\(bookmarkIds\)/)
  assert.match(database, /bulkDelete\(bookmarkIds\)[\s\S]*db\.bookmarks\.bulkPut\(updates\)/)
  assert.match(useDB, /await moveLocalBookmarks\(selectedIds, target\)/)
  assert.match(database, /export async function moveBookmarks[\s\S]*db\.groups\.get\(target\)[\s\S]*db\.bookmarks\.bulkGet\(bookmarkIds\)[\s\S]*db\.bookmarks\.bulkPut\(updates\)/)
  assert.match(database, /export async function reorderNavigation\(groupIds, bookmarkOrders\)/)
  assert.match(database, /db\.transaction\('rw', db\.groups, db\.bookmarks/)
  assert.match(database, /currentGroupIds\.length !== orderedGroupIds\.length/)
  assert.match(useDB, /error\.checkedCount = checked\.length/)
  assert.match(navigation, /已保留并同步完成结果/)
  assert.match(navGroup, /bookmarks-grid--sorting/)
  assert.match(navGroup, /@media \(hover: none\) and \(pointer: coarse\), \(max-width: 760px\)/)
  assert.match(navItem, /@media \(hover: none\) and \(pointer: coarse\), \(max-width: 760px\)/)
  assert.doesNotMatch(navGroup, /@media [^{]*any-pointer: coarse/)
  assert.doesNotMatch(navItem, /@media [^{]*any-pointer: coarse/)
  assert.match(database, /currentBookmarkIds\.length !== orderedBookmarkIds\.length/)
  assert.match(database, /currentBookmarkIdsByGroup/)
  assert.match(database, /currentIds\.length !== ids\.length/)
  assert.match(database, /currentIds\.some\(\(id\) => !ids\.includes\(id\)\)/)
  assert.match(database, /db\.groups\.bulkPut\(updatedGroups\)/)
  assert.match(database, /db\.bookmarks\.bulkPut\(updatedBookmarks\)/)
})
