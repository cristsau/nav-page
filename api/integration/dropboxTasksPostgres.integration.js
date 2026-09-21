import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
const target = new URL(process.env.DATABASE_URL || 'http://invalid')
if (process.env.NODE_ENV !== 'test' || process.env.NAV_RELEASE_ACCEPTANCE_INTEGRATION_TEST !== 'true'
  || !['postgres:', 'postgresql:'].includes(target.protocol) || !['127.0.0.1', 'localhost'].includes(target.hostname)
  || target.pathname !== '/nav_release_acceptance_test' || target.search) throw Error('ISOLATED_DATABASE_REQUIRED')
const { pool } = await import('../src/db/index.js')
const { deliverTaskSnapshot } = await import('../src/lib/dropboxTaskNotifications.js')
test('real PostgreSQL task notification transaction: concurrent deduplication, rollback, deletion and owner gate', async () => {
  const owner = randomUUID(), ledger = `internal.dropbox-notifications.v1.offline.${owner}`
  try {
    await pool.query("INSERT INTO users(id,username,password_hash,role,status,approved_at) VALUES($1,$2,'ci-only-unusable-hash','admin','approved',NOW())", [owner, 'nav_media_' + randomBytes(8).toString('hex')])
    const snapshot = { source: 'offline', ownerUserId: owner, jobs: [{ id: '1'.repeat(32), state: 'complete' }] }
    assert.equal((await Promise.all([deliverTaskSnapshot(snapshot), deliverTaskSnapshot(snapshot)])).reduce((a, b) => a + b, 0), 1)
    const rows = (await pool.query('SELECT * FROM notifications WHERE user_id=$1', [owner])).rows
    assert.equal(rows.length, 1); assert.equal(rows[0].push_enabled, false); assert.equal(rows[0].action_url, '/files?view=offline')
    await pool.query('DELETE FROM notifications WHERE user_id=$1', [owner]); assert.equal(await deliverTaskSnapshot(snapshot), 0)
    const second = { ...snapshot, jobs: [{ id: '2'.repeat(32), state: 'error' }] }
    await assert.rejects(deliverTaskSnapshot(second, { notify: async () => { throw Error('SYNTHETIC_TX_FAILURE') } }))
    assert.equal(await deliverTaskSnapshot(second), 1)
    await pool.query("UPDATE users SET role='user' WHERE id=$1", [owner]); assert.equal(await deliverTaskSnapshot({ ...second, jobs: [{ id: '3'.repeat(32), state: 'complete' }] }), 0)
  } finally {
    await pool.query('DELETE FROM system_settings WHERE key=$1', [ledger]); await pool.query('DELETE FROM users WHERE id=$1', [owner]); await pool.end()
  }
})
