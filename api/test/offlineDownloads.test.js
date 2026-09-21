import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import routes from '../src/routes/offlineDownloads.js'
import { downloadUrl, OfflineDownloads, EncryptedOfflineStore, loadOfflineConfig, OFFLINE_LIMIT } from '../src/lib/offlineDownloads.js'
const key = 'a'.repeat(64), owner = 'owner-test', hash = 'b'.repeat(64)
function fixture() {
  let data = { jobs: [] }, fail = false, offset = 0, finished = 0
  const calls = [], store = { read: async () => structuredClone(data), write: async value => { if (fail) throw Error('DISK_FULL'); data = structuredClone(value) } }
  const uploads = {
    start: async (path, size, contentHash) => { calls.push({ op: 'start', path, size, contentHash }); return { uploadId: 'upload-fixture', offset: 0, state: 'uploading' } },
    reattach: async () => ({ offset, state: 'uploading' }),
    append: async (_id, start, bytes) => { assert.equal(offset, start); offset += bytes.length; return { offset } },
    finish: async () => { finished++; return { state: 'complete' } }
  }
  const service = { protection: async () => ['/Apps/Backup'], client: { getMetadataIfExists: async () => null } }
  const manager = new OfflineDownloads({ store, service, uploads, identity: 'connection-one' })
  return { manager, store, calls, uploads, service, setFail: () => { fail = true }, finishes: () => finished }
}
const add = manager => manager.add({ url: 'https://example.com/synthetic?private=value', destination: '/movie.bin' })
test('offline URL input rejects credentials, alternate ports, schemes, whitespace and overlong URLs', () => {
  assert.equal(downloadUrl('https://example.com/file?token=synthetic'), 'https://example.com/file?token=synthetic')
  for (const url of ['file:///etc/passwd', 'magnet:?x=y', 'http://user:pass@example.com/f', 'https://example.com:8443/f', 'http://localhost/x', 'https://example.com/a#x', 'https://example.com/a\nb', 'x'.repeat(8200)]) assert.throws(() => downloadUrl(url))
})
test('queue separates identity, hides signed URLs, refuses protected and conflicting destinations', async () => {
  const { manager, store } = fixture(), job = await add(manager)
  assert.equal(job.state, 'queued'); assert.equal(JSON.stringify(await manager.status()).includes('private=value'), false)
  await assert.rejects(add(manager), { code: 'TARGET_EXISTS' })
  await assert.rejects(manager.add({ url: 'https://example.com/f', destination: '/Apps/Backup/movie.bin' }), { code: 'BACKUP_PROTECTED' })
  manager.identity = 'different'; assert.equal((await manager.status()).entries.length, 0)
  await assert.rejects(manager.control(job.id, 'cancel'), { code: 'OFFLINE_JOB_MISSING' })
  assert.equal((await store.read()).jobs.length, 1)
})
test('serialized queue caps active tasks and rejects duplicate concurrent destinations', async () => {
  const { manager } = fixture()
  const results = await Promise.allSettled([add(manager), add(manager)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  for (let i = 1; i < 10; i++) await manager.add({ url: 'https://example.com/f', destination: '/file-' + i })
  await assert.rejects(manager.add({ url: 'https://example.com/f', destination: '/excess' }), { code: 'OFFLINE_QUEUE_FULL' })
})
test('worker claims one job, honors pause/resume/cancel and never deletes cloud files', async () => {
  const { manager } = fixture(), job = await add(manager)
  assert.equal((await manager.claim()).job.id, job.id); assert.equal((await manager.claim()).job.id, job.id)
  await manager.control(job.id, 'pause')
  await assert.rejects(manager.transfer(job.id, 'start', { size: 3, contentHash: hash }), { code: 'OFFLINE_PAUSED' })
  assert.equal((await manager.progress(job.id, { state: 'paused', downloaded: 2, size: 3 })).state, 'paused')
  await manager.control(job.id, 'resume'); assert.equal((await manager.claim()).job.id, job.id)
  await manager.control(job.id, 'cancel'); await manager.progress(job.id, { state: 'cancelled' })
  assert.equal((await manager.status()).entries[0].state, 'cancelled'); assert.equal((await manager.claim()).job, null)
})

test('unclaimed cancelled tasks can be cleared; claimed cancellation waits for worker cleanup', async () => {
  const { manager } = fixture(), one = await add(manager)
  await manager.control(one.id, 'cancel'); await manager.clear(); assert.equal((await manager.status()).entries.length, 0)
  const two = await add(manager); await manager.claim(); await manager.control(two.id, 'cancel'); await manager.progress(two.id, { state: 'cancelled' })
  await manager.clear(); assert.equal((await manager.status()).entries.length, 1)
  await manager.progress(two.id, { cleaned: true }); await manager.clear(); assert.equal((await manager.status()).entries.length, 0)
})
test('upload uses exact queued destination, durable commit marker and explicit cleanup acknowledgement', async () => {
  const { manager, calls, store } = fixture(), job = await add(manager); await manager.claim()
  await assert.rejects(manager.transfer(job.id, 'start', { size: OFFLINE_LIMIT + 1, contentHash: hash }), { code: 'INVALID_UPLOAD' })
  await manager.transfer(job.id, 'start', { size: 3, contentHash: hash, destination: '/forged' })
  assert.equal(calls[0].path, '/movie.bin')
  assert.equal((await manager.transfer(job.id, 'chunk', { offset: 0 }, Buffer.from('abc'))).offset, 3)
  await manager.transfer(job.id, 'finish', {})
  assert.equal((await manager.status()).entries[0].state, 'complete'); assert.equal((await store.read()).jobs[0].url, null)
  await assert.rejects(manager.control(job.id, 'cancel'), { code: 'OFFLINE_REVIEW_REQUIRED' })
  await manager.clear(); assert.equal((await manager.status()).entries.length, 1)
  await manager.progress(job.id, { cleaned: true }); await manager.clear(); assert.equal((await manager.status()).entries.length, 0)
})
test('commit failure or process interruption is held for review, not retried', async () => {
  for (const mode of ['throw', 'restart']) {
    const { manager, store, uploads } = fixture(), job = await add(manager); await manager.claim()
    await manager.transfer(job.id, 'start', { size: 0, contentHash: hash })
    if (mode === 'throw') { uploads.finish = async () => { throw Error('UNKNOWN_NETWORK_RESULT') }; await assert.rejects(manager.transfer(job.id, 'finish', {})) }
    else { const data = await store.read(); data.jobs[0].state = 'committing'; await store.write(data); assert.equal((await manager.claim()).job, null) }
    assert.equal((await manager.status()).entries[0].state, 'review')
    await assert.rejects(manager.control(job.id, 'resume'), { code: 'OFFLINE_REVIEW_REQUIRED' })
  }
})
test('state write failure blocks download commit and does not report success', async () => {
  const { manager, setFail, finishes } = fixture(), job = await add(manager); await manager.claim()
  await manager.transfer(job.id, 'start', { size: 0, contentHash: hash }); setFail()
  await assert.rejects(manager.transfer(job.id, 'finish', {})); assert.equal(finishes(), 0)
  await assert.rejects(manager.claim(), { code: 'OFFLINE_STATE_INVALID' })
})

test('reattach reconciles queue state with durable upload cursor and preserves unknown commit review', async () => {
  const { manager, uploads, store } = fixture(), job = await add(manager); await manager.claim()
  await manager.transfer(job.id, 'start', { size: 3, contentHash: hash })
  await manager.progress(job.id, { state: 'error', error: 'NETWORK_FAILED' })
  await manager.control(job.id, 'resume'); await manager.claim()
  uploads.reattach = async () => ({ state: 'uploading', offset: 2 })
  await manager.transfer(job.id, 'start', { size: 3, contentHash: hash })
  assert.equal((await store.read()).jobs[0].uploaded, 2)
  assert.equal((await store.read()).jobs[0].state, 'uploading')
  uploads.reattach = async () => ({ state: 'review', offset: 3 })
  await manager.transfer(job.id, 'start', { size: 3, contentHash: hash })
  assert.equal((await manager.status()).entries[0].state, 'review')
  await manager.progress(job.id, { state: 'error', error: 'NETWORK_FAILED' })
  assert.equal((await manager.status()).entries[0].state, 'review')
  await assert.rejects(manager.transfer(job.id, 'finish', {}), { code: 'OFFLINE_PAUSED' })
})

test('concurrent route initialization opens one manager and closes its upload lease', async () => {
  const app = Fastify({ logger: false }); let created = 0, closed = 0
  const { manager } = fixture(); manager.uploads.store = { close: async () => { closed++ } }
  app.decorate('requireAdmin', async req => { req.currentUser = { id: owner } })
  await app.register(routes, { loadConfig: () => ({ workerKey: key, maxBytes: OFFLINE_LIMIT }), loadConnection: () => ({ ownerUserId: owner }),
    createService: () => ({}), createManager: async () => { created++; await new Promise(r => setTimeout(r, 20)); return manager } })
  try {
    const results = await Promise.all(Array.from({ length: 3 }, () => app.inject('/offline-downloads/status')))
    assert.ok(results.every(r => r.statusCode === 200)); assert.equal(created, 1)
    assert.ok(results.every(r => r.json().uploadPersistence === 'encrypted_disk'))
  } finally { await app.close() }
  assert.equal(closed, 1)
})
test('encrypted state persists, hides URLs, rejects tampering and key changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-offline-')); await chmod(dir, 0o700)
  try {
    const store = new EncryptedOfflineStore(dir, key); await assert.rejects(store.read(), { code: 'OFFLINE_STATE_INVALID' })
    const data = { jobs: [{ url: 'https://example.com/SECRET_SYNTHETIC_URL' }] }; await store.write(data)
    assert.equal((await readFile(join(dir, 'offline-jobs.json'), 'utf8')).includes('SECRET_SYNTHETIC_URL'), false)
    assert.deepEqual(await new EncryptedOfflineStore(dir, key).read(), data)
    await assert.rejects(new EncryptedOfflineStore(dir, 'b'.repeat(64)).read())
    await writeFile(join(dir, 'offline-jobs.json'), '{"tampered":true}', { mode: 0o600 }); await assert.rejects(store.read())
    assert.equal(await loadOfflineConfig(dir), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('offline routes keep owner APIs and narrow worker credentials separate', async () => {
  const { manager } = fixture(), app = Fastify({ logger: false })
  app.decorate('requireAdmin', async (req, reply) => { if (req.headers['x-role'] !== 'admin') { reply.code(401); throw Error('DENIED') } req.currentUser = { id: req.headers['x-owner'] } })
  await app.register(routes, { prefix: '/api', loadConfig: () => ({ version: 1, enabled: true, workerKey: key, maxBytes: OFFLINE_LIMIT }),
    loadConnection: () => ({ ownerUserId: owner }), createService: () => ({}), createManager: () => manager })
  try {
    for (const path of ['status', 'add', 'control', 'clear']) {
      const options = { url: '/api/offline-downloads/' + path, method: path === 'status' ? 'GET' : 'POST' }
      assert.equal((await app.inject(options)).statusCode, 401)
      assert.equal((await app.inject({ ...options, headers: { 'x-role': 'admin', 'x-owner': 'other' } })).statusCode, 403)
      assert.equal((await app.inject({ ...options, headers: { authorization: 'Bearer ' + key } })).statusCode, 401)
    }
    for (const path of ['claim', 'progress', 'start', 'finish']) {
      const options = { url: '/api/offline-downloads/worker/' + path, method: 'POST', payload: {} }
      assert.equal((await app.inject(options)).statusCode, 403)
      assert.equal((await app.inject({ ...options, headers: { 'x-role': 'admin', 'x-owner': owner } })).statusCode, 403)
      assert.equal((await app.inject({ ...options, headers: { authorization: 'Bearer ' + key, origin: 'https://example.com' } })).statusCode, 403)
    }
    assert.equal((await app.inject({ url: '/api/offline-downloads/worker/claim', method: 'POST', payload: {}, headers: { authorization: 'Bearer ' + key } })).statusCode, 200)
  } finally { await app.close() }
})
