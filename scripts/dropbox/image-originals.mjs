// Bounded image-bed response capture for a consistent NAV database snapshot.
// The provider representation may differ from the original upload metadata.
// No credentials, arbitrary origins, redirects, local addresses or executable content.
import { createHash } from 'node:crypto'
import { request } from 'node:https'
import { resolve4 } from 'node:dns/promises'
import { open, lstat, realpath, readFile, mkdir, statfs, rename } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publicAddress } from '../offline/safe-download.mjs'
const LIMIT = 128 * 1024 * 1024, FILE_LIMIT = 10 * 1024 * 1024, RESERVE = 2 * 1024 ** 3
const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
const fail = code => { throw Error(code) }
export function inventory(rows) {
  if (!Array.isArray(rows) || rows.length > 2000) fail('ATTACHMENT_INVENTORY_LIMIT')
  const unique = new Map()
  for (const row of rows) {
    let url
    try { url = new URL(row.url) } catch { fail('ATTACHMENT_URL_INVALID') }
    if (url.origin !== 'https://pic.skrskr.net' || url.username || url.password || url.search || url.hash
      || !/^\/file\/[A-Za-z0-9_./-]{1,1000}$/.test(url.pathname) || url.pathname.split('/').some(p => p === '.' || p === '..')
      || !Number.isSafeInteger(row.size) || row.size < 1 || row.size > FILE_LIMIT || !Object.hasOwn(types, row.mime)) fail('ATTACHMENT_INVENTORY_INVALID')
    if (unique.has(url.href) && (unique.get(url.href).size !== row.size || unique.get(url.href).mime !== row.mime)) fail('ATTACHMENT_METADATA_CONFLICT')
    unique.set(url.href, { url: url.href, size: row.size, mime: row.mime, file: createHash('sha256').update(url.href).digest('hex') + '.' + types[row.mime] })
  }
  const result = [...unique.values()]
  if (result.reduce((n, row) => n + row.size, 0) > LIMIT) fail('ATTACHMENT_BUDGET_EXCEEDED')
  return result
}
export function imageSignature(buffer, mime) {
  return mime === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : mime === 'image/jpeg' ? buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      : mime === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())
        : mime === 'image/webp' && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
}
export async function responseFor(row, resolver = resolve4, connect = request) {
  const url = new URL(row.url), addresses = await resolver(url.hostname)
  if (!addresses.length || addresses.some(ip => !publicAddress(ip))) fail('ATTACHMENT_ADDRESS_BLOCKED')
  return new Promise((accept, reject) => {
    const req = connect(url, { agent: false, family: 4, autoSelectFamily: false, signal: AbortSignal.timeout(60000),
      lookup: (_name, options, callback) => options.all ? callback(null, [{ address: addresses[0], family: 4 }]) : callback(null, addresses[0], 4),
      headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'DOMO-NAV-Original-Backup/1' } }, response => {
      const length = response.headers['content-length']
      if (response.statusCode !== 200 || (length !== undefined && (!/^[1-9][0-9]*$/.test(length) || Number(length) > FILE_LIMIT))
        || !Object.hasOwn(types, response.headers['content-type']?.split(';')[0].trim().toLowerCase())
        || ![undefined, 'identity'].includes(response.headers['content-encoding'])) { response.destroy(); reject(Error('ATTACHMENT_RESPONSE_INVALID')); return }
      accept(response)
    })
    req.once('error', () => reject(Error('ATTACHMENT_FETCH_FAILED'))); req.end()
  })
}
export async function capture(rows, directory, { fetch = responseFor, disk = statfs } = {}) {
  const entries = inventory(rows), s = await lstat(directory)
  const actual = await realpath(directory), samePath = process.platform === 'win32' ? resolve(directory).toLowerCase() === actual.toLowerCase() : resolve(directory) === actual
  if (!s.isDirectory() || s.isSymbolicLink() || !samePath
    || (process.platform !== 'win32' && (s.uid !== process.getuid() || (s.mode & 0o077)))) fail('ATTACHMENT_DIRECTORY_INVALID')
  // DB size is the upload input size, not an immutable provider content length.
  // Reserve the full bounded capture budget; preserve metadata separately.
  const free = await disk(directory)
  if (free.bavail * free.bsize < LIMIT + RESERVE) fail('ATTACHMENT_DISK_LIMIT')
  const originals = join(directory, 'originals'); await mkdir(originals, { mode: 0o700 }) // new snapshot only, never overwrite
  const manifest = []; let bytes = 0
  for (const row of entries) {
    const response = await fetch(row), fd = await open(join(originals, row.file), 'wx', 0o600), hash = createHash('sha256')
    let size = 0, header = Buffer.alloc(0), captured
    try {
      for await (const chunk of response) {
        size += chunk.length
        if (size > FILE_LIMIT || bytes + size > LIMIT) fail('ATTACHMENT_BUDGET_EXCEEDED')
        if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)])
        hash.update(chunk); let offset = 0
        while (offset < chunk.length) { const { bytesWritten } = await fd.write(chunk, offset, chunk.length - offset); if (!bytesWritten) fail('ATTACHMENT_DISK_LIMIT'); offset += bytesWritten }
      }
      const declared = response.headers?.['content-length']
      const mime = Object.keys(types).find(type => imageSignature(header, type))
      if (size < 1 || (declared !== undefined && size !== Number(declared)) || !mime) fail('ATTACHMENT_CONTENT_INVALID')
      const responseMime = response.headers?.['content-type']?.split(';')[0].trim().toLowerCase() || null
      await fd.sync(); bytes += size
      captured = { ...row, sourceSize: row.size, size, sizeMatchesSourceMetadata: size === row.size,
        sourceMime: row.mime, responseMime, mime, mimeMatchesSourceMetadata: mime === row.mime,
        responseMimeMatchesContent: responseMime === null ? null : responseMime === mime,
        file: 'originals/' + row.file.replace(/\.[a-z]+$/, '.' + types[mime]), sha256: hash.digest('hex') }
    } finally { response.destroy(); await fd.close() }
    // A private fresh snapshot plus deduplicated URL hashes prevents collisions.
    if (captured.file !== 'originals/' + row.file) await rename(join(originals, row.file), join(directory, captured.file))
    manifest.push(captured)
  }
  const fd = await open(join(directory, 'originals-manifest.json'), 'wx', 0o600)
  try { await fd.writeFile(JSON.stringify({ version: 2, state: 'complete', byteIdentity: 'imagebed_response',
    metadataSizeMismatchCount: manifest.filter(e => !e.sizeMatchesSourceMetadata).length,
    metadataMimeMismatchCount: manifest.filter(e => !e.mimeMatchesSourceMetadata).length,
    responseMimeMismatchCount: manifest.filter(e => e.responseMimeMatchesContent === false).length,
    count: manifest.length, bytes, entries: manifest })); await fd.sync() } finally { await fd.close() }
  return { count: manifest.length, bytes }
}
export async function main(input) {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !/^\/var\/backups\/nav\/\.nav-backup\.[A-Za-z0-9]{8}\/attachments\/originals-input\.json$/.test(input || '')) fail('ATTACHMENT_ENVIRONMENT_INVALID')
  const s = await lstat(input)
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== 0 || (s.mode & 0o077) || s.size > 4 * 1024 * 1024) fail('ATTACHMENT_INVENTORY_INVALID')
  const result = await capture(JSON.parse(await readFile(input, 'utf8')), dirname(input))
  console.log(JSON.stringify({ state: 'ORIGINAL_BYTES_CAPTURED', ...result }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]).catch(error => {
  console.error(/^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'ATTACHMENT_BACKUP_FAILED'); process.exitCode = 1
})
