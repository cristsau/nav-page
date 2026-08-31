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
})

test('workspace database view editor renders type-aware filters and mobile-accessible controls', async () => {
  const view = await source('app/src/modules/whisper/components/DatabaseWorkspace.vue')
  assert.match(view, /filterOperatorOptions/)
  assert.match(view, /resetFilter\(filter\)/)
  assert.match(view, /filterProperty\(filter\)\?\.type === 'checkbox'/)
  assert.match(view, /filterProperty\(filter\)\?\.type === 'relation'/)
  assert.match(view, /visiblePropertyIds/)
  assert.match(view, /min-width: 44px; min-height: 44px/)
  assert.match(view, /@media \(max-width: 820px\)/)
  assert.match(view, /initial-focus-selector="#database-row-title"/)
})
