import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FILE_SCOPES, DropboxFilesClient, DropboxFilesService, filePath, fileId, revision, protectPath, metadata, officialUrl, kindOf, downloadRange, validateFilesConnection, loadFilesConnection } from '../src/lib/dropboxFiles.js'

// Synthetic identities and responses only. These tests never call Dropbox.
const cfg = () => ({ version: 1, purpose: 'nav-files', accessType: 'full_dropbox', ownerUserId: '00000000-0000-4000-8000-000000000001', clientId: 'fileapp123', backupClientId: 'backupapp123', refreshToken: 'TEST_REFRESH', accountId: 'dbid:TEST', scopes: [...FILE_SCOPES], backupFolderId: 'id:backup', backupFolderPath: '/Apps/Backup' })
const folder = (path = '/Apps/Backup', id = 'id:backup') => ({ '.tag': 'folder', id, name: path.split('/').pop(), path_display: path })
const file = (path = '/notes.txt', more = {}) => ({ '.tag': 'file', id: 'id:file', name: path.split('/').pop(), path_display: path, rev: 'abcdef123', size: 5, server_modified: '2026-09-19T00:00:00Z', ...more })
const code = expected => e => e.code === expected
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const concrete = value => { const { '.tag': _tag, ...rest } = value; return rest }
function fixture({ anchor = folder(), item = file(), listing, data = 'hello' } = {}) {
  const calls = [], uploads = []
  const client = {
    async rpc(route, arg) {
      calls.push({ route, arg })
      if (route === 'files/get_metadata') return arg.path === 'id:backup' ? anchor : item
      if (route.includes('list_folder')) return listing || { entries: [item], has_more: false }
      if (route.includes('search')) return { matches: [{ metadata: { metadata: item } }], has_more: false }
      if (route === 'files/delete_v2') return { metadata: item }
      if (route === 'files/create_folder_v2') return { metadata: concrete(folder(arg.path, 'id:new')) }
      if (route === 'files/move_v2') return { metadata: file(arg.to_path) }
      throw Error('Unexpected fixture route')
    },
    async download() { return new Response(data) },
    async upload(path, bytes, rev) { uploads.push({ path, bytes, rev }); return concrete(file(path, { rev: 'abcdef124', size: bytes.length })) }
  }
  return { service: new DropboxFilesService(cfg(), client), calls, uploads }
}
test('paths, IDs and revisions reject traversal, control and ambiguous values', () => {
  for (const p of ['foo', '//foo', '/a/../b', '/a/./b', '/a/', '/a\\b', '/a\n', '/a/%2e%2e', '/a/ b']) assert.throws(() => filePath(p))
  assert.equal(filePath('/', true), '')
  assert.equal(filePath('/旅行/照片.jpg'), '/旅行/照片.jpg')
  for (const id of ['rev:abcdef123', '/foo', 'id:x\n']) assert.throws(() => fileId(id))
  assert.throws(() => revision('abc')); assert.equal(revision('abcdef123'), 'abcdef123')
})
test('backup descendants and mutation ancestors are protected, siblings allowed', () => {
  for (const p of ['/Apps/Backup', '/apps/backup/a']) assert.throws(() => protectPath(p, ['/Apps/Backup']), code('BACKUP_PROTECTED'))
  assert.throws(() => protectPath('/Apps', ['/Apps/Backup'], true), code('BACKUP_PROTECTED'))
  assert.doesNotThrow(() => protectPath('/Apps', ['/Apps/Backup']))
  assert.doesNotThrow(() => protectPath('/Apps/Backup-other', ['/Apps/Backup'], true))
  assert.throws(() => protectPath('/x', []), code('BACKUP_PROTECTION_UNAVAILABLE'))
})
test('metadata strips unknown fields and rejects unsafe inline types and official URLs', () => {
  const m = metadata(file('/x.html', { secret: 'HIDDEN', preview_url: 'https://www.dropbox.com.evil.test/x' }))
  assert.equal(m.kind, 'file'); assert.equal(m.secret, undefined); assert.equal(m.officialUrl, null)
  assert.equal(kindOf('a.svg'), 'file'); assert.equal(kindOf('a.MP4'), 'video')
  for (const url of ['javascript:alert(1)', 'https://user@www.dropbox.com/a', 'https://www.dropbox.com:444/a']) assert.equal(officialUrl(url), null)
  assert.equal(officialUrl('https://www.dropbox.com/home/a'), 'https://www.dropbox.com/home/a')
  assert.throws(() => metadata(file('/x', { name: 'bad\r\nheader', size: -1 })))
})
test('connection is separate, exact-scope and owner-bound', () => {
  assert.equal(validateFilesConnection(cfg()).purpose, 'nav-files')
  for (const change of [{ purpose: 'backup' }, { accessType: 'app_folder' }, { ownerUserId: 'admin' }, { clientId: 'backupapp123' }, { scopes: [...FILE_SCOPES, 'sharing.write'] }, { scopes: FILE_SCOPES.slice(1) }]) assert.throws(() => validateFilesConnection({ ...cfg(), ...change }))
})
test('concrete endpoint metadata may omit tag, union responses still require it', async () => {
  assert.equal(metadata(concrete(file()), 'file').type, 'file')
  assert.equal(metadata(concrete(folder()), 'folder').type, 'folder')
  assert.throws(() => metadata(concrete(file())), code('INVALID_PROVIDER_RESPONSE'))
  assert.throws(() => metadata(folder(), 'file'), code('INVALID_PROVIDER_RESPONSE'))
  const { service } = fixture()
  assert.equal((await service.mkdir('/New')).type, 'folder')
  assert.equal((await service.upload('/new.txt', Buffer.from('hello'))).type, 'file')
})
test('connection file loader handles missing, bounded size and hardlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-files-test-'))
  try {
    await chmod(dir, 0o700); assert.equal(await loadFilesConnection(dir), null)
    const p = join(dir, 'dropbox-files.json')
    await writeFile(p, JSON.stringify(cfg()), { mode: 0o600 })
    assert.equal((await loadFilesConnection(dir)).purpose, 'nav-files')
    await link(p, join(dir, 'other')); await assert.rejects(loadFilesConnection(dir), code('INVALID_CONNECTION'))
    await rm(join(dir, 'other')); await writeFile(p, 'x'.repeat(32769))
    await assert.rejects(loadFilesConnection(dir), code('INVALID_CONNECTION'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('Linux private connection rejects permissive files and symlinks', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-files-private-'))
  try {
    const p = join(dir, 'dropbox-files.json'), original = join(dir, 'private.json')
    await writeFile(p, JSON.stringify(cfg()), { mode: 0o644 })
    await assert.rejects(loadFilesConnection(dir), code('INVALID_CONNECTION'))
    await rm(p); await writeFile(original, JSON.stringify(cfg()), { mode: 0o600 }); await symlink(original, p)
    await assert.rejects(loadFilesConnection(dir), code('INVALID_CONNECTION'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('range parsing supports seek and suffix; rejects invalid/multiple ranges', () => {
  assert.deepEqual(downloadRange('bytes=1-3', 10), { start: 1, end: 3 })
  assert.deepEqual(downloadRange('bytes=3-', 10), { start: 3, end: 9 })
  assert.deepEqual(downloadRange('bytes=-3', 10), { start: 7, end: 9 })
  assert.deepEqual(downloadRange('bytes=0-999', 10), { start: 0, end: 9 })
  for (const r of ['bytes=10-', 'bytes=-0', 'bytes=9-2', 'bytes=0-1,3-4', 'bytes=9007199254740999-']) assert.throws(() => downloadRange(r, 10), code('INVALID_RANGE'))
})
test('listing hides protected files and locks ancestors; moved backup stays protected', async () => {
  const { service } = fixture({ anchor: folder('/MovedBackup'), listing: { entries: [folder('/Apps', 'id:apps'), folder(), folder('/MovedBackup'), file('/Apps/Backup/secret'), file('/MovedBackup/secret'), file()], has_more: false } })
  const result = await service.list()
  assert.equal(result.entries.length, 2); assert.equal(result.entries[0].mutable, false); assert.equal(result.entries[1].mutable, true)
  await assert.rejects(service.list({ path: '/MovedBackup' }), code('BACKUP_PROTECTED'))
})
test('missing backup anchor fails closed before file operations', async () => {
  const { service, calls } = fixture({ anchor: file('/Backup', { id: 'id:backup' }) })
  await assert.rejects(service.list(), code('BACKUP_PROTECTION_UNAVAILABLE'))
  assert.equal(calls.length, 1)
})
test('list/search/pagination use bounded nonrecursive metadata requests', async () => {
  const { service, calls } = fixture()
  await service.list(); assert.equal(calls.at(-1).arg.recursive, false); assert.equal(calls.at(-1).arg.limit, 100)
  await service.list({ query: 'notes' }); assert.equal(calls.at(-1).arg.options.filename_only, true)
  await service.list({ cursor: 'SYNTHETIC_CURSOR' }); assert.equal(calls.at(-1).route, 'files/list_folder/continue')
  await assert.rejects(service.list({ query: 'a'.repeat(201) }), code('INVALID_QUERY'))
})
test('mkdir/move/upload cannot enter backup paths or change backup ancestors', async () => {
  const { service, uploads } = fixture()
  await assert.rejects(service.mkdir('/Apps/Backup/x'), code('BACKUP_PROTECTED'))
  await assert.rejects(service.move('id:file', '/Apps/Backup/x'), code('BACKUP_PROTECTED'))
  await assert.rejects(service.upload('/Apps/Backup/x', Buffer.from('x')), code('BACKUP_PROTECTED'))
  assert.equal(uploads.length, 0)
  await assert.rejects(fixture({ item: folder('/Apps', 'id:apps') }).service.move('id:apps', '/elsewhere'), code('BACKUP_PROTECTED'))
})
test('move forbids recursive destination and automatic overwrite/ownership transfer', async () => {
  const { service, calls } = fixture({ item: folder('/Notes', 'id:notes') })
  await assert.rejects(service.move('id:notes', '/Notes/child'), code('INVALID_DESTINATION'))
  await service.move('id:notes', '/Renamed')
  assert.deepEqual(calls.at(-1).arg, { from_path: 'id:notes', to_path: '/Renamed', autorename: false, allow_shared_folder: false, allow_ownership_transfer: false })
})
test('delete requires exact name/revision, sends parent_rev, never deletes folders', async () => {
  const { service, calls } = fixture()
  await assert.rejects(service.remove('id:file', 'abcdef122', 'notes.txt'), code('FILE_CHANGED'))
  await assert.rejects(service.remove('id:file', 'abcdef123', 'other.txt'), code('FILE_CHANGED'))
  assert.deepEqual(await service.remove('id:file', 'abcdef123', 'notes.txt'), { deleted: true })
  assert.equal(calls.at(-1).arg.parent_rev, 'abcdef123')
  await assert.rejects(fixture({ item: folder('/Notes', 'id:notes') }).service.remove('id:notes', 'abcdef123', 'Notes'), code('FOLDER_DELETE_DISABLED'))
})
test('text reads only bounded valid UTF-8, matching metadata length', async () => {
  assert.equal((await fixture().service.text('id:file')).content, 'hello')
  for (const data of [Buffer.from([255, 255, 255, 255, 255]), Buffer.from([0, 1, 2, 3, 4])]) await assert.rejects(fixture({ data }).service.text('id:file'), code('TEXT_ENCODING_UNSUPPORTED'))
  await assert.rejects(fixture({ data: 'shorter?' }).service.text('id:file'), code('FILE_CHANGED'))
  await assert.rejects(fixture({ item: file('/x.txt', { size: 1048577 }) }).service.text('id:file'), code('TEXT_UNSUPPORTED'))
  await assert.rejects(fixture({ item: file('/x.html') }).service.text('id:file'), code('TEXT_UNSUPPORTED'))
})
test('text saves enforce revision, size and JSON validity before upload', async () => {
  const { service, uploads } = fixture({ item: file('/x.json') })
  await assert.rejects(service.save('id:file', 'abcdef122', '{}'), code('FILE_CHANGED'))
  await assert.rejects(service.save('id:file', 'abcdef123', '{'), code('INVALID_JSON'))
  await assert.rejects(service.save('id:file', 'abcdef123', 'x'.repeat(1048577)), code('TEXT_TOO_LARGE'))
  await service.save('id:file', 'abcdef123', '{"ok":true}')
  assert.equal(uploads.length, 1); assert.equal(uploads[0].rev, 'abcdef123')
})
function clientFixture({ account = 'dbid:TEST', fail, response } = {}) {
  const calls = []
  const client = new DropboxFilesClient(cfg(), { fetchImpl: async (url, options) => {
    calls.push({ url, options })
    assert.equal(options.redirect, 'error')
    if (fail) throw Error('SYNTHETIC_SENSITIVE_TRANSPORT')
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'TEST_ACCESS', expires_in: 3600, token_type: 'bearer', scope: FILE_SCOPES.join(' ') })
    if (url.endsWith('/users/get_current_account')) return json({ account_id: account })
    return response ? response(url, options) : json(file())
  } })
  return { client, calls }
}
test('client refresh is single-flight and validates account before serving files', async () => {
  const { client, calls } = clientFixture()
  await Promise.all([client.rpc('files/get_metadata', { path: 'id:file' }), client.rpc('files/get_metadata', { path: 'id:file' })])
  assert.equal(calls.filter(c => c.url.endsWith('/oauth2/token')).length, 1)
  const bad = clientFixture({ account: 'dbid:WRONG' })
  for (let i = 0; i < 2; i++) await assert.rejects(bad.client.rpc('files/get_metadata', {}), code('ACCOUNT_MISMATCH'))
  assert.equal(bad.calls.filter(c => c.url.includes('/files/')).length, 0)
  assert.equal(bad.calls.filter(c => c.url.endsWith('/oauth2/token')).length, 2)
})
test('client allows only fixed routes, redacts failures and bounds JSON responses', async () => {
  await assert.rejects(clientFixture().client.rpc('https://evil.test', {}), code('INVALID_OPERATION'))
  await assert.rejects(clientFixture({ fail: true }).client.rpc('files/get_metadata', {}), e => e.message === 'PROVIDER_UNAVAILABLE')
  await assert.rejects(clientFixture({ response: () => new Response('SENSITIVE', { status: 409 }) }).client.rpc('files/get_metadata', {}), code('PROVIDER_CONFLICT'))
  await assert.rejects(clientFixture({ response: () => new Response('x'.repeat(2097153)) }).client.rpc('files/get_metadata', {}), code('PROVIDER_RESPONSE_TOO_LARGE'))
})
test('client upload uses ASCII-safe strict add or revision update', async () => {
  const { client, calls } = clientFixture()
  await client.upload('/中文.txt', Buffer.from('hi'))
  let raw = calls.at(-1).options.headers['Dropbox-API-Arg'], arg = JSON.parse(raw)
  assert.ok(/^[\x00-\x7f]*$/.test(raw)); assert.equal(arg.path, '/中文.txt'); assert.deepEqual(arg.mode, { '.tag': 'add' }); assert.equal(arg.strict_conflict, true); assert.equal(arg.autorename, false)
  await client.upload('/中文.txt', Buffer.from('new'), 'abcdef123')
  arg = JSON.parse(calls.at(-1).options.headers['Dropbox-API-Arg']); assert.deepEqual(arg.mode, { '.tag': 'update', update: 'abcdef123' })
})
test('download binds revision and validates range and receipt before returning stream', async () => {
  const raw = file(), meta = metadata(raw)
  const { client, calls } = clientFixture({ response: () => new Response('ell', { status: 206, headers: { 'Dropbox-API-Result': JSON.stringify(concrete(raw)), 'Content-Range': 'bytes 1-3/5', 'Content-Length': '3' } }) })
  assert.equal(await (await client.download(meta, { range: 'bytes=1-3' })).text(), 'ell')
  assert.equal(JSON.parse(calls.at(-1).options.headers['Dropbox-API-Arg']).path, 'rev:abcdef123')
  for (const headers of [{ 'Content-Range': 'bytes 0-2/5' }, { 'Content-Length': '10' }, { 'Dropbox-API-Result': JSON.stringify(file('/other.txt')) }]) {
    const bad = clientFixture({ response: () => new Response('ell', { status: 206, headers: { 'Dropbox-API-Result': JSON.stringify(raw), 'Content-Range': 'bytes 1-3/5', 'Content-Length': '3', ...headers } }) })
    await assert.rejects(bad.client.download(meta, { range: 'bytes=1-3' }))
  }
})
