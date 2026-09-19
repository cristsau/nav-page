// File bodies are sliced on demand and are never persisted to browser storage.
export class FileTransferQueue {
  constructor({ action, chunk, changed = () => {}, errorText = () => '传输未完成，请重试。', limit, chunkSize }) {
    Object.assign(this, { action, chunk, changed, errorText, limit, chunkSize })
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
        state: 'queued', uploadId: null, pause: false, cancel: false, rate: 0, error: '' }
    })
    this.jobs.push(...next); this.emit(); void this.run()
  }
  pause(id) {
    const job = this.jobs.find(j => j.id === id)
    if (!job || !['queued', 'uploading'].includes(job.state)) return
    job.pause = true
    if (job.state === 'queued') job.state = 'paused'
    this.emit()
  }
  resume(id) {
    const job = this.jobs.find(j => j.id === id)
    if (!job || !['paused', 'error'].includes(job.state)) return
    job.pause = false; job.cancel = false; job.error = ''; job.state = 'queued'; this.emit(); void this.run()
  }
  cancel(id) {
    const job = this.jobs.find(j => j.id === id)
    if (!job || ['complete', 'cancelled', 'review'].includes(job.state)) return
    job.cancel = true; job.pause = false
    if (job.state !== 'uploading') job.state = 'queued'
    this.emit(); void this.run()
  }
  clearFinished() { this.jobs = this.jobs.filter(j => !['complete', 'cancelled', 'review'].includes(j.state)); this.emit() }
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
          if (!remote) remote = await this.action('upload/start', { path: job.path, size: job.size })
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
          if (job.cancel && e?.code === 'UPLOAD_EXPIRED') { job.state = 'cancelled'; job.file = null }
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
