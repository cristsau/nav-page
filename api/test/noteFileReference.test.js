import test from 'node:test'
import assert from 'node:assert/strict'
import { noteFileReference } from '../../app/src/modules/files/noteFileReference.js'
test('note reference is a stable authenticated NAV link, not a public cloud URL', () => {
  const item = { id: 'id:synthetic_123', type: 'file', name: '<b>私人图片.png</b>', officialUrl: 'https://dropbox.com/SECRET', path: '/PRIVATE' }
  for (const origin of ['https://nav.cristsau.cn', 'https://nav.skrskr.net']) {
    const reference = noteFileReference(item, origin)
    assert.equal(reference.text, item.name)
    assert.equal(reference.href, origin + '/files?item=id%3Asynthetic_123')
    assert.ok(!JSON.stringify(reference).includes('SECRET')); assert.ok(!JSON.stringify(reference).includes('PRIVATE'))
  }
  for (const id of ['https://evil.example', '../file', 'id:x?token=secret']) assert.throws(() => noteFileReference({ ...item, id }, 'https://nav.cristsau.cn'))
  assert.throws(() => noteFileReference({ ...item, type: 'folder' }, 'https://nav.cristsau.cn'))
})
