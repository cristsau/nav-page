// Linux operator candidate. Local snapshot retention is separate from cloud retention.
import { constants } from 'node:fs'
import { lstat, readFile, open, rename, unlink, link, statfs } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DropboxClient } from './backup-client.mjs'
import { inspectSnapshot, encryptedArchive, verifyEncryptionTools } from './backup-archive.mjs'
import { backupJob } from './backup-job.mjs'
import { planLocalRetention, pruneLocalRetention } from './local-retention.mjs'
import { createBackupStatus } from './backup-status.mjs'
import { planCloudRetention, pruneCloudRetention } from './cloud-retention.mjs'
import { BackupError, POLICY, planUpload, planRetention, validateLedger, fail, validId } from './backup-policy.mjs'

export async function privatePath(path, directory = false) {
  if (resolve(path) !== path || path === '/') fail('unsafe_private_path')
  let current = path
  while (true) {
    const s = await lstat(current)
    if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) fail('unsafe_private_path')
    if (current === path && (directory ? !s.isDirectory() || (s.mode & 0o077) !== 0 : !s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0)) fail('unsafe_private_path')
    if (current === '/') break
    current = dirname(current)
  }
}
export async function readPrivate(path, limit) {
  await privatePath(path)
  if ((await lstat(path)).size > limit) fail('private_file_size_limit')
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { fail('invalid_private_json') }
}
async function saveLedger(file, ledger, first = false) {
  validateLedger(ledger)
  const parent = dirname(file)
  await privatePath(parent, true)
  if (!first) await privatePath(file)
  const temp = join(parent, `.ledger-${randomBytes(16).toString('hex')}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(ledger)); await handle.sync() } finally { await handle.close() }
  // First creation is no-clobber, subsequent updates are atomic under the canonical lock.
  if (first) { await link(temp, file); await unlink(temp) } else await rename(temp, file)
  const dirHandle = await open(parent, 'r')
  try { await dirHandle.sync() } finally { await dirHandle.close() }
}
async function canonicalLock() {
  // Same lock as nav-backup.sh / nav-restore-rehearsal.sh; inherited descriptor,
  // no shell or permission changes, and no truncation of an existing lock file.
  const parent = await lstat('/run/lock')
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0
    || ((parent.mode & 0o022) && !(parent.mode & 0o1000))) fail('unsafe_lock_directory')
  const handle = await open('/run/lock/nav-backup.lock', constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1) fail('unsafe_lock_file')
    const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] })
    if (result.status !== 0) fail('backup_or_restore_already_running')
    return handle
  } catch (e) { await handle.close(); throw e }
}

async function publishStatus(directory, report) {
  await privatePath(directory, true)
  const target = join(directory, 'dropbox-status.json')
  try { await privatePath(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const content = JSON.stringify(report)
  if (Buffer.byteLength(content) > 65_536) fail('status_report_size_limit')
  const temp = join(directory, `.dropbox-status-${randomBytes(16).toString('hex')}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await rename(temp, target)
    const dirHandle = await open(directory, 'r')
    try { await dirHandle.sync() } finally { await dirHandle.close() }
  } catch (error) { await unlink(temp).catch(() => {}); throw error }
  return { state: 'STATUS_REPORT_PUBLISHED', generatedAt: report.generatedAt, cloudAccess: false }
}

// Host-only read path. Streams ciphertext and verifies the recorded revision;
// never decrypts or accepts a caller-selected filesystem path.
export async function readBackupCiphertext(configPath, id, consume) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('linux_operator_root_required')
  if (!validId(id)) fail('invalid_backup_id')
  const config = await readPrivate(configPath, 16_384)
  await privatePath(config.stateDirectory, true)
  const lock = await canonicalLock()
  try {
    const ledger = validateLedger(await readPrivate(join(config.stateDirectory, 'ledger.json'), 2_000_000))
    const point = ledger.points.find(p => p.id === id)
    if (!point || point.bytes > POLICY.maxUploadBytes) fail('unknown_or_oversize_backup')
    const client = new DropboxClient(await readPrivate(config.credentialsFile, 32_768))
    return await consume(point, write => client.download(point, write))
  } finally { await lock.close() }
}

export async function main(args) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('linux_operator_root_required')
  const [operation, configPath, parameter] = args
  if (!['init-local', 'plan', 'backup', 'list', 'status', 'publish-status', 'download', 'verify', 'retention-plan', 'local-retention-plan', 'prune-local', 'prune-cloud'].includes(operation)
    || args.length > 3 || !configPath) fail('usage_operation_config_optional_snapshot_or_id')
  if (operation === 'prune-cloud' && parameter) fail('prune_cloud_does_not_accept_a_target')
  const config = await readPrivate(configPath, 16_384)
  if (config.version !== 1 || typeof config.credentialsFile !== 'string' || typeof config.stateDirectory !== 'string'
    || typeof config.backupRoot !== 'string') fail('invalid_configuration')
  await privatePath(config.stateDirectory, true)
  const lock = await canonicalLock()
  try {
    // Independent of Dropbox quota/credentials. May be called after a canonical backup succeeds.
    if (operation === 'local-retention-plan') return await planLocalRetention(config.backupRoot)
    if (operation === 'prune-local') return await pruneLocalRetention(config.backupRoot, { enabled: config.allowLocalPrune === true })
    const file = join(config.stateDirectory, 'ledger.json')
    if (operation === 'status' || operation === 'publish-status') {
      if (operation === 'publish-status' && !parameter) fail('status_output_directory_required')
      let ledger = null, credentialsPresent = false, localPlan = null
      try { ledger = validateLedger(await readPrivate(file, 2_000_000)) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      try { await privatePath(config.credentialsFile); credentialsPresent = true }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      // Failed local verification is explicit; never expose paths or raw errors.
      try { localPlan = await planLocalRetention(config.backupRoot) } catch { /* unavailable */ }
      const report = createBackupStatus({ config, ledger, localPlan, credentialsPresent })
      return operation === 'publish-status' ? await publishStatus(parameter, report) : report
    }
    if (operation === 'init-local') {
      await saveLedger(file, { version: 1, points: [], pending: [] }, true)
      return { state: 'LOCAL_LEDGER_INITIALIZED', cloudAccess: false }
    }
    let ledger = validateLedger(await readPrivate(file, 2_000_000))
    if (operation === 'retention-plan') return planRetention(ledger)
    if (operation === 'list') return { points: ledger.points.map(({ id, bytes, state, createdAt }) => ({ id, bytes, state, createdAt })), unresolvedUploads: ledger.pending.length, unresolvedDeletes: ledger.pendingDeletes?.length || 0, limits: POLICY }
    if (operation === 'backup' && config.allowUpload !== true) fail('upload_not_enabled')
    const client = new DropboxClient(await readPrivate(config.credentialsFile, 32_768))
    if (operation === 'verify') {
      if (!validId(parameter)) fail('invalid_backup_id')
      const point = ledger.points.find(p => p.id === parameter)
      if (!point || point.bytes > POLICY.maxUploadBytes) fail('unknown_or_oversize_backup')
      await client.download(point, async () => {})
      if (point.state !== 'restore_verified') point.state = 'download_verified'
      await saveLedger(file, ledger)
      return { state: 'CIPHERTEXT_VERIFIED', id: point.id, restoreVerified: false }
    }
    if (operation === 'prune-cloud') {
      const pruned = await pruneCloudRetention({ client, ledger, saveLedger: next => saveLedger(file, next), enabled: config.allowCloudPrune === true })
      return pruned.result
    }
    if (operation === 'download') {
      if (!validId(parameter)) fail('invalid_backup_id')
      const point = ledger.points.find(p => p.id === parameter)
      if (!point) fail('unknown_backup')
      const space = await statfs(config.stateDirectory, { bigint: true })
      if (space.bavail * space.bsize < BigInt(point.bytes) + 256n * 1024n * 1024n) fail('local_download_space_insufficient')
      const output = join(config.stateDirectory, `${point.id}.tar.age`)
      const temp = join(config.stateDirectory, `.download-${randomBytes(16).toString('hex')}.tmp`)
      const handle = await open(temp, 'wx', 0o600)
      let closed = false
      try {
        await client.download(point, async bytes => {
          let offset = 0
          while (offset < bytes.length) {
            const result = await handle.write(bytes, offset, bytes.length - offset)
            if (!result.bytesWritten) fail('download_write_failed')
            offset += result.bytesWritten
          }
        })
        await handle.sync(); await handle.close(); closed = true
        await link(temp, output) // no overwrite of a prior download
        await unlink(temp)
      } catch (e) {
        if (!closed) await handle.close()
        await unlink(temp).catch(() => {}) // exact newly created temp only
        throw e
      }
      return { state: 'CIPHERTEXT_DOWNLOADED_AND_VERIFIED', id: point.id, restoreVerified: false }
    }
    if (!parameter) fail('snapshot_path_required')
    const snapshot = await inspectSnapshot(config.backupRoot, parameter)
    if (operation === 'plan') {
      const files = await client.inventory()
      const rotation = config.allowCloudPrune === true && ledger.points.length >= POLICY.maxPoints
      return { ...(rotation ? planCloudRetention(ledger, files, { reserveBytes: snapshot.reservedBytes }) : planUpload(ledger, files, snapshot.reservedBytes)),
        requiresCleanup: rotation, source: snapshot, cloudWrite: false }
    }
    const encryptionTools = { age: config.ageExecutable || '/usr/bin/age' }
    if (resolve(encryptionTools.age) !== encryptionTools.age) fail('unsafe_age_executable')
    let executablePath = encryptionTools.age
    while (true) {
      const s = await lstat(executablePath)
      if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) fail('unsafe_age_executable')
      if (executablePath === '/') break
      executablePath = dirname(executablePath)
    }
    verifyEncryptionTools(config.ageRecipient, encryptionTools)
    // Validate the source/encryption tool before preparing capacity. Never rotate
    // merely to hide an over-budget, changed or unresolved repository.
    if (config.allowCloudPrune === true && ledger.points.length >= POLICY.maxPoints) {
      const pruned = await pruneCloudRetention({ client, ledger, saveLedger: next => saveLedger(file, next), enabled: true, reserveBytes: snapshot.reservedBytes })
      ledger = pruned.ledger
    }
    const result = await backupJob({ client, ledger, saveLedger: next => saveLedger(file, next), manifestHash: snapshot.manifestHash,
      reservedBytes: snapshot.reservedBytes, archive: encryptedArchive(parameter, config.ageRecipient, encryptionTools) })
    if (config.allowLocalPrune === true) {
      try { result.localRetention = await pruneLocalRetention(config.backupRoot, { enabled: true }) }
      catch { result.localRetention = { state: 'LOCAL_RETENTION_BLOCKED', attentionRequired: true } }
    }
    return result
  } finally { await lock.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ status: 'BACKUP_NOT_COMPLETED', code: error instanceof BackupError ? error.message : 'local_operation_failed', secretsLogged: false }))
    process.exitCode = 1
  })
}
