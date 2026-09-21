import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { ControlError } from './control-core.mjs'

// Socket transport is started by the root-only adapter. Tests bind only loopback
// with synthetic IO. No generic command endpoint and no provider URL in responses.
export function createControlServer({ controller, streamCiphertext, ownerUserId }) {
  let transfer = false, ticking = false
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Type', 'application/json')
    const json = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)) }
    try {
      if (req.headers['x-nav-owner'] !== ownerUserId) throw new ControlError('OWNER_REQUIRED', 403)
      if (req.method === 'GET' && req.url === '/v1/status') {
        const status = await controller.status(); return json(200, { ...status, busy: status.busy || transfer })
      }
      const match = /^\/v1\/ciphertext\/([a-f0-9]{32})$/.exec(req.url)
      if (req.method === 'GET' && match) {
        const status = await controller.status()
        if (!status.capabilities.download) throw new ControlError('OPERATION_DISABLED', 503)
        if (transfer || ticking || status.busy) throw new ControlError('BACKUP_BUSY')
        transfer = true
        const deadline = setTimeout(() => res.destroy(), 15 * 60_000)
        try {
          await streamCiphertext(match[1], async (point, download) => {
            res.setHeader('Content-Type', 'application/octet-stream')
            res.setHeader('Content-Disposition', `attachment; filename="nav-${match[1]}.tar.age"`)
            res.setHeader('Content-Length', String(point.bytes))
            // Hold the final chunk until full SHA256 + provider content hash pass.
            // A bad/truncated download cannot yield a complete response body.
            let held = null
            await download(async bytes => {
              if (res.destroyed) throw new Error('closed')
              if (held && !res.write(held)) await new Promise((resolve, reject) => {
                const clear = () => { res.off('drain', drained); res.off('close', closed); res.off('error', closed) }
                const drained = () => { clear(); resolve() }
                const closed = () => { clear(); reject(new Error('closed')) }
                res.once('drain', drained); res.once('close', closed); res.once('error', closed)
              })
              held = bytes
            })
            if (res.destroyed) throw new Error('closed')
            res.end(held)
          })
        } finally { clearTimeout(deadline); transfer = false }
        return
      }
      if (!(['POST', 'PUT'].includes(req.method)) || !['/v1/jobs', '/v1/schedule'].includes(req.url)) return json(404, { code: 'NOT_FOUND' })
      if (req.headers['content-type'] !== 'application/json') throw new ControlError('INVALID_OPERATION', 400)
      let length = 0, chunks = []
      for await (const chunk of req) { length += chunk.length; if (length > 2048) throw new ControlError('INVALID_OPERATION', 413); chunks.push(chunk) }
      let input
      try { input = JSON.parse(Buffer.concat(chunks).toString()) } catch { throw new ControlError('INVALID_OPERATION', 400) }
      if (req.method === 'POST' && req.url === '/v1/jobs') {
        if (transfer) throw new ControlError('BACKUP_BUSY')
        return json(202, { job: await controller.enqueue(input) })
      }
      if (req.method === 'PUT' && req.url === '/v1/schedule') return json(200, await controller.setSchedule(input))
      return json(404, { code: 'NOT_FOUND' })
    } catch (e) {
      if (res.headersSent) return res.destroy()
      // Strip ciphertext headers if preparation failed before the first byte.
      res.removeHeader('Content-Length'); res.removeHeader('Content-Disposition'); res.setHeader('Content-Type', 'application/json')
      json(e instanceof ControlError ? e.status : 503, { code: e instanceof ControlError ? e.code : 'CONTROL_UNAVAILABLE' })
    }
  })
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 20
  server.keepAliveTimeout = 1000
  const tick = async () => {
    if (ticking || transfer) return
    ticking = true
    try { await controller.tick(randomBytes(16).toString('hex')); await controller.runNext() }
    finally { ticking = false }
  }
  return { server, tick }
}
