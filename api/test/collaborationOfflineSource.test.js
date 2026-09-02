import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8')

test('realtime collaboration loads durable state before accepting the websocket', async () => {
  const source = await read('api/src/lib/collaborationWebSocket.js')
  const documentLoad = source.indexOf('const document = getYDoc(documentName, true)')
  const durableReady = source.indexOf('await documentContexts.get(document)?.ready')
  const upgrade = source.indexOf('wss.handleUpgrade(request, socket, head')

  assert.ok(documentLoad >= 0 && durableReady > documentLoad && upgrade > durableReady)
  assert.match(source, /authorizeRealtimeEdit/)
  assert.match(source, /allowedOrigins\.has\(origin\)/)
  assert.match(source, /await Promise\.allSettled\(\[\.\.\.activePersistenceWrites\]\)/)
})

test('browser collaboration preserves an offline CRDT and streams comment events across devices', async () => {
  const editor = await read('app/src/modules/whisper/components/BlockEditor.vue')
  const panel = await read('app/src/modules/whisper/components/CollaborationPanel.vue')
  const realtimeClient = await read('app/src/shared/services/collaborationEvents.js')
  const realtimeServer = await read('api/src/lib/collaborationWebSocket.js')
  const realtimeMigration = await read('api/src/db/migrations/028_realtime_collaboration_events.sql')
  const nginx = await read('ovh/nginx.conf')

  assert.match(editor, /new IndexeddbPersistence\(`domo-nav-note-\$\{props\.noteId\}`/)
  assert.match(editor, /new WebsocketProvider/)
  assert.match(editor, /Collaboration\.configure\(\{ document: ydoc, field: 'default' \}\)/)
  assert.match(editor, /离线编辑，联网后合并/)
  assert.match(panel, /subscribeToCollaborationEvents/)
  assert.match(panel, /realtimeStatus\.value !== 'connected'/)
  assert.match(panel, /30_000/)
  assert.doesNotMatch(panel, /4_000/)
  assert.match(panel, /domo-nav:offline-sync/)
  assert.match(panel, /canEditComment/)
  assert.match(panel, /canDeleteComment/)
  assert.match(realtimeClient, /\/api\/collaboration\/events\//)
  assert.match(realtimeClient, /event\.code === 1008/)
  assert.match(realtimeServer, /LISTEN \$\{NOTE_SYNC_CHANNEL\}/)
  assert.match(realtimeServer, /canDeliverNoteSyncEvent/)
  assert.match(realtimeServer, /maxPayload: 16 \* 1024/)
  assert.match(realtimeMigration, /pg_notify\(/)
  assert.match(realtimeMigration, /nav_note_sync_events/)
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade/)
  assert.match(nginx, /proxy_set_header Connection \$nav_connection_upgrade/)
})

test('offline workspace is restart-safe and keeps private API responses out of the shell cache', async () => {
  const serviceWorker = await read('app/public/sw.js')
  const offline = await read('app/src/shared/services/offlineWorkspace.js')
  const auth = await read('app/src/shared/composables/useAuth.js')
  const vite = await read('app/vite.config.js')

  assert.match(serviceWorker, /Promise\.allSettled\(\s*SHELL_ASSETS/)
  assert.doesNotMatch(serviceWorker, /fetch\('\/\.vite\/manifest\.json'/)
  assert.match(serviceWorker, /\/\^\\\/assets\\\/\[\^\/\]\+\\\.\[a-z0-9\]\+\$\/i/)
  assert.match(serviceWorker, /url\.pathname\.startsWith\('\/api\/'\)/)
  assert.match(serviceWorker, /self\.addEventListener\('sync'/)
  assert.match(serviceWorker, /caches\.match\('\/'\)/)
  assert.match(offline, /offline_mutation_receipts|collaboration\/sync\/mutations/)
  assert.match(offline, /requestBackgroundSync/)
  assert.match(offline, /visibilitychange/)
  assert.match(offline, /export async function removeCachedWorkspaceNote/)
  assert.match(offline, /if \(!forceBootstrap \|\| activeSyncForceBootstrap\) return activeSyncPromise/)
  assert.match(offline, /then\(\(\) => synchronizeOfflineWorkspace\(\{ forceBootstrap: true \}\)\)/)
  assert.match(offline, /await removeCachedWorkspaceNote\(note\.id\)/)
  assert.match(auth, /localStorage/)
  assert.match(auth, /validatedAt/)
  assert.match(auth, /clearCurrentAuthState/)
  assert.match(auth, /Number\(error\?\.status\) === 401/)
  assert.match(vite, /manifest: true/)
})

test('note deletion evicts stale offline state and remains idempotent after the server record is gone', async () => {
  const [whisper, card, offline, notesApi, offlineRoute] = await Promise.all([
    read('app/src/modules/whisper/Whisper.vue'),
    read('app/src/modules/whisper/components/NoteCard.vue'),
    read('app/src/shared/services/offlineWorkspace.js'),
    read('app/src/shared/services/notesApi.js'),
    read('api/src/routes/offlineSync.js')
  ])

  assert.match(whisper, /Number\(error\?\.status\) === 404 && ownedExisting/)
  assert.match(whisper, /async function evictDeletedNoteCache/)
  assert.match(whisper, /return \{ \.\.\.result, cacheEvicted \}/)
  assert.match(whisper, /const ownedExisting = existing\?\.accessRole === 'owner'/)
  assert.match(whisper, /getLocalNotes\(\)\)\.map\(\(note\) => \(\{ \.\.\.note, accessRole: 'owner' \}\)\)/)
  assert.match(whisper, /notes\.value = notes\.value\.filter\(\(item\) => item\.id !== note\.id\)/)
  assert.match(whisper, /synchronizeOfflineWorkspace\(\{ forceBootstrap: true \}\)/)
  assert.match(whisper, /本机旧缓存已清理/)
  assert.match(whisper, /detail\?\.state === 'synced'[\s\S]{0,140}notes\.value = await getCachedWorkspaceNotes\(\)/)
  assert.match(card, /const canDelete = computed\(\(\) => props\.note\.accessRole === 'owner'\)/)
  assert.match(card, /v-if="canDelete"[\s\S]{0,180}aria-label="`删除 \$\{note\.title\}`"/)
  assert.match(offline, /function cachedNoteAccessRole/)
  assert.match(offline, /return ownerId && ownerId === userId \? 'owner' : 'viewer'/)
  assert.match(offline, /const needsAccessRoleRepair = await db\.notes/)
  assert.match(offline, /record\.kind === 'note\.create' \? 'owner' : ''/)
  assert.match(notesApi, /map\(\(note\) => \(\{ \.\.\.note, accessRole: 'owner' \}\)\)/)
  assert.match(offlineRoute, /FOR UPDATE OF note/)
  assert.match(offlineRoute, /alreadyDeleted: deleted\.rows\.length === 0/)
  assert.match(offlineRoute, /Only the note owner can delete it/)
  assert.match(offline, /return \{ cacheEvicted \}/)
})

test('large restore upload is line-streamed into PostgreSQL staging before apply', async () => {
  const route = await read('api/src/routes/migration.js')
  const migration = await read('api/src/db/migrations/027_streaming_data_restore.sql')
  const ui = await read('app/src/shared/services/migrationApi.js')

  assert.match(route, /application\/x-domo-nav-backup-ndjson/)
  assert.match(route, /StringDecoder/)
  assert.match(route, /data_restore_stream_records/)
  assert.match(route, /DATA_RESTORE_STREAM_BATCH_SIZE/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS data_restore_stream_uploads/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS data_restore_stream_records/)
  assert.match(ui, /uploadBackendRestoreStream/)
})
