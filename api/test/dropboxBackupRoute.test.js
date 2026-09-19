import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { config } from '../src/config.js'
import routes from '../src/routes/systemIntegrations.js'
import { createBackupStatus } from '../../scripts/dropbox/backup-status.mjs'

test('active system integrations route forwards sanitized backup status behind admin guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nav-dropbox-route-'))
  const previous = config.managedIntegrationsDir
  config.managedIntegrationsDir = directory
  const app = Fastify({ logger: false })
  let guardCalls = 0
  app.decorate('requireAdmin', async request => {
    guardCalls++
    if (request.headers['x-test-role'] !== 'admin') {
      throw Object.assign(new Error('Denied'), { statusCode: request.headers['x-test-role'] ? 403 : 401 })
    }
  })
  app.register(routes, { prefix: '/api' })
  try {
    for (const [headers, status] of [[{}, 401], [{ 'x-test-role': 'user' }, 403]]) {
      const response = await app.inject({ url: '/api/admin/integrations', headers })
      assert.equal(response.statusCode, status)
      assert.equal(response.json().dropboxBackup, undefined)
    }
    const headers = { 'x-test-role': 'admin' }
    const missing = await app.inject({ url: '/api/admin/integrations', headers })
    assert.equal(missing.json().dropboxBackup.state, 'not_connected')
    const report = createBackupStatus({ config: {}, now: new Date(),
      localPlan: { keep: [{ name: 'nav-20260919T020000Z-nogit', bytes: 1234 }], remove: [] } })
    report.token = 'FORBIDDEN_TEST_SECRET'
    report.cloud.accountEmail = 'FORBIDDEN_TEST_SECRET'
    await writeFile(join(directory, 'dropbox-status.json'), JSON.stringify(report))
    const response = await app.inject({ url: '/api/admin/integrations', headers })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['cache-control'], 'private, no-store')
    const body = response.json()
    assert.equal(body.mailboxRetired, true)
    assert.equal(body.dropboxBackup.state, 'available')
    assert.equal(body.dropboxBackup.report.local.points.length, 1)
    assert.equal(body.dropboxBackup.report.cloud.credentialsPresent, false)
    assert.equal(body.dropboxBackup.report.scheduleEnabled, null)
    assert.ok(!response.body.includes('FORBIDDEN_TEST_SECRET'))
    assert.equal(guardCalls, 4)
  } finally {
    await app.close()
    config.managedIntegrationsDir = previous
    await rm(directory, { recursive: true, force: true })
  }
})
