import test from 'node:test'
import assert from 'node:assert/strict'
import { planCloudRetention, pruneCloudRetention } from './cloud-retention.mjs'
import { artifactPath, planUpload, validateLedger } from './backup-policy.mjs'
import { DropboxClient } from './backup-client.mjs'
import { SCOPES } from './oauth.mjs'

const point = (i, restored = false) => ({ id: String(i).repeat(32), remoteId: `id:fixture${i}`, rev: 'abcdef123', bytes: 100,
  sha256: 'a'.repeat(64), contentHash: 'b'.repeat(64), manifestHash: 'c'.repeat(64), createdAt: `2026-09-${10 + i}T00:00:00Z`,
  state: restored ? 'restore_verified' : 'download_verified', ...(restored ? { restoreReceiptHash: 'd'.repeat(64), restoredAt: '2026-09-20T00:00:00Z' } : {}) })
const file = p => ({ '.tag': 'file', id: p.remoteId, path_lower: artifactPath(p.id), rev: p.rev, size: p.bytes, content_hash: p.contentHash })
function fixture() {
  let ledger = { version: 1, points: [point(1), point(2, true), point(3)], pending: [] }
  let files = ledger.points.map(file), saves = [], deletes = []
  const client = { inventory: async () => structuredClone(files), deleteBackup: async p => {
    assert.equal(ledger.pendingDeletes[0].id, p.id); deletes.push(p.id); files = files.filter(f => f.id !== p.remoteId)
  } }
  return { get ledger() { return structuredClone(ledger) }, get files() { return files }, saves, deletes, client,
    saveLedger: async next => { ledger = structuredClone(next); saves.push(ledger) } }
}
test('rotation prepares one slot, preserves newest two and restore proof; normal prune keeps three', () => {
  const f = fixture()
  assert.equal(planCloudRetention(f.ledger, f.files).candidates.length, 0)
  const plan = planCloudRetention(f.ledger, f.files, { reserveBytes: 200 })
  assert.deepEqual(plan.candidates.map(p => p.id), [point(1).id]); assert.equal(plan.remainingCount, 2)
  assert.ok(plan.protectedIds.includes(point(2).id)); assert.ok(plan.protectedIds.includes(point(3).id))
})
test('cleanup is disabled by default and blocked until a full restore proof exists', async () => {
  const f = fixture()
  await assert.rejects(pruneCloudRetention({ ...f, enabled: false }), /cloud_prune_not_enabled/)
  const ledger = { version: 1, points: [point(1), point(2), point(3)], pending: [] }
  await assert.rejects(pruneCloudRetention({ client: f.client, ledger, saveLedger: f.saveLedger, enabled: true }), /verified_restore_required/)
  assert.equal(f.deletes.length, 0)
})
test('restored oldest plus newest two may protect all three; never discard that proof to meet a count', () => {
  const ledger = { version: 1, points: [point(1, true), point(2), point(3)], pending: [] }
  assert.throws(() => planCloudRetention(ledger, ledger.points.map(file), { reserveBytes: 1 }), /protected_backups_prevent_rotation/)
})
test('exact inventory validation and projected capacity happen before any deletion', async () => {
  for (const kind of ['unknown', 'changed', 'over-budget', 'reservation']) {
    const f = fixture()
    if (kind === 'unknown') f.files.push({ ...file(point(4)), path_lower: '/nav-backups-v1/unknown.tar.age' })
    if (kind === 'changed') f.files[0].rev = 'fffffffff'
    if (kind === 'over-budget') f.files.push({ ...file(point(4)), size: 5_000_000_001, path_lower: '/other.bin' })
    await assert.rejects(pruneCloudRetention({ ...f, enabled: true, reserveBytes: kind === 'reservation' ? 1_000_000_001 : 200 }))
    assert.equal(f.deletes.length, 0); assert.equal(f.saves.length, 0)
  }
})
test('successful rotation journals the exact revision before delete and durably removes only it', async () => {
  const f = fixture(), result = await pruneCloudRetention({ ...f, enabled: true, reserveBytes: 200 })
  assert.deepEqual(result.result.removed, [point(1).id]); assert.equal(result.ledger.points.length, 2)
  assert.equal(f.saves.length, 2); assert.equal(f.saves[0].pendingDeletes[0].rev, point(1).rev)
  assert.equal(f.saves[1].pendingDeletes.length, 0)
  assert.doesNotThrow(() => planUpload(f.ledger, f.files, 200))
})
test('lost deletion receipt retains a blocking journal; subsequent run cannot retry or upload', async () => {
  const f = fixture(), del = f.client.deleteBackup
  f.client.deleteBackup = async p => { await del(p); throw Error('NETWORK_LOST_AFTER_DELETE') }
  await assert.rejects(pruneCloudRetention({ ...f, enabled: true, reserveBytes: 200 }))
  assert.equal(f.ledger.pendingDeletes.length, 1)
  await assert.rejects(pruneCloudRetention({ ...f, enabled: true, reserveBytes: 200 }), /pending_delete_requires_reconciliation/)
  assert.throws(() => planUpload(f.ledger, f.files, 200), /pending_delete_requires_reconciliation/)
  assert.equal(f.deletes.length, 1)
})
test('journal write failure cannot cause deletion', async () => {
  const f = fixture()
  await assert.rejects(pruneCloudRetention({ ...f, saveLedger: async () => { throw Error('DISK_FULL') }, enabled: true, reserveBytes: 200 }))
  assert.equal(f.deletes.length, 0)
})
test('false delete receipt and changed surviving files both block final ledger success', async () => {
  for (const variant of ['still-present', 'changed-survivor']) {
    const f = fixture(), del = f.client.deleteBackup
    f.client.deleteBackup = async p => {
      if (variant === 'changed-survivor') { await del(p); f.files[0].rev = 'fffffffff' }
    }
    await assert.rejects(pruneCloudRetention({ ...f, enabled: true, reserveBytes: 200 }))
    assert.equal(f.ledger.pendingDeletes.length, 1)
  }
})
test('invalid journals and missing/invalid restore receipts are rejected', () => {
  const f = fixture()
  for (const journal of [[{}], [{ id: point(1).id, remoteId: 'id:other', rev: 'abcdef123', createdAt: new Date().toISOString() }], 'bad']) {
    assert.throws(() => validateLedger({ ...f.ledger, pendingDeletes: journal }), /invalid_pending_delete/)
  }
  const ledger = f.ledger; delete ledger.points[1].restoreReceiptHash
  assert.throws(() => validateLedger(ledger), /invalid_restore_receipt/)
})
test('Dropbox delete uses ID plus revision, validates receipt and never retries ambiguous writes', async () => {
  const p = point(1)
  for (const mode of ['ok', 'bad', 'lost']) {
    let calls = 0
    const client = new DropboxClient({ schema_version: 1, provider: 'dropbox', client_id: 'SyntheticApp123', refresh_token: 'TEST_ONLY', account_id: 'dbid:SYNTHETIC', scopes: [...SCOPES] }, { fetchImpl: async (url, options) => {
      const result = v => new Response(JSON.stringify(v))
      if (url.endsWith('/oauth2/token')) return result({ access_token: 'TEST_ACCESS', token_type: 'bearer', expires_in: 3600 })
      if (url.endsWith('/users/get_current_account')) return result({ account_id: 'dbid:SYNTHETIC' })
      assert.ok(url.endsWith('/files/delete_v2')); calls++
      assert.deepEqual(JSON.parse(options.body), { path: p.remoteId, parent_rev: p.rev })
      if (mode === 'lost') throw Error('LOST')
      return result({ metadata: { ...file(p), ...(mode === 'bad' ? { rev: 'fffffffff' } : {}) } })
    } })
    if (mode === 'ok') assert.equal((await client.deleteBackup(p)).deleted, true)
    else await assert.rejects(client.deleteBackup(p))
    assert.equal(calls, 1)
  }
})
