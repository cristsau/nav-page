// Shared, bounded input policy; runtime capabilities are independently gated.
import { createHash } from 'node:crypto'
export const MEDIA_LIMIT = 6 * 1024 ** 3
export const TORRENT_LIMIT = 1024 * 1024
const reject = code => { throw Error(code) }

export function magnetSource(raw) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\x00-\x20\x7f]/.test(raw)) reject('INVALID_MAGNET')
  let url
  try { url = new URL(raw) } catch { reject('INVALID_MAGNET') }
  if (url.protocol !== 'magnet:' || url.host || url.hash || url.pathname) reject('INVALID_MAGNET')
  const xt = url.searchParams.getAll('xt')
  if (xt.length !== 1 || !/^urn:btih:[a-f0-9]{40}$/i.test(xt[0])) reject('UNSUPPORTED_MAGNET')
  // No x.pe, xs, as or web-seed injection. Tracker input is retained only as data,
  // then guarded by the isolated downloader network, never a shell command.
  const normalized = new URL('magnet:?xt=' + encodeURIComponent(xt[0].toLowerCase()))
  const trackers = url.searchParams.getAll('tr')
  if (trackers.length > 8) reject('INVALID_MAGNET')
  for (const tracker of trackers) {
    if (tracker.length > 512 || /[\x00-\x20\x7f]/.test(tracker)) reject('INVALID_TRACKER')
    let address
    try { address = new URL(tracker) } catch { reject('INVALID_TRACKER') }
    if (!['https:', 'http:', 'udp:'].includes(address.protocol) || address.username || address.password || address.hash || !address.hostname.includes('.')) reject('INVALID_TRACKER')
    normalized.searchParams.append('tr', address.href)
  }
  return { uri: normalized.href, infoHash: xt[0].slice(9).toLowerCase() }
}

// Parse exact bencode bytes; hash the original info dictionary, not a re-encoding.
// Reject path traversal, links, unsupported BEP52-only metadata and private torrents.
export function torrentMetadata(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > TORRENT_LIMIT) reject('INVALID_TORRENT')
  let offset = 0, nodes = 0, infoBytes
  const text = value => { if (!Buffer.isBuffer(value)) reject('INVALID_TORRENT'); return new TextDecoder('utf-8', { fatal: true }).decode(value) }
  function parse(depth = 0) {
    if (depth > 24 || ++nodes > 30000 || offset >= bytes.length) reject('INVALID_TORRENT')
    const start = offset, tag = bytes[offset++]
    if (tag === 105) {
      const end = bytes.indexOf(101, offset)
      if (end < 0 || end - offset > 16) reject('INVALID_TORRENT')
      const raw = bytes.subarray(offset, end).toString('latin1'); offset = end + 1
      if (!/^(?:0|[1-9]\d*|-[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) reject('INVALID_TORRENT')
      return Number(raw)
    }
    if (tag === 100 || tag === 108) {
      const value = tag === 100 ? Object.create(null) : []
      while (bytes[offset] !== 101) {
        if (offset >= bytes.length) reject('INVALID_TORRENT')
        if (tag === 108) value.push(parse(depth + 1))
        else {
          const key = text(parse(depth + 1))
          if (Object.hasOwn(value, key) || key.length > 256) reject('INVALID_TORRENT')
          const begin = offset; value[key] = parse(depth + 1)
          if (depth === 0 && key === 'info') infoBytes = bytes.subarray(begin, offset)
        }
      }
      offset++; return value
    }
    if (tag >= 48 && tag <= 57) {
      const end = bytes.indexOf(58, start)
      if (end < 0 || end - start > 7) reject('INVALID_TORRENT')
      const raw = bytes.subarray(start, end).toString('latin1')
      if (!/^(?:0|[1-9]\d*)$/.test(raw)) reject('INVALID_TORRENT')
      const length = Number(raw); offset = end + 1 + length
      if (offset > bytes.length) reject('INVALID_TORRENT')
      return bytes.subarray(end + 1, offset)
    }
    reject('INVALID_TORRENT')
  }
  let root
  try { root = parse() } catch { reject('INVALID_TORRENT') }
  if (offset !== bytes.length || !root || !infoBytes || !root.info || Array.isArray(root.info)) reject('INVALID_TORRENT')
  const info = root.info
  if (info.private === 1) reject('PRIVATE_TORRENT_UNSUPPORTED')
  if (info['meta version'] || info['symlink path'] || info['name.utf-8'] || (info.attr && text(info.attr).includes('l'))
    || (Object.hasOwn(info, 'files') && Object.hasOwn(info, 'length'))) reject('UNSUPPORTED_TORRENT')
  const component = raw => {
    let value
    try { value = text(raw) } catch { reject('INVALID_TORRENT_PATH') }
    if (!value || value.length > 255 || value !== value.trim() || /^[. ]+$/.test(value)
      || /[\x00-\x1f\x7f/\\:]/.test(value) || value.endsWith('.')) reject('INVALID_TORRENT_PATH')
    return value
  }
  const name = component(info.name)
  const rawFiles = info.files || [{ length: info.length, path: [] }]
  if (!Array.isArray(rawFiles) || !rawFiles.length || rawFiles.length > 100) reject('TORRENT_FILE_LIMIT')
  const paths = new Set(), files = rawFiles.map((file, i) => {
    if (!Number.isSafeInteger(file.length) || file.length < 0 || !Array.isArray(file.path) || file.path.length > 16 || file['symlink path'] || file['path.utf-8']
      || (file.attr && text(file.attr).includes('l'))) reject('INVALID_TORRENT')
    const path = [name, ...file.path.map(component)].join('/')
    if (path.length > 1024 || paths.has(path.toLowerCase())) reject('INVALID_TORRENT_PATH')
    paths.add(path.toLowerCase()); return { index: i + 1, path, size: file.length }
  })
  const total = files.reduce((sum, file) => sum + file.size, 0), piece = info['piece length']
  if (!Number.isSafeInteger(total) || total > MEDIA_LIMIT) reject('DOWNLOAD_TOO_LARGE')
  if (!Number.isSafeInteger(piece) || piece < 16384 || piece > 16 * 1024 * 1024 || (piece & (piece - 1)) !== 0 || !Buffer.isBuffer(info.pieces)
    || info.pieces.length !== Math.ceil(total / piece) * 20) reject('INVALID_TORRENT')
  // Rebuild only the outer envelope. Original info bytes (and hash) remain exact;
  // url-list/httpseeds/nodes and arbitrary extension fields never reach aria2.
  const candidates = [root.announce, ...(Array.isArray(root['announce-list']) ? root['announce-list'].flat() : [])]
  const trackers = []
  for (const value of candidates) {
    if (!Buffer.isBuffer(value)) continue
    let uri
    try { uri = text(value); magnetSource('magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&tr=' + encodeURIComponent(uri)) } catch { continue }
    if (!trackers.includes(uri) && trackers.length < 8) trackers.push(uri)
  }
  const encode = value => { const b = Buffer.from(value); return Buffer.concat([Buffer.from(b.length + ':'), b]) }
  const envelope = [Buffer.from('d')]
  if (trackers.length) envelope.push(encode('announce'), encode(trackers[0]), encode('announce-list'), Buffer.from('l'),
    ...trackers.flatMap(t => [Buffer.from('l'), encode(t), Buffer.from('e')]), Buffer.from('e'))
  envelope.push(encode('info'), infoBytes, Buffer.from('e'))
  return { infoHash: createHash('sha1').update(infoBytes).digest('hex'), total, files, torrent: Buffer.concat(envelope).toString('base64') }
}

export function torrentInput(raw) {
  if (typeof raw !== 'string' || raw.length > Math.ceil(TORRENT_LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) reject('INVALID_TORRENT')
  const bytes = Buffer.from(raw, 'base64')
  if (bytes.toString('base64') !== raw) reject('INVALID_TORRENT')
  return torrentMetadata(bytes)
}

export function selectTorrentFile(metadata, index) {
  if (index == null && metadata.files.length !== 1) reject('BT_FILE_SELECTION_REQUIRED')
  if (index != null && (!Number.isSafeInteger(index) || index < 1)) reject('INVALID_TORRENT_SELECTION')
  const file = metadata.files.find(file => file.index === (index ?? 1))
  if (!file) reject('INVALID_TORRENT_SELECTION')
  return file
}

export function videoOutputBudget(duration) { return Math.min(MEDIA_LIMIT, Math.ceil(duration * 2400000 / 8) + 16 * 1024 * 1024) }
export function compatibleVideoArgs(directory, duration, size) {
  if (!/^\/var\/lib\/nav-media\/[a-f0-9]{32}$/.test(directory)) reject('INVALID_MEDIA_DIRECTORY')
  if (!Number.isFinite(duration) || duration <= 0 || duration > 4 * 3600 || !Number.isSafeInteger(size) || size < 1 || size > MEDIA_LIMIT) reject('TRANSCODE_INPUT_LIMIT')
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1',
    '-protocol_whitelist', 'file', '-i', directory + '/source.bin', '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', 'scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-maxrate', '2000k', '-bufsize', '4000k', '-threads', '1', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart', '-fs', String(videoOutputBudget(duration)), directory + '/compatible.mp4']
}

export function verifyCompatibleVideo({ inputDuration, outputDuration, outputSize, videoCodec, pixelFormat, audioCodecs }) {
  if (!Number.isFinite(inputDuration) || !Number.isFinite(outputDuration) || inputDuration <= 0 || outputDuration <= 0
    || Math.abs(inputDuration - outputDuration) > Math.max(2, inputDuration * 0.005)
    || !Number.isSafeInteger(outputSize) || outputSize < 1 || outputSize >= MEDIA_LIMIT
    || videoCodec !== 'h264' || pixelFormat !== 'yuv420p' || !Array.isArray(audioCodecs) || audioCodecs.some(codec => codec !== 'aac')) reject('TRANSCODE_VERIFY_FAILED')
  return true
}
