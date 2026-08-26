import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmailSseConnectionLimiter, writeEmailSse } from '../src/lib/emailSse.js'

test('email SSE writer emits one frame and accepts writable streams', () => {
  const writes = []
  const stream = {
    destroyed: false,
    writableEnded: false,
    write(value) {
      writes.push(value)
      return true
    }
  }

  assert.equal(writeEmailSse(stream, 'mail.changed', { revision: 9 }, '9\r\ninvalid'), true)
  assert.deepEqual(writes, [
    'id: 9invalid\nevent: mail.changed\ndata: {"revision":9}\n\n'
  ])
})

test('email SSE writer destroys a stream immediately on backpressure', () => {
  let destroyed = 0
  const stream = {
    destroyed: false,
    writableEnded: false,
    write() { return false },
    destroy() {
      destroyed += 1
      this.destroyed = true
    }
  }

  assert.equal(writeEmailSse(stream, 'heartbeat', { at: 'now' }), false)
  assert.equal(destroyed, 1)
  assert.equal(stream.destroyed, true)
})

test('email SSE writer terminates streams whose write throws', () => {
  let destroyed = 0
  const stream = {
    destroyed: false,
    writableEnded: false,
    write() { throw new Error('socket failed') },
    destroy() { destroyed += 1 }
  }

  assert.equal(writeEmailSse(stream, 'heartbeat', {}), false)
  assert.equal(destroyed, 1)
})

test('email SSE connection limiter is scoped per user and account and releases idempotently', () => {
  const limiter = createEmailSseConnectionLimiter({ maxConnections: 2 })
  const scope = { userId: 'user-1', accountId: 'account-1' }
  const first = limiter.acquire(scope)
  const second = limiter.acquire(scope)

  assert.equal(typeof first, 'function')
  assert.equal(typeof second, 'function')
  assert.equal(limiter.count(scope), 2)
  assert.equal(limiter.acquire(scope), null)
  assert.equal(typeof limiter.acquire({ userId: 'user-1', accountId: 'account-2' }), 'function')
  assert.equal(typeof limiter.acquire({ userId: 'user-2', accountId: 'account-1' }), 'function')

  assert.equal(first(), true)
  assert.equal(first(), false)
  assert.equal(limiter.count(scope), 1)
  assert.equal(typeof limiter.acquire(scope), 'function')
})

test('email SSE connection limiter rejects invalid limits', () => {
  assert.throws(() => createEmailSseConnectionLimiter({ maxConnections: 0 }), /positive safe integer/)
  assert.throws(() => createEmailSseConnectionLimiter({ maxConnections: 1.5 }), /positive safe integer/)
})
