import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { lstat, open, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { SPOOL, jobDirectory, safeDirectory, safeFile, atomicJson, readJson, removeJob } from './media-fs.mjs'
import { delay } from './media-process.mjs'
const CHUNK = 8 * 1024 * 1024, LIMIT = 6 * 1024 ** 3
export class MediaClient {
  constructor(root = SPOOL) { this.root = root }
  file(id) { return join(jobDirectory(id, this.root), 'result.bin') }
  async capabilities() {
    const result = { bt: false, video: false }
    for (const kind of ['bt', 'video']) {
      try { const value = await readJson(join(this.root, kind + '-ready.json'), 1024)
        result[kind] = value.version === 1 && value.kind === kind && Date.now() - value.at < 15000 && value.at <= Date.now() + 1000
      } catch { /* unavailable means no new media job */ }
    }
    return result
  }
  async clean(id) {
    const status = await readJson(join(jobDirectory(id, this.root), 'status.json')).catch(e => { if (e.code === 'ENOENT') return null; throw e })
    if (status?.state === 'running') throw Error('MEDIA_STOP_UNCONFIRMED')
    await removeJob(id, this.root)
  }
  async run(job, { signal, source, progress }) {
    await safeDirectory(this.root)
    const directory = jobDirectory(job.id, this.root); await safeDirectory(directory, true)
    const resultPath = join(directory, 'result.bin')
    let previous
    try { previous = await readJson(join(directory, 'status.json')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (previous?.state === 'complete') { const stat = await safeFile(resultPath, LIMIT); if (stat.size !== previous.size) throw Error('MEDIA_RESULT_INVALID'); return { path: resultPath, size: stat.size } }
    try { await lstat(resultPath); throw Error('MEDIA_RESULT_REQUIRES_REVIEW') } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (job.kind === 'video') {
      const input = join(directory, 'source.bin'), size = job.sourceSize
      if (!Number.isSafeInteger(size) || size < 1 || size > LIMIT) throw Error('TRANSCODE_INPUT_LIMIT')
      let offset = 0
      try { offset = (await safeFile(input, LIMIT)).size } catch (e) { if (e.code !== 'ENOENT') throw e }
      if (offset > size) throw Error('LOCAL_FILE_CHANGED')
      const disk = await statfs(this.root)
      if (disk.bavail * disk.bsize < size - offset + 2 * 1024 ** 3) throw Error('DOWNLOAD_DISK_LIMIT')
      const fd = await open(input, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      try {
        while (offset < size) {
          if (signal.aborted) throw Error('MEDIA_INTERRUPTED')
          const bytes = await source(offset, Math.min(CHUNK, size - offset))
          if (bytes.length !== Math.min(CHUNK, size - offset)) throw Error('DOWNLOAD_SIZE_CHANGED')
          const { bytesWritten } = await fd.write(bytes, 0, bytes.length, offset)
          if (bytesWritten !== bytes.length) throw Error('DOWNLOAD_DISK_LIMIT')
          offset += bytesWritten; await progress({ stage: 'source_download', downloaded: offset, sourceSize: size })
        }
        await fd.sync()
      } finally { await fd.close() }
    }
    const attempt = randomBytes(16).toString('hex'), request = { id: job.id, attempt, kind: job.kind,
      ...(job.kind === 'video' ? { size: job.sourceSize } : { url: job.url, torrent: job.torrent, selection: job.selection }) }
    const leasePath = join(this.root, 'active.json')
    const lease = () => atomicJson(leasePath, { id: job.id, attempt, until: Date.now() + 15000 })
    await atomicJson(join(directory, 'request.json'), request); await lease()
    let leaseFailure = false, leasePending = Promise.resolve(), lastStage = ''
    const timer = setInterval(() => { leasePending = leasePending.then(() => lease()).catch(() => { leaseFailure = true }) }, 5000)
    try {
      const end = Date.now() + 25 * 3600000
      while (Date.now() < end) {
        if (leaseFailure) throw Error('MEDIA_LEASE_FAILED')
        await delay(1000, signal)
        let status
        try { status = await readJson(join(directory, 'status.json')) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
        if (status.attempt !== attempt) continue
        if (status.stage && status.stage !== lastStage) { await progress({ stage: status.stage, downloaded: 0 }); lastStage = status.stage }
        if (status.state === 'selecting') return { files: status.files, total: status.total, infoHash: status.infoHash }
        if (status.state === 'complete') {
          const stat = await safeFile(resultPath, LIMIT)
          if (stat.size !== status.size) throw Error('MEDIA_RESULT_INVALID')
          return { path: resultPath, size: stat.size }
        }
        if (['stopped', 'error'].includes(status.state)) throw Error(/^[A-Z_]{1,64}$/.test(status.error) ? status.error : 'MEDIA_FAILED')
      }
      throw Error('MEDIA_TIMEOUT')
    } finally {
      clearInterval(timer); await leasePending
      await atomicJson(leasePath, { id: job.id, attempt, until: 0 })
      // Wait for child termination acknowledgement before local cleanup/reuse.
      for (let tries = 0; tries < 30; tries++) {
        const status = await readJson(join(directory, 'status.json')).catch(() => null)
        if (status?.attempt === attempt && ['complete', 'selecting', 'stopped', 'error'].includes(status.state)) break
        if (tries === 29) throw Error('MEDIA_STOP_UNCONFIRMED')
        await delay(1000)
      }
    }
  }
}
