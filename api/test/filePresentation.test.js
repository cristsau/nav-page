import test from 'node:test'
import assert from 'node:assert/strict'
import { presentFiles, fileCategory, fileTypeLabel, droppedFiles, hasFileDrag } from '../../app/src/modules/files/filePresentation.js'
const file = (name, extra = {}) => ({ id: name, name, type: 'file', kind: 'file', ...extra })
const source = [file('10.txt', { kind: 'text', size: 100, modified: '2026-02-01T00:00:00Z' }), file('2.txt', { kind: 'text', size: 10, modified: '2026-01-01T00:00:00Z' }), file('3', { type: 'folder' }), file('1', { type: 'folder' }), file('unknown')]
test('name ordering is natural, folder-first in either direction and nonmutating', () => {
  const before = structuredClone(source)
  assert.deepEqual(presentFiles(source).map(i => i.name), ['1', '3', '2.txt', '10.txt', 'unknown'])
  assert.deepEqual(presentFiles(source, 'all', 'name-desc').map(i => i.name), ['3', '1', 'unknown', '10.txt', '2.txt'])
  assert.deepEqual(source, before)
})
test('date/size keep folders first, unknown values last and ties deterministic', () => {
  for (const field of ['modified', 'size']) {
    assert.deepEqual(presentFiles(source, 'all', field + '-desc').map(i => i.name), ['1', '3', '10.txt', '2.txt', 'unknown'])
    assert.deepEqual(presentFiles(source, 'all', field + '-asc').map(i => i.name), ['1', '3', '2.txt', '10.txt', 'unknown'])
  }
  const ties = [file('X', { id: 'b', size: 0 }), file('x', { id: 'a', size: 0 })]
  assert.deepEqual(presentFiles(ties, 'all', 'size-asc').map(i => i.id), ['a', 'b'])
})
test('filters distinguish documents, archives, unknown and folders regardless of extension', () => {
  assert.equal(fileCategory(file('folder.zip', { type: 'folder' })), 'folder')
  for (const kind of ['text', 'office', 'pdf']) assert.equal(fileCategory(file('x', { kind })), 'document')
  for (const ext of ['ZIP', '7z', 'rar', 'tar.gz', 'tgz', 'xz', 'zst']) assert.equal(fileCategory(file('x.' + ext)), 'archive')
  for (const kind of ['image', 'video', 'audio']) assert.equal(fileCategory(file('x', { kind })), kind)
  assert.equal(fileCategory(file('x.svg')), 'other')
  assert.equal(fileTypeLabel(file('x.zip')), '压缩包')
  assert.equal(presentFiles(source, 'document').length, 2)
  assert.equal(presentFiles(source, 'video').length, 0)
  assert.equal(presentFiles(source, 'invalid', 'invalid').length, source.length)
})
const dropItem = (name, entry = { isFile: true }, extra = {}) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => ({ name, size: 0, ...extra }) })
test('file drag detection does not intercept text or links', () => {
  assert.equal(hasFileDrag({ types: ['text/uri-list'], items: [{ kind: 'string' }] }), false)
  assert.equal(hasFileDrag({ types: ['Files'] }), true)
  assert.equal(hasFileDrag({ items: [dropItem('x')] }), true)
  assert.equal(hasFileDrag(null), false)
})
test('drop reads regular files including zero bytes, ignores accompanying text and does not read bodies', () => {
  const result = droppedFiles({ items: [dropItem('empty.txt'), { kind: 'string' }, dropItem('large.mkv', { isFile: true }, { size: 50 * 1024 ** 3 })] })
  assert.deepEqual(result.map(i => i.name), ['empty.txt', 'large.mkv'])
})
test('mixed file/folder drop rejects all instead of silently flattening a tree', () => {
  assert.throws(() => droppedFiles({ items: [dropItem('ok'), dropItem('folder', { isDirectory: true })] }), /文件夹/)
  assert.throws(() => droppedFiles({ items: [dropItem('nested', { isFile: true }, { webkitRelativePath: 'folder/nested' })] }), /原目录结构/)
})
test('unknown directory capability, unreadable/empty and excessive drop fail closed', () => {
  for (const item of [dropItem('x', null), { kind: 'file', getAsFile: () => ({ name: 'unknown' }) }, { ...dropItem('x'), webkitGetAsEntry() { throw Error('denied') } }]) assert.throws(() => droppedFiles({ items: [item] }), /上传文件/)
  assert.throws(() => droppedFiles({ items: [{ ...dropItem('x'), getAsFile: () => null }] }), /本次未加入/)
  assert.throws(() => droppedFiles({ items: [] }), /本机文件/)
  assert.throws(() => droppedFiles({ items: Array.from({ length: 51 }, () => dropItem('x')) }), /50/)
})
