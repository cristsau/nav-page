// Dropbox content hash: SHA256 of concatenated SHA256 digests of 4 MiB blocks.
// Bounded file reads, no persistent browser data, cancellable between blocks.
export async function fileContentHash(file, { stopped = () => false, progress = () => {} } = {}) {
  const block = 4 * 1024 * 1024
  const hashes = new Uint8Array(Math.ceil(file.size / block) * 32)
  for (let offset = 0; offset < file.size; offset += block) {
    if (stopped()) throw Object.assign(Error('UPLOAD_HASH_CANCELLED'), { code: 'UPLOAD_HASH_CANCELLED' })
    const bytes = await file.slice(offset, Math.min(offset + block, file.size)).arrayBuffer()
    hashes.set(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), offset / block * 32)
    progress(Math.min(offset + block, file.size))
  }
  if (stopped()) throw Object.assign(Error('UPLOAD_HASH_CANCELLED'), { code: 'UPLOAD_HASH_CANCELLED' })
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', hashes)), n => n.toString(16).padStart(2, '0')).join('')
}
