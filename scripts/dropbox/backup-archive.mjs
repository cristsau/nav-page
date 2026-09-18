import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
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
  const manifestFile = join(snapshot, 'manifest.sha256')
  const manifestStat = await lstat(manifestFile)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 4_000_000) fail('invalid_snapshot_manifest')
  const manifest = await readFile(manifestFile)
  const expected = new Map()
  for (const line of manifest.toString('utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line)
    if (!match || /[\x00-\x1f\\]/.test(match[2]) || match[2].startsWith('/')
      || match[2].split('/').some(p => p === '.' || p === '..' || !p) || expected.has(match[2])) fail('invalid_snapshot_manifest')
    expected.set(match[2], match[1])
  }
  if (!expected.has('database/nav.dump') || !expected.has('metadata/tree.tsv')) fail('incomplete_snapshot')
  let sourceBytes = 0, entries = 0
  const snapshotDevice = (await lstat(snapshot)).dev
  const found = new Set()
  async function walk(relative) {
    const current = join(snapshot, relative), stat = await lstat(current)
    if (stat.isSymbolicLink() || stat.dev !== snapshotDevice || (process.platform !== 'win32' && (stat.uid !== 0 || (stat.mode & 0o022)))) fail('unsafe_snapshot_member')
    entries++
    if (entries > 100000) fail('snapshot_entry_limit')
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

export function verifyEncryptionTools(recipient) {
  if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(recipient)) fail('invalid_age_recipient')
  const result = spawnSync('/usr/bin/age', ['--encrypt', '--recipient', recipient], { input: Buffer.alloc(0), stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 })
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
