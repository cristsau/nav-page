// Dropbox transport. Fixed official hosts; secrets never appear in diagnostics.
import { createHash } from 'node:crypto'
import { BackupError, fail, artifactPath, uint, hash } from './backup-policy.mjs'
import { SCOPES, validateClientId } from './oauth.mjs'

export const BLOCK = 4 * 1024 * 1024
const RPC = 'https://api.dropboxapi.com/2/'
const CONTENT = 'https://content.dropboxapi.com/2/'
const AGE_PREFIX = Buffer.from('age-encryption.org/v1\n-> ')

export class Digests {
  constructor() { this.whole = createHash('sha256'); this.outer = createHash('sha256'); this.block = createHash('sha256'); this.inBlock = 0; this.size = 0 }
  update(bytes) {
    this.whole.update(bytes); this.size += bytes.length
    let start = 0
    while (start < bytes.length) {
      const count = Math.min(BLOCK - this.inBlock, bytes.length - start)
      this.block.update(bytes.subarray(start, start + count)); start += count; this.inBlock += count
      if (this.inBlock === BLOCK) { this.outer.update(this.block.digest()); this.block = createHash('sha256'); this.inBlock = 0 }
    }
  }
  finish() {
    if (this.inBlock) this.outer.update(this.block.digest())
    return { bytes: this.size, sha256: this.whole.digest('hex'), contentHash: this.outer.digest('hex') }
  }
}

async function json(response) {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); fail(`dropbox_http_${response.status}`) }
  const reader = response.body?.getReader()
  if (!reader) fail('invalid_dropbox_response')
  const parts = []; let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break
      size += value.byteLength; if (size > 2_000_000) fail('dropbox_response_limit')
      parts.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch (e) {
    await reader.cancel().catch(() => {})
    if (e instanceof BackupError) throw e
    fail('invalid_dropbox_response')
  } finally { reader.releaseLock() }
}

export function validateCredential(value) {
  try { validateClientId(value?.client_id) } catch { fail('invalid_credential') }
  if (value.schema_version !== 1 || value.provider !== 'dropbox'
    || typeof value.refresh_token !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,16384}$/.test(value.refresh_token)
    || typeof value.account_id !== 'string' || !value.account_id.startsWith('dbid:')
    || !Array.isArray(value.scopes) || value.scopes.length !== SCOPES.length
    || SCOPES.some(s => !value.scopes.includes(s))) fail('invalid_credential')
}

export class DropboxClient {
  #credential; #token; #until = 0; #fetch
  constructor(credential, { fetchImpl = fetch } = {}) {
    validateCredential(credential); this.#credential = credential; this.#fetch = fetchImpl
  }
  async #send(url, options, timeout = 60_000) {
    try { return await this.#fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) }) }
    catch { fail('dropbox_network_error') }
  }
  async #refresh() {
    if (this.#token && Date.now() < this.#until) return
    const t = await json(await this.#send('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.#credential.client_id, refresh_token: this.#credential.refresh_token })
    }))
    if (typeof t.access_token !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,16384}$/.test(t.access_token)
      || String(t.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(t.expires_in) || t.expires_in < 120) fail('invalid_refresh_response')
    if (t.scope !== undefined) {
      const scopes = new Set(String(t.scope).split(/\s+/))
      if (scopes.size !== SCOPES.length || SCOPES.some(s => !scopes.has(s))) fail('unexpected_oauth_scopes')
    }
    const account = await json(await this.#send(RPC + 'users/get_current_account', {
      method: 'POST', headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' }, body: 'null'
    }))
    if (account.account_id !== this.#credential.account_id || account.disabled === true) {
      this.#token = undefined; this.#until = 0; fail('account_mismatch_or_disabled')
    }
    this.#token = t.access_token; this.#until = Date.now() + Math.min(t.expires_in - 60, 3600) * 1000
  }
  async #rpc(route, arg) {
    await this.#refresh()
    return json(await this.#send(RPC + route, { method: 'POST', headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(arg) }))
  }
  async #upload(route, arg, bytes) {
    await this.#refresh()
    return json(await this.#send(CONTENT + route, { method: 'POST', headers: { Authorization: `Bearer ${this.#token}`,
      'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify(arg) }, body: bytes }))
  }
  async inventory() {
    const files = [], ids = new Set(), cursors = new Set()
    let page = await this.#rpc('files/list_folder', { path: '', recursive: true, include_deleted: false, limit: 1000 })
    for (let count = 0; count < 100; count++) {
      if (!Array.isArray(page.entries) || typeof page.has_more !== 'boolean' || page.entries.length > 1000) fail('invalid_inventory')
      for (const entry of page.entries) {
        if (!['file', 'folder'].includes(entry?.['.tag']) || typeof entry.id !== 'string' || ids.has(entry.id)) fail('invalid_inventory')
        ids.add(entry.id)
        if (entry['.tag'] === 'file') {
          if (!uint(entry.size) || typeof entry.path_lower !== 'string' || !hash(entry.content_hash)) fail('invalid_inventory')
          files.push(entry)
        }
      }
      if (!page.has_more) return files
      if (typeof page.cursor !== 'string' || !page.cursor || cursors.has(page.cursor)) fail('invalid_inventory_cursor')
      cursors.add(page.cursor); page = await this.#rpc('files/list_folder/continue', { cursor: page.cursor })
    }
    fail('inventory_page_limit')
  }
  // Generator must finish only AFTER both archive and age subprocesses exit successfully.
  // A failed/ambiguous session is never retried or committed; caller retains its reservation.
  async upload(id, encryptedChunks, reservedBytes, beforeCommit) {
    const path = artifactPath(id)
    if (!uint(reservedBytes) || reservedBytes < 1 || typeof beforeCommit !== 'function') fail('invalid_upload')
    const start = await this.#upload('files/upload_session/start', { close: false }, Buffer.alloc(0))
    if (typeof start.session_id !== 'string' || !start.session_id || start.session_id.length > 1024) fail('invalid_upload_session')
    const digests = new Digests(); let offset = 0, header = Buffer.alloc(0), validatedHeader = false
    let held = []
    const append = async chunk => {
      if (offset + chunk.length > reservedBytes) fail('upload_reservation_exceeded')
      await this.#upload('files/upload_session/append_v2', { cursor: { session_id: start.session_id, offset }, close: false }, chunk)
      digests.update(chunk); offset += chunk.length
    }
    for await (const chunk of encryptedChunks) {
      if (!Buffer.isBuffer(chunk) || chunk.length > BLOCK || !chunk.length) fail('invalid_encrypted_chunk')
      if (!validatedHeader) {
        held.push(chunk); header = Buffer.concat([header, chunk.subarray(0, AGE_PREFIX.length - header.length)])
        if (header.length < AGE_PREFIX.length) continue
        if (!header.equals(AGE_PREFIX)) fail('age_ciphertext_required')
        validatedHeader = true
        for (const part of held) await append(part)
        held = []
      } else await append(chunk)
    }
    if (offset < 100 || !validatedHeader) fail('empty_or_invalid_ciphertext')
    const result = digests.finish()
    await beforeCommit(result)
    const entry = await this.#upload('files/upload_session/finish', {
      cursor: { session_id: start.session_id, offset }, commit: { path, mode: 'add', autorename: false, strict_conflict: true, mute: true }
    }, Buffer.alloc(0))
    if (entry?.['.tag'] && entry['.tag'] !== 'file') fail('invalid_upload_receipt')
    if (entry.path_lower !== path || entry.size !== result.bytes || entry.content_hash !== result.contentHash
      || typeof entry.id !== 'string' || !entry.id.startsWith('id:') || !/^[a-f0-9]{9,64}$/.test(entry.rev || '')) fail('upload_receipt_mismatch')
    return { ...result, remoteId: entry.id, rev: entry.rev }
  }
  async deleteBackup(point) {
    const path = artifactPath(point.id)
    if (!/^id:[A-Za-z0-9_-]+$/.test(point.remoteId) || !/^[a-f0-9]{9,64}$/.test(point.rev) || !hash(point.contentHash)) fail('invalid_delete_target')
    const result = await this.#rpc('files/delete_v2', { path: point.remoteId, parent_rev: point.rev })
    const m = result?.metadata
    if (m?.['.tag'] !== 'file' || m.id !== point.remoteId || m.rev !== point.rev || m.path_lower !== path
      || m.size !== point.bytes || m.content_hash !== point.contentHash) fail('delete_receipt_requires_reconciliation')
    return { deleted: true }
  }
  async download(point, write) {
    artifactPath(point.id)
    await this.#refresh()
    const response = await this.#send(CONTENT + 'files/download', { method: 'POST', headers: {
      Authorization: `Bearer ${this.#token}`, 'Dropbox-API-Arg': JSON.stringify({ path: `rev:${point.rev}` })
    } }, 15 * 60_000)
    if (!response.ok) { await response.body?.cancel().catch(() => {}); fail(`dropbox_http_${response.status}`) }
    const reader = response.body?.getReader(); if (!reader) fail('invalid_download_response')
    try {
      let meta
      try { meta = JSON.parse(response.headers.get('dropbox-api-result')) } catch { fail('invalid_download_metadata') }
      if (meta?.id !== point.remoteId || meta.rev !== point.rev || meta.path_lower !== artifactPath(point.id)
        || meta.size !== point.bytes || meta.content_hash !== point.contentHash) fail('download_metadata_mismatch')
      const digests = new Digests()
      while (true) {
        const { value, done } = await reader.read(); if (done) break
        if (digests.size + value.byteLength > point.bytes) fail('download_size_exceeded')
        const buffer = Buffer.from(value); digests.update(buffer); await write(buffer)
      }
      const result = digests.finish()
      if (result.bytes !== point.bytes || result.sha256 !== point.sha256 || result.contentHash !== point.contentHash) fail('download_integrity_failed')
      return result
    } catch (e) {
      await reader.cancel().catch(() => {})
      if (e instanceof BackupError) throw e
      fail('download_failed')
    } finally { reader.releaseLock() }
  }
}
