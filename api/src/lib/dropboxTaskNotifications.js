import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { withTransaction } from '../db/index.js'
import { createNotification } from './notifications.js'
import { loadFilesConnection } from './dropboxFiles.js'
import { loadOfflineConfig, EncryptedOfflineStore, connectionIdentity } from './offlineDownloads.js'
import { loadBackupControl, backupControlClient, cleanControlStatus } from './dropboxBackupControl.js'

const ownerPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const digest = text => createHash('sha256').update(text).digest('hex')
// Persist only opaque event fingerprints. Never store cloud paths, URLs, filenames or tokens.
export function taskEvents(source, jobs) {
  if (!['offline', 'backup'].includes(source) || !Array.isArray(jobs) || jobs.length > 50) throw Error('INVALID_TASK_SNAPSHOT')
  return jobs.flatMap(job => {
    if (!/^[a-f0-9]{32,48}$/.test(job?.id || '')) throw Error('INVALID_TASK_SNAPSHOT')
    const success = ['complete', 'succeeded'].includes(job.state)
    if (!success && !['error', 'failed', 'review'].includes(job.state)) return []
    const label = source === 'offline' ? '离线下载' : job.kind === 'verify' ? '备份校验' : '加密备份'
    return [{ key: digest(`${source}:${job.id}:${job.state}`), state: job.state,
      title: `${label}${success ? '已完成' : job.state === 'review' ? '需要核对' : '未完成'}`,
      summary: success ? '任务已完成，可打开管理页查看结果。' : '请打开管理页查看原因。未确认的操作不会自动覆盖或删除文件。',
      actionUrl: source === 'offline' ? '/files?view=offline' : '/settings?section=cloud-backup' }]
  })
}

export async function deliverTaskSnapshot({ source, ownerUserId, jobs }, { transaction = withTransaction, notify = createNotification } = {}) {
  if (!ownerPattern.test(ownerUserId || '')) throw Error('INVALID_TASK_OWNER')
  const events = taskEvents(source, jobs), ledgerKey = `internal.dropbox-notifications.v1.${source}.${ownerUserId}`
  return transaction(async client => {
    const q = client.query.bind(client)
    const owner = await q("SELECT id FROM users WHERE id = $1 AND role = 'admin' AND status = 'approved'", [ownerUserId])
    if (owner.rows.length !== 1) return 0
    await q("INSERT INTO system_settings (key, value) VALUES ($1, '{\"seen\":[]}'::jsonb) ON CONFLICT (key) DO NOTHING", [ledgerKey])
    const saved = await q('SELECT value FROM system_settings WHERE key = $1 FOR UPDATE', [ledgerKey])
    const seen = saved.rows[0]?.value?.seen
    if (!Array.isArray(seen) || seen.length > 500 || seen.some(key => !/^[a-f0-9]{64}$/.test(key))) throw Error('INVALID_NOTIFICATION_LEDGER')
    let count = 0
    for (const event of events) {
      if (seen.includes(event.key)) continue
      await notify({ userId: ownerUserId, eventType: `dropbox.${source}.${event.state}`, title: event.title, summary: event.summary,
        actionUrl: event.actionUrl, sourceType: 'dropbox_task', dedupeKey: 'dropbox-task:' + event.key,
        sensitive: true, pushEnabled: false, queryFn: q })
      count++
    }
    // Atomic with insertion: deleting a notification never recreates it on the next poll/restart.
    // Retain recent receipts as well, so a briefly stale snapshot cannot undo acknowledgement.
    const current = new Set(events.map(e => e.key))
    const retained = [...seen.filter(key => !current.has(key)), ...current].slice(-500)
    await q('UPDATE system_settings SET value = $2::jsonb, updated_at = NOW() WHERE key = $1', [ledgerKey, JSON.stringify({ seen: retained })])
    return count
  })
}

export async function readTaskSnapshots(directory = config.managedIntegrationsDir) {
  const results = []
  // Isolate sources: a stopped backup controller must not suppress download results.
  try {
    const settings = await loadOfflineConfig(directory), connection = settings && await loadFilesConnection(directory)
    if (settings && connection) {
      const data = await new EncryptedOfflineStore(directory, settings.workerKey).read()
      results.push({ source: 'offline', ownerUserId: connection.ownerUserId, jobs: data.jobs.filter(j => j.identity === connectionIdentity(connection)) })
    }
  } catch { results.push({ unavailable: 'offline' }) }
  try {
    const control = await loadBackupControl(directory)
    if (control) results.push({ source: 'backup', ownerUserId: control.ownerUserId, jobs: cleanControlStatus(await backupControlClient(control).status()).jobs })
  } catch { results.push({ unavailable: 'backup' }) }
  return results
}

export function startDropboxTaskNotifications({ read = readTaskSnapshots, deliver = deliverTaskSnapshot, logger, intervalMs = 60_000 } = {}) {
  let stopped = false, pending = null, timer
  async function tick() {
    if (stopped || pending) return
    pending = (async () => {
      const snapshots = await read()
      for (const snapshot of snapshots) if (!stopped && !snapshot.unavailable) {
        try { await deliver(snapshot) } catch { logger?.warn({ code: 'DROPBOX_NOTIFICATION_RETRY' }, 'Personal task notification deferred') }
      }
    })().catch(() => logger?.warn({ code: 'DROPBOX_NOTIFICATION_RETRY' }, 'Personal task notification deferred'))
    try { await pending } finally { pending = null; if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref?.() } }
  }
  timer = setTimeout(tick, 10_000); timer.unref?.()
  return async () => { stopped = true; clearTimeout(timer); await pending }
}
