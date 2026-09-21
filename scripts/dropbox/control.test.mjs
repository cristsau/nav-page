import test from 'node:test'
import assert from 'node:assert/strict'
import { BackupController, initialControlState, validateControlState } from './control-core.mjs'
import { createControlServer } from './control-server.mjs'
import { once } from 'node:events'
import { controlOperations } from './control-operations.mjs'
import { join } from 'node:path'

const id = n => String(n).padStart(32, '0')
function fixture(overrides = {}) {
  let stored = initialControlState(), calls = 0, writes = 0, now = new Date('2026-09-21T00:00:00Z')
  let gates = { backup: true, verify: true, download: true, schedule: true }
  const options = { state: stored, save: async s => { stored = structuredClone(s); writes++ },
    execute: async () => { calls++; return { verified: true } }, gates: async () => gates, now: () => now, ...overrides }
  const c = new BackupController(options)
  return { c, stored: () => stored, calls: () => calls, writes: () => writes,
    advance: ms => { now = new Date(+now + ms) }, gate: g => { gates = { ...gates, ...g } }, options }
}
test('durable queued -> running -> verified; exact idempotency receipt survives restart', async () => {
  const f = fixture(), input = { id: id(1), kind: 'backup' }
  await f.c.enqueue(input); assert.equal(f.stored().jobs[0].state, 'queued'); assert.equal(f.calls(), 0)
  await f.c.runNext(); assert.equal(f.calls(), 1); assert.equal(f.stored().jobs[0].state, 'succeeded')
  const reboot = new BackupController({ ...f.options, state: f.stored() }); await reboot.recover()
  assert.equal((await reboot.enqueue(input)).state, 'succeeded'); await reboot.runNext(); assert.equal(f.calls(), 1)
})
test('duplicate concurrent requests produce exactly one job and one execution', async () => {
  const f = fixture(), input = { id: id(1), kind: 'verify', pointId: id(7) }
  await Promise.all(Array.from({ length: 10 }, () => f.c.enqueue(input)))
  await Promise.all(Array.from({ length: 5 }, () => f.c.runNext()))
  assert.equal(f.calls(), 1); assert.equal((await f.c.status()).jobs.length, 1)
})
test('caller cannot submit commands, paths, extra fields, invalid ids or conflicting request ids', async () => {
  const f = fixture()
  for (const input of [{ id: [id(1)], kind: 'backup' }, { id: id(1), kind: 'prune' }, { id: '../etc', kind: 'backup' }, { id: id(1), kind: 'backup', path: '/etc' }, { id: id(1), kind: 'verify' }]) {
    await assert.rejects(f.c.enqueue(input), /INVALID_OPERATION/)
  }
  await f.c.enqueue({ id: id(1), kind: 'backup' })
  await assert.rejects(f.c.enqueue({ id: id(1), kind: 'verify', pointId: id(7) }), /IDEMPOTENCY_CONFLICT/)
  await assert.rejects(f.c.enqueue({ id: id(2), kind: 'backup' }), /BACKUP_BUSY/)
})
test('store error prevents execution and poisons controller, never empty fallback', async () => {
  const f = fixture({ save: async () => { throw new Error('disk') } })
  await assert.rejects(f.c.enqueue({ id: id(1), kind: 'backup' }), /CONTROL_STORE_UNAVAILABLE/)
  await assert.rejects(f.c.runNext(), /CONTROL_STORE_UNAVAILABLE/); assert.equal(f.calls(), 0)
})
test('running intent is durable before side effects; unknown backup failure blocks retry', async () => {
  let f
  f = fixture({ execute: async (_job, stage) => {
    assert.equal(f.stored().jobs[0].state, 'running'); await stage('upload'); assert.equal(f.stored().jobs[0].stage, 'upload')
    throw new Error('provider secret must not escape')
  } })
  await f.c.enqueue({ id: id(1), kind: 'backup' }); await f.c.runNext()
  assert.equal((await f.c.status()).reviewRequired, true)
  assert.ok(!JSON.stringify(await f.c.status()).includes('secret'))
  await assert.rejects(f.c.enqueue({ id: id(2), kind: 'backup' }), /REVIEW_REQUIRED/)
})
test('interrupted running job becomes review on restart, never resumes cloud write', async () => {
  const state = initialControlState()
  state.jobs.push({ id: id(1), kind: 'backup', pointId: null, source: 'manual', state: 'running', stage: 'snapshot',
    code: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const f = fixture({ state }); await f.c.recover(); await f.c.runNext()
  assert.equal((await f.c.status()).jobs[0].code, 'INTERRUPTED_REVIEW_REQUIRED'); assert.equal(f.calls(), 0)
})
test('unverified result is not success; failed read verification is retryable with a new id', async () => {
  const f = fixture({ execute: async () => ({ verified: false }) })
  await f.c.enqueue({ id: id(1), kind: 'verify', pointId: id(7) }); await f.c.runNext()
  assert.equal((await f.c.status()).jobs[0].state, 'failed'); assert.equal((await f.c.status()).reviewRequired, false)
  await f.c.enqueue({ id: id(2), kind: 'verify', pointId: id(7) })
})
test('lost final journal receipt poisons live controller; restart sees running and requires review', async () => {
  let stored = initialControlState()
  const f = fixture({ save: async s => { if (s.jobs[0]?.state === 'succeeded') throw new Error('disk'); stored = structuredClone(s) } })
  await f.c.enqueue({ id: id(1), kind: 'backup' }); await assert.rejects(f.c.runNext(), /CONTROL_STORE_UNAVAILABLE/)
  const reboot = fixture({ state: stored }); await reboot.c.recover()
  assert.equal((await reboot.c.status()).reviewRequired, true)
})
test('schedule cannot enable without verified restore gate, but disabled time can be saved', async () => {
  const f = fixture(); f.gate({ schedule: false })
  await assert.rejects(f.c.setSchedule({ enabled: true, time: '03:45', revision: 0 }), /SCHEDULE_GATE_CLOSED/)
  await f.c.setSchedule({ enabled: false, time: '04:20', revision: 0 })
  assert.equal((await f.c.status()).schedule.time, '04:20')
  await assert.rejects(f.c.setSchedule({ enabled: false, time: '04:21', revision: 0 }), /SCHEDULE_CONFLICT/)
})
test('schedule starts tomorrow, once per Shanghai date and has no multi-day backlog', async () => {
  const f = fixture()
  await f.c.setSchedule({ enabled: true, time: '03:45', revision: 0 })
  assert.equal(await f.c.tick(id(1)), null)
  f.advance(24 * 3600_000)
  await Promise.all([f.c.tick(id(1)), f.c.tick(id(2))]); await f.c.runNext()
  assert.equal(f.calls(), 1); assert.equal(f.stored().schedule.lastDay, '2026-09-22')
  assert.equal(await f.c.tick(id(3)), null)
  f.advance(4 * 24 * 3600_000); await f.c.tick(id(4)); await f.c.runNext()
  assert.equal(f.calls(), 2)
})
test('gates rechecked at execution, disabled schedule cannot launch an already queued job', async () => {
  const f = fixture(); await f.c.setSchedule({ enabled: true, time: '03:45', revision: 0 }); f.advance(86400_000)
  await f.c.tick(id(1)); await f.c.setSchedule({ enabled: false, time: '03:45', revision: 1 }); await f.c.runNext()
  assert.equal(f.calls(), 0); assert.equal(f.stored().jobs[0].state, 'failed')
})
test('corrupt states and multiple in-flight records fail closed', () => {
  assert.throws(() => validateControlState({}), /CONTROL_STATE_INVALID/)
  assert.throws(() => validateControlState({ ...initialControlState(), schedule: { enabled: true, time: '25:00' } }), /CONTROL_STATE_INVALID/)
})
test('history bounded while receipts retained for 72h; older terminal records only are pruned', async () => {
  const f = fixture()
  for (let n = 1; n <= 50; n++) { await f.c.enqueue({ id: id(n), kind: 'backup' }); await f.c.runNext() }
  await assert.rejects(f.c.enqueue({ id: id(51), kind: 'backup' }), /HISTORY_LIMIT/)
  f.advance(73 * 3600_000); await f.c.enqueue({ id: id(51), kind: 'backup' })
  assert.equal(f.stored().jobs.length, 1)
})
async function withServer(fn, streamCiphertext = async (_id, consume) => consume({ bytes: 6 }, async write => {
  await write(Buffer.from('abc')); await write(Buffer.from('def'))
})) {
  const f = fixture(), transport = createControlServer({ controller: f.c, ownerUserId: 'owner', streamCiphertext })
  transport.server.listen(0, '127.0.0.1'); await once(transport.server, 'listening')
  const url = 'http://127.0.0.1:' + transport.server.address().port
  try { await fn({ ...f, ...transport, url, headers: { 'x-nav-owner': 'owner', 'Content-Type': 'application/json' } }) }
  finally { transport.server.closeAllConnections(); await new Promise(r => transport.server.close(r)) }
}
test('socket protocol owner gate, fixed routes and private no-store responses', async () => withServer(async f => {
  assert.equal((await fetch(f.url + '/v1/status')).status, 403)
  const r = await fetch(f.url + '/v1/status', { headers: f.headers }); assert.equal(r.headers.get('cache-control'), 'private, no-store')
  assert.equal((await r.json()).connected, true)
  assert.equal((await fetch(f.url + '/v1/exec', { headers: f.headers })).status, 404)
  const post = () => fetch(f.url + '/v1/jobs', { method: 'POST', headers: f.headers, body: JSON.stringify({ id: id(1), kind: 'backup' }) })
  assert.equal((await post()).status, 202); assert.equal((await post()).status, 202); await f.tick(); assert.equal(f.calls(), 1)
}))
test('ciphertext streams exact length and attachment, no local archive staging', async () => withServer(async f => {
  const r = await fetch(f.url + '/v1/ciphertext/' + id(1), { headers: f.headers })
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /\.tar\.age/); assert.equal(await r.text(), 'abcdef')
}))
test('hash failure withholds last bytes and truncates response, never complete corrupt file', async () => withServer(async f => {
  const r = await fetch(f.url + '/v1/ciphertext/' + id(1), { headers: f.headers })
  await assert.rejects(r.arrayBuffer())
}, async (_id, consume) => consume({ bytes: 6 }, async write => {
  await write(Buffer.from('abc')); await write(Buffer.from('def')); await new Promise(r => setTimeout(r, 20)); throw new Error('bad hash')
})))
test('pre-stream failures are generic JSON, never filesystem or credential diagnostics', async () => withServer(async f => {
  const r = await fetch(f.url + '/v1/ciphertext/' + id(1), { headers: f.headers })
  assert.equal(r.status, 503); assert.equal(r.headers.get('content-length'), null)
  assert.deepEqual(await r.json(), { code: 'CONTROL_UNAVAILABLE' })
}, async () => { throw new Error('secret') }))

test('a task tick reserves execution before awaiting gates; download cannot race the scheduler', async () => withServer(async f => {
  let release
  const wait = new Promise(r => { release = r })
  const oldTick = f.c.tick.bind(f.c)
  f.c.tick = async (...args) => { await wait; return oldTick(...args) }
  const ticking = f.tick()
  try {
    const r = await fetch(f.url + '/v1/ciphertext/' + id(1), { headers: f.headers })
    assert.equal(r.status, 409); assert.deepEqual(await r.json(), { code: 'BACKUP_BUSY' })
  } finally { release(); await ticking }
}))

function operationFixture(options = {}) {
  const calls = [], config = { backupConfig: '/private/backup.json', statusDirectory: '/private/report', allowManual: true, allowDownload: true, allowSchedule: true }
  let made = false, cloud = { pending: [], points: [] }
  const adapter = controlOperations({ config, settings: async () => ({ backupRoot: '/private/snapshots', allowUpload: true }),
    ledger: async () => cloud,
    names: async () => made ? ['unrelated.txt', 'nav-20260921T000000Z-nogit'] : ['unrelated.txt'],
    runSnapshot: async () => { calls.push('snapshot'); made = true },
    backup: async args => { calls.push(args); return { state: args[0] === 'verify' ? 'CIPHERTEXT_VERIFIED' : 'download_verified' } }, ...options })
  return { adapter, calls, config, setLedger: value => { cloud = value } }
}
test('host workflow snapshots first, chooses exactly one new canonical snapshot and publishes result', async () => {
  const f = operationFixture()
  assert.deepEqual(await f.adapter.execute({ kind: 'backup' }, async s => f.calls.push(s)), { verified: true })
  assert.deepEqual(f.calls, ['snapshot', 'upload', ['backup', f.config.backupConfig, join('/private/snapshots', 'nav-20260921T000000Z-nogit')], ['publish-status', f.config.backupConfig, f.config.statusDirectory]])
})
test('ambiguous or missing new snapshot cannot start cloud upload', async () => {
  const f = operationFixture({ names: async () => [] })
  await assert.rejects(f.adapter.execute({ kind: 'backup' }, async () => {}), /snapshot_identity_unknown/)
  assert.equal(f.calls.some(v => Array.isArray(v) && v[0] === 'backup'), false)
})
test('verification skips snapshot and failed status publication does not repeat a successful operation', async () => {
  const calls = []
  const f = operationFixture({ backup: async args => { calls.push(args[0]); if (args[0] === 'publish-status') throw new Error('report disk'); return { state: 'CIPHERTEXT_VERIFIED' } } })
  assert.deepEqual(await f.adapter.execute({ kind: 'verify', pointId: id(1) }, async () => {}), { verified: true })
  assert.deepEqual(calls, ['verify', 'publish-status']); assert.equal(f.calls.length, 0)
})
test('schedule gate distinguishes hash download from restore and blocks pending cloud mutations', async () => {
  const f = operationFixture()
  f.setLedger({ pending: [], points: [{ state: 'download_verified' }] }); assert.equal((await f.adapter.gates()).schedule, false)
  f.setLedger({ pending: [], points: [{ state: 'restore_verified' }] }); assert.equal((await f.adapter.gates()).schedule, true)
  f.setLedger({ pending: [], pendingDeletes: [{}], points: [{ state: 'restore_verified' }] })
  assert.equal((await f.adapter.gates()).schedule, false); assert.equal((await f.adapter.gates()).backup, false)
})
