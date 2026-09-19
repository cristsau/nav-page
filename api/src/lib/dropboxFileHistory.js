import { metadata, revision, filePath, protectPath, deny, UPLOAD_LIMIT } from './dropboxFiles.js'
import { dropboxContentHash } from './dropboxFileUploads.js'

export async function listFileHistory(service, id) {
  const guards = await service.protection(), current = await service.get(id, false, guards)
  if (current.type !== 'file') deny('FILE_UNAVAILABLE', 415)
  const result = await service.client.rpc('files/list_revisions', { path: current.id, mode: 'id', limit: 20 })
  if (!Array.isArray(result.entries) || result.entries.length > 20 || typeof result.is_deleted !== 'boolean') deny('INVALID_PROVIDER_RESPONSE', 502)
  if (result.is_deleted) deny('FILE_CHANGED', 409)
  const entries = result.entries.map(raw => {
    const item = metadata(raw, 'file')
    if (item.id !== current.id) deny('INVALID_PROVIDER_RESPONSE', 502)
    // A file's historical location must also be outside the protected backup tree.
    protectPath(item.path, guards)
    return item
  })
  return { current, entries, limit: 20, recoveryLimit: UPLOAD_LIMIT }
}

export async function fileRevision(service, id, rev) {
  revision(rev)
  const history = await listFileHistory(service, id)
  const item = history.entries.find(item => item.rev === rev)
  if (!item || !item.downloadable) deny('REVISION_UNAVAILABLE', 409)
  return { item, current: history.current }
}

export async function recoverRevisionCopy(service, id, rev, destination) {
  const { item, current } = await fileRevision(service, id, rev)
  if (item.size > UPLOAD_LIMIT) deny('REVISION_COPY_TOO_LARGE', 413)
  destination = filePath(destination)
  const parentPath = current.path.slice(0, current.path.lastIndexOf('/'))
  // Only a new sibling, never overwrite the original or accept arbitrary destinations.
  if (destination.slice(0, destination.lastIndexOf('/')) !== parentPath || destination.toLowerCase() === current.path.toLowerCase()) deny('INVALID_DESTINATION')
  protectPath(destination, await service.protection(), true)
  const parent = parentPath ? await service.client.getMetadataIfExists(parentPath) : null
  if (parentPath && (!parent || parent.type !== 'folder')) deny('FILE_CHANGED', 409)
  if (await service.client.getMetadataIfExists(destination)) deny('TARGET_EXISTS', 409)
  const response = await service.client.download(item), reader = response.body.getReader(), chunks = []
  let size = 0, bytes
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break
      size += next.value.length
      if (size > item.size || size > UPLOAD_LIMIT) deny('INVALID_PROVIDER_RESPONSE', 502)
      chunks.push(Buffer.from(next.value))
    }
    if (size !== item.size) deny('FILE_CHANGED', 409)
    bytes = Buffer.concat(chunks)
    const fresh = await service.get(id, true)
    if (fresh.path !== current.path || fresh.rev !== current.rev) deny('FILE_CHANGED', 409)
    if (parent) {
      const freshParent = await service.get(parent.id, false)
      if (freshParent.path !== parentPath) deny('FILE_CHANGED', 409)
    }
    protectPath(destination, await service.protection(), true)
    // Strict add, no overwrite or automatic retry. Ambiguous commits require manual review.
    const raw = await service.client.upload(destination, bytes)
    const receipt = metadata(raw, 'file')
    if (receipt.path !== destination || receipt.size !== size || raw.content_hash !== dropboxContentHash(bytes)) deny('UPLOAD_RECEIPT_INVALID', 502)
    return receipt
  } finally {
    await reader.cancel().catch(() => {}); reader.releaseLock()
    bytes?.fill(0); for (const part of chunks) part.fill(0)
  }
}
