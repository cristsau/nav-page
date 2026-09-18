import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import AdmZip from 'adm-zip'

test('patched ZIP library retains ordinary archive round trips', () => {
  const zip = new AdmZip()
  zip.addFile('folder/sample.txt', Buffer.from('synthetic round trip'))
  assert.equal(new AdmZip(zip.toBuffer()).readAsText('folder/sample.txt'), 'synthetic round trip')
})
for (const method of ['extractAllTo', 'extractEntryTo']) test(`${method} cannot overwrite a file through a destination directory link`, () => {
  const root = mkdtempSync(join(tmpdir(), 'nav-admzip-symlink-test-'))
  try {
    const target = join(root, 'target'), outside = join(root, 'outside')
    mkdirSync(target); mkdirSync(outside)
    writeFileSync(join(outside, 'sentinel.txt'), 'untouched')
    symlinkSync(outside, join(target, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const zip = new AdmZip()
    zip.addFile('linked/sentinel.txt', Buffer.from('must not be written'))
    assert.throws(() => method === 'extractAllTo' ? zip.extractAllTo(target, true) : zip.extractEntryTo('linked/sentinel.txt', target, true, true))
    assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'untouched')
  } finally {
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
    assert.ok(basename(root).startsWith('nav-admzip-symlink-test-'))
    rmSync(resolve(root), { recursive: true, force: true })
  }
})
