import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  generateDueNoteReminders,
  validateNoteReminderSchedulerPolicy
} from '../src/lib/noteReminderScheduler.js'
import {
  runScheduledBookmarkHealthCheck,
  validateBookmarkHealthSchedulerPolicy
} from '../src/lib/bookmarkHealthScheduler.js'
import {
  mapNoteVersion,
  NOTE_VERSION_RETENTION_LIMIT
} from '../src/lib/noteVersions.js'
import {
  parseBookmarkHtml,
  planBookmarkImport
} from '../../app/src/shared/utils/bookmarkImport.js'
import {
  exportNotesToMarkdown,
  parseNotesMarkdown
} from '../../app/src/shared/utils/noteMarkdown.js'

async function source(path) {
  return fs.readFile(new URL(path, import.meta.url), 'utf8')
}

test('advance reminder generation is bounded and serialized with an advisory lock', async () => {
  assert.deepEqual(
    validateNoteReminderSchedulerPolicy({ intervalSeconds: 60, batchSize: 500 }),
    { intervalSeconds: 60, batchSize: 500 }
  )
  assert.throws(
    () => validateNoteReminderSchedulerPolicy({ intervalSeconds: 29, batchSize: 1 }),
    /intervalSeconds/
  )

  const calls = []
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
      if (/INSERT INTO note_reminders/.test(sql)) return { rowCount: 3, rows: [] }
      return { rows: [{ released: true }] }
    },
    release() {}
  }
  const result = await generateDueNoteReminders({
    poolInstance: { connect: async () => client },
    policy: { intervalSeconds: 60, batchSize: 25 }
  })
  assert.deepEqual(result, { generated: 3, skipped: null })
  assert.match(calls[1].sql, /LIMIT \$1/)
  assert.match(calls[1].sql, /FOR UPDATE SKIP LOCKED/)
  assert.match(calls[1].sql, /remind_before_minutes \* INTERVAL '1 minute'/)
  assert.deepEqual(calls[1].params, [25])
  assert.match(calls.at(-1).sql, /pg_advisory_unlock/)
})

test('scheduled link checks reuse the safe probe and update only unchanged rows', async () => {
  assert.deepEqual(
    validateBookmarkHealthSchedulerPolicy({
      intervalSeconds: 3600,
      batchSize: 20,
      staleHours: 168,
      concurrency: 2
    }),
    { intervalSeconds: 3600, batchSize: 20, staleHours: 168, concurrency: 2 }
  )

  const calls = []
  const client = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
      if (/FROM nav_bookmarks/.test(sql)) {
        return {
          rows: [
            { id: 'a', user_id: 'u', url: 'https://a.example/', health_failure_count: 0, health_checked_at: null },
            { id: 'b', user_id: 'u', url: 'https://b.example/', health_failure_count: 0, health_checked_at: null }
          ]
        }
      }
      if (/UPDATE nav_bookmarks/.test(sql)) return { rowCount: 1, rows: [] }
      return { rows: [{ released: true }] }
    },
    release() {}
  }
  const result = await runScheduledBookmarkHealthCheck({
    poolInstance: { connect: async () => client },
    policy: { intervalSeconds: 3600, batchSize: 20, staleHours: 168, concurrency: 2 },
    probeFn: async (url) => (
      url.includes('a.example')
        ? { outcome: 'healthy', statusCode: 200 }
        : { outcome: 'failure', statusCode: 404, errorCode: 'http_error' }
    )
  })
  assert.deepEqual(result, {
    checked: 2,
    broken: 0,
    suspect: 1,
    unsupported: 0,
    reachable: 1,
    skipped: null
  })
  const updates = calls.filter(({ sql }) => /UPDATE nav_bookmarks/.test(sql))
  assert.equal(updates.length, 2)
  assert.ok(updates.every(({ sql }) => /health_checked_at IS NOT DISTINCT FROM \$8/.test(sql)))
  assert.match(calls.at(-1).sql, /pg_advisory_unlock/)
})

test('Chrome and Edge bookmark HTML is previewed, normalized, capped and deduplicated', () => {
  const parsed = parseBookmarkHtml(`
    <!DOCTYPE NETSCAPE-Bookmark-file-1>
    <DL><p>
      <DT><H3>工作</H3>
      <DL><p>
        <DT><A HREF="https://example.com/path#old">Example &amp; Docs</A>
        <DT><A HREF="javascript:alert(1)">Bad</A>
      </DL><p>
    </DL><p>
  `)
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0].url, 'https://example.com/path')
  assert.equal(parsed.entries[0].title, 'Example & Docs')
  assert.deepEqual(parsed.entries[0].folderPath, ['工作'])
  assert.equal(parsed.skipped, 1)

  const plan = planBookmarkImport([
    parsed.entries[0],
    { ...parsed.entries[0], title: 'duplicate' }
  ], {
    preserveFolders: true,
    folderGroupIds: { 工作: 'group-1' },
    existingBookmarks: []
  })
  assert.equal(plan.planned.length, 1)
  assert.equal(plan.duplicates, 1)
})

test('Markdown round-trip preserves supported note metadata and skips encrypted notes', () => {
  const exported = exportNotesToMarkdown([
    {
      type: 'memo',
      title: 'Renew cert',
      content: 'Check the expiry date.',
      tags: ['ops'],
      dueAt: '2026-09-01T00:00:00.000Z',
      remindBeforeMinutes: 1440
    },
    { title: 'private', encrypted: true, content: 'secret' }
  ])
  assert.equal(exported.exported, 1)
  assert.equal(exported.skippedEncrypted, 1)
  assert.doesNotMatch(exported.markdown, /secret/)

  const parsed = parseNotesMarkdown(exported.markdown)
  assert.equal(parsed.notes.length, 1)
  assert.equal(parsed.notes[0].title, 'Renew cert')
  assert.equal(parsed.notes[0].remindBeforeMinutes, 1440)
  assert.deepEqual(parsed.notes[0].tags, ['ops'])
})

test('version DTOs are bounded and never expose encrypted bodies or hashes', () => {
  assert.equal(NOTE_VERSION_RETENTION_LIMIT, 50)
  const mapped = mapNoteVersion({
    id: 'version',
    revision: 2,
    type: 'memo',
    title: 'private',
    content: 'ciphertext',
    encrypted: true,
    password_hash: 'must-not-leak',
    tags: [],
    created_at: '2026-08-24T00:00:00.000Z'
  })
  assert.equal(mapped.content, '')
  assert.equal(mapped.contentAvailable, false)
  assert.doesNotMatch(JSON.stringify(mapped), /ciphertext|must-not-leak/)
})

test('frontend wires autosave, versions, dynamic commands and privacy-safe PWA shell', async () => {
  const [
    editor,
    whisper,
    palette,
    app,
    worker,
    browserSettings,
    migration,
    reminderClient,
    navigation
  ] = await Promise.all([
    source('../../app/src/modules/whisper/components/NoteEditor.vue'),
    source('../../app/src/modules/whisper/Whisper.vue'),
    source('../../app/src/shared/components/CommandPalette.vue'),
    source('../../app/src/App.vue'),
    source('../../app/public/sw.js'),
    source('../../app/src/modules/settings/components/BrowserIntegrationSettings.vue'),
    source('../src/db/migrations/022_productivity_completion.sql'),
    source('../../app/src/shared/composables/useNoteReminders.js'),
    source('../../app/src/modules/navigation/Navigation.vue')
  ])
  assert.match(editor, /window\.setTimeout\(runAutosave, 1200\)/)
  assert.match(editor, /beforeunload/)
  assert.match(editor, /initialEncrypted\.value !== Boolean\(formData\.value\.encrypted\)/)
  assert.match(editor, /onBeforeRouteLeave\(async \(\) =>/)
  assert.match(editor, /await runAutosave\(\)[\s\S]*currentDirtySnapshot\(\) === initialSnapshot\.value/)
  assert.match(editor, /!props\.note\?\._unlocked/)
  assert.match(editor, /保存中|已自动保存|自动保存失败/)
  assert.match(whisper, /NoteVersionHistory/)
  assert.match(palette, /fetchBackendChatModels/)
  assert.match(palette, /set-theme/)
  assert.match(palette, /set-ai-model/)
  assert.match(app, /command\.action === 'set-theme'/)
  assert.match(app, /command\.action === 'set-ai-model'/)
  assert.match(app, /closeCommandPalette\(\{ restoreFocus: true \}\)/)
  assert.match(app, /保存失败；刷新后可能恢复/)
  assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/)
  assert.match(worker, /caches\.match\('\/offline\.html'\)/)
  assert.match(worker, /addEventListener\('notificationclick'/)
  assert.match(worker, /addEventListener\('push'/)
  assert.match(reminderClient, /navigator\.serviceWorker\?\.getRegistration/)
  assert.match(reminderClient, /registration\.showNotification\(title, options\)/)
  assert.match(reminderClient, /const notificationError = ref\(''\)/)
  assert.match(reminderClient, /notificationError\.value = '系统通知投递失败/)
  assert.doesNotMatch(reminderClient, /error\.value = '系统通知投递失败/)
  assert.match(reminderClient, /系统通知投递失败/)
  assert.match(navigation, /class="health-issues__label"/)
  assert.match(browserSettings, /不缓存账号数据、笔记、图片或 API 响应/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS note_versions/)
  assert.match(migration, /idx_notes_reminder_generation[\s\S]*ON notes \(due_at, id\)/)
  assert.match(migration, /DELETE FROM note_shares AS share[\s\S]*note\.encrypted = TRUE/)
})

test('backend batch imports are bounded, authenticated and atomic', async () => {
  const [routes, app, portability] = await Promise.all([
    source('../src/routes/productivityImports.js'),
    source('../src/app.js'),
    source('../../app/src/modules/settings/components/ProductivityPortability.vue')
  ])

  assert.match(routes, /MAX_BOOKMARK_IMPORT_ITEMS = 1_000/)
  assert.match(routes, /MAX_NOTE_IMPORT_ITEMS = 200/)
  assert.match(routes, /bodyLimit: MAX_IMPORT_BODY_BYTES/)
  assert.match(routes, /fastify\.requireAuth\(request, reply\)/)
  assert.match(routes, /withNavigationTransaction\(/)
  assert.match(routes, /withTransaction\(async \(client\) =>/)
  assert.match(routes, /SELECT id[\s\S]*FROM nav_bookmarks[\s\S]*FOR UPDATE/)
  assert.match(app, /register\(productivityImportRoutes, \{ prefix: '\/api' \}\)/)
  assert.match(portability, /await importBackendBookmarks\(/)
  assert.match(portability, /await importBackendNotes\(/)
})

test('reminder reconciliation and version restore preserve concurrency and privacy invariants', async () => {
  const [reminders, notes] = await Promise.all([
    source('../src/lib/noteReminders.js'),
    source('../src/routes/notes.js')
  ])

  assert.match(reminders, /SELECT id[\s\S]*FROM notes[\s\S]*ORDER BY id ASC[\s\S]*FOR UPDATE/)
  assert.match(reminders, /remind_before_minutes IS DISTINCT FROM reminder\.remind_before_minutes_snapshot/)
  assert.match(reminders, /reminder_at_snapshot/)
  const restoreRoute = notes.slice(notes.indexOf("fastify.post('/notes/:noteId/versions/:versionId/restore'"))
  assert.match(notes, /if \(encrypted \|\| Boolean\(lockedNote\.rows\[0\]\.encrypted\)\)/)
  assert.match(restoreRoute, /DELETE FROM note_reminders WHERE note_id = \$1 AND user_id = \$2/)
  assert.match(restoreRoute, /DELETE FROM note_shares WHERE note_id = \$1 AND user_id = \$2/)
})

test('migration verification covers productivity checks, uniqueness and cascade foreign keys', async () => {
  const [verifier, workflow, driftTest] = await Promise.all([
    source('../src/db/verifyMigrations.js'),
    source('../../.github/workflows/ci.yml'),
    source('./productivitySchemaDrift.integration.test.js')
  ])

  for (const constraint of [
    'notes_remind_before_minutes_check',
    'notes_revision_check',
    'note_reminders_advance_minutes_check',
    'note_versions_revision_check',
    'note_versions_remind_before_check',
    'note_versions_note_revision_unique',
    'note_versions_user_id_fkey',
    'note_versions_note_id_fkey'
  ]) {
    assert.match(verifier, new RegExp(constraint))
    assert.match(driftTest, new RegExp(constraint))
  }

  assert.match(verifier, /pg_get_constraintdef/)
  assert.match(verifier, /confdeltype/)
  assert.match(verifier, /convalidated/)
  assert.match(verifier, /table_name/)
  assert.match(verifier, /referenced_columns/)
  assert.match(driftTest, /revision >= 1 OR revision < 1/)
  assert.match(driftTest, /ON DELETE CASCADE NOT VALID/)
  assert.match(driftTest, /misplaced note cascade/)
  assert.match(driftTest, /UNIQUE \(user_id, note_id\)/)
  assert.match(verifier, /ondeletecascade/)
  assert.match(workflow, /NAV_PRODUCTIVITY_SCHEMA_DRIFT_TEST: "true"/)
})
