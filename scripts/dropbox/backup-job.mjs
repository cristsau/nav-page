import { randomBytes } from 'node:crypto'
import { POLICY, validateLedger, planUpload, inventoryBytes, fail, hash } from './backup-policy.mjs'

// All callers MUST hold the single-writer lock until this transaction returns.
// saveLedger is durable+atomic. An ambiguous write leaves a reservation, never a fake success.
export async function backupJob({ client, ledger, saveLedger, archive, manifestHash, reservedBytes, now = () => new Date().toISOString(), id = randomBytes(16).toString('hex') }) {
  validateLedger(ledger)
  if (!hash(manifestHash)) fail('invalid_manifest_hash')
  const before = await client.inventory()
  planUpload(ledger, before, reservedBytes)
  let next = structuredClone(ledger)
  if (next.points.some(p => p.id === id)) fail('duplicate_backup_id')
  next.pending.push({ id, reservedBytes, createdAt: now() })
  validateLedger(next)
  await saveLedger(next)
  const receipt = await client.upload(id, archive, reservedBytes, async result => {
    const fresh = await client.inventory()
    // Unknown pre-existing state must not be overwritten or considered successfully backed up.
    planUpload(ledger, fresh, reservedBytes)
    if (inventoryBytes(fresh) + result.bytes > POLICY.budgetBytes) fail('backup_budget_exceeded')
  })
  const point = { id, ...receipt, manifestHash, createdAt: now(), state: 'uploaded' }
  next = { ...next, pending: next.pending.filter(p => p.id !== id), points: [...next.points, point] }
  validateLedger(next)
  await saveLedger(next)
  // Read back the exact revision. Hash match alone does NOT establish decrypt/restore success.
  await client.download(point, async () => {})
  next = structuredClone(next)
  next.points.find(p => p.id === id).state = 'download_verified'
  await saveLedger(next)
  return { id, state: 'download_verified', bytes: point.bytes, restoreVerified: false }
}
