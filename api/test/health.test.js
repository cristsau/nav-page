import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'

test('API health endpoint is available behind the public /api prefix', async () => {
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health'
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      ok: true,
      service: 'nav-api'
    })
  } finally {
    await app.close()
  }
})

test('non-empty malformed DELETE requests still use the JSON parser', async () => {
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/bookmarks/read-only-probe',
      headers: {
        origin: 'http://localhost:5174',
        'content-type': 'application/json'
      },
      payload: '{'
    })

    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /JSON/)
  } finally {
    await app.close()
  }
})

test('bodyless JSON DELETE reaches authentication instead of the JSON parser', async () => {
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/bookmarks/read-only-probe',
      headers: {
        origin: 'http://localhost:5174',
        'content-type': 'application/json'
      }
    })

    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'Authentication required')
  } finally {
    await app.close()
  }
})

test('unsafe cross-site requests are blocked before authentication or route handling', async () => {
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai-search/providers/test',
      headers: {
        origin: 'https://attacker.invalid',
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site'
      },
      payload: {
        provider: 'chatgpt',
        config: {
          endpoint: 'https://attacker.invalid/collect'
        }
      }
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error, 'Cross-site request blocked')
    assert.equal(response.headers['access-control-allow-origin'], undefined)
  } finally {
    await app.close()
  }
})

test('unsafe requests without Origin or Fetch Metadata are blocked', async () => {
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/notes/ai',
      headers: { 'content-type': 'application/json' },
      payload: { action: 'summarize', content: 'test' }
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error, 'Cross-site request blocked')
  } finally {
    await app.close()
  }
})

test('configured app origin remains eligible while unconfigured extensions are blocked', async () => {
  const app = createApp()

  try {
    const appOrigin = await app.inject({
      method: 'POST',
      url: '/api/notes/ai',
      headers: {
        origin: 'http://localhost:5174',
        'content-type': 'application/json'
      },
      payload: { action: 'summarize', content: 'test' }
    })
    assert.equal(appOrigin.statusCode, 401)
    assert.equal(appOrigin.json().error, 'Authentication required')
    assert.equal(appOrigin.headers['access-control-allow-origin'], 'http://localhost:5174')

    const extension = await app.inject({
      method: 'POST',
      url: '/api/notes/ai',
      headers: {
        origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'content-type': 'application/json'
      },
      payload: { action: 'summarize', content: 'test' }
    })
    assert.equal(extension.statusCode, 403)
    assert.equal(extension.json().error, 'Cross-site request blocked')
    assert.equal(extension.headers['access-control-allow-origin'], undefined)
  } finally {
    await app.close()
  }
})

test('an exact configured browser extension origin remains eligible', async () => {
  const previous = config.extensionOrigins
  const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  config.extensionOrigins = origin
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/notes/ai',
      headers: { origin, 'content-type': 'application/json' },
      payload: { action: 'summarize', content: 'test' }
    })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'Authentication required')
    assert.equal(response.headers['access-control-allow-origin'], origin)
  } finally {
    await app.close()
    config.extensionOrigins = previous
  }
})
