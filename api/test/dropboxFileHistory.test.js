import test from 'node:test'
import assert from 'node:assert/strict'
import { DropboxFilesService, FILE_SCOPES, UPLOAD_LIMIT, metadata } from '../src/lib/dropboxFiles.js'
import { listFileHistory, fileRevision, recoverRevisionCopy } from '../src/lib/dropboxFileHistory.js'
import { dropboxContentHash } from '../src/lib/dropboxFileUploads.js'
const cfg = { version: 1, purpose: 'nav-files', accessType: 'full_dropbox', ownerUserId: '00000000-0000-4000-8000-000000000001', clientId: 'fileapp123', backupClientId: 'backupapp123', refreshToken: 'TEST_ONLY', accountId: 'dbid:TEST', scopes: FILE_SCOPES, backupFolderId: 'id:backup', backupFolderPath: '/Apps/Backup' }
const code = expected => e => e.code === expected
function fixture() {
  const current = { '.tag': 'file', id: 'id:sample', path_display: '/sample.txt', name: 'sample.txt', size: 3, rev: 'abcdef125', server_modified: '2026-09-19T00:00:00Z' }
  const previous = { ...current, rev: 'abcdef123' }
  const state = { entries: [current, previous], deleted: false, exists: false, writes: 0, downloads: 0, body: Buffer.from('old'), change: false, wrongReceipt: false }
  const client = {
    async rpc(route, arg) {
      if (route === 'files/get_metadata') return arg.path === 'id:backup' ? { '.tag': 'folder', id: 'id:backup', name: 'Backup', path_display: '/Apps/Backup' } : current
      assert.equal(route, 'files/list_revisions'); assert.deepEqual(arg, { path: 'id:sample', mode: 'id', limit: 20 })
      return { entries: state.entries, is_deleted: state.deleted }
    },
    async getMetadataIfExists() { return state.exists ? metadata(current) : null },
    async download() { state.downloads++; if (state.change) current.rev = 'abcdef126'; return new Response(state.body) },
    async upload(path, bytes, rev) {
      state.writes++; assert.equal(rev, undefined); assert.equal(bytes.toString(), 'old')
      return { ...current, id: 'id:copy', path_display: path, name: path.slice(1), content_hash: state.wrongReceipt ? 'wrong' : dropboxContentHash(bytes) }
    }
  }
  return { service: new DropboxFilesService(cfg, client), state, current, previous }
}
test('history uses stable ID and a bounded provider history; unknown revisions fail closed', async () => {
  const { service } = fixture()
  assert.equal((await listFileHistory(service, 'id:sample')).entries.length, 2)
  assert.equal((await fileRevision(service, 'id:sample', 'abcdef123')).item.rev, 'abcdef123')
  await assert.rejects(fileRevision(service, 'id:sample', 'abcdef199'), code('REVISION_UNAVAILABLE'))
})
test('history rejects protected historical paths, mismatched IDs, deleted and unbounded results', async () => {
  for (const scenario of ['protected', 'id', 'deleted', 'limit']) {
    const { service, state, previous } = fixture()
    if (scenario === 'protected') previous.path_display = '/Apps/Backup/secret.txt'
    if (scenario === 'id') previous.id = 'id:someoneelse'
    if (scenario === 'deleted') state.deleted = true
    if (scenario === 'limit') state.entries = Array(21).fill(previous)
    await assert.rejects(listFileHistory(service, 'id:sample'), code(scenario === 'protected' ? 'BACKUP_PROTECTED' : scenario === 'deleted' ? 'FILE_CHANGED' : 'INVALID_PROVIDER_RESPONSE'))
    assert.equal(state.writes, 0)
  }
})
test('recover version strictly adds a hash-verified new sibling; never overwrites source', async () => {
  const { service, state } = fixture()
  const result = await recoverRevisionCopy(service, 'id:sample', 'abcdef123', '/recovered.txt')
  assert.equal(result.path, '/recovered.txt'); assert.equal(state.writes, 1)
})
test('recover rejects same source, cross-directory targets, collisions and oversized revisions before download', async () => {
  for (const scenario of ['same', 'elsewhere', 'exists', 'large']) {
    const { service, state, previous } = fixture()
    if (scenario === 'exists') state.exists = true
    if (scenario === 'large') previous.size = UPLOAD_LIMIT + 1
    await assert.rejects(recoverRevisionCopy(service, 'id:sample', 'abcdef123', scenario === 'same' ? '/SAMPLE.txt' : scenario === 'elsewhere' ? '/another/copy.txt' : '/copy.txt'), code(scenario === 'exists' ? 'TARGET_EXISTS' : scenario === 'large' ? 'REVISION_COPY_TOO_LARGE' : 'INVALID_DESTINATION'))
    assert.equal(state.downloads, 0); assert.equal(state.writes, 0)
  }
})
test('recover refuses truncated bytes or concurrent changes before writing, and detects wrong receipts', async () => {
  for (const scenario of ['truncated', 'changed', 'receipt']) {
    const { service, state } = fixture()
    if (scenario === 'truncated') state.body = Buffer.from('x')
    if (scenario === 'changed') state.change = true
    if (scenario === 'receipt') state.wrongReceipt = true
    await assert.rejects(recoverRevisionCopy(service, 'id:sample', 'abcdef123', '/copy.txt'), code(scenario === 'receipt' ? 'UPLOAD_RECEIPT_INVALID' : 'FILE_CHANGED'))
    assert.equal(state.writes, scenario === 'receipt' ? 1 : 0)
  }
})
