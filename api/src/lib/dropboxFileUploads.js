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

// Persist only block digests and provider cursors; never persist file bodies.
export class DropboxFileUploads {
  constructor(service) { this.service = service; this.jobs = new Map(); this.starting = 0; this.store = null; this.foreignJobs = new Map() }
  static async restore(service, store, identity) {
    const manager = new DropboxFileUploads(service)
    manager.store = store; manager.identity = identity
    if (!store) return manager
    try {
      for (const [id, record] of await store.load()) {
        if (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.identity)) deny('UPLOAD_STORE_UNAVAILABLE', 503)
        const job = record.job
        validateSavedJob(job)
        if (record.identity !== identity) { manager.foreignJobs.set(id, job.until); continue }
        if (job.state === 'committing') job.state = 'review'
        manager.jobs.set(id, { ...job, busy: false })
      }
      await manager.sweep(); return manager
    } catch { await store.close(); deny('UPLOAD_STORE_UNAVAILABLE', 503) }
  }
  async save(id, job) {
    if (this.store) {
      const { busy, ...saved } = job
      try { await this.store.write(id, { version: 1, identity: this.identity, job: saved }) }
      catch { this.failed = true; deny('UPLOAD_STORE_UNAVAILABLE', 503) }
    }
    this.jobs.set(id, job)
  }
  async remove(id) {
    try { if (this.store) await this.store.remove(id); this.jobs.delete(id) }
    catch { this.failed = true; deny('UPLOAD_STORE_UNAVAILABLE', 503) }
  }
  async sweep() {
    if (this.sweeping) return this.sweeping
    const work = this.sweepExpired(); this.sweeping = work
    try { await work } finally { this.sweeping = null }
  }
  async sweepExpired() {
    if (this.failed || this.store?.failed) deny('UPLOAD_STORE_UNAVAILABLE', 503)
    for (const [id, until] of this.foreignJobs) if (until < Date.now()) {
      await this.remove(id); this.foreignJobs.delete(id)
    }
    for (const [id, job] of this.jobs) if (job.until < Date.now() && !job.busy) {
      job.busy = true
      try { await this.remove(id) } finally { job.busy = false }
    }
  }
  job(id) {
    if (this.failed || this.store?.failed) deny('UPLOAD_STORE_UNAVAILABLE', 503)
    const job = typeof id === 'string' ? this.jobs.get(id) : null
    if (!job || job.until < Date.now()) deny('UPLOAD_EXPIRED', 409)
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
  async list() {
    await this.sweep()
    const guards = await this.service.protection(), entries = []
    for (const [id, job] of this.jobs) {
      if (!job.contentHash) continue // Older clients did not establish file identity.
      try { protectPath(job.path, guards, true) } catch (error) { if (error.code === 'BACKUP_PROTECTED') continue; throw error }
      entries.push({ ...this.view(id, job), path: job.path, contentHash: job.contentHash, expiresAt: job.until })
    }
    return { entries, persistence: this.store ? 'encrypted_disk' : 'api_process', limit: 32 }
  }
  async reattach(id, size, contentHash) {
    const job = this.job(id)
    if (job.busy) deny('BUSY', 429)
    if (!job.contentHash || size !== job.size || contentHash !== job.contentHash) deny('UPLOAD_FILE_MISMATCH', 409)
    await this.guard(job)
    return this.view(id, job)
  }
  async start(path, size, contentHash = null) {
    await this.sweep()
    if (contentHash !== null && (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash))) deny('INVALID_CONTENT_HASH')
    if (this.jobs.size + this.starting + this.foreignJobs.size >= 32) {
      for (const [id, job] of this.jobs) if (job.state === 'complete' && !job.busy) {
        job.busy = true
        try { await this.remove(id) } finally { job.busy = false }
        break
      }
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > LARGE_UPLOAD_LIMIT) deny('UPLOAD_TOO_LARGE', 413)
    if (this.jobs.size + this.starting + this.foreignJobs.size >= 32) deny('BUSY', 429)
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
      const job = { path, parent, parentId, size, contentHash, offset: 0, sessionId: result.session_id, state: 'uploading', busy: false, until: Date.now() + TTL, blocks: [], pending: null, last: null }
      await this.save(id, job); return this.view(id, job)
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
      await this.save(id, job) // Durable intent BEFORE the provider can accept bytes.
      const result = await this.service.client.uploadSession('append_v2', {
        cursor: { session_id: job.sessionId, offset }, close: false, content_hash: dropboxContentHash(bytes)
      }, bytes)
      if (result !== null && result?.correctOffset === undefined) deny('INVALID_PROVIDER_RESPONSE', 502)
      if (result?.correctOffset !== undefined && (!retry || result.correctOffset !== offset + bytes.length)) deny('UPLOAD_OFFSET_MISMATCH', 409)
      const next = { ...job, blocks: [...job.blocks, ...blockHashes(bytes).map(h => h.toString('hex'))],
        offset: job.offset + bytes.length, last: job.pending, pending: null, until: Date.now() + TTL }
      await this.save(id, next)
      return this.view(id, next)
    } finally { job.busy = false; if (this.jobs.has(id)) this.jobs.get(id).busy = false }
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
      const expected = createHash('sha256').update(Buffer.concat(job.blocks.map(h => Buffer.from(h, 'hex')))).digest('hex')
      if (job.contentHash && job.contentHash !== expected) deny('UPLOAD_FILE_MISMATCH', 409)
      job.state = 'committing'
      await this.save(id, job) // A restart here must never issue another finish.
      const raw = await this.service.client.uploadSession('finish', { cursor: { session_id: job.sessionId, offset: job.offset },
        commit: { path: job.path, mode: { '.tag': 'add' }, autorename: false, strict_conflict: true } })
      const item = metadata(raw, 'file')
      if (item.size !== job.size || item.path.toLowerCase() !== job.path.toLowerCase() || raw.content_hash !== expected) deny('UPLOAD_RECEIPT_INVALID', 502)
      const next = { ...job, item, state: 'complete', sessionId: null }
      await this.save(id, next)
      return this.view(id, next)
    } catch (error) {
      if (job.state === 'committing') job.state = 'review'
      throw error
    } finally { job.busy = false; if (this.jobs.has(id)) this.jobs.get(id).busy = false }
  }
  cancel(id) {
    const job = this.job(id)
    if (job.busy) deny('BUSY', 429)
    if (job.state === 'review' || job.state === 'committing') deny('UPLOAD_REVIEW_REQUIRED', 409)
    if (job.state === 'complete') return this.view(id, job)
    // Uncommitted Dropbox sessions expire remotely; cancellation never deletes a cloud file.
    if (!this.store) { this.jobs.delete(id); return { state: 'cancelled' } }
    job.busy = true
    return this.remove(id).then(() => ({ state: 'cancelled' })).finally(() => { job.busy = false })
  }
}

function validateSavedJob(j) {
  const invalid = () => deny('UPLOAD_STORE_UNAVAILABLE', 503)
  if (!j || !['uploading', 'committing', 'review', 'complete'].includes(j.state)
    || !Number.isSafeInteger(j.size) || j.size < 0 || j.size > LARGE_UPLOAD_LIMIT
    || !Number.isSafeInteger(j.offset) || j.offset < 0 || j.offset > j.size
    || (j.offset !== j.size && j.offset % CHUNK_LIMIT !== 0)
    || !Number.isSafeInteger(j.until) || j.until > Date.now() + TTL + 60000
    || (j.contentHash !== null && !/^[a-f0-9]{64}$/.test(j.contentHash))
    || !Array.isArray(j.blocks) || j.blocks.length !== Math.ceil(j.offset / BLOCK) || j.blocks.some(h => !/^[a-f0-9]{64}$/.test(h))
    || (j.state !== 'complete' && (typeof j.sessionId !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(j.sessionId)))
    || (j.parentId !== null && (typeof j.parentId !== 'string' || !/^id:[\w-]+$/.test(j.parentId)))) invalid()
  if (filePath(j.path) !== j.path || j.parent !== j.path.slice(0, j.path.lastIndexOf('/'))) invalid()
  for (const [name, chunk] of [['last', j.last], ['pending', j.pending]]) if (chunk !== null) {
    if (!chunk || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || chunk.offset % CHUNK_LIMIT !== 0
      || chunk.length !== Math.min(CHUNK_LIMIT, j.size - chunk.offset) || chunk.length <= 0 || !/^[a-f0-9]{64}$/.test(chunk.digest)
      || (name === 'pending' ? chunk.offset !== j.offset : chunk.offset + chunk.length !== j.offset)) invalid()
  }
  if (j.state !== 'uploading' && (j.offset !== j.size || j.pending !== null)) invalid()
  if (j.state === 'complete' && (j.sessionId !== null || j.item?.type !== 'file' || j.item?.size !== j.size || j.item?.path?.toLowerCase() !== j.path.toLowerCase())) invalid()
}
