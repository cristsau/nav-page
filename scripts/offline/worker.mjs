// Personal, outbound-only HTTP download worker. Never receives Dropbox OAuth or an admin session.
import { open, lstat, readFile, rename, unlink, statfs, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { downloadResponse } from './safe-download.mjs'
import { MediaClient } from './media-client.mjs'

const BLOCK = 4 * 1024 * 1024, CHUNK = 8 * 1024 * 1024, RESERVE = 2 * 1024 ** 3
const wait = ms => new Promise(r => setTimeout(r, ms))
const safeId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
export async function privateFile(path, max = 8192) {
  const s = await lstat(path)
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max || (process.platform !== 'win32' && (s.uid !== process.getuid() || (s.mode & 0o077)))) throw Error('UNSAFE_LOCAL_FILE')
  return s
}
async function atomic(path, value) {
  try { await privateFile(path) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const tmp = path + '.tmp'
  // Stale temporary files need explicit operator review, never follow/overwrite one.
  const fd = await open(tmp, 'wx', 0o600)
  try { await fd.writeFile(JSON.stringify(value)); await fd.sync() } finally { await fd.close() }
  await rename(tmp, path)
  if (process.platform !== 'win32') { const parent = await open(join(path, '..'), constants.O_RDONLY); try { await parent.sync() } finally { await parent.close() } }
}
export async function contentHash(path, size) {
  await privateFile(path, 6 * 1024 ** 3)
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)), outer = createHash('sha256'), buffer = Buffer.alloc(BLOCK)
  try {
    for (let offset = 0; offset < size; offset += BLOCK) {
      const length = Math.min(BLOCK, size - offset), { bytesRead } = await fd.read(buffer, 0, length, offset)
      if (bytesRead !== length) throw Error('LOCAL_FILE_CHANGED')
      outer.update(createHash('sha256').update(buffer.subarray(0, length)).digest())
    }
    if ((await fd.stat()).size !== size) throw Error('LOCAL_FILE_CHANGED')
    return outer.digest('hex')
  } finally { buffer.fill(0); await fd.close() }
}
export async function apiCall(c, operation, input, bytes) {
  let response
  try {
    response = await fetch(c.apiBase + '/worker/' + operation, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { Authorization: 'Bearer ' + c.workerKey, 'Sec-Fetch-Site': 'none', 'Content-Type': bytes ? 'application/octet-stream' : 'application/json',
        ...(bytes ? { 'X-Offline-Job': input.id, 'X-Upload-Offset': String(input.offset) } : {}) }, body: bytes || JSON.stringify(input) })
  } catch { throw Error('CONTROL_NETWORK_FAILED') }
  const reader = response.body.getReader(), chunks = []; let length = 0
  try {
    const limit = operation === 'source' && response.ok ? CHUNK : operation === 'claim' ? 1500000 : 131072
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > limit) throw Error('CONTROL_RESPONSE_INVALID'); chunks.push(chunk.value) }
    if (operation === 'source' && response.ok) { if (length !== input.length) throw Error('CONTROL_RESPONSE_INVALID'); return Buffer.concat(chunks) }
    const value = JSON.parse(Buffer.concat(chunks).toString())
    if (!response.ok) throw Error(/^[A-Z_]{1,64}$/.test(value.code) ? value.code : 'CONTROL_REQUEST_FAILED')
    return value
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
export class DownloadWorker {
  constructor(config, call = apiCall, deps = {}) { this.config = config; this.call = (op, input, bytes) => call(config, op, input, bytes); this.stopping = false; this.download = deps.download || downloadResponse; this.disk = deps.disk || statfs; this.media = deps.media || (config.mediaDirectory ? new MediaClient(config.mediaDirectory) : null) }
  file(id) { if (!safeId(id)) throw Error('INVALID_JOB'); return join(this.config.directory, id + '.part') }
  dataFile(meta) { if (meta.media && !this.media) throw Error('MEDIA_WORKER_UNAVAILABLE'); return meta.media ? this.media.file(meta.id) : this.file(meta.id) }
  async save(meta) { await atomic(join(this.config.directory, 'current.json'), meta) }
  async previous() {
    const path = join(this.config.directory, 'current.json')
    try { await privateFile(path); const meta = JSON.parse(await readFile(path, 'utf8')); if (!safeId(meta.id)) throw Error('INVALID_LOCAL_STATE'); return meta }
    catch (e) { if (e.code === 'ENOENT') return null; throw e }
  }
  async clean(meta) {
    // Only generated job files inside the dedicated private directory; never cloud files.
    const file = this.dataFile(meta)
    if (meta.media) { if (!this.media) throw Error('MEDIA_WORKER_UNAVAILABLE'); await this.media.clean(meta.id) }
    else try { await privateFile(file, 6 * 1024 ** 3); await unlink(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
    // Keep the receipt until the API acknowledges cleanup; lost responses remain retryable.
    await this.call('progress', { id: meta.id, cleaned: true })
    const current = join(this.config.directory, 'current.json'); await privateFile(current); await unlink(current)
  }
  async tick() {
    let meta = await this.previous()
    if (meta) {
      let status
      try { status = await this.call('progress', { id: meta.id }) }
      catch (e) {
        // An acknowledged task may have been cleared before a crash removed its receipt.
        if (e.message !== 'OFFLINE_JOB_MISSING') throw e
        try { await lstat(this.dataFile(meta)); throw Error('LOCAL_TASK_REQUIRES_REVIEW') } catch (missing) { if (missing.code !== 'ENOENT') throw missing }
        const receipt = join(this.config.directory, 'current.json'); await privateFile(receipt); await unlink(receipt); meta = null
      }
      if (meta) {
      if (['complete', 'cancelled'].includes(status.state)) { await this.clean(meta); meta = null }
      else if (['paused', 'error', 'review', 'selecting'].includes(status.state)) return
      }
    }
    const { job } = await this.call('claim', await this.media?.capabilities() || {})
    if (!job) return
    if (!safeId(job.id) || job.maxBytes !== 6 * 1024 ** 3) throw Error('INVALID_JOB')
    if (meta && meta.id !== job.id) throw Error('LOCAL_TASK_REQUIRES_REVIEW')
    meta ||= { id: job.id, size: null, etag: '', downloaded: false }
    await this.save(meta)
    const controller = new AbortController(); let intent = 'run', controlFailure = false, heartbeatBusy = false, downloaded = 0
    const heartbeat = async () => {
      if (heartbeatBusy) return
      heartbeatBusy = true
      try { const status = await this.call('progress', { id: job.id, downloaded, size: meta.size }); intent = status.intent; if (intent !== 'run' || this.stopping) controller.abort() }
      catch { controlFailure = true; controller.abort() }
      finally { heartbeatBusy = false }
    }
    const timer = setInterval(heartbeat, 5000)
    try {
      if (['magnet', 'torrent', 'video'].includes(job.kind)) { meta.media = true; await this.save(meta) }
      const path = this.dataFile(meta)
      if (!meta.downloaded && ['magnet', 'torrent', 'video'].includes(job.kind)) {
        if (!this.media) throw Error('MEDIA_WORKER_UNAVAILABLE')
        meta.media = true; await this.save(meta)
        let local
        try { local = await privateFile(path, job.maxBytes) } catch (e) { if (e.code !== 'ENOENT') throw e }
        if (local && Number.isSafeInteger(meta.mediaSize)) {
          if (!Number.isSafeInteger(meta.mediaSize) || local.size !== meta.mediaSize) throw Error('MEDIA_RESULT_REQUIRES_REVIEW')
          meta.size = local.size
        } else {
          const result = await this.media.run(job, { signal: controller.signal,
            source: (offset, length) => this.call('source', { id: job.id, offset, length }),
            progress: async value => {
              const disk = await this.disk(this.config.directory)
              if (disk.bavail * disk.bsize < RESERVE) throw Error('DOWNLOAD_DISK_LIMIT')
              if (value.downloaded != null) downloaded = value.downloaded
              const status = await this.call('progress', { id: job.id, ...value }); intent = status.intent
              if (intent !== 'run' || this.stopping) controller.abort()
            } })
          if (result.files) { await this.call('progress', { id: job.id, state: 'selecting', metadata: result }); return }
          meta.mediaSize = result.size; await this.save(meta)
          if (result.path !== path) throw Error('MEDIA_RESULT_INVALID')
          meta.size = result.size
        }
        meta.downloaded = true; await this.save(meta)
      }
      if (!meta.downloaded) {
        let offset = 0
        try { offset = (await privateFile(path, job.maxBytes)).size } catch (e) { if (e.code !== 'ENOENT') throw e }
        if (offset && !meta.etag) offset = 0
        const source = await this.download(job.url, { offset, etag: meta.etag, signal: controller.signal })
        if (!Number.isSafeInteger(source.total) || source.total < 0 || source.total > job.maxBytes) { source.response.destroy(); throw Error('DOWNLOAD_TOO_LARGE') }
        const disk = await this.disk(this.config.directory)
        if (disk.bavail * disk.bsize < source.total - source.start + RESERVE) { source.response.destroy(); throw Error('DOWNLOAD_DISK_LIMIT') }
        meta.size = source.total; meta.etag = source.etag; await this.save(meta)
        let fd
        try { fd = await open(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600); if (!source.start) await fd.truncate(0)
          downloaded = source.start
          const started = Date.now(), initial = downloaded; let spaceCheck = downloaded
          for await (const chunk of source.response) {
            if (controller.signal.aborted || this.stopping) throw Error('DOWNLOAD_INTERRUPTED')
            if (downloaded + chunk.length > meta.size) throw Error('DOWNLOAD_SIZE_CHANGED')
            const { bytesWritten } = await fd.write(chunk, 0, chunk.length, downloaded)
            if (bytesWritten !== chunk.length) throw Error('DOWNLOAD_DISK_LIMIT')
            downloaded += chunk.length
            if (downloaded - spaceCheck >= CHUNK) {
              const available = await this.disk(this.config.directory)
              if (available.bavail * available.bsize < RESERVE) throw Error('DOWNLOAD_DISK_LIMIT')
              spaceCheck = downloaded
            }
            const delay = (downloaded - initial) / (2 * 1024 * 1024) * 1000 - (Date.now() - started)
            if (delay > 0) await wait(Math.min(delay, 1000))
          }
          if (downloaded !== meta.size) throw Error('DOWNLOAD_SIZE_CHANGED')
          await fd.sync()
        } finally { source.response.destroy(); await fd?.close() }
        meta.downloaded = true; await this.save(meta)
      }
      downloaded = meta.size; await heartbeat()
      if (controller.signal.aborted || this.stopping) throw Error('DOWNLOAD_INTERRUPTED')
      const hash = await contentHash(path, meta.size)
      if (controller.signal.aborted || this.stopping) throw Error('DOWNLOAD_INTERRUPTED')
      const started = await this.call('start', { id: job.id, size: meta.size, contentHash: hash })
      if (!Number.isSafeInteger(started.offset) || started.offset < 0 || started.offset > meta.size) throw Error('UPLOAD_OFFSET_INVALID')
      const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)), buffer = Buffer.alloc(CHUNK)
      try {
        for (let offset = started.offset; offset < meta.size;) {
          if (controller.signal.aborted || this.stopping) throw Error('DOWNLOAD_INTERRUPTED')
          const size = Math.min(CHUNK, meta.size - offset), { bytesRead } = await fd.read(buffer, 0, size, offset)
          if (bytesRead !== size) throw Error('LOCAL_FILE_CHANGED')
          const result = await this.call('chunk', { id: job.id, offset }, buffer.subarray(0, size))
          if (result.offset !== offset + size) throw Error('UPLOAD_OFFSET_INVALID')
          offset = result.offset
        }
      } finally { buffer.fill(0); await fd.close() }
      if (controller.signal.aborted || this.stopping) throw Error('DOWNLOAD_INTERRUPTED')
      const done = await this.call('finish', { id: job.id })
      if (done.state !== 'complete') throw Error('UPLOAD_REVIEW_REQUIRED')
      await this.clean(meta)
    } catch (error) {
      if (this.stopping || controlFailure) return // Do not manufacture failure/success after loss of control channel.
      const state = intent === 'cancel' ? 'cancelled' : intent === 'pause' ? 'paused' : 'error'
      await this.call('progress', { id: job.id, state, downloaded, size: meta.size, error: /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'DOWNLOAD_FAILED' })
      if (state === 'cancelled') await this.clean(meta)
    } finally { clearInterval(timer) }
  }
}
export async function main(configPath) {
  if (process.platform !== 'linux' || !configPath?.startsWith('/etc/nav-offline/')) throw Error('INVALID_WORKER_ENVIRONMENT')
  await privateFile(configPath)
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (config.version !== 1 || !/^https:\/\/nav\.(?:cristsau\.cn|skrskr\.net)\/api\/offline-downloads$/.test(config.apiBase)
    || !/^[a-f0-9]{64}$/.test(config.workerKey) || config.directory !== '/var/lib/nav-offline'
    || (config.mediaDirectory && config.mediaDirectory !== '/var/lib/nav-media')) throw Error('INVALID_WORKER_CONFIG')
  await mkdir(config.directory, { mode: 0o700, recursive: true })
  const directory = await lstat(config.directory)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw Error('UNSAFE_LOCAL_DIRECTORY')
  const worker = new DownloadWorker(config)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { worker.stopping = true })
  while (!worker.stopping) {
    try { await worker.tick() } catch { console.error('OFFLINE_WORKER_NEEDS_REVIEW') }
    if (!worker.stopping) await wait(10000)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]).catch(() => { console.error('OFFLINE_WORKER_START_FAILED'); process.exitCode = 1 })
