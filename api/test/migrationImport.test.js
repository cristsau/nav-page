import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

test('guarded cloud restore preserves productivity fields and safely assigns stable numeric IDs', async () => {
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

  assert.match(source, /planDataRestoreNoteNumbers\(notes/)
  assert.match(source, /noteNumberPlan\.numberIds\[noteIndex\]/)
  assert.doesNotMatch(source, /nextval\('notes_number_id_seq'\)/)
  assert.match(source, /findDataRestoreConflicts/)
  assert.match(source, /isValidSearchUrl/)
  assert.match(source, /MAX_DATA_RESTORE_NOTE_NUMBER_ID/)
  assert.match(source, /LOCK TABLE[\s\S]*notes,[\s\S]*note_reminders,[\s\S]*IN SHARE ROW EXCLUSIVE MODE/)
  assert.match(source, /toJsonArray\(note\.tags\)/)
})

test('guarded cloud restore cannot create cross-account or encrypted note shares', async () => {
  const routeUrl = new URL('../src/routes/migration.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(routeUrl), 'utf8')

  assert.match(source, /分享记录必须引用本次恢复的笔记/)
  assert.match(source, /加密笔记不能包含公开分享记录/)
  assert.match(
    source,
    /FROM notes n[\s\S]*n\.id = \$3[\s\S]*n\.user_id = \$2[\s\S]*n\.encrypted = FALSE/
  )
  assert.match(source, /if \(!result\.rows\.length\)[\s\S]*未执行导入/)
})

test('guarded cloud restore only links bookmarks to groups owned by the importing user', async () => {
  const routeUrl = new URL('../src/routes/migration.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(routeUrl), 'utf8')

  assert.match(source, /导航记录必须引用本次恢复的分组/)
  assert.match(
    source,
    /FROM nav_groups g[\s\S]*g\.id = \$3[\s\S]*g\.user_id = \$2/
  )
  assert.match(source, /toJsonArray\(bookmark\.tags\)/)
})

test('legacy import is blocked and apply requires preview, password and a locked fresh state recheck', async () => {
  const routeUrl = new URL('../src/routes/migration.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(routeUrl), 'utf8')

  assert.match(source, /fastify\.post\('\/migration\/restore\/preview'/)
  assert.match(source, /fastify\.post\('\/migration\/restore\/apply'/)
  assert.match(source, /fastify\.post\('\/migration\/import-local'[\s\S]*reply\.code\(428\)/)
  assert.match(source, /verifyPassword\([\s\S]*request\.body\.currentPassword/)
  assert.match(source, /verifyDataRestorePreviewToken/)
  assert.match(source, /fastify\.get\('\/migration\/restore\/safety-backup'/)
  assert.match(source, /createDataRestoreSafetyBackupReceipt/)
  assert.match(source, /verifyDataRestoreSafetyBackupReceipt/)
  assert.match(source, /assessBackendExportRestoreCompatibility/)
  assert.match(source, /currentPassword: '\\u0000'\.repeat\(DATA_RESTORE_MAX_PASSWORD_LENGTH\)/)
  assert.match(source, /requestBytes > DATA_RESTORE_BODY_LIMIT/)
  assert.match(
    source,
    /if \(!restoreCompatibility\.restorable && !restoreCompatibility\.streamRestorable\)[\s\S]*?restore_safety_backup_incompatible/
  )
  assert.match(source, /if \(!blockingErrors\.length\) \{[\s\S]*?createDataRestorePreviewToken/)
  assert.match(source, /SET LOCAL statement_timeout = '60s'/)
  assert.match(source, /status = 'approved'[\s\S]*?FROM sessions[\s\S]*?expires_at > NOW\(\)[\s\S]*?FOR UPDATE/)
  assert.doesNotMatch(source, /isolationLevel: 'serializable'/)
  assert.match(source, /DATA_RESTORE_CONFIRMATION = '恢复'/)
  assert.match(source, /reply\.code\(invalidSession \? 401 : invalidPassword \? 400 : 409\)/)

  const applyRoute = source.indexOf("fastify.post('/migration/restore/apply'")
  const tableLock = source.indexOf('LOCK TABLE', applyRoute)
  const cascadeRecheck = source.indexOf('findCascadeOwnershipConflicts(', tableLock)
  const stateRead = source.indexOf('readDataRestoreState(client', applyRoute)
  const verification = source.indexOf('verifyDataRestorePreviewToken({', applyRoute)
  const safetyBackupVerification = source.indexOf(
    'verifyDataRestoreSafetyBackupReceipt({',
    verification
  )
  const conflictRecheck = source.indexOf('findDataRestoreConflicts(', safetyBackupVerification)
  const firstDelete = source.indexOf("DELETE FROM nav_bookmarks WHERE user_id = $1")
  assert.ok(tableLock > applyRoute && cascadeRecheck > tableLock && stateRead > cascadeRecheck)
  assert.ok(verification > stateRead && safetyBackupVerification > verification)
  assert.ok(conflictRecheck > safetyBackupVerification && firstDelete > conflictRecheck)
})

test('restore preserves the media catalog and only replaces allowlisted settings', async () => {
  const routeUrl = new URL('../src/routes/migration.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(routeUrl), 'utf8')

  assert.doesNotMatch(source, /DELETE FROM media_assets WHERE user_id/)
  assert.match(source, /AND key = ANY\(\$2::text\[\]\)/)
  assert.match(source, /mergeAppConfigSecrets/)
  assert.match(source, /key !== 'appConfig' \|\| incomingSettingKeys\.has\(key\)/)
  assert.match(source, /state: referencedMediaUrls\.has\(normalized\.url\) \? 'active' : 'orphan'/)
  assert.match(source, /\['deleted', 'missing'\]\.includes\(String\(record\.state \|\| ''\)\)/)
  assert.match(source, /restore-conflict-media-unavailable/)
  assert.match(source, /const attachmentUrls = data\.notes\.flatMap/)
  assert.match(source, /restoreMediaUrls = \[\.\.\.new Set\(\[/)
  assert.match(source, /\.\.\.attachmentUrls/)
  assert.match(source, /restoreMediaUpstreamIds = \[\.\.\.new Set/)
  assert.match(source, /UPDATE media_assets[\s\S]*?SET state = \$4,[\s\S]*?delete_attempts = 0,[\s\S]*?delete_requested_at = NULL/)
  assert.match(source, /AND state NOT IN \('deleted', 'missing'\)[\s\S]*?RETURNING id/)
  assert.match(source, /备份中的笔记引用了已删除或缺失的图片/)
  assert.match(source, /unavailable-media-skipped/)
  assert.match(source, /findCascadeOwnershipConflicts/)
  assert.match(source, /FROM nav_bookmarks child[\s\S]*?JOIN nav_groups parent/)
  assert.match(source, /FROM note_shares child[\s\S]*?JOIN notes parent/)
  assert.match(source, /FROM note_reminders child[\s\S]*?JOIN notes parent/)
  assert.match(source, /new Set\(normalizedMediaUrls\)\.size !== normalizedMediaUrls\.length/)
  assert.match(source, /new Set\(normalizedMediaUpstreamIds\)\.size !== normalizedMediaUpstreamIds\.length/)
  assert.match(source, /FROM media_assets[\s\S]*?WHERE user_id = \$1[\s\S]*?id = ANY\(\$2::uuid\[\]\)[\s\S]*?url = ANY\(\$3::text\[\]\)[\s\S]*?upstream_id = ANY\(\$4::text\[\]\)/)
  assert.match(source, /eventType: 'account\.data\.restore'/)
})

test('restore request secrets and backup content are redacted from API logs', async () => {
  const appUrl = new URL('../src/app.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(appUrl), 'utf8')

  assert.match(source, /'req\.body\.currentPassword'/)
  assert.match(source, /'req\.body\.planToken'/)
  assert.match(source, /'req\.body\.backupReceipt'/)
  assert.match(source, /'req\.body\.backup'/)
})

test('note sequence moves only after all inserts and the transactional success audit', async () => {
  const routeUrl = new URL('../src/routes/migration.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(routeUrl), 'utf8')
  const applyRoute = source.indexOf("fastify.post('/migration/restore/apply'")
  const firstDelete = source.indexOf("DELETE FROM nav_bookmarks WHERE user_id = $1", applyRoute)
  const noteInsert = source.indexOf('INSERT INTO notes (', firstDelete)
  const successAudit = source.indexOf("outcome: 'success'", noteInsert)
  const sequenceSet = source.indexOf('SELECT setval(', successAudit)

  assert.ok(firstDelete > applyRoute && noteInsert > firstDelete)
  assert.ok(successAudit > noteInsert && sequenceSet > successAudit)
  assert.equal(source.indexOf('SELECT setval(', applyRoute), sequenceSet)
})
