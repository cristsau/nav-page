import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { BotGuardError } from '../src/lib/botGuard.js'

const PUBLIC_SERVER_ERROR = '服务暂时不可用，请稍后重试。'

async function responseFor(handler) {
  const previous = config.apiLogLevel
  config.apiLogLevel = 'silent'
  const app = createApp()
  config.apiLogLevel = previous
  app.get('/api/test-error-response', { config: { skipSession: true } }, handler)
  try {
    return await app.inject('/api/test-error-response')
  } finally {
    await app.close()
  }
}

test('unhandled database errors do not expose SQL, internal codes or details', async () => {
  const error = Object.assign(new Error('inconsistent types deduced for parameter $5'), {
    code: '42P08', detail: 'text versus character', query: 'SYNTHETIC_INTERNAL_SQL'
  })
  const response = await responseFor(async () => { throw error })
  assert.equal(response.statusCode, 500)
  assert.deepEqual(response.json(), { error: PUBLIC_SERVER_ERROR })
})

for (const statusCode of [500, 502, 503, 504]) {
  test(`unexpected ${statusCode} errors return a safe retry message`, async () => {
    const response = await responseFor(async () => {
      throw Object.assign(new Error('SYNTHETIC_INTERNAL_PROVIDER_FAILURE'), { statusCode, code: 'PRIVATE_ERROR' })
    })
    assert.equal(response.statusCode, statusCode)
    assert.deepEqual(response.json(), { error: PUBLIC_SERVER_ERROR })
  })
}

test('a server failure set on reply is also sanitized', async () => {
  const response = await responseFor(async (_request, reply) => {
    reply.code(503)
    throw new Error('SYNTHETIC_INTERNAL_DEPENDENCY')
  })
  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { error: PUBLIC_SERVER_ERROR })
})

test('4xx validation and authentication messages remain actionable', async () => {
  for (const [statusCode, message] of [[400, 'Invalid request'], [401, 'Authentication required'], [403, 'Admin access required'], [409, 'A pending registration already exists'], [429, 'Too many authentication attempts']]) {
    const response = await responseFor(async () => { throw Object.assign(new Error(message), { statusCode }) })
    assert.equal(response.statusCode, statusCode)
    assert.deepEqual(response.json(), { error: message })
  }
})

test('known bot-guard failure keeps the public recovery contract, not a mutated internal message', async () => {
  const error = new BotGuardError('BOT_GUARD_UNAVAILABLE', 503)
  error.message = 'SYNTHETIC_INTERNAL_PROVIDER_DETAIL'
  const response = await responseFor(async () => { throw error })
  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { error: '安全验证暂不可用，请稍后重试。', code: 'BOT_GUARD_UNAVAILABLE' })
})

test('an arbitrary error cannot impersonate the public bot-guard contract', async () => {
  for (const error of [Object.assign(new Error('SYNTHETIC_INTERNAL_DETAIL'), { statusCode: 503, code: 'BOT_GUARD_UNAVAILABLE' }), new BotGuardError('PRIVATE_CODE', 503)]) {
    const response = await responseFor(async () => { throw error })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { error: PUBLIC_SERVER_ERROR })
  }
})
