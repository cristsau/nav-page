import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isInternalPath,
  sanitizeHttpUrl,
  sanitizeInternalPath,
  sanitizeLinkHref
} from '../../app/src/shared/utils/safeUrl.js'

test('shared URL sanitizer accepts only credential-free HTTP(S) URLs', () => {
  assert.equal(sanitizeHttpUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1')
  assert.equal(sanitizeHttpUrl('http://example.com'), 'http://example.com/')

  for (const value of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'https://user:secret@example.com/private',
    'https://example.com/line\nbreak'
  ]) {
    assert.equal(sanitizeHttpUrl(value), '', value)
  }
})

test('internal links are root-relative and never protocol-relative', () => {
  assert.equal(sanitizeInternalPath('/notes/123?tab=detail'), '/notes/123?tab=detail')
  assert.equal(sanitizeLinkHref('/notes/123'), '/notes/123')
  assert.equal(isInternalPath('/notes/123'), true)

  for (const value of ['//attacker.invalid/path', '/\\attacker.invalid', 'notes/123']) {
    assert.equal(sanitizeInternalPath(value), '', value)
    assert.equal(isInternalPath(value), false)
  }
})
