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

test('browser collaboration preserves an offline CRDT and refreshes comments across devices', async () => {
  const editor = await read('app/src/modules/whisper/components/BlockEditor.vue')
  const panel = await read('app/src/modules/whisper/components/CollaborationPanel.vue')
  const nginx = await read('ovh/nginx.conf')

  assert.match(editor, /new IndexeddbPersistence\(`domo-nav-note-\$\{props\.noteId\}`/)
  assert.match(editor, /new WebsocketProvider/)
  assert.match(editor, /Collaboration\.configure\(\{ document: ydoc, field: 'default' \}\)/)
  assert.match(editor, /离线编辑，联网后合并/)
  assert.match(panel, /window\.setInterval\(refreshLiveComments, 4_000\)/)
  assert.match(panel, /domo-nav:offline-sync/)
  assert.match(panel, /canEditComment/)
  assert.match(panel, /canDeleteComment/)
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade/)
  assert.match(nginx, /proxy_set_header Connection \$nav_connection_upgrade/)
})

test('offline workspace is restart-safe and keeps private API responses out of the shell cache', async () => {
  const serviceWorker = await read('app/public/sw.js')
  const offline = await read('app/src/shared/services/offlineWorkspace.js')
  const auth = await read('app/src/shared/composables/useAuth.js')
  const vite = await read('app/vite.config.js')

  assert.match(serviceWorker, /fetch\('\/\.vite\/manifest\.json', \{ cache: 'no-store' \}\)/)
  assert.match(serviceWorker, /url\.pathname\.startsWith\('\/api\/'\)/)
  assert.match(serviceWorker, /self\.addEventListener\('sync'/)
  assert.match(serviceWorker, /caches\.match\('\/'\)/)
  assert.match(offline, /offline_mutation_receipts|collaboration\/sync\/mutations/)
  assert.match(offline, /requestBackgroundSync/)
  assert.match(offline, /visibilitychange/)
  assert.match(auth, /localStorage/)
  assert.match(auth, /validatedAt/)
  assert.match(auth, /clearCurrentAuthState/)
  assert.match(auth, /Number\(error\?\.status\) === 401/)
  assert.match(vite, /manifest: true/)
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
