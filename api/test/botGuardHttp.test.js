import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { BotGuardError, createBotGuard } from '../src/lib/botGuard.js'

async function responseFor(handler) {
  const oldLevel = config.apiLogLevel
  config.apiLogLevel = 'silent'
  const app = createApp()
  config.apiLogLevel = oldLevel
  app.get('/api/test-bot-error-contract', { config: { skipSession: true } }, handler)
  try {
    return await app.inject({ method: 'GET', url: '/api/test-bot-error-contract' })
  } finally {
    await app.close()
  }
}

test('real HTTP error handler preserves the password challenge signal required by the UI', async () => {
  const guard = createBotGuard({
    runtime: { turnstileEnabled: true, turnstileSiteKey: 'synthetic-site', turnstileSecretKey: 'synthetic-secret' },
    consume: async () => ({ allowed: false }),
    fetchFn: () => assert.fail('Missing proof must not reach the provider')
  })
  const response = await responseFor(async () => {
    await guard({ hostname: 'nav.skrskr.net', headers: { origin: 'https://nav.skrskr.net' }, ip: '198.51.100.5', body: {} }, 'password_login')
    assert.fail('A required challenge must not continue to authentication')
  })
  assert.equal(response.statusCode, 403)
  assert.deepEqual(response.json(), { error: '请先完成安全验证，再提交。', code: 'BOT_CHALLENGE_REQUIRED' })
})

for (const [code, status] of [['BOT_ORIGIN_INVALID', 403], ['BOT_CHALLENGE_INVALID', 403], ['BOT_GUARD_UNAVAILABLE', 503]]) {
  test(`real HTTP error handler preserves the public ${code} contract`, async () => {
    const response = await responseFor(async () => { throw new BotGuardError(code, status) })
    assert.equal(response.statusCode, status)
    assert.deepEqual(Object.keys(response.json()).sort(), ['code', 'error'])
    assert.equal(response.json().code, code)
  })
}

test('generic errors and non-allowlisted codes do not expose internal error metadata', async () => {
  for (const error of [Object.assign(new Error('synthetic failure'), { code: 'BOT_CHALLENGE_REQUIRED', statusCode: 403 }), new BotGuardError('UNLISTED_INTERNAL_CODE')]) {
    const response = await responseFor(async () => { throw error })
    assert.equal(response.statusCode, 403)
    assert.deepEqual(response.json(), { error: error.message })
  }
})
