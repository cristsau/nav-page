import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, realpath, readlink } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fail, BackupError, POLICY } from './backup-policy.mjs'
import { BLOCK } from './backup-client.mjs'

export const SNAPSHOT_NAME = /^nav-([0-9]{8}T[0-9]{6}Z)-(?:[a-f0-9]{7,40}|nogit)$/

export async function inspectSnapshot(root, snapshot) {
  if (resolve(root) !== root || resolve(snapshot) !== snapshot || dirname(snapshot) !== root
    || !SNAPSHOT_NAME.test(basename(snapshot))) fail('invalid_snapshot_path')
  const equivalent = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!equivalent(await realpath(root), root) || !equivalent(await realpath(snapshot), snapshot)) fail('unsafe_snapshot_path')
  for (const privateRoot of [root, snapshot]) {
    const s = await lstat(privateRoot)
    if (!s.isDirectory() || s.isSymbolicLink() || (process.platform !== 'win32' && (s.uid !== 0 || (s.mode & 0o077)))) fail('unsafe_snapshot_path')
  }
  const manifestFile = join(snapshot, 'manifest.sha256')
  const manifestStat = await lstat(manifestFile)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1 || manifestStat.size > 4_000_000
    || (process.platform !== 'win32' && (manifestStat.uid !== 0 || (manifestStat.mode & 0o777) !== 0o600))) fail('invalid_snapshot_manifest')
  const manifest = await readFile(manifestFile)
  const expected = new Map()
  for (const line of manifest.toString('utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line)
    if (!match || /[\x00-\x1f\\]/.test(match[2]) || match[2].startsWith('/')
      || match[2].split('/').some(p => p === '.' || p === '..' || !p) || expected.has(match[2])) fail('invalid_snapshot_manifest')
    expected.set(match[2], match[1])
  }
  if (!expected.has('database/nav.dump') || !expected.has('metadata/tree.tsv')) fail('incomplete_snapshot')
  const metadataStat = await lstat(join(snapshot, 'metadata'))
  const treePath = join(snapshot, 'metadata/tree.tsv'), treeStat = await lstat(treePath)
  if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink() || !treeStat.isFile() || treeStat.isSymbolicLink()
    || treeStat.nlink !== 1 || treeStat.size > 8_000_000) fail('invalid_snapshot_tree')
  const tree = await readFile(treePath)
  if (createHash('sha256').update(tree).digest('hex') !== expected.get('metadata/tree.tsv')) fail('snapshot_hash_mismatch')
  const treeEntries = new Map()
  // Canonical find -P manifest includes type, mode, relative path and link target.
  for (const line of tree.toString('utf8').replace(/\n$/, '').split('\n')) {
    const fields = line.split('\t'), [type, mode, path, target] = fields
    if (fields.length !== 4 || !['f', 'd', 'l'].includes(type) || !/^[0-7]{1,4}$/.test(mode)
      || !path || /[\x00-\x1f\\]/.test(path + target) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')
      || path === 'manifest.sha256' || treeEntries.has(path) || (type !== 'l' && target) || (type === 'l' && !target)) fail('invalid_snapshot_tree')
    treeEntries.set(path, { type, mode: parseInt(mode, 8), target })
  }
  let sourceBytes = 0, entries = 0
  const snapshotDevice = (await lstat(snapshot)).dev
  const found = new Set(), seenTree = new Set()
  async function walk(relative) {
    const current = join(snapshot, relative), stat = await lstat(current)
    if (stat.dev !== snapshotDevice) fail('unsafe_snapshot_member')
    entries++
    if (entries > 100000) fail('snapshot_entry_limit')
    if (relative && relative !== 'manifest.sha256') {
      const record = treeEntries.get(relative)
      if (!record) fail(stat.isFile() ? 'unlisted_snapshot_file' : 'unsafe_snapshot_member')
      const type = stat.isSymbolicLink() ? 'l' : stat.isDirectory() ? 'd' : stat.isFile() ? 'f' : '?'
      if (record.type !== type || (process.platform !== 'win32' && record.mode !== (stat.mode & 0o7777))) fail('snapshot_tree_mismatch')
      seenTree.add(relative)
      if (type === 'l') {
        const target = await readlink(current)
        if (target !== record.target || !resolve(dirname(current), target).startsWith(snapshot + '/')
          || !(await realpath(current)).startsWith(snapshot + '/')) fail('unsafe_snapshot_symlink')
        return // preserve the link in tar; never follow it or hash its target twice
      }
    }
    if (stat.isDirectory()) {
      for (const name of await readdir(current)) await walk(relative ? `${relative}/${name}` : name)
    } else if (stat.isFile() && stat.nlink === 1) {
      sourceBytes += stat.size
      if (sourceBytes > POLICY.maxUploadBytes) fail('snapshot_size_limit')
      if (relative === 'manifest.sha256') return
      if (!expected.has(relative)) fail('unlisted_snapshot_file')
      const h = createHash('sha256')
      for await (const chunk of createReadStream(current)) h.update(chunk)
      if (h.digest('hex') !== expected.get(relative)) fail('snapshot_hash_mismatch')
      found.add(relative)
    } else fail('unsafe_snapshot_member')
  }
  await walk('')
  if (found.size !== expected.size) fail('missing_snapshot_file')
  if (seenTree.size !== treeEntries.size) fail('snapshot_tree_mismatch')
  // Conservative reservation plus streaming hard cap; no complete tar/age file on source disk.
  const reservedBytes = sourceBytes + entries * 4096 + 20 * 1024 * 1024
  return { manifestHash: createHash('sha256').update(manifest).digest('hex'), sourceBytes, entries, reservedBytes }
}

function completion(child) {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new BackupError('archive_process_unavailable')))
    child.once('close', code => code === 0 ? resolve() : reject(new BackupError('archive_process_failed')))
  })
}

export function verifyEncryptionTools(recipient, { age = '/usr/bin/age' } = {}) {
  if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(recipient)) fail('invalid_age_recipient')
  const result = spawnSync(age, ['--encrypt', '--recipient', recipient], { input: Buffer.alloc(0), stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 })
  if (result.status !== 0) fail('age_preflight_failed')
  if (spawnSync('/usr/bin/tar', ['--version'], { stdio: 'ignore', timeout: 5000 }).status !== 0) fail('tar_preflight_failed')
}

export async function* encryptedArchive(snapshot, recipient, { tar = '/usr/bin/tar', age = '/usr/bin/age' } = {}) {
  if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(recipient)) fail('invalid_age_recipient')
  // No shell, no user-provided options, no private key on the backup host.
  const source = spawn(tar, ['--format=posix', '-C', snapshot, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const encrypt = spawn(age, ['--encrypt', '--recipient', recipient], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const sourceDone = completion(source), encryptDone = completion(encrypt)
  const pipeDone = pipeline(source.stdout, encrypt.stdin)
  const all = Promise.all([sourceDone, encryptDone, pipeDone])
  all.catch(() => { source.kill(); encrypt.kill() })
  const timer = setTimeout(() => { source.kill(); encrypt.kill() }, 15 * 60_000)
  try {
    let block = Buffer.allocUnsafe(BLOCK), filled = 0
    for await (const chunk of encrypt.stdout) {
      let start = 0
      while (start < chunk.length) {
        const length = Math.min(BLOCK - filled, chunk.length - start)
        chunk.copy(block, filled, start, start + length); start += length; filled += length
        if (filled === BLOCK) { yield block; block = Buffer.allocUnsafe(BLOCK); filled = 0 }
      }
    }
    if (filled) yield block.subarray(0, filled)
    await all // never finish the Dropbox session when tar or age failed
  } catch { fail('archive_encryption_failed') }
  finally { clearTimeout(timer); source.kill(); encrypt.kill(); await all.catch(() => {}) }
}
