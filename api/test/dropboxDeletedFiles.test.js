import test from 'node:test'
import assert from 'node:assert/strict'
import { DropboxFilesService, FILE_SCOPES, metadata } from '../src/lib/dropboxFiles.js'
import { listDeletedFiles, deletedHistory, deletedRevision, recoverDeletedCopy } from '../src/lib/dropboxDeletedFiles.js'
import { dropboxContentHash } from '../src/lib/dropboxFileUploads.js'
const cfg = { version: 1, purpose: 'nav-files', accessType: 'full_dropbox', ownerUserId: '00000000-0000-4000-8000-000000000001', clientId: 'fileapp123', backupClientId: 'backupapp123', refreshToken: 'TEST_ONLY', accountId: 'dbid:TEST', scopes: FILE_SCOPES, backupFolderId: 'id:backup', backupFolderPath: '/Apps/Backup' }
const code = expected => e => e.code === expected
const deleted = path => ({ '.tag': 'deleted', name: path.split('/').pop(), path_display: path })
function fixture() {
  const old = { '.tag': 'file', id: 'id:old', name: 'old.txt', path_display: '/old.txt', size: 3, rev: 'abcdef123', server_modified: '2026-09-19T00:00:00Z' }
  const state = { page: [old, deleted('/old.txt'), deleted('/Apps')], history: [old], isDeleted: true, live: false, exists: false, changed: false, writes: 0, downloads: 0, calls: [] }
  const client = {
    async rpc(route, arg) {
      state.calls.push({ route, arg })
      if (route === 'files/get_metadata') {
        if (arg.path === 'id:backup') return { '.tag': 'folder', id: 'id:backup', name: 'Backup', path_display: '/Apps/Backup' }
        assert.equal(arg.include_deleted, true)
        return state.live ? old : deleted(arg.path)
      }
      if (route === 'files/list_folder' || route === 'files/list_folder/continue') return { entries: state.page, has_more: true, cursor: 'PRIVATE_CURSOR' }
      if (route === 'files/list_revisions') { assert.equal(arg.mode, 'path'); return { entries: state.history, is_deleted: state.isDeleted } }
      throw Error('Unexpected operation')
    },
    async getMetadataIfExists() { return state.exists ? metadata(old) : null },
    async download() { state.downloads++; if (state.changed) state.live = true; return new Response(Buffer.from('old')) },
    async upload(path, bytes, rev) { assert.equal(rev, undefined); state.writes++; return { ...old, id: 'id:copy', name: path.slice(1), path_display: path, content_hash: dropboxContentHash(bytes) } }
  }
  return { service: new DropboxFilesService(cfg, client), state, old }
}
test('deleted listing is bounded, nonrecursive, paginated and excludes backup ancestors', async () => {
  const { service, state } = fixture(), result = await listDeletedFiles(service)
  assert.deepEqual(result.entries, [{ name: 'old.txt', path: '/old.txt', type: 'deleted' }])
  assert.equal(result.hasMore, true); assert.equal(result.cursor, 'PRIVATE_CURSOR')
  assert.deepEqual(state.calls.find(c => c.route === 'files/list_folder').arg, { path: '', recursive: false, include_deleted: true, limit: 100 })
  await listDeletedFiles(service, '', result.cursor)
  assert.equal(state.calls.at(-1).route, 'files/list_folder/continue')
  state.page = [deleted('/other/nested.txt')]
  await assert.rejects(listDeletedFiles(service), code('INVALID_PROVIDER_RESPONSE'))
})
test('deleted history rechecks tombstone, path identity, same file lineage and protection', async () => {
  for (const scenario of ['live', 'notDeleted', 'path', 'ids', 'limit', 'protected']) {
    const { service, state, old } = fixture()
    if (scenario === 'live') state.live = true
    if (scenario === 'notDeleted') state.isDeleted = false
    if (scenario === 'path') state.history = [{ ...old, path_display: '/moved.txt' }]
    if (scenario === 'ids') state.history.push({ ...old, id: 'id:other' })
    if (scenario === 'limit') state.history = Array(21).fill(old)
    await assert.rejects(deletedHistory(service, scenario === 'protected' ? '/Apps/Backup/secret' : '/old.txt'), code(scenario === 'protected' ? 'BACKUP_PROTECTED' : scenario === 'limit' ? 'INVALID_PROVIDER_RESPONSE' : 'DELETED_FILE_CHANGED'))
    assert.equal(state.writes, 0)
  }
})
test('deleted file can be downloaded by validated revision and safely copied, never restored over original', async () => {
  const { service, state } = fixture()
  assert.equal((await deletedRevision(service, '/old.txt', 'abcdef123')).id, 'id:old')
  assert.equal((await recoverDeletedCopy(service, '/old.txt', 'abcdef123', '/old-recovered.txt')).path, '/old-recovered.txt')
  assert.equal(state.writes, 1)
  assert.ok(state.calls.every(c => !['files/restore', 'files/permanently_delete'].includes(c.route)))
})
test('deleted copy refuses collisions, same name, change during download, missing versions and large files', async () => {
  for (const scenario of ['exists', 'same', 'changed', 'missing', 'large']) {
    const { service, state, old } = fixture()
    if (scenario === 'exists') state.exists = true
    if (scenario === 'changed') state.changed = true
    if (scenario === 'large') old.size = 20 * 1024 * 1024 + 1
    await assert.rejects(recoverDeletedCopy(service, '/old.txt', scenario === 'missing' ? 'abcdef999' : 'abcdef123', scenario === 'same' ? '/old.txt' : '/new.txt'), code(({ exists: 'TARGET_EXISTS', same: 'INVALID_DESTINATION', changed: 'DELETED_FILE_CHANGED', missing: 'REVISION_UNAVAILABLE', large: 'REVISION_COPY_TOO_LARGE' })[scenario]))
    assert.equal(state.writes, 0)
  }
})
