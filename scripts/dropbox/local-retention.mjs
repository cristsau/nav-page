// Local canonical snapshots ONLY. The caller must hold nav-backup.lock throughout.
import { lstat, readdir, realpath, readFile, rm } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { inspectSnapshot, SNAPSHOT_NAME } from './backup-archive.mjs'
import { fail } from './backup-policy.mjs'

const KEEP = 3
async function safeRoot(root) {
  if (typeof root !== 'string' || resolve(root) !== root || root.split(/[\\/]/).filter(Boolean).length < 3
    || ['/var/backups', '/var/lib', '/opt', '/home', '/root', '/tmp'].includes(root)) fail('unsafe_retention_root')
  const equivalent = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!equivalent(await realpath(root), root)) fail('unsafe_retention_root')
  let path = root
  while (true) {
    const s = await lstat(path)
    if (!s.isDirectory() || s.isSymbolicLink() || (process.platform !== 'win32' && (s.uid !== 0 || (s.mode & 0o022)))) fail('unsafe_retention_root')
    if (dirname(path) === path) break
    path = dirname(path)
  }
  if (process.platform === 'linux') {
    // Do not traverse nested mountpoints, including bind mounts on the same device.
    const mounts = await readFile('/proc/self/mountinfo', 'utf8')
    for (const line of mounts.trim().split('\n')) {
      const mount = line.split(' ')[4]?.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)))
      if (mount?.startsWith(root + '/')) fail('nested_mount_in_backup_root')
    }
  }
}

async function names(root) {
  const result = [], timestamps = new Set()
  for (const name of await readdir(root)) {
    if (name.startsWith('.nav-backup.')) fail('unfinished_local_snapshot')
    if (!name.startsWith('nav-')) continue // never delete unrelated entries
    const match = SNAPSHOT_NAME.exec(name)
    if (!match) fail('unexpected_local_snapshot_name')
    const timestamp = match[1]
    const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}.000Z`
    const date = new Date(iso)
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso || timestamps.has(timestamp)) fail('ambiguous_snapshot_order')
    timestamps.add(timestamp)
    const s = await lstat(join(root, name))
    if (!s.isDirectory() || s.isSymbolicLink()) fail('unsafe_retention_candidate')
    result.push(name)
  }
  return result.sort().reverse()
}

export async function planLocalRetention(root) {
  await safeRoot(root)
  const ordered = await names(root)
  const snapshots = []
  // Verify the whole proposed set before any deletion; malformed old files also stop pruning.
  for (const name of ordered) {
    const path = join(root, name), s = await lstat(path)
    const checked = await inspectSnapshot(root, path)
    snapshots.push({ name, manifestHash: checked.manifestHash, bytes: checked.sourceBytes, dev: s.dev, ino: s.ino })
  }
  return { keepCount: KEEP, keep: snapshots.slice(0, KEEP), remove: snapshots.slice(KEEP), cloudWrite: false }
}

export async function pruneLocalRetention(root, { enabled = false } = {}) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('linux_operator_root_required')
  if (!enabled) fail('local_prune_not_enabled')
  const plan = await planLocalRetention(root), removed = []
  for (const candidate of plan.remove) {
    await safeRoot(root)
    const expected = [...plan.keep, ...plan.remove].map(s => s.name).filter(n => !removed.includes(n))
    if (JSON.stringify(await names(root)) !== JSON.stringify(expected)) fail('local_snapshots_changed')
    // A newly corrupted keeper cannot authorize deletion of an older usable copy.
    for (const item of [...plan.keep, candidate]) {
      const path = join(root, item.name), stat = await lstat(path)
      if (dirname(path) !== root || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino
        || (await inspectSnapshot(root, path)).manifestHash !== item.manifestHash) fail('local_snapshots_changed')
    }
    const target = join(root, candidate.name)
    if (dirname(target) !== root || await realpath(target) !== target) fail('unsafe_retention_candidate')
    await rm(target, { recursive: true, force: false, maxRetries: 0 }) // exact verified direct child only
    removed.push(candidate.name)
  }
  return { state: 'LOCAL_RETENTION_COMPLETE', keepCount: KEEP, kept: plan.keep.map(s => s.name), removed, cloudWrite: false }
}
