import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createCorsOriginValidator,
  isUnsafeRequestOriginTrusted,
  parseAllowedOrigins
} from '../src/lib/requestSecurity.js'
import { config } from '../src/config.js'
import { createApp } from '../src/app.js'

const productionOrigins = 'https://nav.skrskr.net,https://nav.cristsau.cn'

function validateCors(origin) {
  return new Promise((resolve, reject) => {
    createCorsOriginValidator(productionOrigins)(origin, (error, allowed) => {
      if (error) {
        reject(error)
        return
      }

      resolve(allowed)
    })
  })
}

test('production CORS allowlist accepts both NAV domains exactly', async () => {
  assert.deepEqual(parseAllowedOrigins(productionOrigins), [
    'https://nav.skrskr.net',
    'https://nav.cristsau.cn'
  ])
  assert.equal(await validateCors('https://nav.skrskr.net'), true)
  assert.equal(await validateCors('https://nav.cristsau.cn'), true)
  assert.equal(await validateCors('http://nav.cristsau.cn'), false)
  assert.equal(await validateCors('https://nav.cristsau.cn:8443'), false)
  assert.equal(await validateCors('https://nav.cristsau.cn.attacker.invalid'), false)
})

test('reverse-proxied unsafe requests trust the explicit public origin allowlist', () => {
  const request = {
    method: 'POST',
    headers: {
      origin: 'https://nav.cristsau.cn',
      host: 'nav.skrskr.net',
      'x-forwarded-host': 'nav.skrskr.net',
      'sec-fetch-site': 'same-origin'
    }
  }

  assert.equal(isUnsafeRequestOriginTrusted(request, productionOrigins), true)
  assert.equal(
    isUnsafeRequestOriginTrusted({
      ...request,
      headers: {
        ...request.headers,
        origin: 'https://attacker.invalid'
      }
    }, productionOrigins),
    false
  )
  assert.equal(
    isUnsafeRequestOriginTrusted({
      ...request,
      headers: {
        ...request.headers,
        origin: 'https://attacker.invalid',
        host: 'attacker.invalid',
        'x-forwarded-host': 'attacker.invalid'
      }
    }, productionOrigins),
    false
  )
  assert.equal(
    isUnsafeRequestOriginTrusted(request, 'https://nav.skrskr.net'),
    false
  )
})

test('Fastify serves credentialed CORS for both production domains and blocks attackers', async () => {
  const previousCorsOrigin = config.corsOrigin
  config.corsOrigin = productionOrigins
  const app = createApp()

  try {
    for (const origin of parseAllowedOrigins(productionOrigins)) {
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/api/notes/ai',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type'
        }
      })
      assert.equal(preflight.statusCode, 204)
      assert.equal(preflight.headers['access-control-allow-origin'], origin)
      assert.equal(preflight.headers['access-control-allow-credentials'], 'true')

      const post = await app.inject({
        method: 'POST',
        url: '/api/notes/ai',
        headers: {
          origin,
          host: 'nav.skrskr.net',
          'x-forwarded-host': 'nav.skrskr.net',
          'content-type': 'application/json'
        },
        payload: {
          action: 'summarize',
          content: 'test'
        }
      })
      assert.equal(post.statusCode, 401)
      assert.equal(post.headers['access-control-allow-origin'], origin)
      assert.equal(post.headers['access-control-allow-credentials'], 'true')
    }

    const attacker = await app.inject({
      method: 'POST',
      url: '/api/notes/ai',
      headers: {
        origin: 'https://attacker.invalid',
        host: 'attacker.invalid',
        'x-forwarded-host': 'attacker.invalid',
        'content-type': 'application/json'
      },
      payload: {
        action: 'summarize',
        content: 'test'
      }
    })
    assert.equal(attacker.statusCode, 403)
    assert.equal(attacker.headers['access-control-allow-origin'], undefined)
  } finally {
    await app.close()
    config.corsOrigin = previousCorsOrigin
  }
})
