import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('browser extension uses least-privilege default access and exposes quick add', async () => {
  const manifestUrl = new URL('../../extension/manifest.json', import.meta.url)
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))

  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.version, '1.1.0')
  assert.deepEqual(manifest.host_permissions, ['https://nav.skrskr.net/*'])
  assert.equal(manifest.permissions.includes('notifications'), false)
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'))
  assert.ok(manifest.commands['quick-add-last-group'])
})
