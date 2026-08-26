import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import {
  createRecoverableSerialQueue,
  startRuntimeFunctions
} from '../src/lib/runtimeLifecycle.js'
import { tryAcquirePostgresAdvisoryLease } from '../src/lib/postgresAdvisoryLease.js'

async function source(path) {
  return fs.readFile(new URL(path, import.meta.url), 'utf8')
}

test('runtime refresh queue recovers after a rejected operation', async () => {
  const queue = createRecoverableSerialQueue()
  const calls = []
  await assert.rejects(queue.run(async () => {
    calls.push('failed')
    throw new Error('expected failure')
  }), /expected failure/)
  const result = await queue.run(async () => {
    calls.push('recovered')
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.deepEqual(calls, ['failed', 'recovered'])
})

test('partial runtime startup stops already-started functions in reverse order', async () => {
  const events = []
  await assert.rejects(startRuntimeFunctions([
    async () => async () => { events.push('first-stop') },
    async () => async () => { events.push('second-stop') },
    async () => { throw new Error('startup failed') }
  ]), /startup failed/)
  assert.deepEqual(events, ['second-stop', 'first-stop'])
})

function advisoryClient(queryResults) {
  const client = new EventEmitter()
  client.queries = []
  client.releaseCalls = []
  client.query = async (sql, values) => {
    client.queries.push({ sql, values })
    return queryResults.shift()
  }
  client.release = (error) => { client.releaseCalls.push(error) }
  return client
}

test('PostgreSQL advisory lease holds one pool session and unlocks before release', async () => {
  const client = advisoryClient([
    { rows: [{ acquired: true }] },
    { rows: [{ released: true }] }
  ])
  const lease = await tryAcquirePostgresAdvisoryLease({
    poolInstance: { async connect() { return client } },
    name: 'nav_email_ingest:mxroute:INBOX'
  })
  assert.equal(lease.active, true)
  assert.match(client.queries[0].sql, /pg_try_advisory_lock/)
  assert.deepEqual(client.queries[0].values, ['nav_email_ingest:mxroute:INBOX'])
  await lease.release()
  assert.equal(lease.active, false)
  assert.match(client.queries[1].sql, /pg_advisory_unlock/)
  assert.equal(client.releaseCalls.length, 1)
})

test('unavailable advisory lease releases the unused pool session', async () => {
  const client = advisoryClient([{ rows: [{ acquired: false }] }])
  const lease = await tryAcquirePostgresAdvisoryLease({
    poolInstance: { async connect() { return client } },
    name: 'nav_email_ingest:mxroute:INBOX'
  })
  assert.equal(lease, null)
  assert.equal(client.releaseCalls.length, 1)
})

test('advisory lease loss invalidates leadership and notifies the worker', async () => {
  const client = advisoryClient([{ rows: [{ acquired: true }] }])
  const losses = []
  const lease = await tryAcquirePostgresAdvisoryLease({
    poolInstance: { async connect() { return client } },
    name: 'nav_email_ingest:mxroute:INBOX',
    onLost(error) { losses.push(error) }
  })
  const failure = new Error('connection lost')
  client.emit('error', failure)
  assert.equal(lease.active, false)
  assert.deepEqual(losses, [failure])
  assert.deepEqual(client.releaseCalls, [failure])
})

test('mail worker is isolated from API runtime and retained by backup and disaster restore', async () => {
  const [controller, worker, ingestWorker, scheduler, config, env, compose, backup, restore, backupExample] = await Promise.all([
    source('../src/lib/emailRuntimeController.js'),
    source('../src/mailWorker.js'),
    source('../src/lib/emailIngestWorker.js'),
    source('../src/lib/emailIngestScheduler.js'),
    source('../src/config.js'),
    source('../.env.example'),
    source('../../docker-compose.backend.yml'),
    source('../../scripts/nav-backup.sh'),
    source('../../scripts/nav-disaster-restore.sh'),
    source('../../scripts/nav-backup.env.example')
  ])

  assert.match(config, /\['combined', 'api', 'worker'\]/)
  assert.match(env, /NAV_EMAIL_RUNTIME_ROLE=combined/)
  assert.match(controller, /role === 'combined' \|\| role === 'api'/)
  assert.match(controller, /role === 'combined' \|\| role === 'worker'/)
  assert.match(controller, /createRecoverableSerialQueue/)
  assert.match(worker, /NAV_EMAIL_RUNTIME_ROLE=worker/)
  assert.match(worker, /applyManagedIntegrationsToRuntime/)
  assert.match(worker, /SIGTERM/)
  assert.match(ingestWorker, /tryAcquirePostgresAdvisoryLease/)
  assert.match(ingestWorker, /nav_email_ingest:/)
  assert.match(scheduler, /rerunRequested/)
  assert.match(scheduler, /activeClient\?\.close/)

  assert.equal((compose.match(/image: "domo-nav-api:\$\{NAV_RELEASE_SHA:-development\}"/g) || []).length, 2)
  const workerService = compose.slice(
    compose.indexOf('  nav-mail-worker:'),
    compose.indexOf('\nvolumes:')
  )
  assert.match(workerService, /NAV_EMAIL_RUNTIME_ROLE: worker/)
  assert.match(workerService, /nav-api:\s*\n\s+condition: service_healthy/)
  assert.match(workerService, /command: \["node", "src\/mailWorker\.js"\]/)
  assert.match(workerService, /scripts\/checkMailWorkerHealth\.js/)
  assert.match(workerService, /NAV_INTEGRATIONS_DIR[^\n]+:ro"/)
  assert.match(workerService, /imap-password:\/run\/secrets\/nav\/imap-password:ro/)
  assert.match(workerService, /email-encryption-key:\/run\/secrets\/nav\/email-encryption-key:ro/)
  assert.doesNotMatch(workerService, /^\s+ports:/m)
  assert.match(backup, /NAV_RUNTIME_CONTAINERS:=nav-api;nav-mail-worker;nav-postgres/)
  assert.match(restore, /NAV_DR_APP_CONTAINERS:=nav-mail-worker;nav-api;nav-web/)
  assert.match(restore, /NAV_DR_COMPOSE_SERVICES:=nav-postgres;nav-api;nav-mail-worker/)
  assert.match(backupExample, /REPLACE_NAV_MAIL_WORKER_CONTAINER/)
  assert.match(backupExample, /^NAV_DR_APP_CONTAINERS=nav-mail-worker;nav-api;nav-web$/m)
  assert.match(backupExample, /^NAV_DR_COMPOSE_SERVICES=nav-postgres;nav-api;nav-mail-worker$/m)
})
