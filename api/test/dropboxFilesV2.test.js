import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DropboxFilesService, FILE_SCOPES } from '../src/lib/dropboxFiles.js'
import { DropboxFileUploads, CHUNK_LIMIT, LARGE_UPLOAD_LIMIT, dropboxContentHash } from '../src/lib/dropboxFileUploads.js'

const cfg = { version: 1, purpose: 'nav-files', accessType: 'full_dropbox', ownerUserId: '00000000-0000-4000-8000-000000000001', clientId: 'fileapp123', backupClientId: 'backupapp123', refreshToken: 'TEST_ONLY', accountId: 'dbid:TEST', scopes: FILE_SCOPES, backupFolderId: 'id:backup', backupFolderPath: '/Apps/Backup' }
const folder = (path, id) => ({ '.tag': 'folder', id, name: path.split('/').pop(), path_display: path })
const file = (path = '/notes.txt', id = 'id:file', size = 5) => ({ '.tag': 'file', id, name: path.split('/').pop(), path_display: path, rev: 'abcdef123', size, server_modified: '2026-09-19T00:00:00Z' })
const code = expected => error => error.code === expected
function fixture() {
  const items = new Map([['id:backup', folder('/Apps/Backup', 'id:backup')], ['id:file', file()], ['id:folder', folder('/Photos', 'id:folder')], ['id:child', file('/Photos/child.txt', 'id:child')]])
  const mutations = [], chunks = []; let appended = 0, failAppend = false, failFinish = false
  const client = {
    async getMetadataIfExists(path) { return [...items.values()].find(x => x.path_display === path) || null },
    async rpc(route, arg) {
      if (route === 'files/get_metadata') return items.get(arg.path) || [...items.values()].find(x => x.path_display === arg.path)
      if (route === 'files/list_folder') return { entries: [...items.values()].filter(x => x.path_display.startsWith('/Photos/')), has_more: false }
      mutations.push({ route, arg })
      if (route === 'files/delete_v2') return { metadata: items.get(arg.path) }
      if (route === 'files/copy_v2') return { metadata: file(arg.to_path, 'id:copied') }
      throw Error('Unexpected operation')
    },
    async uploadSession(op, arg, bytes) {
      if (op === 'start') return { session_id: 'PRIVATE_PROVIDER_SESSION' }
      if (op === 'append_v2') {
        assert.equal(arg.content_hash, dropboxContentHash(bytes))
        if (arg.cursor.offset !== appended) return { correctOffset: appended }
        chunks.push(Buffer.from(bytes)); appended += bytes.length
        if (failAppend) { failAppend = false; throw Error('NETWORK_LOST_AFTER_ACCEPTANCE') }
        return null
      }
      if (op === 'finish') {
        mutations.push({ op, arg }); assert.equal(arg.commit.autorename, false); assert.equal(arg.commit.strict_conflict, true); assert.deepEqual(arg.commit.mode, { '.tag': 'add' })
        if (failFinish) throw Error('NETWORK_LOST_DURING_COMMIT')
        const { '.tag': _, ...receipt } = file(arg.commit.path, 'id:uploaded', appended)
        return { ...receipt, content_hash: dropboxContentHash(Buffer.concat(chunks)) }
      }
    }
  }
  const service = new DropboxFilesService(cfg, client)
  return { items, mutations, client, service, uploads: new DropboxFileUploads(service), failAppend: () => { failAppend = true }, failFinish: () => { failFinish = true } }
}
test('file delete needs only an opaque preview confirmation; revision remains bound and replay is idempotent', async () => {
  const { service, mutations } = fixture(), preview = await service.prepareDelete('id:file')
  assert.equal(preview.item.name, 'notes.txt'); assert.match(preview.token, /^[a-f0-9]{48}$/)
  await service.deleteConfirmed('id:file', preview.token); await service.deleteConfirmed('id:file', preview.token)
  assert.equal(mutations.length, 1); assert.equal(mutations[0].arg.parent_rev, 'abcdef123')
  await assert.rejects(service.deleteConfirmed('id:child', preview.token), code('DELETE_EXPIRED'))
})
test('folder deletion previews descendants and refuses changed trees, backup anchors and ancestors', async () => {
  const { service, items, mutations } = fixture(), preview = await service.prepareDelete('id:folder')
  assert.equal(preview.descendants, 1); assert.equal(preview.files, 1)
  items.get('id:child').rev = 'abcdef124'
  await assert.rejects(service.deleteConfirmed('id:folder', preview.token), code('FILE_CHANGED')); assert.equal(mutations.length, 0)
  await assert.rejects(service.deleteConfirmed('id:folder', preview.token), code('DELETE_REVIEW_REQUIRED'))
  await assert.rejects(service.prepareDelete('id:backup'), code('BACKUP_PROTECTED'))
  items.set('id:apps', folder('/Apps', 'id:apps'))
  await assert.rejects(service.prepareDelete('id:apps'), code('BACKUP_PROTECTED'))
  const next = await service.prepareDelete('id:folder'); await service.deleteConfirmed('id:folder', next.token)
  assert.equal(mutations[0].arg.path, 'id:folder'); assert.equal(mutations[0].arg.parent_rev, undefined)
})
test('delete preview expires and recursive preflight has a strict size cap', async () => {
  const { service, items } = fixture(), preview = await service.prepareDelete('id:file')
  service.deletePlans.get(preview.token).until = 0
  await assert.rejects(service.deleteConfirmed('id:file', preview.token), code('DELETE_EXPIRED'))
  for (let i = 0; i < 501; i++) items.set('id:c' + i, file('/Photos/' + i, 'id:c' + i))
  await assert.rejects(service.prepareDelete('id:folder'), code('INVALID_PROVIDER_RESPONSE'))
})
test('copy protects both ends and is strict no-overwrite', async () => {
  const { service, mutations } = fixture()
  await assert.rejects(service.copy('id:backup', '/copy'), code('BACKUP_PROTECTED'))
  await assert.rejects(service.copy('id:file', '/Apps/Backup/copy'), code('BACKUP_PROTECTED'))
  await assert.rejects(service.copy('id:folder', '/Photos/sub'), code('INVALID_DESTINATION'))
  await service.copy('id:file', '/copied.txt'); assert.equal(mutations[0].route, 'files/copy_v2'); assert.equal(mutations[0].arg.autorename, false)
})
test('paginated folder previews stop after five bounded pages without a deletion', async () => {
  const { service, client, mutations } = fixture(), original = client.rpc
  let pages = 0
  client.rpc = async (route, arg) => {
    if (route.startsWith('files/list_folder')) { pages++; return { entries: Array.from({ length: 100 }, (_, i) => file('/Photos/' + pages + '-' + i, 'id:c' + pages + '-' + i)), cursor: 'TEST_CURSOR', has_more: true } }
    return original(route, arg)
  }
  await assert.rejects(service.prepareDelete('id:folder'), code('FOLDER_TOO_LARGE'))
  assert.equal(pages, 5); assert.equal(mutations.length, 0)
})
test('duplicate targets fail before sending file bytes or starting a provider session', async () => {
  const { uploads, client } = fixture(); let starts = 0
  client.uploadSession = async () => { starts++; throw Error('Unexpected start') }
  await assert.rejects(uploads.start('/notes.txt', 100), code('TARGET_EXISTS')); assert.equal(starts, 0)
})
test('upload accepts a logical 50 GiB session but rejects oversized files before provider work', async () => {
  const { uploads } = fixture()
  const state = await uploads.start('/movie.mkv', LARGE_UPLOAD_LIMIT)
  assert.equal(state.size, LARGE_UPLOAD_LIMIT); assert.equal(state.offset, 0); assert.equal(state.chunkSize, CHUNK_LIMIT)
  assert.equal(JSON.stringify(state).includes('PRIVATE_PROVIDER_SESSION'), false)
  await assert.rejects(uploads.start('/too-big.mkv', LARGE_UPLOAD_LIMIT + 1), code('UPLOAD_TOO_LARGE'))
  await assert.rejects(uploads.start('/Apps/Backup/file', 1), code('BACKUP_PROTECTED'))
  await assert.rejects(uploads.finish(state.uploadId), code('UPLOAD_INCOMPLETE'))
  assert.equal(uploads.cancel(state.uploadId).state, 'cancelled')
  assert.throws(() => uploads.status(state.uploadId), code('UPLOAD_EXPIRED'))
})
test('25 MiB upload uses bounded chunks, verified hashes, exact length, replay and strict finish', async () => {
  const { uploads, mutations } = fixture(), size = 25 * 1024 * 1024
  const { uploadId } = await uploads.start('/movie.mp4', size)
  for (let offset = 0; offset < size; offset += CHUNK_LIMIT) {
    const bytes = Buffer.alloc(Math.min(CHUNK_LIMIT, size - offset), 37)
    const result = await uploads.append(uploadId, offset, bytes)
    assert.equal(result.offset, offset + bytes.length)
    assert.equal((await uploads.append(uploadId, offset, bytes)).offset, result.offset)
  }
  const result = await uploads.finish(uploadId)
  assert.equal(result.state, 'complete'); assert.equal(result.item.size, size)
  assert.equal((await uploads.finish(uploadId)).state, 'complete'); assert.equal(mutations.length, 1)
  assert.equal(uploads.cancel(uploadId).state, 'complete')
})
test('lost append response resumes only the identical pending chunk at the expected provider offset', async () => {
  const { uploads, failAppend } = fixture(), data = Buffer.from('sample'), { uploadId } = await uploads.start('/sample.txt', data.length)
  failAppend(); await assert.rejects(uploads.append(uploadId, 0, data))
  assert.equal(uploads.status(uploadId).offset, 0)
  await assert.rejects(uploads.append(uploadId, 0, Buffer.from('change')), code('INVALID_CHUNK'))
  assert.equal((await uploads.append(uploadId, 0, data)).offset, data.length)
  assert.equal((await uploads.finish(uploadId)).state, 'complete')
})
test('unknown commit outcome is never retried, auto-overwritten or deleted', async () => {
  const { uploads, failFinish, mutations } = fixture(), { uploadId } = await uploads.start('/empty.txt', 0)
  failFinish(); await assert.rejects(uploads.finish(uploadId))
  assert.equal(uploads.status(uploadId).state, 'review')
  await assert.rejects(uploads.finish(uploadId), code('UPLOAD_REVIEW_REQUIRED'))
  assert.throws(() => uploads.cancel(uploadId), code('UPLOAD_REVIEW_REQUIRED'))
  assert.equal(mutations.length, 1)
})
test('chunks cannot overrun, reorder or fill whole-file buffers; moved protection rechecked before commit', async () => {
  const { uploads, items } = fixture(), { uploadId } = await uploads.start('/Photos/movie.mp4', 10)
  await assert.rejects(uploads.append(uploadId, 0, Buffer.alloc(11)), code('INVALID_CHUNK'))
  await assert.rejects(uploads.append(uploadId, 1, Buffer.alloc(10)), code('INVALID_CHUNK'))
  await assert.rejects(uploads.append(uploadId, 0, Buffer.alloc(CHUNK_LIMIT + 1)), code('INVALID_CHUNK'))
  await uploads.append(uploadId, 0, Buffer.alloc(10))
  items.set('id:backup', folder('/Photos', 'id:backup'))
  await assert.rejects(uploads.finish(uploadId), code('BACKUP_PROTECTED'))
})
test('Dropbox content hash matches independent block construction and empty file', () => {
  const data = Buffer.alloc(4 * 1024 * 1024 + 7, 9)
  const a = createHash('sha256').update(data.subarray(0, 4 * 1024 * 1024)).digest()
  const b = createHash('sha256').update(data.subarray(4 * 1024 * 1024)).digest()
  assert.equal(dropboxContentHash(data), createHash('sha256').update(Buffer.concat([a, b])).digest('hex'))
  assert.equal(dropboxContentHash(Buffer.alloc(0)), createHash('sha256').digest('hex'))
})
test('bad finish content hash is not reported complete or retried', async () => {
  const { uploads, client } = fixture(), original = client.uploadSession
  client.uploadSession = async (...args) => { const result = await original(...args); return args[0] === 'finish' ? { ...result, content_hash: '0'.repeat(64) } : result }
  const { uploadId } = await uploads.start('/bad-hash.txt', 0)
  await assert.rejects(uploads.finish(uploadId), code('UPLOAD_RECEIPT_INVALID'))
  assert.equal(uploads.status(uploadId).state, 'review')
})
test('parallel chunks for the same handle are locked and unrecognized handles fail closed', async () => {
  const { uploads, client } = fixture(), original = client.uploadSession
  let release
  client.uploadSession = async (...args) => {
    if (args[0] === 'append_v2') await new Promise(resolve => { release = resolve })
    return original(...args)
  }
  const { uploadId } = await uploads.start('/locked.txt', 2)
  const pending = uploads.append(uploadId, 0, Buffer.from('ab'))
  await new Promise(resolve => setTimeout(resolve, 5))
  await assert.rejects(uploads.append(uploadId, 0, Buffer.from('ab')), code('BUSY'))
  assert.throws(() => uploads.cancel(uploadId), code('BUSY'))
  release(); await pending
  assert.throws(() => uploads.status('PRIVATE_PROVIDER_SESSION'), code('UPLOAD_EXPIRED'))
})
