import test from 'node:test'
import assert from 'node:assert/strict'
import { OfflineDownloads, OFFLINE_LIMIT } from '../src/lib/offlineDownloads.js'
import { torrentMetadata } from '../src/lib/offlineMediaPolicy.js'
import { ariaArgs, probe } from '../../scripts/offline/media-runner.mjs'
import { MediaClient } from '../../scripts/offline/media-client.mjs'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40)
function fixture() {
  let data = { jobs: [] }
  const store = { read: async () => structuredClone(data), write: async v => { data = structuredClone(v) } }
  const item = { id: 'id:synthetic', rev: 'abc123', kind: 'video', size: 10, downloadable: true }
  const service = { get: async () => item, protection: async () => ['/Apps/Backup'], client: {
    getMetadataIfExists: async () => null, download: async (_item, { range }) => { assert.equal(range, 'bytes=0-9'); return new Response(Buffer.alloc(10)) }
  } }
  const manager = new OfflineDownloads({ store, service, identity: 'test', uploads: {} })
  return { manager, store, item, service }
}
test('new media jobs fail closed until a fresh capable worker; legacy workers cannot claim them', async () => {
  const { manager } = fixture(), input = { kind: 'magnet', url: magnet, destination: '/synthetic.mp4' }
  await assert.rejects(manager.add(input), { code: 'MEDIA_WORKER_UNAVAILABLE' })
  await manager.claim({ bt: true }); const job = await manager.add(input)
  assert.equal((await manager.claim()).job, null)
  const claimed = (await manager.claim({ bt: true })).job
  assert.equal(claimed.id, job.id); assert.equal(claimed.kind, 'magnet')
  assert.ok(!JSON.stringify(await manager.status()).includes('urn:btih'))
  manager.lastSeen = 0; assert.equal((await manager.status()).media.bt, false)
})
test('magnet metadata is checked, explicitly selected and blocks the serial queue', async () => {
  const { manager } = fixture(); await manager.claim({ bt: true })
  const job = await manager.add({ kind: 'magnet', url: magnet, destination: '/one.mp4' }); await manager.claim({ bt: true })
  const metadata = { infoHash: 'a'.repeat(40), total: 10, files: [{ index: 1, path: 'a.mp4', size: 5 }, { index: 2, path: 'b.mp4', size: 5 }] }
  await assert.rejects(manager.progress(job.id, { state: 'selecting', metadata: { ...metadata, infoHash: 'b'.repeat(40) } }))
  await manager.progress(job.id, { state: 'selecting', metadata })
  await manager.add({ kind: 'http', url: 'https://example.test/f', destination: '/second' })
  assert.equal((await manager.claim({ bt: true })).job, null)
  await assert.rejects(manager.select(job.id, 3)); await manager.select(job.id, 2)
  assert.equal((await manager.claim({ bt: true })).job.selection, 2)
  await assert.rejects(manager.select(job.id, 1))
})
test('video reads are scoped to current job and immutable revision; no arbitrary worker file proxy', async () => {
  const { manager, item } = fixture(); await manager.claim({ video: true })
  const job = await manager.add({ kind: 'video', sourceId: item.id, sourceRev: item.rev, destination: '/compatible.mp4' })
  await assert.rejects(manager.source(job.id, 0, 10), { code: 'OFFLINE_PAUSED' })
  await manager.claim({ video: true }); assert.equal((await manager.source(job.id, 0, 10)).length, 10)
  await assert.rejects(manager.source(job.id, 0, 11), { code: 'INVALID_RANGE' })
  item.rev = 'changed'; await assert.rejects(manager.source(job.id, 0, 10), { code: 'FILE_CHANGED' })
  await manager.control(job.id, 'pause'); await assert.rejects(manager.source(job.id, 0, 10), { code: 'OFFLINE_PAUSED' })
  await assert.rejects(manager.source('other', 0, 10), { code: 'OFFLINE_JOB_MISSING' })
})
test('BT args disable local discovery/RPC/seeding and constrain resources; video rejects giant/missing dimensions', async () => {
  const args = ariaArgs('/var/lib/nav-media/' + 'a'.repeat(32))
  for (const value of ['--enable-rpc=false', '--bt-enable-lpd=false', '--seed-time=0', '--max-overall-upload-limit=64K', '--max-overall-download-limit=2M', '--no-conf=true']) assert.ok(args.includes(value))
  const run = value => async () => JSON.stringify(value)
  for (const width of [undefined, -1, 5000]) await assert.rejects(probe('/source', null, run({ format: { duration: '3' }, streams: [{ codec_type: 'video', width, height: 320 }] })))
})
test('media capabilities expire, fail closed on damaged state, and do not reveal file data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nav-media-caps-')); await chmod(root, 0o700)
  try {
    const client = new MediaClient(root); assert.deepEqual(await client.capabilities(), { bt: false, video: false })
    await writeFile(join(root, 'bt-ready.json'), JSON.stringify({ version: 1, kind: 'bt', at: Date.now() }), { mode: 0o600 })
    await writeFile(join(root, 'video-ready.json'), JSON.stringify({ version: 1, kind: 'video', at: Date.now() - 20000 }), { mode: 0o600 })
    assert.deepEqual(await client.capabilities(), { bt: true, video: false }); assert.throws(() => client.file('../secret'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
