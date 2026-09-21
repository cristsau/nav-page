import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, chmod, rm, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inventory, imageSignature, responseFor, capture } from './image-originals.mjs'
const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex'), row = { url: 'https://pic.skrskr.net/file/synthetic.png', size: bytes.length, mime: 'image/png' }
test('original inventory deduplicates, rejects external origins, credential URLs and oversize', () => {
  assert.equal(inventory([row, row]).length, 1)
  for (const patch of [{ url: 'https://evil.test/file/x' }, { url: row.url + '?token=x' }, { url: 'https://a:b@pic.skrskr.net/file/x' }, { size: 11 * 1024 ** 2 }, { mime: 'text/html' }]) assert.throws(() => inventory([{ ...row, ...patch }]))
  assert.throws(() => inventory([row, { ...row, size: 1 }]))
  assert.equal(imageSignature(bytes, row.mime), true); assert.equal(imageSignature(Buffer.from('<html>'), row.mime), false)
})
test('DNS pinning rejects mixed private answers and redirects without forwarding credentials', async () => {
  await assert.rejects(responseFor(row, async () => ['1.1.1.1', '127.0.0.1']), /ADDRESS_BLOCKED/)
  const connect = (_url, options, done) => {
    assert.equal(options.headers.Authorization, undefined)
    options.lookup('pic.skrskr.net', {}, (_error, address) => assert.equal(address, '1.1.1.1'))
    const req = new EventEmitter(); req.end = () => { const r = Readable.from([bytes]); r.statusCode = 302; r.headers = { location: 'http://127.0.0.1' }; done(r) }; return req
  }
  await assert.rejects(responseFor(row, async () => ['1.1.1.1'], connect), /RESPONSE_INVALID/)
})
test('original-byte manifest is produced only after complete verified bounded files', async () => {
  for (const mode of ['valid', 'truncated', 'wrong-type', 'disk']) {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'nav-originals-')); await chmod(directory, 0o700)
    try {
      const run = () => capture([row], directory, { fetch: async () => Readable.from([mode === 'truncated' ? bytes.subarray(0, 4) : mode === 'wrong-type' ? Buffer.alloc(bytes.length) : bytes]), disk: async () => ({ bavail: mode === 'disk' ? 0 : 4 * 1024 ** 3, bsize: 1 }) })
      if (mode === 'valid') { assert.equal((await run()).count, 1); const m = JSON.parse(await readFile(join(directory, 'originals-manifest.json'))); assert.match(m.entries[0].sha256, /^[a-f0-9]{64}$/); assert.deepEqual(await readFile(join(directory, m.entries[0].file)), bytes); await assert.rejects(run()) }
      else { await assert.rejects(run()); await assert.rejects(readFile(join(directory, 'originals-manifest.json')), { code: 'ENOENT' }) }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})
