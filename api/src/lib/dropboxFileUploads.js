import { createHash, randomBytes } from 'node:crypto'
import { deny, filePath, metadata, protectPath } from './dropboxFiles.js'

export const CHUNK_LIMIT = 8 * 1024 * 1024
export const LARGE_UPLOAD_LIMIT = 50 * 1024 ** 3
const BLOCK = 4 * 1024 * 1024, TTL = 24 * 60 * 60 * 1000
function blockHashes(bytes) {
  const hashes = []
  for (let i = 0; i < bytes.length; i += BLOCK) hashes.push(createHash('sha256').update(bytes.subarray(i, i + BLOCK)).digest())
  return hashes
}
export function dropboxContentHash(bytes) { return createHash('sha256').update(Buffer.concat(blockHashes(bytes))).digest('hex') }

// Opaque handles and hash state live only in this API process. No file bodies on disk,
// no provider session IDs in the browser, and no cross-restart resume claim.
export class DropboxFileUploads {
  constructor(service) { this.service = service; this.jobs = new Map(); this.starting = 0 }
  sweep() { for (const [id, job] of this.jobs) if (job.until < Date.now() && !job.busy) this.jobs.delete(id) }
  job(id) {
    this.sweep()
    const job = typeof id === 'string' ? this.jobs.get(id) : null
    if (!job) deny('UPLOAD_EXPIRED', 409)
    return job
  }
  view(id, job) { return { uploadId: id, offset: job.offset, size: job.size, chunkSize: CHUNK_LIMIT, state: job.state, ...(job.item ? { item: job.item } : {}) } }
  async guard(job) {
    protectPath(job.path, await this.service.protection(), true)
    if (job.parentId) {
      const parent = await this.service.get(job.parentId)
      if (parent.type !== 'folder' || parent.path !== job.parent) deny('FILE_CHANGED', 409)
    }
  }
  async start(path, size) {
    this.sweep()
    if (this.jobs.size + this.starting >= 32) {
      for (const [id, job] of this.jobs) if (job.state === 'complete' && !job.busy) { this.jobs.delete(id); break }
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > LARGE_UPLOAD_LIMIT) deny('UPLOAD_TOO_LARGE', 413)
    if (this.jobs.size + this.starting >= 32) deny('BUSY', 429)
    path = filePath(path)
    this.starting++
    try {
      const parent = path.slice(0, path.lastIndexOf('/'))
      protectPath(path, await this.service.protection(), true)
      if (await this.service.client.getMetadataIfExists(path)) deny('TARGET_EXISTS', 409)
      let parentId = null
      if (parent) {
        const m = metadata(await this.service.client.rpc('files/get_metadata', { path: parent }))
        if (m.type !== 'folder' || m.path.toLowerCase() !== parent.toLowerCase()) deny('INVALID_DESTINATION')
        parentId = m.id
      }
      const result = await this.service.client.uploadSession('start', { close: false })
      if (typeof result?.session_id !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(result.session_id)) deny('INVALID_PROVIDER_RESPONSE', 502)
      const id = randomBytes(24).toString('hex')
      const job = { path, parent, parentId, size, offset: 0, sessionId: result.session_id, state: 'uploading', busy: false, until: Date.now() + TTL, hash: createHash('sha256'), pending: null, last: null }
      this.jobs.set(id, job); return this.view(id, job)
    } finally { this.starting-- }
  }
  status(id) { return this.view(id, this.job(id)) }
  async append(id, offset, bytes) {
    const job = this.job(id)
    if (job.busy) deny('BUSY', 429)
    if (job.state !== 'uploading') deny('UPLOAD_REVIEW_REQUIRED', 409)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > CHUNK_LIMIT) deny('INVALID_CHUNK')
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (job.last?.offset === offset && job.last.length === bytes.length && job.last.digest === digest) return this.view(id, job)
    if (offset !== job.offset || bytes.length !== Math.min(CHUNK_LIMIT, job.size - offset)) deny('INVALID_CHUNK', 409)
    if (job.pending && (job.pending.offset !== offset || job.pending.digest !== digest)) deny('INVALID_CHUNK', 409)
    job.busy = true
    try {
      await this.guard(job)
      const retry = Boolean(job.pending)
      job.pending = { offset, length: bytes.length, digest }
      const result = await this.service.client.uploadSession('append_v2', {
        cursor: { session_id: job.sessionId, offset }, close: false, content_hash: dropboxContentHash(bytes)
      }, bytes)
      if (result !== null && result?.correctOffset === undefined) deny('INVALID_PROVIDER_RESPONSE', 502)
      if (result?.correctOffset !== undefined && (!retry || result.correctOffset !== offset + bytes.length)) deny('UPLOAD_OFFSET_MISMATCH', 409)
      for (const hash of blockHashes(bytes)) job.hash.update(hash)
      job.offset += bytes.length; job.last = job.pending; job.pending = null; job.until = Date.now() + TTL
      return this.view(id, job)
    } finally { job.busy = false }
  }
  async finish(id) {
    const job = this.job(id)
    if (job.busy) deny('BUSY', 429)
    if (job.state === 'complete') return this.view(id, job)
    if (job.state !== 'uploading') deny('UPLOAD_REVIEW_REQUIRED', 409)
    if (job.offset !== job.size || job.pending) deny('UPLOAD_INCOMPLETE', 409)
    job.busy = true
    try {
      await this.guard(job)
      job.state = 'committing'
      const expected = job.hash.copy().digest('hex')
      const raw = await this.service.client.uploadSession('finish', { cursor: { session_id: job.sessionId, offset: job.offset },
        commit: { path: job.path, mode: { '.tag': 'add' }, autorename: false, strict_conflict: true } })
      const item = metadata(raw, 'file')
      if (item.size !== job.size || item.path.toLowerCase() !== job.path.toLowerCase() || raw.content_hash !== expected) deny('UPLOAD_RECEIPT_INVALID', 502)
      job.item = item; job.state = 'complete'; job.sessionId = null; job.hash = null
      return this.view(id, job)
    } catch (error) {
      if (job.state === 'committing') job.state = 'review'
      throw error
    } finally { job.busy = false }
  }
  cancel(id) {
    const job = this.job(id)
    if (job.busy) deny('BUSY', 429)
    if (job.state === 'review' || job.state === 'committing') deny('UPLOAD_REVIEW_REQUIRED', 409)
    if (job.state === 'complete') return this.view(id, job)
    // Uncommitted Dropbox sessions expire remotely; cancellation never deletes a cloud file.
    this.jobs.delete(id); return { state: 'cancelled' }
  }
}
