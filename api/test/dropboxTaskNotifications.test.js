import test from 'node:test'
import assert from 'node:assert/strict'
import { taskEvents, deliverTaskSnapshot } from '../src/lib/dropboxTaskNotifications.js'
const ownerUserId = '00000000-0000-4000-8000-000000000001'
const job = (state = 'complete') => ({ id: 'a'.repeat(32), state, name: 'PRIVATE_NAME', url: 'PRIVATE_URL', destination: 'PRIVATE_PATH' })
function harness() {
  let saved = null, approved = true, fail = false
  const delivered = []
  const transaction = async fn => {
    const before = structuredClone(saved), length = delivered.length
    try { return await fn({ query: async (sql, params) => {
      if (sql.startsWith('SELECT id')) return { rows: approved ? [{ id: ownerUserId }] : [] }
      if (sql.startsWith('INSERT INTO system_settings')) { saved ||= { seen: [] }; return { rows: [] } }
      if (sql.startsWith('SELECT value')) return { rows: [{ value: saved }] }
      if (sql.startsWith('UPDATE system_settings')) { if (fail) throw Error('DB_FAILURE'); saved = JSON.parse(params[1]); return { rows: [] } }
      throw Error('UNEXPECTED_SQL')
    } }) } catch (e) { saved = before; delivered.length = length; throw e }
  }
  return { transaction, notify: async payload => delivered.push(payload), delivered, deny: () => { approved = false }, fail: value => { fail = value } }
}
test('task notifications contain no filenames, links or private paths; only terminal work is reported', () => {
  assert.deepEqual(taskEvents('offline', [job('queued'), job('paused'), job('cancelled')]), [])
  const events = taskEvents('offline', [job(), { ...job('review'), id: 'b'.repeat(32) }])
  assert.equal(events.length, 2); assert.ok(!JSON.stringify(events).includes('PRIVATE'))
  assert.equal(events[0].actionUrl, '/files?view=offline')
  assert.match(taskEvents('backup', [{ ...job('succeeded'), kind: 'verify' }])[0].title, /校验已完成/)
  assert.throws(() => taskEvents('offline', [{ id: 'malformed', state: 'error' }]))
})
test('exact approved owner receives one durable notification, not all administrators; deletion is not recreated', async () => {
  const f = harness(), snapshot = { ownerUserId, source: 'offline', jobs: [job()] }
  assert.equal(await deliverTaskSnapshot(snapshot, f), 1)
  assert.equal(f.delivered[0].userId, ownerUserId); assert.equal(f.delivered[0].pushEnabled, false)
  f.delivered.length = 0
  assert.equal(await deliverTaskSnapshot(snapshot, f), 0); assert.equal(f.delivered.length, 0)
  await deliverTaskSnapshot({ ...snapshot, jobs: [] }, f)
  assert.equal(await deliverTaskSnapshot(snapshot, f), 0, 'briefly stale snapshot cannot resurrect a deleted notification')
  f.deny(); assert.equal(await deliverTaskSnapshot({ ...snapshot, jobs: [job('review')] }, f), 0)
})
test('notification and receipt roll back together on database failure', async () => {
  const f = harness(), snapshot = { ownerUserId, source: 'backup', jobs: [job('failed')] }
  f.fail(true); await assert.rejects(deliverTaskSnapshot(snapshot, f)); assert.equal(f.delivered.length, 0)
  f.fail(false); assert.equal(await deliverTaskSnapshot(snapshot, f), 1)
  assert.equal(await deliverTaskSnapshot(snapshot, f), 0)
})
