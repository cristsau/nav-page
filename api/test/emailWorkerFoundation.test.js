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

test('active deployment and recovery defaults no longer start a mailbox worker', async () => {
  const [runtime, worker, compose, backup, restore, example] = await Promise.all([
    source('../src/lib/systemMailRuntime.js'), source('../src/mailWorker.js'),
    source('../../docker-compose.backend.yml'), source('../../scripts/nav-backup.sh'),
    source('../../scripts/nav-disaster-restore.sh'), source('../../scripts/nav-backup.env.example')
  ])
  assert.match(runtime, /systemOnly: true/)
  assert.doesNotMatch(runtime, /emailRuntimeController|startEmailIngest/)
  assert.match(worker, /mailbox retired/)
  assert.doesNotMatch(compose, /nav-mail-worker|imap-password/)
  assert.match(backup, /NAV_RUNTIME_CONTAINERS:=nav-api;nav-postgres/)
  assert.match(restore, /NAV_DR_COMPOSE_SERVICES:=nav-postgres;nav-api/)
  assert.doesNotMatch(example, /REPLACE_NAV_MAIL_WORKER_CONTAINER/)
})
