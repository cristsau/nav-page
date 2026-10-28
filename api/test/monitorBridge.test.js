import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MonitorBridge, monitorTarget, validateMonitorConfig, loadMonitorConfig, monitorJson } from '../src/lib/monitorBridge.js'
import monitorRoutes from '../src/routes/monitor.js'
const owner = '11111111-1111-4111-8111-111111111111'
const settings = { version: 1, enabled: true, ownerUserId: owner, upstream: 'http://nav-monitor:28080', site: 'https://node.cvv.gr', password: 'synthetic-password-only' }
const cookie = 'monitor_session=' + 'a'.repeat(64)
const loginResponse = () => new Response('{}', { headers: { 'set-cookie': cookie + '; HttpOnly; SameSite=Lax; Path=/' } })

test('monitor config is fixed-target, private, bounded and missing stays disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-monitor-test-'))
  try {
    assert.equal(await loadMonitorConfig(dir), null)
    const file = join(dir, 'monitor.json')
    await writeFile(file, JSON.stringify(settings), { mode: 0o600 })
    assert.deepEqual(await loadMonitorConfig(dir), settings)
    for (const field of [{ upstream: 'http://169.254.169.254' }, { site: 'https://attacker.test' }, { ownerUserId: '0'.repeat(36) }, { password: 'short' }]) assert.throws(() => validateMonitorConfig({ ...settings, ...field }))
    await writeFile(file, 'x'.repeat(4100)); await assert.rejects(loadMonitorConfig(dir), { code: 'MONITOR_CONFIG_INVALID' })
    assert.equal(validateMonitorConfig({ version: 1, enabled: false }), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('only native monitoring paths pass; URL escape, auth and agent routes are refused', () => {
  for (const value of ['/nodes', '/nodes/2/metrics?hours=24&points=120', '/db/backup', '/themes/default/preview', '/nodes/batch', '/sessions/' + 'a'.repeat(64)]) assert.equal(monitorTarget(value), '/api' + value)
  for (const value of ['//evil.test', '/nodes/../auth/login', '/nodes/%2e%2e', '/nodes%2f..', '/auth/login', '/agent/ws', '/db/restore', '/ws', '/me#x', '/me\r\nCookie:x']) assert.throws(() => monitorTarget(value))
})
test('parallel reads share one native login; only bridge cookie and fixed origin reach hub', async () => {
  const calls = []
  const bridge = new MonitorBridge(settings, async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/auth/login')) { await new Promise(resolve => setTimeout(resolve, 10)); return loginResponse() }
    return Response.json(url.endsWith('/me') ? { authed: true } : { nodes: [] })
  })
  await Promise.all([bridge.request('/nodes'), bridge.request('/me')])
  assert.equal(calls.filter(call => call.url.endsWith('/auth/login')).length, 1)
  for (const { url, options } of calls.slice(1)) { assert.ok(url.startsWith(settings.upstream + '/api/')); assert.equal(options.headers.cookie, cookie); assert.equal(options.headers.origin, settings.site); assert.equal(options.headers.authorization, undefined); assert.equal(options.redirect, 'error') }
})
test('expired native session refreshes a read once, never replays a mutation', async () => {
  let logins = 0, reads = 0, writes = 0
  const bridge = new MonitorBridge(settings, async (url, options) => {
    if (url.endsWith('/auth/login')) { logins++; return loginResponse() }
    if (options.method === 'GET') { reads++; return reads === 1 ? new Response('', { status: 401 }) : Response.json({ nodes: [] }) }
    writes++; return new Response('', { status: 401 })
  })
  assert.equal((await bridge.request('/nodes')).status, 200)
  assert.equal(logins, 2); assert.equal(reads, 2)
  assert.equal((await bridge.request('/nodes', { method: 'POST', body: '{}' })).status, 401)
  assert.equal(writes, 1); assert.equal(bridge.cookie, '')
})
test('native emergency credentials cannot be silently changed through NAV', async () => {
  const bridge = new MonitorBridge(settings, () => { throw Error('must not contact hub') })
  await assert.rejects(bridge.request('/settings', { method: 'PUT', body: '{"admin_password":"different-synthetic"}' }), { code: 'MONITOR_NAV_AUTH_MANAGED' })
  await assert.rejects(bridge.request('/nodes', { method: 'TRACE' }), { statusCode: 405 })
})
test('a revoked native session returning anonymous HTTP 200 is refreshed for NAV identity', async () => {
  let me = 0, logins = 0
  const bridge = new MonitorBridge(settings, async url => {
    if (url.endsWith('/auth/login')) { logins++; return loginResponse() }
    return Response.json({ authed: ++me > 1 })
  })
  assert.equal((await (await bridge.request('/me')).json()).authed, true)
  assert.equal(me, 2); assert.equal(logins, 2)
})
test('oversized status and malformed login fail without exposing session or error payload', async () => {
  await assert.rejects(monitorJson(new Response('x'.repeat(20000))))
  const bridge = new MonitorBridge(settings, async () => new Response('sensitive upstream failure', { status: 500 }))
  await assert.rejects(bridge.login(), { code: 'MONITOR_LOGIN_UNAVAILABLE' })
  assert.equal(bridge.cookie, '')
})
test('NAV owner checks cover status and every proxy request; no upstream cookie returned', async () => {
  let user = null, hits = 0
  const app = Fastify()
  app.decorate('requireAdmin', async (req, reply) => { if (!user) { reply.code(401); throw Error('auth') } if (user.role !== 'admin') { reply.code(403); throw Error('admin') } req.currentUser = user })
  await app.register(monitorRoutes, { prefix: '/api', loadConfig: async () => settings,
    fetcher: async (url, options) => {
      hits++
      if (url.endsWith('/auth/login')) return loginResponse()
      assert.equal(options.headers.cookie, cookie)
      return Response.json(url.endsWith('/me') ? { authed: true } : { nodes: [] }, { headers: { 'set-cookie': 'should-not-leak=1', location: 'https://evil.test', 'cache-control': 'public,max-age=300' } })
    } })
  try {
    for (const url of ['/api/monitor/status', '/api/monitor/proxy/nodes']) { const res = await app.inject(url); assert.equal(res.statusCode, 401) }
    user = { id: owner, role: 'user' }; assert.equal((await app.inject('/api/monitor/status')).statusCode, 403)
    user = { id: '22222222-2222-4222-8222-222222222222', role: 'admin' }; assert.equal((await app.inject('/api/monitor/status')).statusCode, 403)
    assert.equal(hits, 0)
    user = { id: owner, role: 'admin' }
    assert.equal((await app.inject('/api/monitor/status')).json().login, 'nav')
    const res = await app.inject({ url: '/api/monitor/proxy/nodes', headers: { cookie: 'nav_session=synthetic-private', authorization: 'Bearer untrusted' } })
    assert.equal(res.statusCode, 200); assert.deepEqual(res.json(), { nodes: [] })
    assert.equal(res.headers['set-cookie'], undefined); assert.equal(res.headers.location, undefined); assert.equal(res.headers['cache-control'], 'private, no-store')
    user = null; assert.equal((await app.inject('/api/monitor/proxy/nodes')).statusCode, 401)
  } finally { await app.close() }
})
test('proxy preserves binary bytes, query and write response without accepting client targets', async () => {
  const bytes = Buffer.from([0, 1, 2, 255]), requests = [], app = Fastify()
  app.decorate('requireAdmin', async req => { req.currentUser = { id: owner, role: 'admin' } })
  await app.register(monitorRoutes, { prefix: '/api', loadConfig: async () => settings, fetcher: async (url, options) => {
    if (url.endsWith('/auth/login')) return loginResponse()
    requests.push({ url, options })
    if (url.endsWith('/db/backup')) return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="monitor.db"' } })
    return Response.json({ ok: true })
  } })
  try {
    const upload = await app.inject({ method: 'POST', url: '/api/monitor/proxy/themes?offset=0&total=4', headers: { 'content-type': 'application/octet-stream' }, payload: bytes })
    assert.equal(upload.statusCode, 200); assert.deepEqual(requests[0].options.body, bytes); assert.ok(requests[0].url.endsWith('/api/themes?offset=0&total=4'))
    const download = await app.inject('/api/monitor/proxy/db/backup')
    assert.deepEqual(download.rawPayload, bytes); assert.match(download.headers['content-disposition'], /attachment/)
    assert.equal((await app.inject('/api/monitor/proxy/auth/login')).statusCode, 400)
  } finally { await app.close() }
})

test('live HTTP streams hold the concurrency slot and disconnect aborts the hub request', { timeout: 20000 }, async () => {
  const app = Fastify({ forceCloseConnections: true }), signals = [], clients = []
  app.decorate('requireAdmin', async req => { req.currentUser = { id: owner, role: 'admin' } })
  await app.register(monitorRoutes, { prefix: '/api', loadConfig: async () => settings, fetcher: async (url, options) => {
    if (url.endsWith('/auth/login')) return loginResponse()
    if (url.endsWith('/me')) return Response.json({ authed: true })
    signals.push(options.signal)
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      options.signal.addEventListener('abort', () => controller.error(new Error('synthetic disconnect')), { once: true })
    } }), { headers: { 'content-type': 'application/octet-stream' } })
  } })
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    for (let i = 0; i < 4; i++) clients.push(await fetch(origin + '/api/monitor/proxy/db/backup'))
    const busy = await fetch(origin + '/api/monitor/status')
    assert.equal(busy.status, 429); await busy.body.cancel()
    for (const response of clients) await response.body.cancel()
    for (let i = 0; i < 40 && signals.some(signal => !signal.aborted); i++) await delay(25)
    assert.ok(signals.every(signal => signal.aborted))
    const status = await fetch(origin + '/api/monitor/status')
    assert.equal(status.status, 200); assert.equal((await status.json()).connected, true)
  } finally {
    for (const response of clients) await response.body?.cancel().catch(() => {})
    await app.close()
  }
})
