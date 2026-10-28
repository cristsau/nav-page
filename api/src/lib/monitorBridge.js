import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

export function monitorError(code, statusCode = 503) { return Object.assign(new Error(code), { code, statusCode }) }
export function validateMonitorConfig(value) {
  if (value?.version !== 1 || typeof value.enabled !== 'boolean') throw monitorError('MONITOR_CONFIG_INVALID')
  if (!value.enabled) return null
  if (!['http://nav-monitor:28080', 'http://127.0.0.1:28080'].includes(value.upstream)
    || value.site !== 'https://node.cvv.gr'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.ownerUserId || '')
    || typeof value.password !== 'string' || value.password.length < 12 || value.password.length > 256
    || /[\x00-\x1f\x7f]/.test(value.password)) throw monitorError('MONITOR_CONFIG_INVALID')
  return value
}
export async function loadMonitorConfig(directory) {
  if (!directory) return null
  let handle
  try {
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== 'win32' && (parent.mode & 0o022))) throw monitorError('MONITOR_CONFIG_INVALID')
    const path = join(directory, 'monitor.json'), before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096
      || (process.platform !== 'win32' && ((before.mode & 0o077) || before.uid !== process.getuid()))) throw monitorError('MONITOR_CONFIG_INVALID')
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const stat = await handle.stat()
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw monitorError('MONITOR_CONFIG_INVALID')
    const buffer = Buffer.alloc(4097)
    try {
      let size = 0
      while (size < buffer.length) { const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null); if (!bytesRead) break; size += bytesRead }
      if (size > 4096) throw monitorError('MONITOR_CONFIG_INVALID')
      return validateMonitorConfig(JSON.parse(buffer.subarray(0, size).toString('utf8')))
    } finally { buffer.fill(0) }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw monitorError('MONITOR_CONFIG_INVALID')
  } finally { await handle?.close() }
}

// Only the pinned hub's API surface. No arbitrary URL, dot segments, encoded
// slashes, redirects, Agent control path, or client-supplied authorization.
const allowed = /^\/(?:me|nodes(?:\/(?:order|batch|[0-9]+(?:\/(?:metrics|token|traffic|ping-tasks))?))?|register-window|ping-tasks(?:\/(?:order|[0-9]+))?|settings|version|notify\/test|themes(?:\/[a-z0-9_-]+(?:\/(?:preview|update|config))?)?|theme-install|db(?:\/(?:backup|vacuum))?|sessions(?:\/[a-f0-9]+)?)$/
export function monitorTarget(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\\#\x00-\x20\x7f]/.test(raw)) throw monitorError('MONITOR_PATH_INVALID', 400)
  const queryAt = raw.indexOf('?'), path = queryAt < 0 ? raw : raw.slice(0, queryAt)
  if (!allowed.test(path)) throw monitorError('MONITOR_PATH_INVALID', 400)
  return '/api' + raw
}

export async function monitorJson(response, maxBytes = 16384) {
  if (!response.body) throw monitorError('MONITOR_UNAVAILABLE')
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) throw monitorError('MONITOR_UNAVAILABLE'); chunks.push(value) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export class MonitorBridge {
  constructor(settings, fetcher = fetch) { this.settings = settings; this.fetcher = fetcher; this.cookie = ''; this.pending = null }
  async login() {
    if (this.cookie) return this.cookie
    if (this.pending) return this.pending
    this.pending = (async () => {
      const response = await this.fetcher(this.settings.upstream + '/api/auth/login', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', origin: this.settings.site, 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ password: this.settings.password })
      })
      try {
        const cookie = response.headers.getSetCookie().find(item => /^monitor_session=[a-f0-9]{64};/.test(item))?.split(';', 1)[0]
        if (!response.ok || !cookie) throw monitorError('MONITOR_LOGIN_UNAVAILABLE')
        this.cookie = cookie
        return cookie
      } finally { await response.body?.cancel().catch(() => {}) }
    })()
    try { return await this.pending } finally { this.pending = null }
  }
  async request(rawPath, { method = 'GET', body, contentType, signal } = {}) {
    const path = monitorTarget(rawPath)
    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method)) throw monitorError('MONITOR_METHOD_INVALID', 405)
    if (path.split('?', 1)[0] === '/api/settings' && method !== 'GET' && body) {
      let data
      try { data = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body) } catch { throw monitorError('MONITOR_BODY_INVALID', 400) }
      if (Object.hasOwn(data || {}, 'admin_password')) throw monitorError('MONITOR_NAV_AUTH_MANAGED', 409)
    }
    const send = async () => this.fetcher(this.settings.upstream + path, {
      method, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      headers: { cookie: await this.login(), origin: this.settings.site, 'sec-fetch-site': 'same-origin',
        'x-forwarded-proto': 'https', ...(contentType ? { 'content-type': contentType } : {}) }
    })
    let response = await send()
    let anonymousMe = false
    if (method === 'GET' && path === '/api/me' && response.ok) {
      const data = await monitorJson(response)
      anonymousMe = data.authed !== true
      response = Response.json(data)
    }
    if (response.status === 401 || anonymousMe) {
      this.cookie = ''
      // Reads can refresh an expired bridge session. A write is never replayed.
      if (method === 'GET' || method === 'HEAD') { await response.body?.cancel(); response = await send() }
    }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw monitorError('MONITOR_REDIRECT_REFUSED') }
    return response
  }
}
