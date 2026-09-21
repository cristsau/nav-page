// File bodies are sliced on demand and are never persisted to browser storage.
import { fileContentHash } from './fileIdentity.js'
export class FileTransferQueue {
  constructor({ action, chunk, changed = () => {}, errorText = () => '传输未完成，请重试。', limit, chunkSize, hash = fileContentHash }) {
    Object.assign(this, { action, chunk, changed, errorText, limit, chunkSize, hash })
    this.jobs = []; this.running = false; this.closed = false; this.sequence = 0
  }
  emit() { if (!this.closed) this.changed(this.jobs.map(job => ({ ...job, file: undefined }))) }
  add(files, directory, plannedPaths = null) {
    if (files.length > 50 || this.jobs.length + files.length > 100) throw Error('每次最多选择 50 个文件；请先清理已完成任务。')
    if (plannedPaths && plannedPaths.length !== files.length) throw Error('文件夹上传计划已失效。')
    const next = files.map((file, index) => {
      if (!file.name || /[\x00-\x1f\x7f/\\]/.test(file.name) || file.name !== file.name.trim() || ['.', '..'].includes(file.name)) throw Error('包含无效文件名，未加入队列。')
      if (file.size > this.limit) throw Error('包含超过 50 GB 的文件，未加入队列。')
      const path = plannedPaths ? plannedPaths[index] : `${directory}/${file.name}`
      if (!path.startsWith(directory + '/') || path.split('/').slice(1).some(p => !p || ['.', '..'].includes(p) || p !== p.trim() || /[\x00-\x1f\x7f\\]/.test(p))) throw Error('文件夹路径无效。')
      return { id: ++this.sequence, name: plannedPaths ? path.slice(directory.length + 1) : file.name, file, path, size: file.size, offset: 0,
        state: 'queued', uploadId: null, contentHash: null, hashOffset: 0, pause: false, cancel: false, rate: 0, error: '' }
    })
    this.jobs.push(...next); this.emit(); void this.run()
  }
  async recover() {
    const { entries } = await this.action('upload/list', {})
    if (this.closed) return
    if (!Array.isArray(entries) || entries.length > 32) throw Error('INVALID_UPLOAD_LIST')
    const ids = new Set()
    for (const remote of entries) {
      if (!remote || typeof remote.uploadId !== 'string' || !/^[a-f0-9]{48}$/.test(remote.uploadId) || ids.has(remote.uploadId)
        || typeof remote.path !== 'string' || !remote.path.startsWith('/') || remote.path.length > 2048
        || remote.path.split('/').slice(1).some(p => !p || ['.', '..'].includes(p) || p !== p.trim() || /[\x00-\x1f\x7f\\]/.test(p))
        || typeof remote.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(remote.contentHash)
        || !Number.isSafeInteger(remote.size) || remote.size < 0 || remote.size > this.limit
        || !Number.isSafeInteger(remote.offset) || remote.offset < 0 || remote.offset > remote.size
        || !['uploading', 'complete', 'committing', 'review'].includes(remote.state)) throw Error('INVALID_UPLOAD_LIST')
      ids.add(remote.uploadId)
    }
    // Validate the whole response first; a broken page must not partly change the queue.
    const missing = entries.filter(remote => !this.jobs.some(job => job.uploadId === remote.uploadId))
    if (this.jobs.length + missing.length > 100) throw Error('请先清理已完成任务，再读取待续传任务。')
    for (const remote of missing) {
      this.jobs.push({ id: ++this.sequence, name: remote.path.split('/').pop(), path: remote.path, size: remote.size, offset: remote.offset,
        uploadId: remote.uploadId, contentHash: remote.contentHash, file: null, hashOffset: 0, pause: false, cancel: false, rate: 0,
        state: remote.state === 'complete' ? 'complete' : remote.state === 'uploading' ? 'awaiting_file' : 'review',
        error: remote.state === 'review' || remote.state === 'committing' ? '提交结果待核对，请先检查云端目录。' : '' })
    }
    this.emit()
  }
  async reselect(id, file) {
    const job = this.jobs.find(j => j.id === id)
    if (!job || job.state !== 'awaiting_file' || !file) return
    if (file.name !== job.path.split('/').pop() || file.size !== job.size) { job.error = '请选择同名、同大小的原文件；随后还会核对完整内容。'; this.emit(); return }
    job.state = 'checking'; job.error = ''; job.hashOffset = 0; job.pause = false; this.emit()
    try {
      const contentHash = await this.hash(file, { stopped: () => this.closed || job.cancel || job.pause, progress: n => { job.hashOffset = n; this.emit() } })
      if (contentHash !== job.contentHash) throw Object.assign(Error('UPLOAD_FILE_MISMATCH'), { code: 'UPLOAD_FILE_MISMATCH' })
      const remote = await this.action('upload/reattach', { uploadId: job.uploadId, size: file.size, contentHash })
      if (this.closed) return
      if (job.cancel) { await this.cancelRemote(job); return }
      if (remote.state === 'complete') { job.state = 'complete'; job.offset = job.size }
      else if (remote.state !== 'uploading') { job.state = 'review'; job.error = '提交结果待核对，请先检查云端目录。' }
      else { job.file = file; job.offset = remote.offset; job.state = 'paused' }
    } catch (error) {
      if (job.cancel) { job.state = 'queued'; void this.run() }
      else if (job.pause && error.code === 'UPLOAD_HASH_CANCELLED') { job.state = 'awaiting_file'; job.pause = false; job.error = '核对已暂停；准备好后请重新选择原文件。' }
      else { job.state = 'awaiting_file'; job.error = error.code === 'UPLOAD_FILE_MISMATCH' ? '内容不一致，未继续上传。请选择原文件。' : this.errorText(error) }
    }
    this.emit()
  }
  pause(id) {
    const job = this.jobs.find(j => j.id === id)
    if (!job || !['queued', 'checking', 'uploading'].includes(job.state)) return
    job.pause = true
    if (job.state === 'queued') job.state = 'paused'
    this.emit()
  }
  resume(id) {
    const job = this.jobs.find(j => j.id === id)
    if (!job || !['paused', 'error'].includes(job.state)) return
    if (!job.file && !job.cancel) { job.state = 'awaiting_file'; this.emit(); return }
    job.pause = false; job.cancel = false; job.error = ''; job.state = 'queued'; this.emit(); void this.run()
  }
  cancel(id) {
    const job = this.jobs.find(j => j.id === id)
    if (!job || ['complete', 'cancelled', 'review'].includes(job.state)) return
    job.cancel = true; job.pause = false
    if (!['uploading', 'checking'].includes(job.state)) job.state = 'queued'
    this.emit(); void this.run()
  }
  async clearFinished() {
    if (this.clearing) return
    const selected = this.jobs.filter(j => ['complete', 'cancelled'].includes(j.state))
    const ids = [...new Set(selected.filter(j => j.state === 'complete' && j.uploadId).map(j => j.uploadId))]
    this.clearing = true
    try {
      // Keep all visible records on failure; repeating an acknowledged deletion is safe.
      for (let index = 0; index < ids.length; index += 32) {
        const batch = ids.slice(index, index + 32), result = await this.action('upload/dismiss', { ids: batch })
        if (!Array.isArray(result?.cleared) || result.cleared.length !== batch.length || batch.some(id => !result.cleared.includes(id))) throw Error('INVALID_UPLOAD_RECEIPT')
      }
      const selectedIds = new Set(selected.map(j => j.id))
      this.jobs = this.jobs.filter(j => !selectedIds.has(j.id) || !['complete', 'cancelled'].includes(j.state)); this.emit()
      return selected.length
    } finally { this.clearing = false }
  }
  async run() {
    if (this.running || this.closed) return
    this.running = true
    try {
      let job
      while (!this.closed && (job = this.jobs.find(j => j.state === 'queued'))) {
        job.state = 'uploading'; this.emit()
        try {
          let remote = job.uploadId ? await this.action('upload/status', { uploadId: job.uploadId }) : null
          if (remote?.state === 'complete') { job.offset = job.size; job.state = 'complete'; job.file = null; this.emit(); continue }
          if (remote && remote.state !== 'uploading') { job.state = 'review'; job.file = null; job.error = '提交结果待核对，请刷新 Dropbox 目录，不要重复上传。'; this.emit(); continue }
          if (job.cancel) { await this.cancelRemote(job); continue }
          if (!remote) {
            job.state = 'checking'; job.hashOffset = 0; this.emit()
            job.contentHash = await this.hash(job.file, { stopped: () => this.closed || job.cancel || job.pause, progress: n => { job.hashOffset = n; this.emit() } })
            if (this.closed) return
            if (job.cancel) { await this.cancelRemote(job); continue }
            if (job.pause) { job.state = 'paused'; this.emit(); continue }
            remote = await this.action('upload/start', { path: job.path, size: job.size, contentHash: job.contentHash })
          }
          job.state = 'uploading'; this.emit()
          job.uploadId = remote.uploadId; job.offset = remote.offset
          const chunkSize = remote.chunkSize || this.chunkSize
          while (!this.closed && job.offset < job.size && !job.pause && !job.cancel) {
            const before = job.offset, started = Date.now()
            const result = await this.chunk(job.uploadId, before, job.file.slice(before, Math.min(before + chunkSize, job.size)))
            if (result.offset !== Math.min(before + chunkSize, job.size)) throw Error('INVALID_UPLOAD_PROGRESS')
            job.offset = result.offset; job.rate = (job.offset - before) * 1000 / Math.max(1, Date.now() - started); this.emit()
          }
          if (this.closed) return
          if (job.cancel) { await this.cancelRemote(job); continue }
          if (job.pause) { job.state = 'paused'; this.emit(); continue }
          const result = await this.action('upload/finish', { uploadId: job.uploadId })
          if (result.state !== 'complete') throw Error('INVALID_UPLOAD_RECEIPT')
          job.state = 'complete'; job.offset = job.size; job.file = null
        } catch (e) {
          if (e?.code === 'UPLOAD_HASH_CANCELLED' && job.cancel) { await this.cancelRemote(job) }
          else if (e?.code === 'UPLOAD_HASH_CANCELLED' && job.pause) job.state = 'paused'
          else if (job.cancel && e?.code === 'UPLOAD_EXPIRED') { job.state = 'cancelled'; job.file = null }
          else {
            job.state = ['UPLOAD_REVIEW_REQUIRED', 'UPLOAD_RECEIPT_INVALID'].includes(e?.code) ? 'review' : 'error'
            job.error = this.errorText(e)
            if (job.state === 'review') job.file = null
          }
        }
        this.emit()
      }
    } finally { this.running = false }
  }
  async cancelRemote(job) {
    const result = job.uploadId ? await this.action('upload/cancel', { uploadId: job.uploadId }) : null
    job.state = result?.state === 'complete' ? 'complete' : 'cancelled'; job.file = null; this.emit()
  }
  dispose() { this.closed = true; this.jobs = [] }
}
