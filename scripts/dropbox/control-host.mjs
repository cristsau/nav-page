// Linux-only operator service. Not installed/enabled by importing this module.
import { open, lstat, readdir, rename, unlink, chmod } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { main as backup, privatePath, readPrivate, readBackupCiphertext } from './backup-cli.mjs'
import { validateLedger } from './backup-policy.mjs'
import { controlOperations } from './control-operations.mjs'
import { BackupController, initialControlState, validateControlState } from './control-core.mjs'
import { createControlServer } from './control-server.mjs'

async function save(path, state, first = false) {
  validateControlState(state); await privatePath(dirname(path), true)
  if (!first) await privatePath(path)
  const temp = path + '.' + randomBytes(12).toString('hex') + '.tmp'
  const f = await open(first ? path : temp, 'wx', 0o600)
  try { await f.writeFile(JSON.stringify(state)); await f.sync() } finally { await f.close() }
  if (!first) await rename(temp, path)
  const d = await open(dirname(path), 'r'); try { await d.sync() } finally { await d.close() }
}
async function rootCode(path) {
  if (resolve(path) !== path) throw new Error('unsafe_code')
  let p = path
  while (true) {
    const s = await lstat(p)
    if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) || (p === path && !s.isFile())) throw new Error('unsafe_code')
    if (p === '/') break
    p = dirname(p)
  }
}
async function takeLease() {
  const parent = await lstat('/run/lock')
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || ((parent.mode & 0o022) && !(parent.mode & 0o1000))) throw new Error('unsafe_lock')
  const h = await open('/run/lock/nav-dropbox-control.lock', constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  const s = await h.stat()
  if (!s.isFile() || s.uid !== 0 || s.nlink !== 1 || spawnSync('/usr/bin/flock', ['-n', '-x', '3'], { stdio: ['ignore', 'ignore', 'ignore', h.fd] }).status !== 0) {
    await h.close(); throw new Error('controller_already_running')
  }
  return h
}
export async function startHost(configPath, initialize = false) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('linux_root_required')
  const c = await readPrivate(configPath, 16_384)
  if (c.version !== 1 || typeof c.ownerUserId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(c.ownerUserId) || typeof c.allowManual !== 'boolean' || typeof c.allowSchedule !== 'boolean'
    || typeof c.allowDownload !== 'boolean') throw new Error('invalid_control_configuration')
  for (const p of [c.stateDirectory, c.socketDirectory, c.statusDirectory]) await privatePath(p, true)
  for (const p of [c.backupConfig, c.snapshotConfig]) await privatePath(p)
  await rootCode(c.snapshotScript)
  const lease = await takeLease(), statePath = join(c.stateDirectory, 'control.json'), socketPath = join(c.socketDirectory, 'control.sock')
  if (initialize) { try { await save(statePath, initialControlState(), true); return { initialized: true } } finally { await lease.close() } }
  let server, timer
  try {
    const settings = () => readPrivate(c.backupConfig, 16_384)
    const ledger = async cfg => validateLedger(await readPrivate(join(cfg.stateDirectory, 'ledger.json'), 2_000_000))
    const operations = controlOperations({ config: c, settings, ledger, backup,
      names: async root => { await privatePath(root, true); return readdir(root) },
      runSnapshot: async () => {
        // No shell interpolation, no client paths; no legacy cloud/prune flags.
        const child = spawn('/usr/bin/bash', [c.snapshotScript, '--config', c.snapshotConfig], { stdio: 'ignore', timeout: 30 * 60_000,
          env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } })
        const [code] = await once(child, 'close')
        if (code !== 0) throw new Error('snapshot_failed')
      }
    })
    const controller = new BackupController({ state: await readPrivate(statePath, 100_000), save: s => save(statePath, s), ...operations })
    await controller.recover()
    // Dedicated singleton lock acquired before removal of an old socket inode.
    try { const s = await lstat(socketPath); if (!s.isSocket() || s.uid !== 0) throw new Error('unsafe_socket'); await unlink(socketPath) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    const transport = createControlServer({ controller, ownerUserId: c.ownerUserId,
      streamCiphertext: (id, consume) => readBackupCiphertext(c.backupConfig, id, consume) })
    server = transport.server
    // Keep a strong reference to the FileHandle for the server lifetime; an
    // unreferenced FileHandle can be garbage-collected and release flock early.
    server.once('close', () => { clearInterval(timer); void lease.close() })
    server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600)
    timer = setInterval(() => { transport.tick().catch(() => { /* fail closed; no sensitive logging */ }) }, 2000)
    // The lease is held until process exit. systemd stops the entire cgroup.
    return { started: true }
  } catch (e) { clearInterval(timer); server?.close(); await lease.close(); throw e }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || !['init', 'serve'].includes(process.argv[2])) { console.error('CONTROL_USAGE_ERROR'); process.exitCode = 1 }
  else startHost(process.argv[3], process.argv[2] === 'init').then(r => { if (r.initialized) console.log('CONTROL_INITIALIZED_DISABLED') }).catch(() => {
    console.error('CONTROL_START_FAILED'); process.exitCode = 1
  })
}
