import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, chmod, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadUploadStore } from '../src/lib/dropboxUploadStore.js'
import { DropboxFileUploads, dropboxContentHash, CHUNK_LIMIT } from '../src/lib/dropboxFileUploads.js'
import { OfflineDownloads, EncryptedOfflineStore } from '../src/lib/offlineDownloads.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nav-offline-upload-')); await chmod(root, 0o700)
  for (const [cfg, state, key] of [['dropbox-uploads.json', 'dropbox-upload-state', 'a'], ['dropbox-offline-uploads.json', 'dropbox-offline-upload-state', 'b']]) {
    await mkdir(join(root, state), { mode: 0o700 })
    await writeFile(join(root, cfg), JSON.stringify({ version: 1, enabled: true, key: key.repeat(64) }), { mode: 0o600 })
  }
  let received = Buffer.alloc(0), starts = 0, finishes = 0, loseAppend = false, store, web
  const service = { protection: async () => ['/Apps/Backup'], client: {
    getMetadataIfExists: async () => null,
    uploadSession: async (op, args, bytes) => {
      if (op === 'start') { starts++; return { session_id: 'SYNTHETIC_OFFLINE_SESSION' } }
      assert.equal(args.cursor.session_id, 'SYNTHETIC_OFFLINE_SESSION')
      if (op === 'append_v2') {
        if (args.cursor.offset !== received.length) return { correctOffset: received.length }
        received = Buffer.concat([received, bytes])
        if (loseAppend) { loseAppend = false; throw Error('LOST_RECEIPT') }
        return null
      }
      finishes++
      return { id: 'id:fixture', name: 'movie.bin', path_display: '/movie.bin', size: received.length, rev: 'abcdef123',
        server_modified: '2026-09-21T00:00:00Z', content_hash: dropboxContentHash(received) }
    }
  } }
  const queue = new EncryptedOfflineStore(root, 'c'.repeat(64)); await queue.write({ jobs: [] })
  const restart = async (identity = 'd'.repeat(64)) => {
    await store?.close(); store = await loadUploadStore(root, 'offline')
    const uploads = await DropboxFileUploads.restore(service, store, identity)
    return new OfflineDownloads({ service, uploads, store: queue, identity: 'connection-one' })
  }
  // Both namespaces must hold leases concurrently without sharing keys/cursors.
  web = await loadUploadStore(root)
  t.after(async () => { await store?.close(); await web?.close(); await rm(root, { recursive: true, force: true }) })
  return { root, queue, restart, manager: await restart(), lose: () => { loseAppend = true }, counts: () => ({ starts, finishes }), web }
}

test('offline queue resumes same provider session across restart independently of web uploads', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(CHUNK_LIMIT + 19, 41), input = { size: bytes.length, contentHash: dropboxContentHash(bytes) }
  const job = await f.manager.add({ url: 'https://example.com/synthetic', destination: '/movie.bin' }); await f.manager.claim()
  const initial = await f.manager.transfer(job.id, 'start', input)
  await f.manager.transfer(job.id, 'chunk', { offset: 0 }, bytes.subarray(0, CHUNK_LIMIT))
  const sealed = await readFile(join(f.root, 'dropbox-offline-upload-state', initial.uploadId + '.json'), 'utf8')
  assert.ok(!sealed.includes('SYNTHETIC_OFFLINE_SESSION')); assert.ok(!sealed.includes('movie.bin'))
  assert.deepEqual(await f.web.load(), [])
  const next = await f.restart(); assert.equal((await next.status()).uploadPersistence, 'encrypted_disk')
  assert.equal((await next.claim()).job.id, job.id)
  assert.equal((await next.transfer(job.id, 'start', input)).offset, CHUNK_LIMIT)
  await next.transfer(job.id, 'chunk', { offset: CHUNK_LIMIT }, bytes.subarray(CHUNK_LIMIT))
  assert.equal((await next.transfer(job.id, 'finish', {})).state, 'complete')
  assert.deepEqual(f.counts(), { starts: 1, finishes: 1 })
})

test('lost append receipt is reconciled after offline restart without creating another session', async t => {
  const f = await fixture(t), bytes = Buffer.from('synthetic'), input = { size: bytes.length, contentHash: dropboxContentHash(bytes) }
  const job = await f.manager.add({ url: 'https://example.com/synthetic', destination: '/movie.bin' }); await f.manager.claim()
  await f.manager.transfer(job.id, 'start', input); f.lose()
  await assert.rejects(f.manager.transfer(job.id, 'chunk', { offset: 0 }, bytes))
  const next = await f.restart(); assert.equal((await next.transfer(job.id, 'start', input)).offset, 0)
  await assert.rejects(next.transfer(job.id, 'chunk', { offset: 0 }, Buffer.from('different')), { code: 'INVALID_CHUNK' })
  await next.transfer(job.id, 'chunk', { offset: 0 }, bytes)
  await next.transfer(job.id, 'finish', {}); assert.deepEqual(f.counts(), { starts: 1, finishes: 1 })
})

test('configured offline store corruption fails closed and never changes the web namespace', async t => {
  const f = await fixture(t)
  await assert.rejects(loadUploadStore(f.root, '../web'), { code: 'UPLOAD_STORE_UNAVAILABLE' })
  await writeFile(join(f.root, 'dropbox-offline-uploads.json'), '{}', { mode: 0o600 })
  await assert.rejects(f.restart(), { code: 'UPLOAD_STORE_UNAVAILABLE' })
  assert.deepEqual(await f.web.load(), [])
})
