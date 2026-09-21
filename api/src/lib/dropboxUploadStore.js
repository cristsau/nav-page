// Private upload metadata only. File bodies and OAuth credentials never enter this store.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readPrivateJson } from './offlineDownloads.js'
import { deny } from './dropboxFiles.js'

const ID = /^[a-f0-9]{48}$/, HEX = /^[a-f0-9]{64}$/, LIMIT = 1_300_000
const bad = () => deny('UPLOAD_STORE_UNAVAILABLE', 503)
async function directory(path) {
  const s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink() || (process.platform !== 'win32' && (s.uid !== process.getuid() || (s.mode & 0o077)))) bad()
}
async function syncDirectory(path) {
  if (process.platform === 'win32') return
  const fd = await open(path, constants.O_RDONLY)
  try { await fd.sync() } finally { await fd.close() }
}
async function processStamp(pid) {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  }
  process.kill(pid, 0); return 'process-alive'
}

export class EncryptedUploadStore {
  constructor(path, key) { this.path = path; this.key = Buffer.from(key, 'hex'); this.lock = null; this.failed = false }
  async acquire() {
    try {
      await directory(this.path)
      const lockPath = join(this.path, 'writer.lock')
      try {
        const previous = await readPrivateJson(lockPath, 1024)
        if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.stamp !== 'string') bad()
        let alive
        try { alive = (await processStamp(previous.pid)) === previous.stamp }
        catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; alive = false }
        if (alive) bad()
        // Single API process / PID namespace only. Concurrent stale-lock recovery is
        // deliberately not supported: an exclusive recovery marker makes it fail closed.
        const marker = await open(join(this.path, 'recovery.lock'), 'wx', 0o600)
        try {
          const current = await readPrivateJson(lockPath, 1024)
          if (JSON.stringify(current) !== JSON.stringify(previous)) bad()
          await unlink(lockPath)
        } finally { await marker.close(); await unlink(join(this.path, 'recovery.lock')) }
      } catch (e) { if (e.code !== 'ENOENT') throw e }
      const lock = { pid: process.pid, stamp: await processStamp(process.pid), nonce: randomBytes(16).toString('hex') }
      const fd = await open(lockPath, 'wx', 0o600)
      try { await fd.writeFile(JSON.stringify(lock)); await fd.sync() } finally { await fd.close() }
      this.lock = lock
      await syncDirectory(this.path)
      return this
    } catch { await this.close(); bad() }
  }
  async check() {
    if (!this.lock || this.failed) bad()
    await directory(this.path)
    const lock = await readPrivateJson(join(this.path, 'writer.lock'), 1024)
    if (lock.nonce !== this.lock.nonce) bad()
  }
  async read(id) {
    if (!ID.test(id)) bad()
    const raw = await readPrivateJson(join(this.path, id + '.json'), LIMIT)
    if (raw.version !== 1 || !/^[a-f0-9]{24}$/.test(raw.iv) || !/^[a-f0-9]{32}$/.test(raw.tag)
      || typeof raw.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)) bad()
    const decrypt = createDecipheriv('aes-256-gcm', this.key, Buffer.from(raw.iv, 'hex'))
    decrypt.setAAD(Buffer.from('nav-upload-v1:' + id)); decrypt.setAuthTag(Buffer.from(raw.tag, 'hex'))
    const plain = Buffer.concat([decrypt.update(Buffer.from(raw.data, 'base64')), decrypt.final()])
    try { return JSON.parse(plain.toString()) } finally { plain.fill(0) }
  }
  async load() {
    try {
      await this.check()
      const files = await readdir(this.path)
      const ids = files.filter(f => /^[a-f0-9]{48}\.json$/.test(f)).map(f => f.slice(0, -5))
      if (ids.length > 32 || files.length > 70 || files.some(f => !/^[a-f0-9]{48}\.json(?:\.[a-f0-9]{24}\.tmp)?$/.test(f) && !['writer.lock', 'recovery.lock'].includes(f))) bad()
      return await Promise.all(ids.map(async id => [id, await this.read(id)]))
    } catch { this.failed = true; bad() }
  }
  async write(id, value) {
    let temporary
    try {
      if (!ID.test(id)) bad()
      await this.check()
      try { await this.read(id) } catch (e) {
        if (e.code !== 'ENOENT') throw e
        if ((await readdir(this.path)).filter(f => /^[a-f0-9]{48}\.json$/.test(f)).length >= 32) bad()
      }
      const plain = Buffer.from(JSON.stringify(value)), iv = randomBytes(12)
      if (plain.length > 950_000) { plain.fill(0); bad() }
      const cipher = createCipheriv('aes-256-gcm', this.key, iv)
      cipher.setAAD(Buffer.from('nav-upload-v1:' + id))
      let encrypted
      try { encrypted = Buffer.concat([cipher.update(plain), cipher.final()]) } finally { plain.fill(0) }
      const body = JSON.stringify({ version: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: encrypted.toString('base64') })
      const target = join(this.path, id + '.json')
      temporary = target + '.' + randomBytes(12).toString('hex') + '.tmp'
      const fd = await open(temporary, 'wx', 0o600)
      try { await fd.writeFile(body); await fd.sync() } finally { await fd.close() }
      await rename(temporary, target); temporary = null; await syncDirectory(this.path)
    } catch { this.failed = true; bad() }
    finally { if (temporary) await unlink(temporary).catch(() => {}) }
  }
  async remove(id) {
    try { await this.check(); await this.read(id); await unlink(join(this.path, id + '.json')); await syncDirectory(this.path) }
    catch { this.failed = true; bad() }
  }
  async close() {
    if (!this.lock) return
    const lock = this.lock; this.lock = null
    try {
      if ((await readPrivateJson(join(this.path, 'writer.lock'), 1024)).nonce === lock.nonce) await unlink(join(this.path, 'writer.lock'))
    } catch { /* Never remove another writer's lock. */ }
    this.key.fill(0)
  }
}

export function uploadStoreNames(purpose = 'web') {
  if (!['web', 'offline'].includes(purpose)) bad()
  return purpose === 'web'
    ? { config: 'dropbox-uploads.json', state: 'dropbox-upload-state' }
    : { config: 'dropbox-offline-uploads.json', state: 'dropbox-offline-upload-state' }
}

export async function loadUploadStore(directoryPath, purpose = 'web') {
  const names = uploadStoreNames(purpose)
  if (!directoryPath) return null
  let c
  try {
    await directory(directoryPath)
    try { c = await readPrivateJson(join(directoryPath, names.config), 4096) }
    catch (e) { if (e.code === 'ENOENT') return null; throw e }
    if (c.version !== 1 || c.enabled !== true || !HEX.test(c.key)) bad()
    return await new EncryptedUploadStore(join(directoryPath, names.state), c.key).acquire()
  } catch { bad() }
}
