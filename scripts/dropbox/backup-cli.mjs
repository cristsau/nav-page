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
import { BackupError, POLICY, planUpload, planRetention, validateLedger, fail, validId } from './backup-policy.mjs'

async function privatePath(path, directory = false) {
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
async function readPrivate(path, limit) {
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

export async function main(args) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('linux_operator_root_required')
  const [operation, configPath, parameter] = args
  if (!['init-local', 'plan', 'backup', 'list', 'download', 'retention-plan', 'local-retention-plan', 'prune-local'].includes(operation)
    || args.length > 3 || !configPath) fail('usage_operation_config_optional_snapshot_or_id')
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
    if (operation === 'init-local') {
      await saveLedger(file, { version: 1, points: [], pending: [] }, true)
      return { state: 'LOCAL_LEDGER_INITIALIZED', cloudAccess: false }
    }
    const ledger = validateLedger(await readPrivate(file, 2_000_000))
    if (operation === 'retention-plan') return planRetention(ledger)
    if (operation === 'list') return { points: ledger.points.map(({ id, bytes, state, createdAt }) => ({ id, bytes, state, createdAt })), unresolvedUploads: ledger.pending.length, limits: POLICY }
    if (operation === 'backup' && config.allowUpload !== true) fail('upload_not_enabled')
    const client = new DropboxClient(await readPrivate(config.credentialsFile, 32_768))
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
    if (operation === 'plan') return { ...planUpload(ledger, await client.inventory(), snapshot.reservedBytes), source: snapshot, cloudWrite: false }
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
