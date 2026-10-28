import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { OfflineDownloads } from '../src/lib/offlineDownloads.js'
import routes from '../src/routes/offlineDownloads.js'
import { nodeProfile, nodeSettings } from '../src/lib/offlineNodes.js'
const id = '1'.repeat(32), other = '2'.repeat(32), key = 'a'.repeat(64)
function fixture(data = { jobs: [] }) {
  let saved = structuredClone(data), failing = false
  const store = { read: async () => structuredClone(saved), write: async value => { if (failing) throw Error('FULL'); saved = structuredClone(value) } }
  const service = { protection: async () => ['/Apps/Backup'], client: { getMetadataIfExists: async () => null } }
  const manager = new OfflineDownloads({ store, service, uploads: {}, identity: 'owner' })
  return { manager, store, service, fail: () => { failing = true } }
}
const activation = (nodeId = id) => ({ action: 'activate', id: nodeId, name: '下载节点', address: 'node.example.test', oldNodeStopped: true })
async function ready(manager) {
  await manager.manageNode({ action: 'prepare' })
  manager.startedAt -= 46000; manager.lastSeen = 0
  await manager.claim({}, id)
}
test('profile accepts only a name and inventory host; no URLs, paths, credentials or extra fields', () => {
  assert.deepEqual(nodeProfile({ name: ' 下载节点 ', address: 'NODE.example.test', workerKey: key }), { name: '下载节点', address: 'node.example.test' })
  for (const address of ['https://node.test', 'node.test:9119', 'user:pass@node.test', 'node.test/path', '-node.test', 'node..test']) assert.throws(() => nodeProfile({ name: 'n', address }))
  for (const address of ['', '192.0.2.1', '2001:db8::1']) assert.equal(nodeProfile({ name: 'n', address }).address, address)
  assert.throws(() => nodeProfile({ name: '\n', address: '' }))
  assert.throws(() => nodeSettings({ node: null }), { code: 'OFFLINE_STATE_INVALID' })
})
test('legacy workers remain compatible; pending nodes cannot consume tasks or change active health', async () => {
  const { manager } = fixture()
  const job = await manager.add({ url: 'https://example.test/a', destination: '/a' })
  assert.deepEqual(await manager.claim({ bt: true }, id), { job: null, nodeState: 'pending' })
  assert.equal(manager.lastSeen, 0)
  assert.equal((await manager.status()).workerOnline, false)
  assert.equal((await manager.claim()).job.id, job.id)
  await assert.rejects(manager.progress(job.id, { state: 'error' }, id), { code: 'OFFLINE_NODE_NOT_ACTIVE' })
})
test('prepare blocks new tasks but drains existing jobs and can be cancelled', async () => {
  const { manager } = fixture()
  const job = await manager.add({ url: 'https://example.test/a', destination: '/a' })
  await manager.manageNode({ action: 'prepare' })
  await assert.rejects(manager.add({ url: 'https://example.test/b', destination: '/b' }), { code: 'OFFLINE_NODE_PREPARING' })
  assert.equal((await manager.claim()).job.id, job.id)
  assert.equal((await manager.status()).node.blockers.unfinished, 1)
  await manager.manageNode({ action: 'cancel' })
  assert.equal((await manager.add({ url: 'https://example.test/b', destination: '/b' })).state, 'queued')
})
test('every unfinished state and unacknowledged cache block migration, including other connections', async () => {
  for (const state of ['queued', 'paused', 'error', 'review', 'selecting', 'committing', 'downloading', 'uploading', 'complete', 'cancelled']) {
    const { manager } = fixture({ jobs: [{ state, cleaned: false, identity: 'other-owner' }] })
    await ready(manager)
    await assert.rejects(manager.manageNode(activation()), { code: 'OFFLINE_NODE_NOT_READY' }, state)
  }
})
test('activation requires preparation, quiet old node, recent candidate and explicit stopped confirmation', async () => {
  const { manager } = fixture()
  await manager.claim({}, id)
  await assert.rejects(manager.manageNode(activation()), { code: 'OFFLINE_NODE_NOT_READY' })
  await manager.manageNode({ action: 'prepare' })
  await assert.rejects(manager.manageNode(activation()), { code: 'OFFLINE_NODE_NOT_READY' }) // restart does not bypass quiet interval
  manager.startedAt -= 46000
  await manager.claim()
  await assert.rejects(manager.manageNode(activation()), { code: 'OFFLINE_NODE_NOT_READY' })
  manager.lastSeen -= 46000
  manager.candidates.get(id).lastSeen -= 46000
  await assert.rejects(manager.manageNode(activation()), { code: 'OFFLINE_NODE_STALE' })
  await manager.claim({}, id)
  await assert.rejects(manager.manageNode({ ...activation(), oldNodeStopped: false }), { code: 'OFFLINE_NODE_STOP_REQUIRED' })
})
test('switch is durable and fences legacy and other workers on every job operation', async () => {
  const { manager, store, service } = fixture({ jobs: [{ state: 'complete', cleaned: true, destination: '/previous.bin' }] })
  await ready(manager); await manager.manageNode(activation())
  const restarted = new OfflineDownloads({ store, service, uploads: {}, identity: 'owner' })
  assert.equal((await restarted.status()).node.id, id)
  assert.equal((await restarted.status()).workerOnline, false)
  const job = await restarted.add({ url: 'https://example.test/a', destination: '/a' })
  for (const wrong of [null, other]) {
    await assert.rejects(restarted.progress(job.id, {}, wrong), { code: 'OFFLINE_NODE_NOT_ACTIVE' })
    await assert.rejects(restarted.source(job.id, 0, 1, wrong), { code: 'OFFLINE_NODE_NOT_ACTIVE' })
    for (const operation of ['start', 'chunk', 'finish']) await assert.rejects(restarted.transfer(job.id, operation, {}, undefined, wrong), { code: 'OFFLINE_NODE_NOT_ACTIVE' })
  }
  await assert.rejects(restarted.claim(), { code: 'OFFLINE_NODE_NOT_ACTIVE' })
  assert.equal((await restarted.claim({}, other)).job, null)
  assert.equal((await restarted.claim({}, id)).job.id, job.id)
  assert.equal((await restarted.status()).workerOnline, true)
})
test('profile edits preserve selected node and tasks; failed durable save never claims a switch succeeded', async () => {
  const { manager, store, fail } = fixture()
  await ready(manager); await manager.manageNode(activation())
  await manager.manageNode({ action: 'profile', name: '新名称', address: '' })
  assert.equal((await store.read()).node.id, id)
  await manager.manageNode({ action: 'prepare' }); await manager.claim({}, other)
  fail()
  await assert.rejects(manager.manageNode(activation(other)), /FULL/)
  assert.equal((await store.read()).node.id, id)
  await assert.rejects(manager.claim({}, other), { code: 'OFFLINE_STATE_INVALID' })
})
test('node management requires the connected owner; worker header is carried through all routes', async () => {
  const { manager } = fixture(), app = Fastify({ logger: false })
  app.decorate('requireAdmin', async (req, reply) => { if (req.headers['x-role'] !== 'admin') { reply.code(401); throw Error('DENIED') }; req.currentUser = { id: req.headers['x-owner'] } })
  await app.register(routes, { prefix: '/api', loadConfig: () => ({ workerKey: key }), loadConnection: () => ({ ownerUserId: 'owner' }), createService: () => ({}), createManager: () => manager })
  try {
    for (const headers of [{}, { authorization: 'Bearer ' + key }, { 'x-role': 'admin', 'x-owner': 'other' }]) {
      const r = await app.inject({ method: 'POST', url: '/api/offline-downloads/node', headers, payload: { action: 'prepare' } })
      assert.ok([401, 403].includes(r.statusCode))
    }
    const headers = { 'x-role': 'admin', 'x-owner': 'owner' }
    const r = await app.inject({ method: 'POST', url: '/api/offline-downloads/node', headers, payload: { action: 'prepare' } })
    assert.equal(r.statusCode, 200); assert.match(r.headers['cache-control'], /no-store/)
    await ready(manager); await manager.manageNode(activation())
    for (const operation of ['progress', 'source', 'start', 'finish', 'chunk']) {
      const bytes = operation === 'chunk'
      const r = await app.inject({ method: 'POST', url: '/api/offline-downloads/worker/' + operation,
        headers: { authorization: 'Bearer ' + key, 'x-offline-node': other, ...(bytes ? { 'content-type': 'application/octet-stream', 'x-offline-job': id, 'x-upload-offset': '0' } : {}) },
        payload: bytes ? Buffer.from('a') : { id } })
      assert.equal(r.statusCode, 409); assert.equal(r.json().code, 'OFFLINE_NODE_NOT_ACTIVE')
    }
    const online = await app.inject({ method: 'POST', url: '/api/offline-downloads/worker/claim', headers: { authorization: 'Bearer ' + key, 'x-offline-node': id }, payload: {} })
    assert.equal(online.statusCode, 200); assert.equal((await manager.status()).workerOnline, true)
  } finally { await app.close() }
})
