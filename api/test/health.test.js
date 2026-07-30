import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'

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

test('Fastify client errors keep their original 400 status', async () => {
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/bookmarks/read-only-probe',
      headers: {
        'content-type': 'application/json'
      }
    })

    assert.equal(response.statusCode, 400)
    assert.match(response.json().error, /Body cannot be empty/)
  } finally {
    await app.close()
  }
})

test('bodyless DELETE reaches authentication instead of the JSON parser', async () => {
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/bookmarks/read-only-probe'
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

test('configured app and browser extension origins remain eligible for unsafe requests', async () => {
  const app = createApp()

  try {
    for (const origin of [
      'http://localhost:5174',
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/notes/ai',
        headers: {
          origin,
          'content-type': 'application/json'
        },
        payload: {
          action: 'summarize',
          content: 'test'
        }
      })

      assert.equal(response.statusCode, 401)
      assert.equal(response.json().error, 'Authentication required')
      assert.equal(response.headers['access-control-allow-origin'], origin)
    }
  } finally {
    await app.close()
  }
})
