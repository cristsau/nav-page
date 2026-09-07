import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)
const source = (path) => readFile(new URL(path, root), 'utf8')

test('assistant sources and operation links use shared safe URL boundaries', async () => {
  const view = await source('app/src/modules/assistant/AssistantView.vue')
  assert.match(view, /sanitizeLinkHref/)
  assert.match(view, /sanitizeInternalPath/)
  assert.match(view, /safeSourceHref\(source\) \? 'a' : 'div'/)
  assert.match(view, /safeActionHref\(action\)/)
  assert.doesNotMatch(view, /:href="source\.href\?\.startsWith/)
})

test('global search sources render unsafe targets as text-only results', async () => {
  const view = await source('app/src/shared/components/SearchBox.vue')
  assert.match(view, /sanitizeLinkHref/)
  assert.match(view, /safeResultHref\(item\) \? 'a' : 'div'/)
  assert.match(view, /const targetUrl = sanitizeHttpUrl\(searchResult\.value\?\.externalUrl\)/)
  assert.doesNotMatch(view, /:href="item\.url"/)
})

test('bookmark AI sources never bind an unvalidated result URL', async () => {
  const view = await source('app/src/modules/navigation/components/BookmarkAiPanel.vue')
  assert.match(view, /function safeSourceUrl\(item\)/)
  assert.match(view, /:is="safeSourceUrl\(item\) \? 'a' : 'div'"/)
  assert.doesNotMatch(view, /:href="item\.url"/)
})
