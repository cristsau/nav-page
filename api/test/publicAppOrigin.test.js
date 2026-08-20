import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPublicShareUrl,
  normalizePublicAppOrigin,
  resolvePublicAppOrigin
} from '../../app/src/shared/utils/publicAppOrigin.js'

test('copied share URLs use the configured canonical origin, not the active alias', () => {
  assert.equal(
    buildPublicShareUrl('AbCd2345', {
      configuredOrigin: 'https://nav.skrskr.net',
      runtimeOrigin: 'https://nav.cristsau.cn',
      production: true
    }),
    'https://nav.skrskr.net/share/AbCd2345'
  )
})

test('production public origin fails closed instead of following an alias', () => {
  assert.throws(
    () => resolvePublicAppOrigin({
      configuredOrigin: '',
      runtimeOrigin: 'https://nav.cristsau.cn',
      production: true
    }),
    /VITE_PUBLIC_APP_ORIGIN/
  )
  assert.throws(
    () => buildPublicShareUrl('bad/code', {
      configuredOrigin: 'https://nav.skrskr.net',
      production: true
    }),
    /Invalid public share code/
  )
})

test('public origin accepts only a bare HTTPS origin outside local development', () => {
  assert.equal(
    normalizePublicAppOrigin('https://nav.skrskr.net'),
    'https://nav.skrskr.net'
  )
  assert.equal(normalizePublicAppOrigin('https://nav.skrskr.net/path'), '')
  assert.equal(normalizePublicAppOrigin('https://user@nav.skrskr.net'), '')
  assert.equal(normalizePublicAppOrigin('http://nav.skrskr.net'), '')
  assert.equal(
    normalizePublicAppOrigin('http://127.0.0.1:5174', { allowLocalHttp: true }),
    'http://127.0.0.1:5174'
  )
})
