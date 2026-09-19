// Separate personal file-library connection. Never reuse the backup credential.
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

export const FILE_SCOPES = ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write']
export const TEXT_LIMIT = 1024 * 1024
export const UPLOAD_LIMIT = 20 * 1024 * 1024
export class DropboxFilesError extends Error {
  constructor(code, statusCode = 400) { super(code); this.code = code; this.statusCode = statusCode }
}
export const deny = (code, status = 400) => { throw new DropboxFilesError(code, status) }
export function filePath(value, root = false) {
  if (root && (value === '' || value === '/')) return ''
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048
    || /[\x00-\x1f\x7f\\]/.test(value) || /%(?:2e|2f|5c|00)/i.test(value)
    || value.split('/').slice(1).some(p => !p || p === '.' || p === '..' || p !== p.trim())) deny('INVALID_PATH')
  return value.normalize('NFC')
}
export function fileId(value) {
  if (typeof value !== 'string' || !/^id:[A-Za-z0-9_-]{1,150}$/.test(value)) deny('INVALID_FILE_ID')
  return value
}
export function revision(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{9,64}$/.test(value)) deny('INVALID_REVISION')
  return value
}
export function protectPath(path, protectedPaths, mutation = false) {
  const normalized = filePath(path, !mutation).toLowerCase()
  if (!Array.isArray(protectedPaths) || !protectedPaths.length) deny('BACKUP_PROTECTION_UNAVAILABLE', 503)
  for (const raw of protectedPaths) {
    const p = filePath(raw).toLowerCase()
    if (normalized === p || normalized.startsWith(p + '/') || (mutation && p.startsWith(normalized + '/'))) deny('BACKUP_PROTECTED', 403)
  }
  return normalized
}
export function kindOf(name) {
  const ext = String(name).split('.').pop().toLowerCase()
  if (['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yaml', 'yml', 'toml'].includes(ext)) return 'text'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'm4v', 'mov', 'mkv'].includes(ext)) return 'video'
  if (['mp3', 'm4a', 'ogg', 'wav', 'flac'].includes(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'].includes(ext)) return 'office'
  return 'file'
}
export function contentType(name) {
  const ext = String(name).split('.').pop().toLowerCase()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', pdf: 'application/pdf' })[ext] || 'application/octet-stream'
}
export function officialUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && url.hostname === 'www.dropbox.com' && !url.port && !url.username && !url.password) return url.href
  } catch { /* no untrusted links */ }
  return null
}
export function metadata(value, expectedType = null) {
  // Concrete FileMetadata/FolderMetadata omit .tag; only known endpoint types may supply it.
  const type = value?.['.tag'] ?? expectedType
  if (!value || !['file', 'folder'].includes(type) || (expectedType && type !== expectedType) || typeof value.name !== 'string' || !value.name || value.name.length > 512 || /[\x00-\x1f\x7f/\\]/.test(value.name)) deny('INVALID_PROVIDER_RESPONSE', 502)
  const result = { id: fileId(value.id), name: value.name, path: filePath(value.path_display || value.path_lower),
    type, kind: type === 'folder' ? 'folder' : kindOf(value.name), officialUrl: officialUrl(value.preview_url) }
  if (result.type === 'file') {
    if (!Number.isSafeInteger(value.size) || value.size < 0 || !Number.isFinite(Date.parse(value.server_modified))) deny('INVALID_PROVIDER_RESPONSE', 502)
    Object.assign(result, { size: value.size, rev: revision(value.rev), modified: value.server_modified, downloadable: value.is_downloadable !== false })
  }
  return result
}
export function validateFilesConnection(c) {
  if (c?.version !== 1 || c.purpose !== 'nav-files' || c.accessType !== 'full_dropbox'
    || typeof c.ownerUserId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(c.ownerUserId)
    || typeof c.clientId !== 'string' || !/^[A-Za-z0-9]{8,80}$/.test(c.clientId)
    || c.clientId === c.backupClientId || typeof c.backupClientId !== 'string' || !/^[A-Za-z0-9]{8,80}$/.test(c.backupClientId)
    || typeof c.refreshToken !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,16384}$/.test(c.refreshToken)
    || typeof c.accountId !== 'string' || !/^dbid:[A-Za-z0-9_-]{1,256}$/.test(c.accountId)
    || !Array.isArray(c.scopes) || c.scopes.length !== 4 || FILE_SCOPES.some(s => !c.scopes.includes(s))) deny('INVALID_CONNECTION', 503)
  fileId(c.backupFolderId)
  filePath(c.backupFolderPath)
  return c
}
export async function loadFilesConnection(directory) {
  if (!directory) return null
  let handle
  try {
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== 'win32' && (parent.mode & 0o022))) deny('INVALID_CONNECTION', 503)
    const path = join(directory, 'dropbox-files.json'), before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 32768
      || (process.platform !== 'win32' && ((before.mode & 0o077) || before.uid !== process.getuid()))) deny('INVALID_CONNECTION', 503)
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const s = await handle.stat()
    if (s.dev !== before.dev || s.ino !== before.ino) deny('INVALID_CONNECTION', 503)
    const buffer = Buffer.alloc(32769)
    let length = 0
    while (length < buffer.length) { const n = await handle.read(buffer, length, buffer.length - length, null); if (!n.bytesRead) break; length += n.bytesRead }
    if (length > 32768) deny('INVALID_CONNECTION', 503)
    try { return validateFilesConnection(JSON.parse(buffer.subarray(0, length).toString('utf8'))) }
    finally { buffer.fill(0) }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error instanceof DropboxFilesError) throw error
    deny('INVALID_CONNECTION', 503)
  } finally { await handle?.close() }
}
async function boundedJson(response, allowConflict = false) {
  if (!response.ok && !(allowConflict && response.status === 409)) {
    await response.body?.cancel().catch(() => {})
    deny(response.status === 409 ? 'PROVIDER_CONFLICT' : response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_UNAVAILABLE', response.status === 409 ? 409 : 502)
  }
  if (!response.body) deny('INVALID_PROVIDER_RESPONSE', 502)
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) deny('PROVIDER_RESPONSE_TOO_LARGE', 502); chunks.push(value) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) { await reader.cancel().catch(() => {}); if (error instanceof DropboxFilesError) throw error; deny('INVALID_PROVIDER_RESPONSE', 502) }
  finally { reader.releaseLock() }
}
export class DropboxFilesClient {
  #config; #fetch; #token; #until = 0; #refreshing
  constructor(config, { fetchImpl = fetch } = {}) { this.#config = validateFilesConnection(config); this.#fetch = fetchImpl }
  async #request(url, options) {
    try { return await this.#fetch(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(60000) }) }
    catch { deny('PROVIDER_UNAVAILABLE', 502) }
  }
  async #auth() {
    if (this.#token && Date.now() < this.#until) return this.#token
    if (!this.#refreshing) this.#refreshing = (async () => {
      const c = this.#config
      const t = await boundedJson(await this.#request('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refreshToken }) }))
      if (typeof t.access_token !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,16384}$/.test(t.access_token)
        || String(t.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(t.expires_in) || t.expires_in < 120) deny('INVALID_PROVIDER_RESPONSE', 502)
      if (t.scope !== undefined) { const scopes = new Set(String(t.scope).split(/\s+/)); if (scopes.size !== 4 || FILE_SCOPES.some(s => !scopes.has(s))) deny('UNEXPECTED_SCOPES', 503) }
      const a = await boundedJson(await this.#request('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST', headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' }, body: 'null' }))
      if (a.account_id !== c.accountId || a.disabled === true) deny('ACCOUNT_MISMATCH', 503)
      this.#token = t.access_token; this.#until = Date.now() + Math.min(t.expires_in - 60, 1800) * 1000
    })().finally(() => { this.#refreshing = null })
    await this.#refreshing
    return this.#token
  }
  async rpc(route, arg) {
    if (!['files/get_metadata', 'files/list_folder', 'files/list_folder/continue', 'files/search_v2', 'files/search/continue_v2',
      'files/create_folder_v2', 'files/move_v2', 'files/copy_v2', 'files/delete_v2', 'files/list_revisions'].includes(route)) deny('INVALID_OPERATION')
    const token = await this.#auth()
    return boundedJson(await this.#request('https://api.dropboxapi.com/2/' + route, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(arg) }))
  }
  async upload(path, bytes, rev = null) {
    const token = await this.#auth()
    return boundedJson(await this.#request('https://content.dropboxapi.com/2/files/upload', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': asciiJson({ path: filePath(path), mode: rev ? { '.tag': 'update', update: revision(rev) } : { '.tag': 'add' }, autorename: false, strict_conflict: true }) }, body: bytes }))
  }
  async uploadSession(operation, arg, bytes = Buffer.alloc(0)) {
    if (!['start', 'append_v2', 'finish'].includes(operation)) deny('INVALID_OPERATION')
    const token = await this.#auth()
    const response = await this.#request('https://content.dropboxapi.com/2/files/upload_session/' + operation, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': asciiJson(arg) }, body: bytes
    })
    const result = await boundedJson(response, operation === 'append_v2')
    if (response.status === 409) {
      if (result?.error?.['.tag'] === 'incorrect_offset' && Number.isSafeInteger(result.error.correct_offset) && result.error.correct_offset >= 0) return { correctOffset: result.error.correct_offset }
      deny('PROVIDER_CONFLICT', 409)
    }
    return result
  }
  async getMetadataIfExists(path) {
    const token = await this.#auth()
    const response = await this.#request('https://api.dropboxapi.com/2/files/get_metadata', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath(path) }) })
    const result = await boundedJson(response, true)
    if (response.status === 409) {
      if (result?.error?.['.tag'] === 'path' && result.error.path?.['.tag'] === 'not_found') return null
      deny('PROVIDER_CONFLICT', 409)
    }
    return metadata(result)
  }
  async download(meta, { range, signal } = {}) {
    const expected = downloadRange(range, meta.size)
    const token = await this.#auth()
    const response = await this.#request('https://content.dropboxapi.com/2/files/download', { method: 'POST', signal,
      headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': asciiJson({ path: 'rev:' + revision(meta.rev) }), ...(range ? { Range: range } : {}) } })
    if (![200, 206].includes(response.status)) { await response.body?.cancel().catch(() => {}); deny(response.status === 416 ? 'INVALID_RANGE' : 'PROVIDER_UNAVAILABLE', response.status === 416 ? 416 : 502) }
    let receipt
    try { receipt = metadata(JSON.parse(response.headers.get('dropbox-api-result')), 'file') } catch { await response.body?.cancel().catch(() => {}); deny('INVALID_PROVIDER_RESPONSE', 502) }
    if (receipt.id !== meta.id || receipt.rev !== meta.rev || receipt.size !== meta.size || receipt.path !== meta.path || !response.body) { await response.body?.cancel().catch(() => {}); deny('FILE_CHANGED', 409) }
    const actualLength = response.headers.get('content-length')
    const expectedLength = expected ? expected.end - expected.start + 1 : meta.size
    if (response.status !== (expected ? 206 : 200)
      || (expected && response.headers.get('content-range') !== `bytes ${expected.start}-${expected.end}/${meta.size}`)
      || (actualLength !== null && (!/^\d+$/.test(actualLength) || Number(actualLength) !== expectedLength))) {
      await response.body.cancel(); deny('INVALID_RANGE', 502)
    }
    return response
  }
}
function asciiJson(value) { return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) }

export function downloadRange(range, size) {
  if (range === undefined) return null
  if (typeof range !== 'string' || range.length > 100 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || size === 0) deny('INVALID_RANGE', 416)
  const [left, right] = range.slice(6).split('-')
  if ([left, right].some(v => v && !Number.isSafeInteger(Number(v)))) deny('INVALID_RANGE', 416)
  const start = left ? Number(left) : Math.max(0, size - Number(right))
  const end = left && right ? Math.min(Number(right), size - 1) : size - 1
  if (start >= size || start > end || (!left && Number(right) === 0)) deny('INVALID_RANGE', 416)
  return { start, end }
}

export class DropboxFilesService {
  constructor(config, client = new DropboxFilesClient(config)) { this.config = validateFilesConnection(config); this.client = client; this.deletePlans = new Map() }
  async protection() {
    const anchor = metadata(await this.client.rpc('files/get_metadata', { path: this.config.backupFolderId }))
    if (anchor.id !== this.config.backupFolderId || anchor.type !== 'folder') deny('BACKUP_PROTECTION_UNAVAILABLE', 503)
    return [this.config.backupFolderPath, anchor.path]
  }
  async get(id, mutation = false, guards = null) {
    guards ||= await this.protection()
    const item = metadata(await this.client.rpc('files/get_metadata', { path: fileId(id) }))
    if (item.id !== id) deny('INVALID_PROVIDER_RESPONSE', 502)
    protectPath(item.path, guards, mutation)
    return item
  }
  async list({ path = '', query = '', cursor = null } = {}) {
    const guards = await this.protection()
    protectPath(filePath(path, true), guards)
    if (typeof query !== 'string' || query.length > 200 || /[\x00-\x1f]/.test(query)) deny('INVALID_QUERY')
    let result
    if (cursor) result = await this.client.rpc(query ? 'files/search/continue_v2' : 'files/list_folder/continue', { cursor })
    else if (query) result = await this.client.rpc('files/search_v2', { query, options: { path: filePath(path, true), max_results: 100, filename_only: true } })
    else result = await this.client.rpc('files/list_folder', { path: filePath(path, true), recursive: false, limit: 100, include_deleted: false })
    const raw = query ? result.matches?.map(v => v.metadata?.metadata) : result.entries
    if (!Array.isArray(raw) || raw.length > 100 || typeof result.has_more !== 'boolean' || (result.has_more && (typeof result.cursor !== 'string' || result.cursor.length > 16384))) deny('INVALID_PROVIDER_RESPONSE', 502)
    const entries = []
    for (const value of raw) {
      const item = metadata(value)
      try { protectPath(item.path, guards) } catch (error) { if (error.code === 'BACKUP_PROTECTED') continue; throw error }
      let mutable = true
      try { protectPath(item.path, guards, true) } catch { mutable = false }
      entries.push({ ...item, mutable })
    }
    return { entries, cursor: result.has_more ? result.cursor : null, hasMore: result.has_more }
  }
  async mkdir(path) {
    const guards = await this.protection(); protectPath(path, guards, true)
    return metadata((await this.client.rpc('files/create_folder_v2', { path: filePath(path), autorename: false })).metadata, 'folder')
  }
  async move(id, destination) {
    const guards = await this.protection(), item = await this.get(id, true, guards)
    protectPath(destination, guards, true)
    if (filePath(destination).toLowerCase().startsWith(item.path.toLowerCase() + '/')) deny('INVALID_DESTINATION')
    return metadata((await this.client.rpc('files/move_v2', { from_path: item.id, to_path: filePath(destination), autorename: false, allow_shared_folder: false, allow_ownership_transfer: false })).metadata)
  }
  async copy(id, destination) {
    const guards = await this.protection(), item = await this.get(id, true, guards)
    protectPath(destination, guards, true)
    const target = filePath(destination).toLowerCase(), source = item.path.toLowerCase()
    if (target === source || target.startsWith(source + '/')) deny('INVALID_DESTINATION')
    return metadata((await this.client.rpc('files/copy_v2', { from_path: item.id, to_path: filePath(destination), autorename: false, allow_shared_folder: false })).metadata)
  }
  async deleteSnapshot(id) {
    const guards = await this.protection(), item = await this.get(id, true, guards), children = []
    if (item.type === 'folder') {
      let result = await this.client.rpc('files/list_folder', { path: item.id, recursive: true, include_deleted: false, limit: 100 })
      for (let page = 0; ; page++) {
        if (!Array.isArray(result.entries) || result.entries.length > 100 || typeof result.has_more !== 'boolean') deny('INVALID_PROVIDER_RESPONSE', 502)
        for (const raw of result.entries) {
          const child = metadata(raw)
          if (!child.path.toLowerCase().startsWith(item.path.toLowerCase() + '/')) deny('FILE_CHANGED', 409)
          protectPath(child.path, guards, true); children.push(child)
        }
        if (children.length > 500 || (result.has_more && page >= 4)) deny('FOLDER_TOO_LARGE', 413)
        if (!result.has_more) break
        if (typeof result.cursor !== 'string' || result.cursor.length > 16384) deny('INVALID_PROVIDER_RESPONSE', 502)
        result = await this.client.rpc('files/list_folder/continue', { cursor: result.cursor })
      }
    }
    const digest = createHash('sha256').update(JSON.stringify([item, ...children].map(x => [x.id, x.path, x.type, x.rev || '', x.size || 0]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex')
    return { item, digest, descendants: children.length, files: [item, ...children].filter(x => x.type === 'file').length, bytes: [item, ...children].reduce((sum, x) => sum + (x.size || 0), 0) }
  }
  async prepareDelete(id) {
    for (const [key, plan] of this.deletePlans) if (plan.until < Date.now() && plan.state !== 'running') this.deletePlans.delete(key)
    if (this.deletePlans.size >= 100) deny('BUSY', 429)
    const snapshot = await this.deleteSnapshot(id), token = randomBytes(24).toString('hex')
    this.deletePlans.set(token, { ...snapshot, until: Date.now() + 10 * 60000, state: 'ready' })
    return { token, item: snapshot.item, descendants: snapshot.descendants, files: snapshot.files, bytes: snapshot.bytes }
  }
  async deleteConfirmed(id, token) {
    const plan = typeof token === 'string' ? this.deletePlans.get(token) : null
    if (!plan || plan.until < Date.now() || plan.item.id !== fileId(id)) deny('DELETE_EXPIRED', 409)
    if (plan.state === 'complete') return { deleted: true }
    if (plan.state !== 'ready') deny('DELETE_REVIEW_REQUIRED', 409)
    plan.state = 'running'
    try {
      const current = await this.deleteSnapshot(id)
      if (current.digest !== plan.digest) deny('FILE_CHANGED', 409)
      // Dropbox cannot transactionally lock an externally edited folder tree. Recheck immediately before mutation.
      protectPath(current.item.path, await this.protection(), true)
      const result = metadata((await this.client.rpc('files/delete_v2', { path: id, ...(current.item.type === 'file' ? { parent_rev: current.item.rev } : {}) })).metadata)
      if (result.id !== id) deny('INVALID_PROVIDER_RESPONSE', 502)
      plan.state = 'complete'; return { deleted: true }
    } catch (error) { plan.state = 'review'; throw error }
  }
  async remove(id, rev, confirmation) {
    const item = await this.get(id, true)
    // No recursive folder deletion surface. A file deletion is bound to the displayed revision.
    if (item.type !== 'file') deny('FOLDER_DELETE_DISABLED', 403)
    if (confirmation !== item.name || revision(rev) !== item.rev) deny('FILE_CHANGED', 409)
    const result = metadata((await this.client.rpc('files/delete_v2', { path: item.id, parent_rev: item.rev })).metadata)
    if (result.id !== item.id) deny('INVALID_PROVIDER_RESPONSE', 502)
    return { deleted: true }
  }
  async upload(path, bytes) {
    const guards = await this.protection(); protectPath(path, guards, true)
    if (!Buffer.isBuffer(bytes) || bytes.length > UPLOAD_LIMIT) deny('UPLOAD_TOO_LARGE', 413)
    return metadata(await this.client.upload(path, bytes), 'file')
  }
  async text(id) {
    const item = await this.get(id)
    if (item.kind !== 'text' || item.size > TEXT_LIMIT || !item.downloadable) deny('TEXT_UNSUPPORTED', 415)
    const response = await this.client.download(item), reader = response.body.getReader(), chunks = []; let size = 0
    try {
      while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > TEXT_LIMIT) deny('TEXT_TOO_LARGE', 413); chunks.push(r.value) }
      if (size !== item.size) deny('FILE_CHANGED', 409)
      let content
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { deny('TEXT_ENCODING_UNSUPPORTED', 415) }
      if (content.includes('\0')) deny('TEXT_ENCODING_UNSUPPORTED', 415)
      return { item, content }
    } catch (error) { await reader.cancel().catch(() => {}); throw error } finally { reader.releaseLock() }
  }
  async save(id, rev, content) {
    const item = await this.get(id, true)
    if (item.kind !== 'text' || !item.downloadable) deny('TEXT_UNSUPPORTED', 415)
    if (item.rev !== revision(rev)) deny('FILE_CHANGED', 409)
    if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > TEXT_LIMIT) deny('TEXT_TOO_LARGE', 413)
    if (item.name.toLowerCase().endsWith('.json')) { try { JSON.parse(content) } catch { deny('INVALID_JSON') } }
    return metadata(await this.client.upload(item.path, Buffer.from(content, 'utf8'), item.rev), 'file')
  }
}
