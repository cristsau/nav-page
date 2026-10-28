import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { requestPinnedBookmarkTarget } from '../src/lib/bookmarkHealth.js'

test('pinned lookup cannot deliver an unreachable TLS error before listeners attach', async t => {
  let constructing = false, addressSeen
  t.mock.method(https, 'request', (_url, options) => {
    const request = new EventEmitter()
    request.setTimeout = () => request
    request.end = () => {}
    request.destroy = error => request.emit('error', error)
    constructing = true
    options.lookup('synthetic.invalid', {}, (_error, address, family) => {
      assert.equal(constructing, false)
      addressSeen = { address, family }
      request.emit('error', Object.assign(new Error('synthetic network unreachable'), { code: 'ENETUNREACH' }))
    })
    constructing = false
    return request
  })
  await assert.rejects(requestPinnedBookmarkTarget({ url: new URL('https://synthetic.invalid/'), address: '2001:db8::1', family: 6, method: 'HEAD', timeoutMs: 100 }), { code: 'ENETUNREACH' })
  assert.deepEqual(addressSeen, { address: '2001:db8::1', family: 6 })
})

test('real HTTPS unreachable target rejects without terminating the process', { timeout: 3000 }, async () => {
  await assert.rejects(requestPinnedBookmarkTarget({ url: new URL('https://synthetic.invalid/'), address: '2001:db8::1', family: 6, method: 'HEAD', timeoutMs: 100 }))
})
