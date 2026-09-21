import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { filePath, protectPath, deny } from './dropboxFiles.js'

export const OFFLINE_LIMIT = 6 * 1024 ** 3
const terminal = new Set(['complete', 'cancelled', 'error', 'review'])
export function downloadUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) deny('INVALID_DOWNLOAD_URL')
  let url
  try { url = new URL(value) } catch { deny('INVALID_DOWNLOAD_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) || !url.hostname.includes('.')) deny('INVALID_DOWNLOAD_URL')
  return url.href
}
export const connectionIdentity = c => createHash('sha256').update(JSON.stringify(c)).digest('hex')
export async function readPrivateJson(path, limit = 262144) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit
    || (process.platform !== 'win32' && (before.uid !== process.getuid() || (before.mode & 0o077)))) deny('OFFLINE_CONFIG_INVALID', 503)
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const now = await fd.stat()
    if (now.ino !== before.ino || now.dev !== before.dev || now.size > limit) deny('OFFLINE_CONFIG_INVALID', 503)
    const buffer = Buffer.alloc(limit + 1)
    try { const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0); if (bytesRead > limit) deny('OFFLINE_CONFIG_INVALID', 503); return JSON.parse(buffer.subarray(0, bytesRead).toString()) }
    finally { buffer.fill(0) }
  } finally { await fd.close() }
}
export async function loadOfflineConfig(directory) {
  if (!directory) return null
  try {
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== 'win32' && (parent.uid !== process.getuid() || (parent.mode & 0o077)))) deny('OFFLINE_CONFIG_INVALID', 503)
    const c = await readPrivateJson(join(directory, 'offline-downloads.json'), 4096)
    if (c.version !== 1 || c.enabled !== true || !/^[a-f0-9]{64}$/.test(c.workerKey) || c.maxBytes !== OFFLINE_LIMIT) deny('OFFLINE_CONFIG_INVALID', 503)
    return c
  } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
export class EncryptedOfflineStore {
  constructor(directory, key) { this.path = join(directory, 'offline-jobs.json'); this.key = createHash('sha256').update('nav-offline-state-v1\0' + key).digest() }
  async read() {
    try {
      const raw = await readPrivateJson(this.path)
      if (raw.version !== 1 || !/^[a-f0-9]{24}$/.test(raw.iv) || !/^[a-f0-9]{32}$/.test(raw.tag) || typeof raw.data !== 'string') deny('OFFLINE_STATE_INVALID', 503)
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(raw.iv, 'hex'))
      decipher.setAAD(Buffer.from('nav-offline-state-v1')); decipher.setAuthTag(Buffer.from(raw.tag, 'hex'))
      const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()])
      try { const value = JSON.parse(plain.toString()); if (!Array.isArray(value.jobs) || value.jobs.length > 50) deny('OFFLINE_STATE_INVALID', 503); return value }
      finally { plain.fill(0) }
    } catch { deny('OFFLINE_STATE_INVALID', 503) }
  }
  async write(value) {
    // Refuse replacing links or a damaged existing state file.
    try { await readPrivateJson(this.path) } catch (e) { if (e.code !== 'ENOENT') throw e }
    const plain = Buffer.from(JSON.stringify(value)), iv = randomBytes(12)
    if (plain.length > 150000) deny('OFFLINE_QUEUE_FULL', 409)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from('nav-offline-state-v1'))
    const data = Buffer.concat([cipher.update(plain), cipher.final()]); plain.fill(0)
    const body = JSON.stringify({ version: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') })
    const temporary = this.path + '.' + randomBytes(12).toString('hex') + '.tmp'
    let fd
    try { fd = await open(temporary, 'wx', 0o600); await fd.writeFile(body); await fd.sync(); await fd.close(); fd = null; await rename(temporary, this.path)
      if (process.platform !== 'win32') { const parent = await open(join(this.path, '..'), constants.O_RDONLY); try { await parent.sync() } finally { await parent.close() } }
    }
    finally { await fd?.close(); await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e }) }
  }
}
export class OfflineDownloads {
  constructor({ store, service, uploads, identity, maxBytes = OFFLINE_LIMIT }) {
    Object.assign(this, { store, service, uploads, identity, maxBytes }); this.serial = Promise.resolve(); this.lastSeen = 0; this.failed = false
  }
  async save(data) {
    try { await this.store.write(data) }
    catch (error) { this.failed = true; throw error }
  }
  async transaction(fn) {
    const run = this.serial.then(async () => {
      if (this.failed) deny('OFFLINE_STATE_INVALID', 503)
      const data = await this.store.read(), result = await fn(data)
      await this.save(data); return result
    })
    this.serial = run.catch(() => {}); return run
  }
  view(job) {
    return { id: job.id, name: job.name, destination: job.destination, state: job.state, intent: job.intent,
      downloaded: job.downloaded, size: job.size, uploaded: job.uploaded, createdAt: job.createdAt, updatedAt: job.updatedAt, error: job.error || '' }
  }
  async status() {
    const data = await this.store.read()
    return { enabled: true, maxBytes: this.maxBytes, queueLimit: 10, workerOnline: Date.now() - this.lastSeen < 45000,
      uploadPersistence: this.uploads.store ? 'encrypted_disk' : 'api_process',
      entries: data.jobs.filter(j => j.identity === this.identity).map(j => this.view(j)).reverse() }
  }
  async add(input) {
    const url = downloadUrl(input.url), destination = filePath(input.destination), name = destination.split('/').pop()
    if (name.length > 255) deny('INVALID_DESTINATION')
    protectPath(destination, await this.service.protection(), true)
    const parent = destination.slice(0, destination.lastIndexOf('/'))
    if (parent) { const folder = await this.service.client.getMetadataIfExists(parent); if (folder?.type !== 'folder') deny('INVALID_DESTINATION') }
    if (await this.service.client.getMetadataIfExists(destination)) deny('TARGET_EXISTS', 409)
    return this.transaction(data => {
      if (data.jobs.filter(j => !terminal.has(j.state)).length >= 10 || data.jobs.length >= 50) deny('OFFLINE_QUEUE_FULL', 409)
      if (data.jobs.some(j => j.destination.toLowerCase() === destination.toLowerCase() && !terminal.has(j.state))) deny('TARGET_EXISTS', 409)
      const job = { id: randomBytes(16).toString('hex'), identity: this.identity, url, name, destination, state: 'queued', intent: 'run',
        downloaded: 0, size: null, uploaded: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      data.jobs.push(job); return this.view(job)
    })
  }
  job(data, id) {
    const job = data.jobs.find(j => j.id === id && j.identity === this.identity)
    if (!job) deny('OFFLINE_JOB_MISSING', 404)
    return job
  }
  async control(id, command) {
    return this.transaction(data => {
      const job = this.job(data, id)
      if (['committing', 'complete', 'cancelled', 'review'].includes(job.state)) deny('OFFLINE_REVIEW_REQUIRED', 409)
      if (command === 'pause') { job.intent = 'pause'; if (job.state === 'queued') job.state = 'paused' }
      else if (command === 'cancel') { job.intent = 'cancel'; if (['queued', 'paused', 'error'].includes(job.state)) { job.state = 'cancelled'; job.url = null; if (!job.claimed) job.cleaned = true } }
      else if (command === 'resume' && ['paused', 'error'].includes(job.state)) { job.intent = 'run'; job.state = 'queued'; job.error = '' }
      else deny('OFFLINE_COMMAND_INVALID')
      job.updatedAt = new Date().toISOString(); return this.view(job)
    })
  }
  async clear() { return this.transaction(data => { data.jobs = data.jobs.filter(j => j.identity !== this.identity || !['complete', 'cancelled'].includes(j.state) || !j.cleaned); return { cleared: true } }) }
  async claim() {
    this.lastSeen = Date.now()
    return this.transaction(async data => {
      // One active job; a restarted worker receives the same identity, never a second job.
      let job = data.jobs.find(j => j.identity === this.identity && ['downloading', 'uploading', 'committing'].includes(j.state))
      if (job?.state === 'committing') { job.state = 'review'; job.error = 'COMMIT_RESULT_UNKNOWN'; return { job: null } }
      job ||= data.jobs.find(j => j.identity === this.identity && j.state === 'queued')
      if (!job) return { job: null }
      protectPath(job.destination, await this.service.protection(), true)
      if (job.state === 'queued') job.state = 'downloading'
      job.claimed = true
      return { job: { id: job.id, url: job.url, state: job.state, intent: job.intent, maxBytes: this.maxBytes } }
    })
  }
  async progress(id, input) {
    this.lastSeen = Date.now()
    return this.transaction(data => {
      const job = this.job(data, id)
      if (terminal.has(job.state)) { if (input.cleaned === true && ['complete', 'cancelled'].includes(job.state)) job.cleaned = true; return this.view(job) }
      if (job.state === 'committing') return this.view(job)
      if (Number.isSafeInteger(input.downloaded) && input.downloaded >= 0 && input.downloaded <= this.maxBytes) job.downloaded = input.downloaded
      if (Number.isSafeInteger(input.size) && input.size >= 0 && input.size <= this.maxBytes) job.size = input.size
      if (input.state === 'paused' && job.intent === 'pause') job.state = 'paused'
      if (input.state === 'cancelled' && job.intent === 'cancel') { job.state = 'cancelled'; job.url = null }
      if (input.state === 'error') { job.state = 'error'; job.error = /^[A-Z_]{1,64}$/.test(input.error) ? input.error : 'DOWNLOAD_FAILED' }
      job.updatedAt = new Date().toISOString(); return this.view(job)
    })
  }
  async transfer(id, operation, input, bytes) {
    this.lastSeen = Date.now()
    return this.transaction(async data => {
      const job = this.job(data, id)
      if (job.intent !== 'run' || !['downloading', 'uploading'].includes(job.state)) deny('OFFLINE_PAUSED', 409)
      protectPath(job.destination, await this.service.protection(), true)
      if (operation === 'start') {
        if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > this.maxBytes || !/^[a-f0-9]{64}$/.test(input.contentHash)) deny('INVALID_UPLOAD')
        if (job.uploadId) {
          try {
            const remote = await this.uploads.reattach(job.uploadId, input.size, input.contentHash)
            // Provider metadata may be ahead of queue metadata if acknowledgement
            // persistence was interrupted. Use the durable provider cursor.
            job.uploaded = remote.offset; job.size = input.size
            job.state = remote.state === 'uploading' ? 'uploading' : 'review'
            if (job.state === 'review') job.error = 'COMMIT_RESULT_UNKNOWN'
            job.updatedAt = new Date().toISOString()
            return remote
          }
          catch (e) { if (e.code !== 'UPLOAD_EXPIRED') throw e; job.uploadId = null }
        }
        const remote = await this.uploads.start(job.destination, input.size, input.contentHash)
        job.uploadId = remote.uploadId; job.state = 'uploading'; job.size = input.size; job.uploaded = 0; return remote
      }
      if (!job.uploadId) deny('UPLOAD_EXPIRED', 409)
      if (operation === 'chunk') { const remote = await this.uploads.append(job.uploadId, input.offset, bytes); job.uploaded = remote.offset; return remote }
      if (operation === 'finish') {
        // Durable uncertainty marker before a possibly committing external call.
        job.state = 'committing'; await this.save(data)
        try {
          const remote = await this.uploads.finish(job.uploadId)
          job.state = 'complete'; job.uploaded = job.size; job.url = null; job.uploadId = null; return { state: 'complete' }
        } catch (e) { job.state = 'review'; job.error = 'COMMIT_RESULT_UNKNOWN'; await this.save(data); throw e }
      }
      deny('OFFLINE_COMMAND_INVALID')
    })
  }
}
