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
