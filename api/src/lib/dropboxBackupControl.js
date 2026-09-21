import http from 'node:http'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { readPrivateJson } from './offlineDownloads.js'

export class BackupControlError extends Error {
  constructor(code = 'CONTROL_UNAVAILABLE', statusCode = 503) { super(code); this.code = code; this.statusCode = statusCode }
}
const id = /^[a-f0-9]{32}$/
export async function loadBackupControl(directory) {
  if (!directory) return null
  if (!isAbsolute(directory)) throw new BackupControlError()
  try {
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new BackupControlError()
    const c = await readPrivateJson(join(directory, 'dropbox-backup-control.json'), 4096)
    if (c.version !== 1 || typeof c.ownerUserId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(c.ownerUserId)
      || c.socketPath !== '/run/nav-dropbox-control/control.sock') throw new BackupControlError()
    return { ownerUserId: c.ownerUserId, socketPath: c.socketPath }
  } catch (e) { if (e.code === 'ENOENT') return null; throw new BackupControlError() }
}
export function cleanControlStatus(v) {
  const validDate = x => typeof x === 'string' && x.length <= 30 && Number.isFinite(Date.parse(x))
  if (v?.connected !== true || !Number.isSafeInteger(v.revision) || v.revision < 0 || v.timezone !== 'Asia/Shanghai'
    || typeof v.busy !== 'boolean' || typeof v.reviewRequired !== 'boolean' || !Array.isArray(v.jobs) || v.jobs.length > 50
    || typeof v.schedule?.enabled !== 'boolean' || typeof v.schedule.active !== 'boolean' || typeof v.schedule.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v.schedule.time)
    || ![null, 'REVIEW_REQUIRED', 'SCHEDULE_GATE_CLOSED'].includes(v.schedule.blockedReason)
    || !['backup', 'verify', 'download', 'schedule'].every(k => typeof v.capabilities?.[k] === 'boolean')) throw new BackupControlError()
  const jobs = v.jobs.map(j => {
    if (typeof j?.id !== 'string' || !id.test(j.id) || !['backup', 'verify'].includes(j.kind) || !['manual', 'schedule'].includes(j.source)
      || !['queued', 'running', 'succeeded', 'failed', 'review'].includes(j.state) || !['queued', 'snapshot', 'upload', 'verify', 'completed', 'stopped'].includes(j.stage)
      || !validDate(j.createdAt) || !validDate(j.updatedAt) || !(j.pointId === null || (typeof j.pointId === 'string' && id.test(j.pointId)))
      || ![null, 'INTERRUPTED_REVIEW_REQUIRED', 'OPERATION_DISABLED', 'BACKUP_REVIEW_REQUIRED', 'VERIFICATION_FAILED'].includes(j.code)) throw new BackupControlError()
    return Object.fromEntries(['id', 'kind', 'source', 'state', 'stage', 'createdAt', 'updatedAt', 'pointId', 'code'].map(k => [k, j[k]]))
  })
  return { connected: true, revision: v.revision, timezone: 'Asia/Shanghai', busy: v.busy, reviewRequired: v.reviewRequired, jobs,
    schedule: { enabled: v.schedule.enabled, active: v.schedule.active, time: v.schedule.time, blockedReason: v.schedule.blockedReason },
    capabilities: Object.fromEntries(['backup', 'verify', 'download', 'schedule'].map(k => [k, v.capabilities[k]])) }
}
export function backupControlClient(c) {
  const send = (method, path, body, stream = false) => new Promise((resolve, reject) => {
    const r = http.request({ socketPath: c.socketPath, path, method,
      headers: { 'x-nav-owner': c.ownerUserId, ...(body ? { 'Content-Type': 'application/json' } : {}) } })
    const timer = setTimeout(() => r.destroy(), stream ? 15 * 60_000 : 7000)
    r.on('error', () => { clearTimeout(timer); reject(new BackupControlError()) })
    r.on('response', response => {
      response.once('close', () => clearTimeout(timer))
      if (stream && response.statusCode === 200) {
        const bytes = Number(response.headers['content-length'])
        if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1_000_000_000 || response.headers['content-type'] !== 'application/octet-stream') {
          response.destroy(); return reject(new BackupControlError())
        }
        return resolve({ stream: response, bytes })
      }
      const chunks = []; let count = 0
      response.on('data', b => { count += b.length; if (count > 65536) response.destroy(); else chunks.push(b) })
      response.on('error', () => reject(new BackupControlError()))
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString())
          if (response.statusCode >= 400) {
            const safe = new Set(['OWNER_REQUIRED', 'BACKUP_BUSY', 'REVIEW_REQUIRED', 'OPERATION_DISABLED', 'SCHEDULE_GATE_CLOSED', 'SCHEDULE_CONFLICT', 'HISTORY_LIMIT', 'IDEMPOTENCY_CONFLICT', 'INVALID_OPERATION'])
            return reject(new BackupControlError(safe.has(value.code) ? value.code : 'CONTROL_UNAVAILABLE', [400, 403, 409, 429, 503].includes(response.statusCode) ? response.statusCode : 503))
          }
          resolve(value)
        } catch { reject(new BackupControlError()) }
      })
    })
    r.end(body ? JSON.stringify(body) : undefined)
  })
  return {
    status: () => send('GET', '/v1/status'),
    enqueue: input => send('POST', '/v1/jobs', input),
    schedule: input => send('PUT', '/v1/schedule', input),
    download: pointId => { if (!id.test(pointId)) throw new BackupControlError('INVALID_OPERATION', 400); return send('GET', '/v1/ciphertext/' + pointId, null, true) }
  }
}
