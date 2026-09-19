import test from 'node:test'
import assert from 'node:assert/strict'
import { FileTransferQueue } from '../../app/src/modules/files/fileTransfers.js'
const file = (name, size) => Object.assign(new Blob([new Uint8Array(size)]), { name })
const tick = () => new Promise(resolve => setTimeout(resolve, 5))
async function settle(queue) { for (let i = 0; i < 100 && queue.running; i++) await tick(); assert.equal(queue.running, false) }
function harness() {
  const states = [], calls = [], remote = new Map(); let seq = 0
  const queue = new FileTransferQueue({ limit: 100, chunkSize: 4, changed: jobs => states.push(jobs), errorText: () => 'synthetic error',
    action: async (action, body) => {
      calls.push({ action, body })
      if (action === 'upload/start') { const s = { uploadId: String(++seq), offset: 0, size: body.size, chunkSize: 4, state: 'uploading' }; remote.set(s.uploadId, s); return { ...s } }
      const state = remote.get(body.uploadId)
      if (action === 'upload/status') return { ...state }
      if (action === 'upload/finish') { state.state = 'complete'; return { ...state } }
      if (action === 'upload/cancel') return { state: state.state === 'complete' ? 'complete' : 'cancelled' }
    },
    chunk: async (id, offset, bytes) => { calls.push({ action: 'chunk', offset, size: bytes.size }); remote.get(id).offset = offset + bytes.size; return { offset: offset + bytes.size } }
  })
  return { queue, calls, states, remote }
}
test('multi-file queue slices bodies, retains destinations, completes in order and releases file references', async () => {
  const { queue, calls } = harness()
  queue.add([file('a.txt', 9), file('b.txt', 2)], '/Movies'); await settle(queue)
  assert.deepEqual(queue.jobs.map(j => j.state), ['complete', 'complete'])
  assert.deepEqual(calls.filter(c => c.action === 'chunk').map(c => c.size), [4, 4, 1, 2])
  assert.deepEqual(calls.filter(c => c.action === 'upload/start').map(c => c.body.path), ['/Movies/a.txt', '/Movies/b.txt'])
  assert.ok(queue.jobs.every(j => j.file === null)); queue.clearFinished(); assert.equal(queue.jobs.length, 0)
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
