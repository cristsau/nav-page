import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const LIMITS = Object.freeze({ budgetBytes: 5_000_000_000, maxPoints: 3, maxUploadBytes: 1_000_000_000 })
const MAX_REPORT_BYTES = 65_536
const MAX_AGE_MS = 30 * 60 * 1000
const uint = value => Number.isSafeInteger(value) && value >= 0
const bool = value => typeof value === 'boolean'
const timestamp = value => typeof value === 'string' && value.length <= 30 && Number.isFinite(Date.parse(value))
const unavailable = state => ({ state, report: null, limits: LIMITS })

function points(input, local) {
  if (!Array.isArray(input) || input.length > 100) throw new Error('invalid_points')
  const seen = new Set()
  return input.map(p => {
    const idPattern = local ? /^nav-\d{8}T\d{6}Z-(?:[a-f0-9]{7,40}|nogit)$/ : /^[a-f0-9]{32}$/
    const states = local ? ['manifest_checked'] : ['uploaded', 'download_verified', 'restore_verified']
    if (!p || typeof p.id !== 'string' || !idPattern.test(p.id) || seen.has(p.id) || !uint(p.bytes) || !timestamp(p.createdAt) || !states.includes(p.state)) throw new Error('invalid_point')
    seen.add(p.id)
    return { id: p.id, bytes: p.bytes, createdAt: new Date(p.createdAt).toISOString(), state: p.state }
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

// Reconstruct an allowlisted public response. Never return a host document wholesale.
export function sanitizeDropboxBackupStatus(input, now = Date.now()) {
  try {
    if (!input || input.version !== 1 || !timestamp(input.generatedAt)) return unavailable('invalid_report')
    const age = now - Date.parse(input.generatedAt)
    if (age < -60_000) return unavailable('invalid_report')
    const local = input.local, cloud = input.cloud
    if (!local || !cloud || !['checked', 'unavailable'].includes(local.state) || local.keepCount !== 3
      || !bool(local.pruneConfigured) || !['valid', 'not_initialized'].includes(cloud.ledgerState)
      || !bool(cloud.uploadConfigured) || !bool(cloud.credentialsPresent) || !bool(cloud.recipientConfigured)
      || !uint(cloud.recordedBytes) || !uint(cloud.pendingUploads)
      || input.remoteInventoryChecked !== false || input.independentCopyVerified !== null || input.scheduleEnabled !== null
      || Object.keys(LIMITS).some(key => input.limits?.[key] !== LIMITS[key])) return unavailable('invalid_report')
    const localPoints = points(local.points, true), cloudPoints = points(cloud.points, false)
    if (local.state === 'unavailable' && localPoints.length) return unavailable('invalid_report')
    if (cloud.ledgerState === 'not_initialized' && (cloudPoints.length || cloud.pendingUploads || cloud.recordedBytes)) return unavailable('invalid_report')
    if (cloudPoints.reduce((sum, p) => sum + p.bytes, 0) !== cloud.recordedBytes) return unavailable('invalid_report')
    return { state: age > MAX_AGE_MS ? 'stale' : 'available', limits: LIMITS, report: {
      generatedAt: new Date(input.generatedAt).toISOString(),
      local: { state: local.state, keepCount: 3, pruneConfigured: local.pruneConfigured, points: localPoints },
      cloud: { ledgerState: cloud.ledgerState, uploadConfigured: cloud.uploadConfigured, credentialsPresent: cloud.credentialsPresent,
        recipientConfigured: cloud.recipientConfigured, recordedBytes: cloud.recordedBytes, pendingUploads: cloud.pendingUploads, points: cloudPoints },
      independentCopyVerified: null, scheduleEnabled: null, remoteInventoryChecked: false
    } }
  } catch { return unavailable('invalid_report') }
}

export async function readDropboxBackupStatus(directory, { now = Date.now() } = {}) {
  if (!directory || !isAbsolute(directory)) return unavailable('not_connected')
  let handle
  try {
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink()) return unavailable('invalid_report')
    const path = join(directory, 'dropbox-status.json')
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_REPORT_BYTES) return unavailable('invalid_report')
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const stat = await handle.stat()
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_REPORT_BYTES) return unavailable('invalid_report')
    // A bounded read also protects against a file growing after stat().
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_REPORT_BYTES) return unavailable('invalid_report')
    return sanitizeDropboxBackupStatus(JSON.parse(buffer.subarray(0, length).toString('utf8')), now)
  } catch (error) { return unavailable(error.code === 'ENOENT' ? 'not_connected' : 'invalid_report') }
  finally { await handle?.close() }
}
