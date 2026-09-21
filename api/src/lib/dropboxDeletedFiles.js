import { filePath, metadata, revision, protectPath, deny, UPLOAD_LIMIT } from './dropboxFiles.js'
import { copyRevisionBytes } from './dropboxFileHistory.js'

function deletedMetadata(raw) {
  if (raw?.['.tag'] !== 'deleted' || typeof raw.name !== 'string') deny('DELETED_FILE_CHANGED', 409)
  const path = filePath(raw.path_display || raw.path_lower)
  if (path.split('/').pop() !== raw.name) deny('INVALID_PROVIDER_RESPONSE', 502)
  return { path, name: raw.name, type: 'deleted' }
}
export async function deletedAt(service, path) {
  path = filePath(path)
  protectPath(path, await service.protection(), true)
  const item = deletedMetadata(await service.client.rpc('files/get_metadata', { path, include_deleted: true }))
  if (item.path !== path) deny('DELETED_FILE_CHANGED', 409)
  return item
}
export async function listDeletedFiles(service, path = '', cursor = null) {
  path = filePath(path, true)
  const guards = await service.protection()
  protectPath(path, guards)
  const result = await service.client.rpc(cursor ? 'files/list_folder/continue' : 'files/list_folder', cursor ? { cursor }
    : { path, recursive: false, include_deleted: true, limit: 100 })
  // Provider limit is approximate. Bound response work even for a larger page.
  if (!Array.isArray(result.entries) || result.entries.length > 1000 || typeof result.has_more !== 'boolean'
    || (result.has_more && (typeof result.cursor !== 'string' || result.cursor.length > 16384))) deny('INVALID_PROVIDER_RESPONSE', 502)
  const entries = []
  for (const raw of result.entries) {
    if (raw?.['.tag'] !== 'deleted') continue
    const item = deletedMetadata(raw)
    if (item.path.slice(0, item.path.lastIndexOf('/')).toLowerCase() !== path.toLowerCase()) deny('INVALID_PROVIDER_RESPONSE', 502)
    try { protectPath(item.path, guards, true) } catch (error) { if (error.code === 'BACKUP_PROTECTED') continue; throw error }
    entries.push(item)
  }
  return { entries, hasMore: result.has_more, cursor: result.has_more ? result.cursor : null }
}
export async function deletedHistory(service, path) {
  const deleted = await deletedAt(service, path), guards = await service.protection()
  const result = await service.client.rpc('files/list_revisions', { path: deleted.path, mode: 'path', limit: 20 })
  if (result.is_deleted !== true) deny('DELETED_FILE_CHANGED', 409)
  if (!Array.isArray(result.entries) || result.entries.length > 20) deny('INVALID_PROVIDER_RESPONSE', 502)
  const entries = result.entries.map(raw => {
    const item = metadata(raw, 'file')
    if (item.path !== deleted.path) deny('DELETED_FILE_CHANGED', 409)
    protectPath(item.path, guards, true)
    return item
  })
  if (new Set(entries.map(item => item.id)).size > 1) deny('DELETED_FILE_CHANGED', 409)
  await deletedAt(service, path)
  return { deleted, entries, recoveryLimit: UPLOAD_LIMIT, limit: 20 }
}
export async function deletedRevision(service, path, rev) {
  revision(rev)
  const history = await deletedHistory(service, path)
  const item = history.entries.find(item => item.rev === rev && item.downloadable)
  if (!item) deny('REVISION_UNAVAILABLE', 409)
  return item
}
export async function recoverDeletedCopy(service, path, rev, destination) {
  const item = await deletedRevision(service, path, rev)
  return copyRevisionBytes(service, item, destination, async () => {
    const fresh = await deletedRevision(service, path, rev)
    if (fresh.id !== item.id || fresh.size !== item.size || fresh.path !== item.path) deny('DELETED_FILE_CHANGED', 409)
  })
}
