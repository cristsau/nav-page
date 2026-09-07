import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createCorsOriginValidator,
  isAllowedExtensionOrigin,
  isUnsafeRequestOriginTrusted,
  parseAllowedExtensionOrigins,
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

test('extension origins require an exact dedicated allowlist', async () => {
  const official = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  const other = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba'

  assert.deepEqual(parseAllowedExtensionOrigins(`${official.toUpperCase()},invalid`), [official])
  assert.equal(isAllowedExtensionOrigin(official, official), true)
  assert.equal(isAllowedExtensionOrigin(other, official), false)
  assert.equal(isAllowedExtensionOrigin(official, ''), false)

  const unconfigured = createCorsOriginValidator(productionOrigins)
  const configured = createCorsOriginValidator(productionOrigins, official)
  const validate = (validator, origin) => new Promise((resolve, reject) => {
    validator(origin, (error, allowed) => error ? reject(error) : resolve(allowed))
  })
  assert.equal(await validate(unconfigured, official), false)
  assert.equal(await validate(configured, official), true)
  assert.equal(await validate(configured, other), false)

  const request = { method: 'POST', headers: { origin: official } }
  assert.equal(isUnsafeRequestOriginTrusted(request, productionOrigins, ''), false)
  assert.equal(isUnsafeRequestOriginTrusted(request, productionOrigins, official), true)
})

test('unsafe requests without Origin require an affirmative Fetch Metadata signal', () => {
  const request = (site) => ({
    method: 'POST',
    headers: site ? { 'sec-fetch-site': site } : {}
  })

  assert.equal(isUnsafeRequestOriginTrusted(request('same-origin'), productionOrigins), true)
  assert.equal(isUnsafeRequestOriginTrusted(request('same-site'), productionOrigins), true)
  assert.equal(isUnsafeRequestOriginTrusted(request('none'), productionOrigins), true)
  assert.equal(isUnsafeRequestOriginTrusted(request('cross-site'), productionOrigins), false)
  assert.equal(isUnsafeRequestOriginTrusted(request(''), productionOrigins), false)
})

test('Fastify serves credentialed CORS for both production domains and blocks attackers', async () => {
  const previousCorsOrigin = config.corsOrigin
  config.corsOrigin = productionOrigins
  const app = createApp()

  try {
    for (const origin of parseAllowedOrigins(productionOrigins)) {
      const preflightCases = [
        { method: 'POST', url: '/api/note-images', headers: 'content-type,x-file-name' },
        { method: 'PUT', url: '/api/notes/test-note', headers: 'content-type' },
        { method: 'PATCH', url: '/api/media/images/test-image', headers: 'content-type' },
        { method: 'DELETE', url: '/api/media/images/test-image', headers: 'authorization' }
      ]

      for (const preflightCase of preflightCases) {
        const preflight = await app.inject({
          method: 'OPTIONS',
          url: preflightCase.url,
          headers: {
            origin,
            'access-control-request-method': preflightCase.method,
            'access-control-request-headers': preflightCase.headers
          }
        })
        assert.equal(preflight.statusCode, 204)
        assert.equal(preflight.headers['access-control-allow-origin'], origin)
        assert.equal(preflight.headers['access-control-allow-credentials'], 'true')

        const allowedMethods = String(preflight.headers['access-control-allow-methods'] || '')
          .split(',')
          .map((value) => value.trim())
        assert.equal(allowedMethods.includes(preflightCase.method), true)

        const allowedHeaders = String(preflight.headers['access-control-allow-headers'] || '')
          .toLowerCase()
          .split(',')
          .map((value) => value.trim())
        for (const requestedHeader of preflightCase.headers.split(',')) {
          assert.equal(allowedHeaders.includes(requestedHeader), true)
        }
      }

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
