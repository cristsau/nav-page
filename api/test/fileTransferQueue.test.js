import test from 'node:test'
import assert from 'node:assert/strict'
import { FileTransferQueue } from '../../app/src/modules/files/fileTransfers.js'
import { fileContentHash } from '../../app/src/modules/files/fileIdentity.js'
import { dropboxContentHash } from '../src/lib/dropboxFileUploads.js'
const file = (name, size) => Object.assign(new Blob([new Uint8Array(size)]), { name })
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
async function settle(queue) { for (let i = 0; i < 100 && queue.running; i++) await tick(); assert.equal(queue.running, false) }
function harness() {
  const states = [], calls = [], remote = new Map(); let seq = 0
  const queue = new FileTransferQueue({ limit: 100, chunkSize: 4, changed: jobs => states.push(jobs), errorText: () => 'synthetic error',
    action: async (action, body) => {
      calls.push({ action, body })
      if (action === 'upload/start') { const s = { uploadId: (++seq).toString(16).padStart(48, '0'), path: body.path, contentHash: body.contentHash, offset: 0, size: body.size, chunkSize: 4, state: 'uploading' }; remote.set(s.uploadId, s); return { ...s } }
      if (action === 'upload/list') return { entries: [...remote.values()] }
      if (action === 'upload/dismiss') { for (const id of body.ids) remote.delete(id); return { cleared: body.ids } }
      const state = remote.get(body.uploadId)
      if (action === 'upload/status' || action === 'upload/reattach') return { ...state }
      if (action === 'upload/finish') { state.state = 'complete'; return { ...state } }
      if (action === 'upload/cancel') return { state: state.state === 'complete' ? 'complete' : 'cancelled' }
    },
    chunk: async (id, offset, bytes) => { calls.push({ action: 'chunk', offset, size: bytes.size }); remote.get(id).offset = offset + bytes.size; return { offset: offset + bytes.size } }
  })
  return { queue, calls, states, remote }
}
test('browser content hash matches Dropbox across blocks and zero bytes', async () => {
  for (const size of [0, 9, 4 * 1024 * 1024 + 17]) {
    const data = Buffer.alloc(size, 19), blob = new Blob([data])
    assert.equal(await fileContentHash(blob), dropboxContentHash(data))
  }
  await assert.rejects(fileContentHash(new Blob(['x']), { stopped: () => true }), { code: 'UPLOAD_HASH_CANCELLED' })
})
test('refresh recovery requires a matching original and explicit continue; accepted chunks are not repeated', async () => {
  const { queue, calls } = harness(), originalChunk = queue.chunk
  let release
  queue.chunk = async (...args) => { await new Promise(r => { release = r }); return originalChunk(...args) }
  queue.add([file('a.txt', 9)], '')
  while (!release) await tick()
  queue.pause(1); release(); await settle(queue)
  const restored = new FileTransferQueue({ action: queue.action, chunk: originalChunk, limit: 100, chunkSize: 4 })
  queue.dispose(); await restored.recover()
  assert.equal(restored.jobs[0].state, 'awaiting_file'); assert.equal(restored.jobs[0].file, null)
  assert.equal(restored.jobs[0].offset, 4)
  await restored.reselect(1, Object.assign(new Blob(['different']), { name: 'a.txt' }))
  assert.equal(restored.jobs[0].state, 'awaiting_file'); assert.match(restored.jobs[0].error, /内容不一致/)
  await restored.reselect(1, file('a.txt', 9))
  assert.equal(restored.jobs[0].state, 'paused'); assert.equal(calls.filter(c => c.action === 'chunk').length, 1)
  restored.resume(1); await settle(restored)
  assert.equal(restored.jobs[0].state, 'complete')
  assert.deepEqual(calls.filter(c => c.action === 'chunk').map(c => c.offset), [0, 4, 8])
})
test('hash cancellation starts no remote session and leaves no file reference', async () => {
  const { queue, calls } = harness()
  let release
  queue.hash = async (_file, { stopped }) => { await new Promise(r => { release = r }); if (stopped()) throw Object.assign(Error(), { code: 'UPLOAD_HASH_CANCELLED' }) }
  queue.add([file('a.txt', 9)], '')
  while (!release) await tick()
  queue.cancel(1); release(); await settle(queue)
  assert.equal(queue.jobs[0].state, 'cancelled'); assert.equal(queue.jobs[0].file, null)
  assert.equal(calls.length, 0)
})

test('refresh rejects malformed, duplicate and excess jobs atomically', async () => {
  const good = { uploadId: 'a'.repeat(48), path: '/a.txt', size: 9, offset: 4, contentHash: 'b'.repeat(64), state: 'uploading' }
  for (const broken of [null, { ...good, uploadId: '' }, { ...good, path: '/a/../b' }, { ...good, path: '/a\\b' }, { ...good, offset: 10 }, { ...good, size: -1 }, { ...good, contentHash: 9 }, { ...good, state: 'unknown' }]) {
    const { queue } = harness(); queue.action = async () => ({ entries: [{ ...good, uploadId: 'c'.repeat(48) }, broken] })
    await assert.rejects(queue.recover()); assert.equal(queue.jobs.length, 0)
  }
  const { queue } = harness(); queue.action = async () => ({ entries: [good, good] })
  await assert.rejects(queue.recover()); assert.equal(queue.jobs.length, 0)
  queue.action = async () => ({ entries: [good] }); await queue.recover(); await queue.recover(); assert.equal(queue.jobs.length, 1)
  queue.jobs = Array.from({ length: 100 }, (_, id) => ({ id }))
  await assert.rejects(queue.recover()); assert.equal(queue.jobs.length, 100)
})

test('reselected hash can be paused or cancelled before reattaching', async () => {
  for (const operation of ['pause', 'cancel']) {
    const { queue, calls } = harness(), original = file('a.txt', 9)
    await queue.action('upload/start', { path: '/a.txt', size: 9, contentHash: await fileContentHash(original) }); await queue.recover()
    let release
    queue.hash = async (_file, { stopped }) => { await new Promise(r => { release = r }); if (stopped()) throw Object.assign(Error(), { code: 'UPLOAD_HASH_CANCELLED' }) }
    const pending = queue.reselect(1, original)
    while (!release) await tick()
    queue[operation](1); release(); await pending; await settle(queue)
    assert.equal(queue.jobs[0].state, operation === 'pause' ? 'awaiting_file' : 'cancelled')
    assert.equal(queue.jobs[0].file, null); assert.equal(calls.filter(c => c.action === 'upload/reattach').length, 0)
  }
})
test('multi-file queue slices bodies, retains destinations, completes in order and releases file references', async () => {
  const { queue, calls } = harness()
  queue.add([file('a.txt', 9), file('b.txt', 2)], '/Movies'); await settle(queue)
  assert.deepEqual(queue.jobs.map(j => j.state), ['complete', 'complete'])
  assert.deepEqual(calls.filter(c => c.action === 'chunk').map(c => c.size), [4, 4, 1, 2])
  assert.deepEqual(calls.filter(c => c.action === 'upload/start').map(c => c.body.path), ['/Movies/a.txt', '/Movies/b.txt'])
  assert.ok(queue.jobs.every(j => j.file === null)); await queue.clearFinished(); assert.equal(queue.jobs.length, 0)
  await queue.recover(); assert.equal(queue.jobs.length, 0)
})

test('failed completed-record cleanup preserves visible tasks and never dismisses uncertain work', async () => {
  const { queue } = harness()
  queue.add([file('done.txt', 1)], ''); await settle(queue)
  queue.jobs.push({ id: 2, state: 'review', uploadId: 'f'.repeat(48) })
  queue.action = async (action, body) => { assert.equal(action, 'upload/dismiss'); assert.equal(body.ids.length, 1); throw Error('offline') }
  await assert.rejects(queue.clearFinished()); assert.equal(queue.jobs.length, 2)
  assert.equal(queue.clearing, false)
})
test('pause waits for the in-flight chunk, then resumes without duplicating accepted bytes', async () => {
  const { queue, calls } = harness(), original = queue.chunk
  let release
  queue.chunk = async (...args) => { await new Promise(resolve => { release = resolve }); return original(...args) }
  queue.add([file('a.txt', 9)], '')
  while (!release) await tick()
  queue.pause(1); release(); await settle(queue)
  assert.equal(queue.jobs[0].state, 'paused'); assert.equal(queue.jobs[0].offset, 4)
  queue.chunk = original; queue.resume(1); await settle(queue)
  assert.deepEqual(calls.filter(c => c.action === 'chunk').map(c => c.offset), [0, 4, 8])
})
test('failed chunk pauses that task, continues others, and retry uses server acknowledged progress', async () => {
  const { queue } = harness(), original = queue.chunk; let failed = false
  queue.chunk = async (...args) => { if (!failed) { failed = true; throw Error('network') } return original(...args) }
  queue.add([file('first.txt', 5), file('second.txt', 1)], ''); await settle(queue)
  assert.deepEqual(queue.jobs.map(j => j.state), ['error', 'complete'])
  queue.resume(1); await settle(queue); assert.equal(queue.jobs[0].state, 'complete')
})
test('cancelling paused uploads never calls delete and cancelling queued files never starts a session', async () => {
  const { queue, calls } = harness()
  queue.add([file('first.txt', 9), file('next.txt', 1)], ''); queue.cancel(2); await settle(queue)
  assert.equal(queue.jobs[1].state, 'cancelled'); assert.equal(calls.filter(c => c.action === 'upload/start').length, 1)
  assert.ok(calls.every(c => !c.action.includes('delete')))
})
test('queue validates all files before enqueue, caps file counts and does not persist file data', () => {
  const { queue } = harness()
  assert.throws(() => queue.add([file('normal', 1), file('huge', 101)], ''))
  assert.equal(queue.jobs.length, 0)
  assert.throws(() => queue.add([file('../x', 1)], ''))
  assert.throws(() => queue.add(Array.from({ length: 51 }, () => file('x', 1)), ''))
})
