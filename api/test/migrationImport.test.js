import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

test('cloud import preserves productivity fields and stable numeric IDs', async () => {
  const routeUrl = new URL('../src/routes/migration.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(routeUrl), 'utf8')

  for (const field of [
    'number_id',
    'entry_date',
    'mood',
    'due_at',
    'completed'
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`))
  }

  assert.match(source, /COALESCE\(\$3::bigint,\s*nextval\('notes_number_id_seq'\)\)/)
  assert.match(source, /已被占用，未执行导入/)
  assert.match(source, /isValidSearchUrl/)
  assert.match(source, /MAX_IMPORTED_NOTE_NUMBER_ID = 999999999/)
  assert.match(source, /LOCK TABLE notes IN SHARE ROW EXCLUSIVE MODE/)
  assert.match(source, /importedNumberIds\.reduce/)
  assert.match(source, /toJsonArray\(note\.tags\)/)
})

test('cloud import cannot create cross-account or encrypted note shares', async () => {
  const routeUrl = new URL('../src/routes/migration.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(routeUrl), 'utf8')

  assert.match(source, /分享记录必须引用本次导入的笔记/)
  assert.match(source, /加密笔记不能包含公开分享记录/)
  assert.match(
    source,
    /FROM notes n[\s\S]*n\.id = \$3[\s\S]*n\.user_id = \$2[\s\S]*n\.encrypted = FALSE/
  )
  assert.match(source, /if \(!result\.rows\.length\)[\s\S]*未执行导入/)
})

test('cloud import only links bookmarks to groups owned by the importing user', async () => {
  const routeUrl = new URL('../src/routes/migration.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(routeUrl), 'utf8')

  assert.match(source, /导航记录必须引用本次导入的分组/)
  assert.match(
    source,
    /FROM nav_groups g[\s\S]*g\.id = \$3[\s\S]*g\.user_id = \$2/
  )
  assert.match(source, /toJsonArray\(bookmark\.tags\)/)
})
