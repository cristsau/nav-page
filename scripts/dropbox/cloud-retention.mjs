import { POLICY, planRetention, validateLedger, validateRepository, fail } from './backup-policy.mjs'

// reserveBytes > 0 prepares ONE slot immediately before an authorized upload.
// Ordinary cleanup keeps up to three; rotation must never leave fewer than two,
// or remove the last restore-verified point to meet the requested count.
export function planCloudRetention(ledger, files, { reserveBytes = 0 } = {}) {
  const used = validateRepository(ledger, files)
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0 || reserveBytes > POLICY.maxUploadBytes) fail('invalid_upload_reservation')
  if (used > POLICY.budgetBytes) fail('backup_budget_exceeded')
  const retention = planRetention(ledger)
  const required = Math.max(0, ledger.points.length - (reserveBytes ? POLICY.maxPoints - 1 : POLICY.maxPoints))
  if (required && retention.reason === 'no_verified_restore') fail('verified_restore_required')
  const candidates = [...retention.candidates].reverse().slice(0, required)
  if (candidates.length !== required) fail('protected_backups_prevent_rotation')
  const remainingBytes = used - candidates.reduce((sum, p) => sum + p.bytes, 0)
  if (remainingBytes + reserveBytes > POLICY.budgetBytes) fail('backup_budget_exceeded')
  return { candidates, protectedIds: retention.protectedIds, remainingCount: ledger.points.length - required, remainingBytes, reserveBytes }
}

// Caller holds canonical backup lock. Never retry a possibly accepted deletion.
// Only exact ledger revisions in the dedicated App Folder may be removed.
export async function pruneCloudRetention({ client, ledger, saveLedger, enabled = false, reserveBytes = 0, now = () => new Date().toISOString() }) {
  if (enabled !== true) fail('cloud_prune_not_enabled')
  validateLedger(ledger)
  if (!ledger.points.some(p => p.state === 'restore_verified')) fail('verified_restore_required')
  let current = structuredClone(ledger)
  const initial = planCloudRetention(current, await client.inventory(), { reserveBytes })
  const removed = []
  for (const candidate of initial.candidates) {
    const fresh = planCloudRetention(current, await client.inventory(), { reserveBytes })
    if (!fresh.candidates.some(p => p.id === candidate.id)) fail('retention_plan_changed')
    const point = current.points.find(p => p.id === candidate.id)
    current.pendingDeletes = [{ id: point.id, remoteId: point.remoteId, rev: point.rev, createdAt: now() }]
    await saveLedger(current) // durable uncertainty BEFORE any destructive call
    await client.deleteBackup(point)
    const after = await client.inventory()
    if (after.some(p => p.id === point.remoteId)) fail('delete_receipt_requires_reconciliation')
    const next = { ...current, points: current.points.filter(p => p.id !== point.id), pendingDeletes: [] }
    validateRepository(next, after)
    await saveLedger(next); current = next; removed.push(point.id)
  }
  return { ledger: current, result: { state: 'CLOUD_RETENTION_COMPLETE', removed, remainingCount: current.points.length, restoreVerifiedPreserved: true } }
}
