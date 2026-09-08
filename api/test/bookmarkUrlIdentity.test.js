import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { normalizeHttpUrl } from '../src/lib/urls.js'
import { normalizeBookmarkUrl } from '../../app/src/shared/utils/safeUrl.js'

test('quick-add and API normalize bookmark identities consistently without losing URL meaning', () => {
  const urls = [
    'EXAMPLE.test', 'HTTPS://EXAMPLE.test:443/Guide?Key=VALUE#Part',
    'http://example.test:80/', 'https://example.test/a/../Guide',
    'https://example.test/Guide', 'https://example.test/guide',
    'https://example.test/guide/', 'https://example.test/?id=ABC',
    'https://example.test/?id=abc', 'https://example.test/?id=1&id=2',
    'https://example.test/?id=2&id=1', 'https://example.test/#Section',
    'https://example.test/#section', 'https://example.test/%2F',
    'https://example.test/?utm_source=campaign', 'https://例子.测试/指南',
    'https://example.test/line\nbreak', 'https://example.test/\t',
    'https://user:synthetic@example.test/', 'javascript:alert(1)', '', 'not a url'
  ]
  for (const url of urls) assert.equal(normalizeBookmarkUrl(url), normalizeHttpUrl(url))
  assert.equal(normalizeBookmarkUrl(urls[1]), 'https://example.test/Guide?Key=VALUE#Part')
  for (const [left, right] of [[4, 5], [5, 6], [7, 8], [9, 10], [11, 12]]) {
    assert.notEqual(normalizeBookmarkUrl(urls[left]), normalizeBookmarkUrl(urls[right]))
  }
})

test('server deduplication stays owner/group scoped and case-sensitive inside its transaction', async () => {
  const source = await readFile(new URL('../src/routes/navigation.js', import.meta.url), 'utf8')
  const createRoute = source.slice(source.indexOf("fastify.post('/bookmarks',"), source.indexOf("fastify.put('/bookmarks/:bookmarkId'"))
  assert.match(createRoute, /withNavigationTransaction\(request.currentUser.id/)
  assert.match(createRoute, /WHERE user_id = \$1\s+AND group_id = \$2\s+AND url = \$3/)
  assert.doesNotMatch(createRoute, /LOWER\(url\)/)
  assert.match(createRoute, /reply.code\(result.created \? 201 : 200\)/)
})
