import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile, readFile, lstat, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publicAddress, parseUrl, pinnedTarget, downloadResponse } from './safe-download.mjs'
import { contentHash, DownloadWorker } from './worker.mjs'
import { dropboxContentHash } from '../../api/src/lib/dropboxFileUploads.js'
test('download target rejects private, mapped, linklocal, reserved and infrastructure addresses', async () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.2', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', '172.81.57.10', '15.204.56.108', '192.0.2.1']) assert.equal(publicAddress(address), false, address)
  assert.equal(publicAddress('1.1.1.1'), true)
  for (const url of ['https://user:secret@example.com/a', 'ftp://example.com/a', 'https://example.com:9119/a', 'http://localhost/a', 'http://2130706433/a', 'http://127.1/a']) {
    await assert.rejects(pinnedTarget(url, async () => ['127.0.0.1']))
  }
  await assert.rejects(pinnedTarget('https://example.com/f', async () => ['1.1.1.1', '127.0.0.1']))
  assert.equal((await pinnedTarget('https://example.com/f', async () => ['1.1.1.1'])).address, '1.1.1.1')
  assert.throws(() => parseUrl('https://example.com/a\r\nHeader:x'))
})
function connector(responses, calls) {
  return (url, options, callback) => {
    calls.push({ url: url.href, options }); const req = new EventEmitter()
    req.end = () => queueMicrotask(() => { const value = responses.shift(), response = Readable.from([Buffer.from('abc')]); Object.assign(response, value); callback(response) })
    req.destroy = e => req.emit('error', e)
    return req
  }
}
test('HTTP source pins DNS and checks every redirect, disallows downgrades and HTML', async () => {
  const calls = [], resolve = async host => host === 'unsafe.test' ? ['127.0.0.1'] : ['1.1.1.1']
  await assert.rejects(downloadResponse('https://example.com/f', { resolve, connect: connector([{ statusCode: 302, headers: { location: 'https://unsafe.test/x' } }], calls) }), /UNSAFE_DOWNLOAD_HOST/)
  assert.equal(calls.length, 1)
  calls[0].options.lookup('example.com', { all: true }, (_err, values) => assert.deepEqual(values, [{ address: '1.1.1.1', family: 4 }]))
  await assert.rejects(downloadResponse('https://example.com/f', { resolve, connect: connector([{ statusCode: 302, headers: { location: 'http://example.com/x' } }], []) }), /DOWNGRADE/)
  await assert.rejects(downloadResponse('https://example.com/f', { resolve, connect: connector([{ statusCode: 200, headers: { 'content-length': '3', 'content-type': 'text/html' } }], []) }), /NOT_DIRECT/)
})
test('resumed HTTP bytes require exact strong ETag, range and length; 200 restarts cleanly', async () => {
  const resolve = async () => ['1.1.1.1']
  const headers = { 'content-length': '3', 'content-range': 'bytes 3-5/6', etag: '"abc"' }
  const valid = await downloadResponse('https://example.com/f', { offset: 3, etag: '"abc"', resolve, connect: connector([{ statusCode: 206, headers }], []) })
  assert.equal(valid.start, 3); assert.equal(valid.total, 6); valid.response.destroy()
  await assert.rejects(downloadResponse('https://example.com/f', { offset: 3, etag: '"abc"', resolve, connect: connector([{ statusCode: 206, headers: { ...headers, etag: '"changed"' } }], []) }), /RANGE_CHANGED/)
  const fresh = await downloadResponse('https://example.com/f', { offset: 3, etag: '"abc"', resolve, connect: connector([{ statusCode: 200, headers: { 'content-length': '6' } }], []) })
  assert.equal(fresh.start, 0); fresh.response.destroy()
})
test('worker hashes bounded file blocks and generates only scoped temporary filenames', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-worker-')); await chmod(dir, 0o700)
  try {
    const path = join(dir, 'synthetic'), bytes = Buffer.alloc(4 * 1024 * 1024 + 13, 7)
    await writeFile(path, bytes, { mode: 0o600 }); assert.equal(await contentHash(path, bytes.length), dropboxContentHash(bytes))
    const worker = new DownloadWorker({ directory: dir }, async () => {})
    assert.equal(worker.file('a'.repeat(32)), join(dir, 'a'.repeat(32) + '.part'))
    assert.throws(() => worker.file('../anything'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('worker downloads synthetic bytes, uploads verified blocks, and retries lost cleanup acknowledgement without a second commit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-worker-flow-')); await chmod(dir, 0o700)
  const bytes = Buffer.from('synthetic offline fixture'), id = 'c'.repeat(32), calls = [], received = []
  let state = 'downloading', failedAck = false, cleaned = false, finishCount = 0
  const call = async (_c, op, input, chunk) => {
    calls.push(op)
    if (op === 'claim') return { job: cleaned ? null : { id, url: 'https://example.com/synthetic', maxBytes: 6 * 1024 ** 3 } }
    if (op === 'progress') {
      if (input.cleaned && !failedAck) { failedAck = true; throw Error('CONTROL_NETWORK_FAILED') }
      if (input.cleaned) cleaned = true
      return { state, intent: 'run' }
    }
    if (op === 'start') { assert.equal(input.size, bytes.length); assert.equal(input.contentHash, dropboxContentHash(bytes)); return { offset: 0 } }
    if (op === 'chunk') { received.push(Buffer.from(chunk)); return { offset: chunk.length } }
    if (op === 'finish') { finishCount++; state = 'complete'; return { state } }
    throw Error('UNEXPECTED_CALL')
  }
  try {
    const worker = new DownloadWorker({ directory: dir }, call, { disk: async () => ({ bavail: 20 * 1024 ** 3, bsize: 1 }),
      download: async () => ({ response: Readable.from([bytes]), start: 0, total: bytes.length, etag: '"synthetic"' }) })
    await worker.tick(); assert.deepEqual(Buffer.concat(received), bytes); assert.equal(finishCount, 1)
    assert.ok(await lstat(join(dir, 'current.json'))); await assert.rejects(lstat(worker.file(id)), { code: 'ENOENT' })
    await worker.tick(); assert.equal(cleaned, true); assert.equal(finishCount, 1)
    await assert.rejects(lstat(join(dir, 'current.json')), { code: 'ENOENT' })
    assert.equal(calls.filter(op => op === 'start').length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('worker refuses unknown length, oversize, low disk and resumes only with saved strong ETag', async () => {
  for (const mode of ['oversize', 'disk', 'resume', 'cancel']) {
    const dir = await mkdtemp(join(tmpdir(), 'nav-worker-guard-')); await chmod(dir, 0o700)
    const id = 'd'.repeat(32); let final, cleanup = false, starts = 0
    try {
      const worker = new DownloadWorker({ directory: dir }, async (_c, op, value) => {
        if (op === 'claim') return { job: { id, url: 'https://example.com/synthetic', maxBytes: 6 * 1024 ** 3 } }
        if (op === 'progress') { if (value.state) final = value.state; if (value.cleaned) cleanup = true; return { state: 'downloading', intent: mode === 'cancel' ? 'cancel' : 'run' } }
        if (op === 'start') { starts++; throw Error('SYNTHETIC_STOP_BEFORE_UPLOAD') }
        throw Error('UNEXPECTED_CALL')
      }, { disk: async () => ({ bavail: mode === 'disk' ? 100 : 20 * 1024 ** 3, bsize: 1 }), download: async (_url, options) => {
        if (mode === 'resume') { assert.equal(options.offset, 3); assert.equal(options.etag, '"same"') }
        return { response: Readable.from([Buffer.from('def')]), start: mode === 'resume' ? 3 : 0, total: mode === 'oversize' ? 7 * 1024 ** 3 : mode === 'resume' ? 6 : 3, etag: '"same"' }
      } })
      if (mode === 'resume') { await worker.save({ id, size: 6, etag: '"same"', downloaded: false }); await writeFile(worker.file(id), 'abc', { mode: 0o600 }) }
      await worker.tick()
      assert.equal(final, mode === 'cancel' ? 'cancelled' : 'error')
      assert.equal(starts, mode === 'resume' ? 1 : 0)
      if (mode === 'resume') assert.equal(await readFile(worker.file(id), 'utf8'), 'abcdef')
      if (mode === 'cancel') { assert.equal(cleanup, true); await assert.rejects(lstat(worker.file(id)), { code: 'ENOENT' }) }
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
})
