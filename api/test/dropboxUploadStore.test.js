import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DropboxFileUploads, dropboxContentHash, CHUNK_LIMIT, LARGE_UPLOAD_LIMIT } from '../src/lib/dropboxFileUploads.js'
import { loadUploadStore } from '../src/lib/dropboxUploadStore.js'

const identity = 'a'.repeat(64), code = e => e?.code === 'UPLOAD_STORE_UNAVAILABLE'
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'nav-upload-test-')); await chmod(root, 0o700)
  await mkdir(join(root, 'dropbox-upload-state'), { mode: 0o700 })
  await writeFile(join(root, 'dropbox-uploads.json'), JSON.stringify({ version: 1, enabled: true, key: 'b'.repeat(64) }), { mode: 0o600 })
  let store, failAfterAppend = false, failFinish = false, finished = 0, appendCalls = 0
  let bytes = Buffer.alloc(0)
  const service = { protection: async () => ['/Apps/Backup'], client: {
    getMetadataIfExists: async () => null,
    uploadSession: async (op, arg, chunk) => {
      if (op === 'start') return { session_id: 'PRIVATE_TEST_SESSION' }
      if (op === 'append_v2') {
        appendCalls++
        if (arg.cursor.offset !== bytes.length) return { correctOffset: bytes.length }
        bytes = Buffer.concat([bytes, chunk])
        if (failAfterAppend) { failAfterAppend = false; throw Error('LOST_RECEIPT') }
        return null
      }
      finished++
      if (failFinish) throw Error('LOST_FINISH_RECEIPT')
      return { id: 'id:uploaded', name: arg.commit.path.slice(1), path_display: arg.commit.path, size: bytes.length, rev: 'abcdef123', server_modified: '2026-09-21T00:00:00Z', content_hash: dropboxContentHash(bytes) }
    }
  } }
  const restart = async () => {
    await store?.close(); store = await loadUploadStore(root)
    return DropboxFileUploads.restore(service, store, identity)
  }
  t.after(async () => { await store?.close(); await rm(root, { recursive: true, force: true }) })
  return { root, service, restart, manager: await restart(), store: () => store,
    loseAppend: () => { failAfterAppend = true }, loseFinish: () => { failFinish = true }, counts: () => ({ finished, appendCalls }) }
}
test('restart resumes the last 1 MiB using encrypted block hashes and the same provider session', async t => {
  const f = await setup(t), data = Buffer.alloc(CHUNK_LIMIT + 1024 * 1024, 73), digest = dropboxContentHash(data)
  const { uploadId } = await f.manager.start('/movie.bin', data.length, digest)
  await f.manager.append(uploadId, 0, data.subarray(0, CHUNK_LIMIT))
  const sealed = await readFile(join(f.root, 'dropbox-upload-state', uploadId + '.json'), 'utf8')
  for (const secret of ['movie.bin', 'PRIVATE_TEST_SESSION', digest, 'IIIIIIIIIIII']) assert.ok(!sealed.includes(secret))
  const next = await f.restart()
  assert.equal((await next.list()).persistence, 'encrypted_disk')
  assert.equal((await next.reattach(uploadId, data.length, digest)).offset, CHUNK_LIMIT)
  await next.append(uploadId, CHUNK_LIMIT, data.subarray(CHUNK_LIMIT))
  assert.equal((await next.finish(uploadId)).state, 'complete')
  const again = await f.restart(); assert.equal((await again.finish(uploadId)).state, 'complete')
  assert.deepEqual(f.counts(), { finished: 1, appendCalls: 2 })
})
test('restart reconciles an accepted append with lost receipt only for identical bytes', async t => {
  const f = await setup(t), data = Buffer.from('fixture'), { uploadId } = await f.manager.start('/file', data.length, dropboxContentHash(data))
  f.loseAppend(); await assert.rejects(f.manager.append(uploadId, 0, data))
  const next = await f.restart()
  await assert.rejects(next.append(uploadId, 0, Buffer.from('changed')), e => e.code === 'INVALID_CHUNK')
  assert.equal((await next.append(uploadId, 0, data)).offset, data.length)
  assert.equal((await next.finish(uploadId)).state, 'complete')
})
test('restart never repeats uncertain finish or cancels its cloud file', async t => {
  const f = await setup(t), { uploadId } = await f.manager.start('/empty', 0, dropboxContentHash(Buffer.alloc(0)))
  f.loseFinish(); await assert.rejects(f.manager.finish(uploadId))
  const next = await f.restart(); assert.equal(next.status(uploadId).state, 'review')
  await assert.rejects(next.finish(uploadId), e => e.code === 'UPLOAD_REVIEW_REQUIRED')
  assert.throws(() => next.cancel(uploadId), e => e.code === 'UPLOAD_REVIEW_REQUIRED')
  assert.equal(f.counts().finished, 1)
})
test('failed durable intent prevents sending a chunk and poisons this writer until restart', async t => {
  const f = await setup(t), { uploadId } = await f.manager.start('/file', 1)
  f.store().write = async () => { throw Error('DISK_FULL_PRIVATE_PATH') }
  await assert.rejects(f.manager.append(uploadId, 0, Buffer.from('a')), code)
  await assert.rejects(f.manager.append(uploadId, 0, Buffer.from('a')), code)
  assert.equal(f.counts().appendCalls, 0)
  const next = await f.restart(); assert.equal(next.status(uploadId).offset, 0)
})
test('failure saving accepted offset replays persisted intent safely after restart', async t => {
  const f = await setup(t), data = Buffer.from('a'), { uploadId } = await f.manager.start('/file', 1)
  const save = f.store().write.bind(f.store()); let writes = 0
  f.store().write = async (...args) => { if (++writes === 2) throw Error('DISK_FULL'); return save(...args) }
  await assert.rejects(f.manager.append(uploadId, 0, data), code)
  const next = await f.restart(); await next.append(uploadId, 0, data); await next.finish(uploadId)
  assert.deepEqual(f.counts(), { finished: 1, appendCalls: 2 })
})
test('cancellation removes metadata durably, never calls provider delete', async t => {
  const f = await setup(t), { uploadId } = await f.manager.start('/cancel', 1)
  assert.equal((await f.manager.cancel(uploadId)).state, 'cancelled')
  assert.equal((await (await f.restart()).list()).entries.length, 0)
  assert.deepEqual(f.counts(), { finished: 0, appendCalls: 0 })
})
test('another connection cannot see or resume previous owner jobs', async t => {
  const f = await setup(t), { uploadId } = await f.manager.start('/private-name', 1, 'c'.repeat(64))
  await f.store().close()
  const other = await loadUploadStore(f.root)
  try {
    const manager = await DropboxFileUploads.restore(f.service, other, 'd'.repeat(64))
    assert.equal((await manager.list()).entries.length, 0)
    assert.throws(() => manager.status(uploadId), e => e.code === 'UPLOAD_EXPIRED')
  } finally { await other.close() }
})
test('expired records are removed during restart without provider writes', async t => {
  const f = await setup(t), { uploadId } = await f.manager.start('/expired', 1, 'c'.repeat(64))
  const saved = await f.store().read(uploadId); saved.job.until = 0; await f.store().write(uploadId, saved)
  const next = await f.restart(); assert.equal((await next.list()).entries.length, 0)
  assert.deepEqual(f.counts(), { finished: 0, appendCalls: 0 })
  assert.equal((await readdir(join(f.root, 'dropbox-upload-state'))).some(f => f.endsWith('.json')), false)
})
test('duplicate writers are refused without deleting the active lock', async t => {
  const f = await setup(t)
  await assert.rejects(loadUploadStore(f.root), code)
  const job = await f.manager.start('/still-valid', 0)
  assert.equal(f.manager.status(job.uploadId).offset, 0)
})
test('an actual exited child process leaves a stale lease that the next API process can reclaim', async t => {
  const f = await setup(t); await f.store().close()
  const script = `import {loadUploadStore} from ${JSON.stringify(new URL('../src/lib/dropboxUploadStore.js', import.meta.url).href)};
    const s = await loadUploadStore(${JSON.stringify(f.root)}); process.exit(s ? 0 : 1);`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 0, 'synthetic child acquires a writer lease before abrupt exit')
  const next = await f.restart(); assert.equal((await next.list()).entries.length, 0)
})
test('tampered ciphertext fails closed without falling back to empty memory mode', async t => {
  const f = await setup(t), { uploadId } = await f.manager.start('/file', 1)
  const path = join(f.root, 'dropbox-upload-state', uploadId + '.json')
  const raw = JSON.parse(await readFile(path, 'utf8')); raw.tag = '0'.repeat(32)
  await writeFile(path, JSON.stringify(raw)); await assert.rejects(f.restart(), code)
})
test('saved invalid offset/block count cannot be used to skip unverified bytes', async t => {
  const f = await setup(t), { uploadId } = await f.manager.start('/file', 10)
  const saved = await f.store().read(uploadId); saved.job.offset = 10
  await f.store().write(uploadId, saved); await assert.rejects(f.restart(), code)
})
test('configured but missing directory is an error; only absent config is memory mode', async t => {
  const f = await setup(t); await f.store().close()
  await rm(join(f.root, 'dropbox-upload-state'), { recursive: true })
  await assert.rejects(loadUploadStore(f.root), code)
  await rm(join(f.root, 'dropbox-uploads.json'))
  assert.equal(await loadUploadStore(f.root), null)
  assert.equal(await loadUploadStore(''), null)
})
test('maximum 50 GiB metadata remains bounded without allocating file contents', async t => {
  const f = await setup(t), { uploadId } = await f.manager.start('/large', LARGE_UPLOAD_LIMIT)
  const saved = await f.store().read(uploadId)
  saved.job.offset = saved.job.size; saved.job.blocks = Array(12800).fill('c'.repeat(64))
  await f.store().write(uploadId, saved)
  const next = await f.restart(); assert.equal(next.status(uploadId).offset, LARGE_UPLOAD_LIMIT)
  assert.ok((await readFile(join(f.root, 'dropbox-upload-state', uploadId + '.json'))).length < 1_300_000)
})
test('Linux private mode and symlink checks reject unsafe storage', { skip: process.platform !== 'linux' }, async t => {
  const f = await setup(t); await f.store().close()
  const config = join(f.root, 'dropbox-uploads.json')
  await chmod(config, 0o644); await assert.rejects(loadUploadStore(f.root), code); await chmod(config, 0o600)
  const real = config + '.real'; await writeFile(real, await readFile(config), { mode: 0o600 }); await rm(config); await symlink(real, config)
  await assert.rejects(loadUploadStore(f.root), code)
})
