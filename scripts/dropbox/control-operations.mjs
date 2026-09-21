import { join } from 'node:path'
import { SNAPSHOT_NAME } from './backup-archive.mjs'

// Fixed workflow adapter; injected primitives make ordering/receipts testable
// without spawning a shell, using production snapshots or contacting Dropbox.
export function controlOperations({ config, settings, ledger, names, runSnapshot, backup }) {
  return {
    gates: async () => {
      const cfg = await settings(), l = await ledger(cfg), resolved = !l.pending.length && !l.pendingDeletes?.length
      return { backup: config.allowManual && cfg.allowUpload === true && resolved, verify: config.allowManual, download: config.allowDownload,
        schedule: config.allowSchedule && config.allowManual && cfg.allowUpload === true && resolved && l.points.some(p => p.state === 'restore_verified') }
    },
    execute: async (job, progress) => {
      try {
        if (job.kind === 'verify') {
          const result = await backup(['verify', config.backupConfig, job.pointId])
          return { verified: result.state === 'CIPHERTEXT_VERIFIED' }
        }
        const cfg = await settings(), before = new Set(await names(cfg.backupRoot))
        await runSnapshot()
        const added = (await names(cfg.backupRoot)).filter(n => !before.has(n) && SNAPSHOT_NAME.test(n))
        if (added.length !== 1) throw new Error('snapshot_identity_unknown')
        await progress('upload')
        const result = await backup(['backup', config.backupConfig, join(cfg.backupRoot, added[0])])
        return { verified: result.state === 'download_verified' }
      } finally {
        // A stale report must not cause a repeat of a successful cloud upload.
        await backup(['publish-status', config.backupConfig, config.statusDirectory]).catch(() => {})
      }
    }
  }
}
