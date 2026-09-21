import { resolve4 } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

export function publicAddress(address) {
  if (isIP(address) !== 4) return false
  if (['172.81.57.10', '15.204.56.108'].includes(address)) return false // Do not target the controller or worker's own public services.
  const [a, b, c] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
}
export function parseUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\x00-\x20\x7f]/.test(raw)) throw Error('INVALID_DOWNLOAD_URL')
  let url
  try { url = new URL(raw) } catch { throw Error('INVALID_DOWNLOAD_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) || !url.hostname.includes('.')) throw Error('INVALID_DOWNLOAD_URL')
  return url
}
export async function pinnedTarget(raw, resolve = resolve4) {
  const url = parseUrl(raw), addresses = isIP(url.hostname) ? [url.hostname] : await resolve(url.hostname)
  if (!addresses.length || addresses.some(a => !publicAddress(a))) throw Error('UNSAFE_DOWNLOAD_HOST')
  return { url, address: addresses[0] }
}
export async function downloadResponse(raw, { offset = 0, etag = '', signal, resolve, connect } = {}) {
  let next = raw
  for (let hop = 0; hop <= 5; hop++) {
    const { url, address } = await pinnedTarget(next, resolve)
    const response = await new Promise((accept, reject) => {
      const request = (connect || (url.protocol === 'https:' ? httpsRequest : httpRequest))(url, {
        agent: false, family: 4, autoSelectFamily: false, signal, timeout: 30000,
        lookup: (_host, options, callback) => options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
        headers: { 'User-Agent': 'DOMO-NAV-Offline/1', 'Accept-Encoding': 'identity',
          ...(offset && etag ? { Range: `bytes=${offset}-`, 'If-Range': etag } : {}) }
      }, accept)
      request.once('error', () => reject(Error(signal?.aborted ? 'DOWNLOAD_INTERRUPTED' : 'DOWNLOAD_NETWORK_FAILED')))
      request.once('timeout', () => request.destroy(Error('DOWNLOAD_TIMEOUT'))); request.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy()
      if (hop === 5 || !response.headers.location) throw Error('DOWNLOAD_REDIRECT_LIMIT')
      const target = parseUrl(new URL(response.headers.location, url).href)
      if (url.protocol === 'https:' && target.protocol !== 'https:') throw Error('DOWNLOAD_DOWNGRADE_BLOCKED')
      next = target.href; continue
    }
    if (![200, 206].includes(response.statusCode)) { response.destroy(); throw Error('DOWNLOAD_HTTP_FAILED') }
    const length = response.headers['content-length'], encoding = response.headers['content-encoding']
    if (typeof length !== 'string' || !/^\d{1,12}$/.test(length) || (encoding && encoding !== 'identity')
      || /text\/html/i.test(response.headers['content-type'] || '')) { response.destroy(); throw Error('DOWNLOAD_NOT_DIRECT_FILE') }
    const remaining = Number(length)
    let start = 0, total = remaining
    if (response.statusCode === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '')
      if (!offset || !etag || !range || Number(range[1]) !== offset || Number(range[2]) - offset + 1 !== remaining
        || Number(range[2]) + 1 !== Number(range[3]) || response.headers.etag !== etag) { response.destroy(); throw Error('DOWNLOAD_RANGE_CHANGED') }
      start = offset; total = Number(range[3])
    }
    const newEtag = typeof response.headers.etag === 'string' && /^"[^\x00-\x20\x7f]{1,1024}"$/.test(response.headers.etag) ? response.headers.etag : ''
    return { response, start, total, etag: newEtag }
  }
  throw Error('DOWNLOAD_REDIRECT_LIMIT')
}
