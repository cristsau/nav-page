// CI-only loopback contract check. No private fixture values are printed or archived.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import monitorRoutes from '../../api/src/routes/monitor.js'
const require = createRequire(new URL('../../api/package.json', import.meta.url)), Fastify = require('fastify')
if (process.env.CI !== 'true' || process.platform !== 'linux' || !process.env.RUNNER_TEMP || !process.env.NAV_MONITOR_BUILD_DIR) throw Error('CI Linux only')
const directory = await mkdtemp(join(process.env.RUNNER_TEMP, 'nav-monitor-native-')), build = process.env.NAV_MONITOR_BUILD_DIR
const owner = '11111111-1111-4111-8111-111111111111', upstream = 'http://127.0.0.1:28080'
let password = '', stdout = '', hub, agent, api
async function until(check, label) { for (let i = 0; i < 60; i++) { if (await check().catch(() => false)) return; await delay(250) } throw Error('Timeout: ' + label) }
async function stop(child) { if (!child || child.exitCode !== null) return; child.kill('SIGTERM'); for (let i = 0; i < 40 && child.exitCode === null; i++) await delay(50); if (child.exitCode === null) child.kill('SIGKILL') }
try {
  hub = spawn(join(build, 'monitor-hub'), ['--listen', '127.0.0.1:28080', '--db', join(directory, 'hub.db'), '--site', 'https://node.cvv.gr'], { stdio: ['ignore', 'pipe', 'ignore'] })
  hub.stdout.on('data', chunk => { if (password) return; stdout = (stdout + chunk.toString()).slice(-8192); password = stdout.match(/Emergency password: ([a-f0-9]{24})/)?.[1] || ''; if (password) stdout = '' })
  await until(async () => password && (await fetch(upstream + '/api/me')).ok, 'hub ready')
  api = Fastify({ forceCloseConnections: true })
  api.decorate('requireAdmin', async (request, reply) => { if (request.headers['x-test-owner'] !== owner) { reply.code(401); throw Error('synthetic authentication') } request.currentUser = { id: owner, role: 'admin' } })
  await api.register(monitorRoutes, { prefix: '/api', loadConfig: async () => ({ version: 1, enabled: true, ownerUserId: owner, upstream, site: 'https://node.cvv.gr', password }) })
  const origin = await api.listen({ host: '127.0.0.1', port: 0 })
  async function request(path, method = 'GET', body) {
    const res = await fetch(origin + '/api/monitor/' + path, { method, headers: { 'x-test-owner': owner, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.ok(res.ok, `native API status ${res.status} at ${path}`)
    assert.equal(res.headers.get('set-cookie'), null)
    return res
  }
  assert.equal((await (await request('status')).json()).connected, true)
  await request('proxy/settings', 'PUT', { public_page: 'off', retention_days: '7' })
  assert.equal((await fetch(upstream + '/api/nodes')).status, 401)
  await request('proxy/nodes', 'POST', { name: 'CI synthetic node', public: false })
  const node = (await (await request('proxy/nodes')).json()).nodes[0]
  assert.ok(node?.id)
  const token = (await (await request(`proxy/nodes/${node.id}/token`)).json()).token
  assert.equal(typeof token, 'string')
  agent = spawn(join(build, 'monitor-agent'), ['--interval', '2'], { env: { ...process.env, MONITOR_SERVER: upstream, MONITOR_TOKEN: token }, stdio: 'ignore' })
  await until(async () => { const data = await (await request('proxy/nodes')).json(); return data.admin && data.nodes[0]?.online && typeof data.nodes[0].metrics?.cpu === 'number' }, 'agent metrics')
  assert.equal((await fetch(origin + '/api/monitor/status')).status, 401)
  await stop(agent)
  await request(`proxy/nodes/${node.id}`, 'DELETE')
  assert.equal((await (await request('proxy/nodes')).json()).nodes.length, 0)
  console.log('MONITOR_NATIVE_PASS: real pinned Hub/Agent, NAV bridge login, private overview, CRUD, live metrics, anonymous denial')
} finally {
  await api?.close(); await stop(agent); await stop(hub); password = ''; stdout = ''
  if (!resolve(directory).startsWith(resolve(process.env.RUNNER_TEMP) + '/nav-monitor-native-')) throw Error('Unsafe fixture cleanup')
  await rm(directory, { recursive: true, force: true })
}
