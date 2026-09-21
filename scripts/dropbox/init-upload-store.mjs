// Explicit operator command; never called by HTTP or application startup.
import { lstat, mkdir, open } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export async function initUploadStore(path, purpose = 'web') {
  if (!['web', 'offline'].includes(purpose)) throw Error('INVALID_PURPOSE')
  const names = purpose === 'web'
    ? { config: 'dropbox-uploads.json', state: 'dropbox-upload-state' }
    : { config: 'dropbox-offline-uploads.json', state: 'dropbox-offline-upload-state' }
  if (process.platform !== 'linux' || process.getuid() !== 0 || resolve(path) !== path || path === '/') throw Error('LINUX_PRIVATE_DIRECTORY_REQUIRED')
  let parent = path
  while (true) {
    const s = await lstat(parent)
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & (parent === path ? 0o077 : 0o022))) throw Error('UNSAFE_DIRECTORY')
    if (parent === '/') break
    parent = dirname(parent)
  }
  // Refuse overwriting keys or recreating lost metadata. Partial initialization
  // requires an operator review, not automatic key rotation.
  for (const name of [names.config, names.state]) {
    try { await lstat(join(path, name)); throw Error('ALREADY_INITIALIZED_OR_PARTIAL') }
    catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  await mkdir(join(path, names.state), { mode: 0o700 })
  const fd = await open(join(path, names.config), 'wx', 0o600)
  try { await fd.writeFile(JSON.stringify({ version: 1, enabled: true, key: randomBytes(32).toString('hex') })); await fd.sync() }
  finally { await fd.close() }
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
  return { state: 'UPLOAD_METADATA_STORE_INITIALIZED', purpose, cloudAccess: false }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (![3, 4].includes(process.argv.length)) throw Error('PRIVATE_DIRECTORY_AND_OPTIONAL_PURPOSE_REQUIRED')
    console.log(JSON.stringify(await initUploadStore(process.argv[2], process.argv[3])))
  } catch { console.error('UPLOAD_STORE_INIT_NOT_COMPLETED'); process.exitCode = 1 }
}
