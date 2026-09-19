import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackupStatus } from '../../scripts/dropbox/backup-status.mjs'
import { sanitizeDropboxBackupStatus, readDropboxBackupStatus } from '../src/lib/dropboxBackupStatus.js'

const now = Date.parse('2026-09-19T03:00:00Z')
function fixture(overrides = {}) {
  return createBackupStatus({
    config: { allowUpload: false, allowLocalPrune: true }, now: new Date(now),
    localPlan: { keep: [{ name: 'nav-20260919T020000Z-nogit', bytes: 1234 }], remove: [] }, ...overrides
  })
}
const point = { id: 'a'.repeat(32), bytes: 123, state: 'download_verified', createdAt: new Date(now).toISOString(),
  sha256: 'b'.repeat(64), contentHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64), remoteId: 'id:opaque', rev: 'a'.repeat(9) }

test('operator report and API schema agree; missing ledger is distinct from no files', () => {
  const result = sanitizeDropboxBackupStatus(fixture(), now)
  assert.equal(result.state, 'available')
  assert.equal(result.report.local.points[0].createdAt, '2026-09-19T02:00:00.000Z')
  assert.equal(result.report.cloud.ledgerState, 'not_initialized')
  assert.equal(result.report.cloud.uploadConfigured, false)
  assert.equal(result.report.independentCopyVerified, null)
  assert.equal(result.report.scheduleEnabled, null)
  assert.equal(result.report.remoteInventoryChecked, false)
})
test('download verification is not upgraded to restore verification', () => {
  const result = sanitizeDropboxBackupStatus(fixture({ ledger: { version: 1, points: [point], pending: [] } }), now)
  assert.equal(result.report.cloud.points[0].state, 'download_verified')
  assert.equal(result.report.cloud.recordedBytes, 123)
})
test('stale and future-dated reports cannot be current success', () => {
  assert.equal(sanitizeDropboxBackupStatus(fixture(), now + 1_800_001).state, 'stale')
  assert.equal(sanitizeDropboxBackupStatus(fixture(), now - 60_001).state, 'invalid_report')
})
test('status generator and reader discard secrets, paths, remote IDs and arbitrary fields', () => {
  const report = fixture({ config: { refreshToken: 'NEVER_RETURN_SECRET', credentialsFile: '/etc/private' },
    ledger: { version: 1, points: [{ ...point, secret: 'NEVER_RETURN_SECRET' }], pending: [] } })
  report.token = 'NEVER_RETURN_SECRET'
  report.cloud.accountEmail = 'NEVER_RETURN_SECRET'
  report.cloud.points[0].remoteId = 'NEVER_RETURN_SECRET'
  const output = JSON.stringify(sanitizeDropboxBackupStatus(report, now))
  assert.ok(!output.includes('NEVER_RETURN_SECRET'))
  assert.ok(!output.includes('/etc/private'))
})
test('malformed, contradictory, duplicate and oversized collections fail closed', () => {
  const changes = [
    r => { r.local.keepCount = 10 }, r => { r.limits.budgetBytes = 1e12 },
    r => { r.local.points[0].bytes = -1 }, r => { r.local.points[0].id = '../../secrets' },
    r => { r.local.state = 'unavailable' }, r => { r.cloud.recordedBytes = 1 },
    r => { r.cloud.pendingUploads = 1 }, r => { r.cloud.credentialsPresent = 'true' },
    r => { r.local.points.push(r.local.points[0]) }, r => { r.local.points = Array(101).fill(r.local.points[0]) },
    r => { r.scheduleEnabled = true }, r => { r.independentCopyVerified = true },
    r => { r.remoteInventoryChecked = true }, r => { r.version = 2 },
    r => { r.local.points[0].state = 'restore_verified' }, r => { r.generatedAt = 'bad' }
  ]
  for (const change of changes) {
    const r = structuredClone(fixture()); change(r)
    assert.deepEqual(sanitizeDropboxBackupStatus(r, now).report, null)
  }
})
test('missing or failed local checks do not imply zero healthy backups', () => {
  const result = sanitizeDropboxBackupStatus(fixture({ localPlan: null }), now)
  assert.equal(result.report.local.state, 'unavailable')
  assert.deepEqual(result.report.local.points, [])
})
test('file reader is bounded, rejects directories, hardlinks, malformed JSON and absent configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-dropbox-status-'))
  const path = join(dir, 'dropbox-status.json')
  try {
    assert.equal((await readDropboxBackupStatus('')).state, 'not_connected')
    assert.equal((await readDropboxBackupStatus('relative')).state, 'not_connected')
    assert.equal((await readDropboxBackupStatus(dir)).state, 'not_connected')
    await writeFile(path, JSON.stringify(fixture()))
    assert.equal((await readDropboxBackupStatus(dir, { now })).state, 'available')
    await link(path, join(dir, 'hardlink'))
    assert.equal((await readDropboxBackupStatus(dir, { now })).state, 'invalid_report')
    await rm(join(dir, 'hardlink'))
    await writeFile(path, '{')
    assert.equal((await readDropboxBackupStatus(dir, { now })).state, 'invalid_report')
    await writeFile(path, 'x'.repeat(65_537))
    assert.equal((await readDropboxBackupStatus(dir, { now })).state, 'invalid_report')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('symbolic reports and symbolic directories are refused', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-dropbox-link-'))
  try {
    await writeFile(join(dir, 'real.json'), JSON.stringify(fixture()))
    await symlink(join(dir, 'real.json'), join(dir, 'dropbox-status.json'))
    assert.equal((await readDropboxBackupStatus(dir, { now })).state, 'invalid_report')
    await symlink(dir, join(dir, 'alias'))
    assert.equal((await readDropboxBackupStatus(join(dir, 'alias'), { now })).state, 'invalid_report')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
