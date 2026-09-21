// Metadata only: no OAuth, network access, decryption, deletion or scheduler changes.
import { POLICY, validateLedger, planRetention } from './backup-policy.mjs'
import { SNAPSHOT_NAME } from './backup-archive.mjs'

export function createBackupStatus({ config, ledger = null, localPlan = null, credentialsPresent = false, now = new Date() }) {
  if (ledger) validateLedger(ledger)
  const localPoints = [...(localPlan?.keep || []), ...(localPlan?.remove || [])].map(point => {
    const match = SNAPSHOT_NAME.exec(point.name)
    if (!match || !Number.isSafeInteger(point.bytes) || point.bytes < 0) throw new Error('invalid_local_status')
    const t = match[1]
    return { id: point.name, bytes: point.bytes,
      createdAt: new Date(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`).toISOString(),
      state: 'manifest_checked' }
  })
  const points = (ledger?.points || []).map(({ id, bytes, state, createdAt }) => ({ id, bytes, state, createdAt }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  let retention = { reason: 'not_initialized', protectedIds: [], eligibleIds: [] }
  if (ledger) {
    if (ledger.pending.length || ledger.pendingDeletes?.length) retention = { reason: 'needs_reconciliation', protectedIds: points.map(p => p.id), eligibleIds: [] }
    else {
      const plan = planRetention(ledger)
      const needed = Math.max(0, points.length - 2)
      const eligibleIds = [...plan.candidates].reverse().slice(0, needed).map(p => p.id)
      retention = { reason: plan.reason === 'no_verified_restore' ? 'no_verified_restore'
        : eligibleIds.length < needed ? 'protected_limit' : needed ? 'ready' : 'not_required', protectedIds: plan.protectedIds, eligibleIds }
    }
  }
  return {
    version: 1, generatedAt: now.toISOString(), limits: POLICY,
    local: { state: localPlan ? 'checked' : 'unavailable', keepCount: 3,
      pruneConfigured: config.allowLocalPrune === true, points: localPoints },
    cloud: { ledgerState: ledger ? 'valid' : 'not_initialized',
      uploadConfigured: config.allowUpload === true, credentialsPresent: credentialsPresent === true,
      recipientConfigured: /^age1[0-9a-z]{58}$/.test(config.ageRecipient || ''),
      pruneConfigured: config.allowCloudPrune === true, pendingDeletes: ledger?.pendingDeletes?.length || 0, retention,
      recordedBytes: points.reduce((sum, p) => sum + p.bytes, 0),
      pendingUploads: ledger?.pending.length || 0, points },
    // This report cannot establish an independent offline copy or a running schedule.
    // Those facts must never be inferred from an upload flag or a local file.
    independentCopyVerified: null, scheduleEnabled: null, remoteInventoryChecked: false
  }
}
