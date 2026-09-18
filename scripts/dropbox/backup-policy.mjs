// Pure policy: no I/O, credentials, deletion, timers or application database writes.
export const POLICY = Object.freeze({ budgetBytes: 5_000_000_000, maxPoints: 3, maxUploadBytes: 1_000_000_000 })
export const ROOT = '/nav-backups-v1'
export class BackupError extends Error {
  constructor(code) { super(code); this.name = 'BackupError' }
}
export const fail = code => { throw new BackupError(code) }
export const uint = n => Number.isSafeInteger(n) && n >= 0
export const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
export const artifactPath = id => {
  if (!validId(id)) fail('invalid_backup_id')
  return `${ROOT}/${id}.tar.age`
}

export function validateLedger(ledger) {
  if (!ledger || ledger.version !== 1 || !Array.isArray(ledger.points) || !Array.isArray(ledger.pending)
    || ledger.points.length > 1000 || ledger.pending.length > 1000) fail('invalid_ledger')
  const ids = new Set()
  for (const p of ledger.points) {
    if (!p || !validId(p.id) || ids.has(p.id) || !uint(p.bytes) || p.bytes === 0 || !hash(p.sha256)
      || !hash(p.contentHash) || !hash(p.manifestHash) || !Number.isFinite(Date.parse(p.createdAt))
      || !['uploaded', 'download_verified', 'restore_verified'].includes(p.state)
      || typeof p.remoteId !== 'string' || !p.remoteId.startsWith('id:')
      || typeof p.rev !== 'string' || !/^[a-f0-9]{9,64}$/.test(p.rev)) fail('invalid_ledger')
    if (p.state === 'restore_verified' && (!hash(p.restoreReceiptHash) || !Number.isFinite(Date.parse(p.restoredAt)))) fail('invalid_restore_receipt')
    ids.add(p.id)
  }
  for (const p of ledger.pending) {
    if (!p || !validId(p.id) || ids.has(p.id) || !uint(p.reservedBytes) || p.reservedBytes === 0
      || !Number.isFinite(Date.parse(p.createdAt))) fail('invalid_pending_reservation')
    ids.add(p.id)
  }
  return ledger
}

// Inventory covers the entire dedicated App Folder, including unknown/staging objects.
export function inventoryBytes(files) {
  if (!Array.isArray(files)) fail('invalid_inventory')
  const seen = new Set()
  let total = 0
  for (const f of files) {
    if (f?.['.tag'] !== 'file' || !uint(f.size) || typeof f.id !== 'string'
      || typeof f.path_lower !== 'string' || seen.has(f.id)) fail('invalid_inventory')
    seen.add(f.id); total += f.size
    if (!uint(total)) fail('invalid_inventory')
  }
  return total
}

export function planUpload(ledger, files, reservedBytes) {
  validateLedger(ledger)
  if (!uint(reservedBytes) || reservedBytes < 1 || reservedBytes > POLICY.maxUploadBytes) fail('invalid_upload_reservation')
  const used = inventoryBytes(files)
  // Any pending write means a previous job is unresolved. Never expire it by wall clock alone.
  if (ledger.pending.length) fail('pending_upload_requires_reconciliation')
  for (const p of ledger.points) {
    const f = files.find(f => f.id === p.remoteId)
    if (!f || f.path_lower !== artifactPath(p.id) || f.rev !== p.rev || f.size !== p.bytes
      || f.content_hash !== p.contentHash) fail('repository_changed_requires_reconciliation')
  }
  if (files.some(f => f.path_lower.startsWith(ROOT + '/') && !ledger.points.some(p => p.remoteId === f.id))) fail('unknown_backup_requires_reconciliation')
  if (ledger.points.length >= POLICY.maxPoints) fail('retention_review_required')
  if (used + reservedBytes > POLICY.budgetBytes) fail('backup_budget_exceeded')
  return { usedBytes: used, reservedBytes, remainingBytes: POLICY.budgetBytes - used - reservedBytes }
}

// Suggestions only. No delete API exists in this candidate. Keep at least two points,
// and never suggest deleting the newest independently restore-verified point.
export function planRetention(ledger) {
  validateLedger(ledger)
  if (ledger.pending.length) fail('pending_upload_requires_reconciliation')
  const points = [...ledger.points].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
  const verified = points.filter(p => p.state === 'restore_verified').sort((a, b) => Date.parse(b.restoredAt) - Date.parse(a.restoredAt) || a.id.localeCompare(b.id))
  if (!verified.length) return { protectedIds: points.map(p => p.id), candidates: [], reason: 'no_verified_restore' }
  const keep = new Set([verified[0].id, ...points.slice(0, 2).map(p => p.id)])
  return { protectedIds: [...keep], candidates: points.filter(p => !keep.has(p.id)).map(p => ({ id: p.id, remoteId: p.remoteId, rev: p.rev, bytes: p.bytes })), reason: 'manual_review_only' }
}
