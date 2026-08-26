import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createEmailMailboxEventBroker,
  parseEmailMailboxEventPayload
} from '../src/lib/emailMailboxEventBroker.js'

const CHANNEL = 'nav_email_mailbox_changes'

function createClient({ queryError = null } = {}) {
  const client = new EventEmitter()
  client.queries = []
  client.releases = []
  client.query = async (sql) => {
    client.queries.push(sql)
    if (queryError && sql.startsWith('LISTEN ')) throw queryError
    return { rows: [] }
  }
  client.release = (error) => { client.releases.push(error) }
  return client
}

function createPool(clients) {
  return {
    connectCalls: 0,
    async connect() {
      const client = clients[this.connectCalls]
      this.connectCalls += 1
      if (!client) throw new Error('No fake PostgreSQL client available')
      return client
    }
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('payload parser exposes only routable mailbox metadata', () => {
  const parsed = parseEmailMailboxEventPayload(JSON.stringify({
    userId: 'user-1',
    accountId: 'account-1',
    folderId: 'folder-1',
    messageId: 'message-1',
    locationId: 'location-1',
    revision: 42,
    subject: 'private subject',
    body: 'private body',
    sender: 'private sender'
  }))
  assert.deepEqual(parsed, {
    userId: 'user-1',
    accountId: 'account-1',
    folderId: 'folder-1',
    messageId: 'message-1',
    locationId: 'location-1',
    revision: 42
  })
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(parseEmailMailboxEventPayload('{not-json'), null)
  assert.equal(parseEmailMailboxEventPayload({ userId: 'user-1' }), null)
})

test('concurrent start is single-flight and uses one LISTEN session', async () => {
  const client = createClient()
  const pool = createPool([client])
  const broker = createEmailMailboxEventBroker({ poolInstance: pool })

  const results = await Promise.all(Array.from({ length: 12 }, () => broker.start()))

  assert.equal(pool.connectCalls, 1)
  assert.equal(new Set(results).size, 1)
  assert.deepEqual(client.queries, [`LISTEN "${CHANNEL}"`])
  assert.equal(broker.active, true)
  await broker.close()
})

test('one listener fans sanitized events out and unsubscribe is idempotent', async () => {
  const client = createClient()
  const broker = createEmailMailboxEventBroker({ poolInstance: createPool([client]) })
  const first = []
  const second = []
  const unsubscribeFirst = broker.subscribe({ onEvent(event) { first.push(event) } })
  broker.subscribe({ onEvent(event) { second.push(event) } })
  await broker.start()

  client.emit('notification', {
    channel: CHANNEL,
    payload: JSON.stringify({
      userId: 'user-1', accountId: 'account-1', revision: 9,
      body: 'must not escape', subject: 'must not escape'
    })
  })
  client.emit('notification', { channel: 'some_other_channel', payload: '{}' })

  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.deepEqual(Object.keys(first[0]), ['userId', 'accountId', 'revision'])
  assert.equal(unsubscribeFirst(), true)
  assert.equal(unsubscribeFirst(), false)
  assert.equal(broker.subscriberCount, 1)

  client.emit('notification', {
    channel: CHANNEL,
    payload: JSON.stringify({ userId: 'user-1', accountId: 'account-1', revision: 10 })
  })
  assert.equal(first.length, 1)
  assert.equal(second.length, 2)
  await broker.close()
})

test('subscriber failures are isolated from the remaining fanout', async () => {
  const client = createClient()
  const warnings = []
  const broker = createEmailMailboxEventBroker({
    poolInstance: createPool([client]),
    logger: { warn(value) { warnings.push(value) } }
  })
  const received = []
  broker.subscribe({ onEvent() { throw new Error('consumer failed') } })
  broker.subscribe({ onEvent(event) { received.push(event) } })
  await broker.start()

  client.emit('notification', {
    channel: CHANNEL,
    payload: JSON.stringify({ userId: 'user-1', accountId: 'account-1' })
  })

  assert.equal(received.length, 1)
  assert.equal(warnings.length, 1)
  await broker.close()
})

test('listener errors notify subscribers, release the session and permit restart', async () => {
  const firstClient = createClient()
  const secondClient = createClient()
  const pool = createPool([firstClient, secondClient])
  const broker = createEmailMailboxEventBroker({ poolInstance: pool })
  const errors = []
  const events = []
  broker.subscribe({
    onEvent(event) { events.push(event) },
    onError(error) { errors.push(error) }
  })
  await broker.start()

  const failure = new Error('postgres connection lost')
  firstClient.emit('error', failure)
  await tick()

  assert.deepEqual(errors, [failure])
  assert.deepEqual(firstClient.releases, [failure])
  assert.equal(broker.active, false)
  assert.equal(firstClient.listenerCount('notification'), 0)

  await broker.start()
  secondClient.emit('notification', {
    channel: CHANNEL,
    payload: JSON.stringify({ userId: 'user-1', accountId: 'account-1', revision: 2 })
  })
  assert.equal(pool.connectCalls, 2)
  assert.equal(events.length, 1)
  await broker.close()
})

test('listener end is treated as connection loss and permits restart', async () => {
  const firstClient = createClient()
  const secondClient = createClient()
  const pool = createPool([firstClient, secondClient])
  const broker = createEmailMailboxEventBroker({ poolInstance: pool })
  const errors = []
  broker.subscribe({ onError(error) { errors.push(error) } })
  await broker.start()

  firstClient.emit('end')
  await tick()

  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /listener ended/)
  assert.equal(broker.active, false)
  await broker.start()
  assert.equal(pool.connectCalls, 2)
  await broker.close()
})

test('close UNLISTENs and releases exactly once, then broker can restart', async () => {
  const firstClient = createClient()
  const secondClient = createClient()
  const pool = createPool([firstClient, secondClient])
  const broker = createEmailMailboxEventBroker({ poolInstance: pool })
  await broker.start()

  await Promise.all([broker.close(), broker.close()])

  assert.deepEqual(firstClient.queries, [
    `LISTEN "${CHANNEL}"`,
    `UNLISTEN "${CHANNEL}"`
  ])
  assert.equal(firstClient.releases.length, 1)
  assert.equal(broker.active, false)

  await broker.restart()
  assert.equal(broker.active, true)
  assert.equal(pool.connectCalls, 2)
  await broker.close()
  assert.equal(secondClient.releases.length, 1)
})

test('LISTEN startup failure releases the client and a later start can recover', async () => {
  const failure = new Error('LISTEN denied')
  const failedClient = createClient({ queryError: failure })
  const recoveredClient = createClient()
  const pool = createPool([failedClient, recoveredClient])
  const broker = createEmailMailboxEventBroker({ poolInstance: pool })

  await assert.rejects(broker.start(), /LISTEN denied/)
  assert.deepEqual(failedClient.releases, [failure])
  assert.equal(broker.active, false)

  await broker.start()
  assert.equal(broker.active, true)
  assert.equal(pool.connectCalls, 2)
  await broker.close()
})
