import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const source = (path) => readFile(new URL(path, root), 'utf8')

test('workspace database client and Whisper entry expose the owned database workspace', async () => {
  const [api, view, whisper] = await Promise.all([
    source('app/src/shared/services/workspaceDatabasesApi.js'),
    source('app/src/modules/whisper/components/DatabaseWorkspace.vue'),
    source('app/src/modules/whisper/Whisper.vue')
  ])

  assert.ok(api.includes('/workspace-databases'))
  assert.match(api, /includeArchived/)
  assert.match(view, /backlinksByRow/)
  assert.match(whisper, /DatabaseWorkspace/)
  assert.match(whisper, /role="tablist"/)
  assert.match(whisper, /:aria-selected="workspaceMode === 'databases'"/)
  assert.match(view, /项目跟踪/)
  assert.match(view, /新建视图/)
  assert.match(view, /视图筛选与排序/)
  assert.match(view, /可见属性/)
  assert.match(view, /反向关联/)
  assert.match(view, /恢复记录/)
  assert.match(view, /rowsTruncated/)
  assert.match(view, /本页和当前视图仅处理前/)
  assert.match(view, /:aria-current=/)
  assert.match(view, /<caption class="sr-only">/)
})

test('workspace database view editor renders type-aware filters and mobile-accessible controls', async () => {
  const view = await source('app/src/modules/whisper/components/DatabaseWorkspace.vue')
  assert.match(view, /filterOperatorOptions/)
  assert.match(view, /resetFilter\(filter\)/)
  assert.match(view, /filterProperty\(filter\)\?\.type === 'checkbox'/)
  assert.match(view, /filterProperty\(filter\)\?\.type === 'relation'/)
  assert.match(view, /visiblePropertyIds/)
  assert.match(view, /min-width: 44px; min-height: 44px/)
  assert.match(view, /\.database-row-actions button \{ min-width: 44px; min-height: 44px; \}/)
  assert.match(view, /@media \(max-width: 820px\)/)
  assert.match(view, /initial-focus-selector="#database-row-title"/)
})

test('workspace database URL cells use the shared sanitizer on render and write', async () => {
  const view = await source('app/src/modules/whisper/components/DatabaseWorkspace.vue')
  assert.match(view, /import \{ sanitizeHttpUrl \} from '@\/shared\/utils\/safeUrl'/)
  assert.match(view, /function safeRowUrl\(row, property\)/)
  assert.match(view, /v-else-if="safeRowUrl\(row, property\)"/)
  assert.doesNotMatch(view, /:href="row\.values\[property\.id\]"/)
  assert.match(view, /必须是无账号密码的 HTTP 或 HTTPS 地址/)
})
