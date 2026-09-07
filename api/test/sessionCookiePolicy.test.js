import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { normalizeSessionCookieSameSite } from '../src/config.js'

test('session cookie SameSite defaults to lax and accepts only deliberate modes', () => {
  assert.equal(normalizeSessionCookieSameSite(), 'lax')
  assert.equal(normalizeSessionCookieSameSite('LAX'), 'lax')
  assert.equal(normalizeSessionCookieSameSite('none'), 'none')
  assert.throws(
    () => normalizeSessionCookieSameSite('strict'),
    (error) => error?.code === 'SESSION_COOKIE_SAME_SITE_INVALID'
  )
})

test('session cookie plugin uses the validated configured policy', async () => {
  const source = await readFile(new URL('../src/plugins/auth.js', import.meta.url), 'utf8')
  assert.match(source, /sameSite: config\.sessionCookieSameSite/)
  assert.doesNotMatch(source, /sameSite: secure \? 'none' : 'lax'/)
})
