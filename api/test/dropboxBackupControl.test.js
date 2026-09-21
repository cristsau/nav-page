import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { Readable } from 'node:stream'
import routes from '../src/routes/dropboxBackupControl.js'
import { BackupControlError, backupControlClient, cleanControlStatus, loadBackupControl } from '../src/lib/dropboxBackupControl.js'
import { isUnsafeRequestOriginTrusted } from '../src/lib/requestSecurity.js'
import { BackupController, initialControlState } from '../../scripts/dropbox/control-core.mjs'
import { createControlServer } from '../../scripts/dropbox/control-server.mjs'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pointId = '1'.repeat(32), owner = '11111111-1111-4111-8111-111111111111'
const status = () => ({ connected: true, revision: 0, timezone: 'Asia/Shanghai', busy: false, reviewRequired: false,
  jobs: [], schedule: { enabled: false, active: false, time: '03:45', blockedReason: 'SCHEDULE_GATE_CLOSED' },
  capabilities: { backup: true, verify: true, download: true, schedule: false } })
async function fixture(fn, options = {}) {
  let calls = 0
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async (req, reply) => {
    if (!isUnsafeRequestOriginTrusted(req, 'https://nav.test')) return reply.code(403).send({ error: 'cross site' })
  })
  app.decorate('requireAdmin', async req => {
    if (req.headers.role !== 'admin') throw Object.assign(new Error('denied'), { statusCode: req.headers.role ? 403 : 401 })
    req.currentUser = { id: req.headers.owner || owner }
  })
  const mock = { status: async () => { calls++; return status() }, enqueue: async () => { calls++; return { secret: 'never return' } },
    schedule: async () => { calls++; return {} }, download: async () => { calls++; return { stream: Readable.from(['abcdef']), bytes: 6 } } }
  app.register(routes, { prefix: '/api', loadConfig: async () => ({ ownerUserId: owner }), client: () => mock, ...options })
  const request = (path, args = {}) => app.inject({ url: '/api/admin/integrations/dropbox-backup/' + path, headers: { role: 'admin', origin: 'https://nav.test' }, ...args })
  try { await fn({ app, request, calls: () => calls, mock }) } finally { await app.close() }
}
test('admin plus exact owner required before contacting executor; cross-site POST blocked', () => fixture(async f => {
  for (const [headers, expected] of [[{}, 401], [{ role: 'user' }, 403], [{ role: 'admin', owner: 'other' }, 403]]) {
    assert.equal((await f.request('status', { headers })).statusCode, expected)
  }
  assert.equal((await f.request('jobs', { method: 'POST', headers: { role: 'admin', origin: 'https://evil.test' }, payload: { id: pointId, kind: 'backup' } })).statusCode, 403)
  assert.equal(f.calls(), 0)
  const r = await f.request('status'); assert.equal(r.statusCode, 200); assert.equal(r.headers['cache-control'], 'private, no-store')
}))
test('disconnected status is explicit and mutation fails closed', () => fixture(async f => {
  assert.deepEqual((await f.request('status')).json(), { connected: false })
  assert.equal((await f.request('jobs', { method: 'POST', payload: { id: pointId, kind: 'backup' } })).statusCode, 503)
  assert.equal(f.calls(), 0)
}, { loadConfig: async () => null }))
test('operation schema rejects shell/path/restore/delete and hides internal receipts', () => fixture(async f => {
  for (const payload of [{ id: pointId, kind: 'delete' }, { id: pointId, kind: 'backup', command: 'rm' }, { id: pointId, kind: 'verify', pointId: '../etc' }]) {
    assert.equal((await f.request('jobs', { method: 'POST', payload })).statusCode, 400)
  }
  assert.equal(f.calls(), 0)
  const r = await f.request('jobs', { method: 'POST', payload: { id: pointId, kind: 'backup' } })
  assert.equal(r.statusCode, 202); assert.deepEqual(r.json(), { accepted: true, id: pointId }); assert.ok(!r.body.includes('secret'))
}))
test('safe schedule settings and precise ciphertext attachment through authenticated endpoint', () => fixture(async f => {
  assert.equal((await f.request('schedule', { method: 'PUT', payload: { enabled: false, time: '26:01', revision: 0 } })).statusCode, 400)
  assert.deepEqual((await f.request('schedule', { method: 'PUT', payload: { enabled: false, time: '04:15', revision: 0 } })).json(), { saved: true })
  const r = await f.request('ciphertext/' + pointId)
  assert.equal(r.statusCode, 200); assert.equal(r.body, 'abcdef'); assert.match(r.headers['content-disposition'], /\.tar\.age/)
}))
test('executor errors are bounded and no internal messages/paths/credentials leak', () => fixture(async f => {
  f.mock.status = async () => { throw new Error('sensitive config') }
  const r = await f.request('status'); assert.equal(r.statusCode, 503); assert.ok(!r.body.includes('sensitive'))
  f.mock.enqueue = async () => { throw new BackupControlError('BACKUP_BUSY', 409) }
  assert.equal((await f.request('jobs', { method: 'POST', payload: { id: pointId, kind: 'backup' } })).statusCode, 409)
}))
test('sanitizer never passes host extra fields or malformed state', () => {
  const clean = cleanControlStatus({ ...status(), secret: 'hidden' })
  assert.ok(!JSON.stringify(clean).includes('hidden'))
  assert.throws(() => cleanControlStatus({ ...status(), jobs: [{ id: pointId, secret: 'hidden' }] }))
  assert.throws(() => cleanControlStatus({ ...status(), schedule: { ...status().schedule, time: '24:01' } }))
})
test('missing control directory is disabled; invalid relative configuration is rejected', async () => {
  assert.equal(await loadBackupControl(''), null)
  await assert.rejects(loadBackupControl('relative'), /CONTROL_UNAVAILABLE/)
})

test('private control config is bounded and does not accept arbitrary socket targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nav-control-config-'))
  try {
    const file = join(directory, 'dropbox-backup-control.json')
    await writeFile(file, JSON.stringify({ version: 1, ownerUserId: owner, socketPath: '/var/run/docker.sock' }), { mode: 0o600 })
    await assert.rejects(loadBackupControl(directory))
    await writeFile(file, JSON.stringify({ version: 1, ownerUserId: owner, socketPath: '/run/nav-dropbox-control/control.sock', extra: 'hidden' }))
    assert.deepEqual(await loadBackupControl(directory), { ownerUserId: owner, socketPath: '/run/nav-dropbox-control/control.sock' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('real private socket HTTP client: bounded status, idempotent jobs and streamed ciphertext', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nav-control-http-'))
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\nav-control-test-' + randomUUID() : join(directory, 'c.sock')
  const controller = new BackupController({ state: initialControlState(), save: async () => {},
    gates: async () => ({ backup: true, verify: true, download: true, schedule: false }), execute: async () => ({ verified: true }) })
  const { server, tick } = createControlServer({ controller, ownerUserId: owner,
    streamCiphertext: async (_id, consume) => consume({ bytes: 6 }, async write => { await write(Buffer.from('abc')); await write(Buffer.from('def')) }) })
  try {
    server.listen(socketPath); await once(server, 'listening')
    const c = backupControlClient({ socketPath, ownerUserId: owner })
    assert.equal(cleanControlStatus(await c.status()).connected, true)
    await c.enqueue({ id: pointId, kind: 'backup' }); await tick()
    await c.enqueue({ id: pointId, kind: 'backup' }); assert.equal((await c.status()).jobs.length, 1)
    const result = await c.download(pointId), chunks = []
    for await (const b of result.stream) chunks.push(b)
    assert.equal(result.bytes, 6); assert.equal(Buffer.concat(chunks).toString(), 'abcdef')
    await assert.rejects(backupControlClient({ socketPath, ownerUserId: 'wrong' }).status(), /OWNER_REQUIRED/)
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true }) }
})
