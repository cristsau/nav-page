import test from 'node:test'
import assert from 'node:assert/strict'
import { getOriginPattern, normalizeHttpUrl } from '../src/lib/urls.js'

test('normalizeHttpUrl adds https to a bare hostname', () => {
  assert.equal(normalizeHttpUrl('example.com/path'), 'https://example.com/path')
})

test('normalizeHttpUrl accepts http and strips embedded credentials', () => {
  assert.equal(
    normalizeHttpUrl('http://user:secret@example.com/page'),
    'http://example.com/page'
  )
})

test('normalizeHttpUrl rejects unsafe and malformed protocols', () => {
  assert.equal(normalizeHttpUrl('javascript:alert(1)'), '')
  assert.equal(normalizeHttpUrl('file:///etc/passwd'), '')
  assert.equal(normalizeHttpUrl('not a valid host'), '')
})

test('getOriginPattern returns a browser-extension origin pattern', () => {
  assert.equal(getOriginPattern('https://nav.skrskr.net/settings'), 'https://nav.skrskr.net/*')
})
