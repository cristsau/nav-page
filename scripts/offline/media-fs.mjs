// Private, generated spool only. No credentials or arbitrary host paths.
import { constants } from 'node:fs'
import { lstat, open, rename, unlink, mkdir, readdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
export const SPOOL = '/var/lib/nav-media'
export const jobId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
export function jobDirectory(id, root = SPOOL) { if (!jobId(id)) throw Error('INVALID_JOB'); return join(root, id) }
export async function safeDirectory(path, create = false) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e })
  const s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink() || (process.platform !== 'win32' && (s.uid !== process.getuid() || (s.mode & 0o077)))) throw Error('UNSAFE_MEDIA_DIRECTORY')
}
export async function safeFile(path, limit) {
  const s = await lstat(path)
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > limit || (process.platform !== 'win32' && (s.uid !== process.getuid() || (s.mode & 0o077)))) throw Error('UNSAFE_MEDIA_FILE')
  return s
}
export async function readJson(path, limit = 2 * 1024 * 1024) {
  const s = await safeFile(path, limit), fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const now = await fd.stat(); if (now.ino !== s.ino || now.dev !== s.dev) throw Error('UNSAFE_MEDIA_FILE')
    const buffer = Buffer.alloc(limit + 1), { bytesRead } = await fd.read(buffer, 0, buffer.length, 0)
    if (bytesRead > limit) throw Error('MEDIA_STATE_LIMIT')
    return JSON.parse(buffer.subarray(0, bytesRead).toString())
  } finally { await fd.close() }
}
export async function atomicJson(path, value) {
  try { await safeFile(path, 2 * 1024 * 1024) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const body = JSON.stringify(value); if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw Error('MEDIA_STATE_LIMIT')
  const tmp = path + '.' + randomBytes(8).toString('hex') + '.tmp', fd = await open(tmp, 'wx', 0o600)
  try { await fd.writeFile(body); await fd.sync() } finally { await fd.close() }
  try { await rename(tmp, path) } finally { await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e }) }
}
// Reject links/special files; cleanup only under an exact generated job directory.
export async function removeJob(id, root = SPOOL) {
  const path = jobDirectory(id, root)
  try { await safeDirectory(path) } catch (e) { if (e.code === 'ENOENT') return; throw e }
  async function clear(directory, depth = 0) {
    if (depth > 18) throw Error('MEDIA_DEPTH_LIMIT')
    for (const name of await readdir(directory)) {
      const entry = join(directory, name), s = await lstat(entry)
      if (s.isSymbolicLink() || s.uid !== process.getuid() || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))) throw Error('UNSAFE_MEDIA_FILE')
      if (s.isDirectory()) { await clear(entry, depth + 1); await rmdir(entry) } else await unlink(entry)
    }
  }
  await clear(path); await rmdir(path)
}
