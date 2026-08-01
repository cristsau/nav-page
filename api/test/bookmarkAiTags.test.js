import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  AI_RATE_LIMIT_MAX_REQUESTS,
  consumeAiRateLimit
} from '../src/lib/aiRateLimit.js'
import {
  buildBookmarkAiTagInput,
  sanitizeBookmarkAiUrl
} from '../src/lib/bookmarkAi.js'
import { normalizeBookmarkUserTags } from '../src/lib/bookmarkTags.js'
import { buildNoteAiPrompts } from '../src/lib/noteAi.js'
import { createApp } from '../src/app.js'
import {
  isCurrentBookmarkTagSave,
  resolveBookmarkAiProvider,
  resolveBookmarkGenerativeAiProvider
} from '../../app/src/modules/navigation/navigationUi.js'

test('bookmark tag input strips URL credentials, query and fragment', () => {
  const input = buildBookmarkAiTagInput({
    title: 'Deployment console',
    url: 'https://user:pass@example.test/private/path?token=secret#section',
    description: 'Docker service dashboard',
    tags: ['运维']
  })

  assert.equal(
    sanitizeBookmarkAiUrl('https://user:pass@example.test/private/path?token=secret#section'),
    'https://example.test/private/path'
  )
  assert.equal(input.action, 'tags')
  assert.equal(input.type, 'bookmark')
  assert.deepEqual(input.tags, ['运维'])
  assert.match(input.content, /https:\/\/example\.test\/private\/path/)
  assert.match(input.content, /Docker service dashboard/)
  assert.doesNotMatch(input.content, /user|pass|token=|secret|section/)
})

test('saving a bookmark preserves existing user labels even when AI would filter them', () => {
  const existing = [
    'docs.example.com',
    '10.0.0.8',
    '12345678',
    '普通标签',
    ...Array.from({ length: 20 }, (_, index) => `历史${index + 1}`)
  ]

  assert.deepEqual(normalizeBookmarkUserTags(existing), existing)
})

test('bookmark tag prompt identifies the record as a navigation bookmark', () => {
  const prompts = buildNoteAiPrompts(buildBookmarkAiTagInput({
    title: 'Oracle JP',
    url: 'https://example.test/',
    description: 'Private deployment entry'
  }))

  assert.match(prompts.userPrompt, /记录类型：导航书签/)
  assert.match(prompts.systemPrompt, /严格只返回一个 JSON 对象/)
})

test('Brave-only bookmark AI keeps analysis but disables generative tags', () => {
  const braveOnly = {
    search: {
      providers: {
        brave: {
          enabled: true,
          apiKeyConfigured: true
        }
      }
    }
  }

  assert.equal(resolveBookmarkAiProvider(braveOnly), 'brave')
  assert.equal(resolveBookmarkGenerativeAiProvider(braveOnly), '')
  assert.equal(resolveBookmarkGenerativeAiProvider({
    search: {
      providers: {
        chatgpt: {
          enabled: true,
          mode: 'proxy',
          cliProxyBaseUrl: 'https://proxy.example.test'
        }
      }
    }
  }), 'chatgpt')
  assert.equal(resolveBookmarkAiProvider({
    search: {
      providers: {
        chatgpt: {
          enabled: true,
          mode: 'proxy',
          cliProxyBaseUrl: 'https://proxy.example.test'
        }
      }
    }
  }), 'chatgpt')
})

test('bookmark tag save guard rejects closed, stale or switched panels', () => {
  const current = {
    requestId: 7,
    currentRequestId: 7,
    bookmarkId: 'bookmark-a',
    currentBookmarkId: 'bookmark-a',
    panelOpen: true
  }

  assert.equal(isCurrentBookmarkTagSave(current), true)
  assert.equal(isCurrentBookmarkTagSave({ ...current, panelOpen: false }), false)
  assert.equal(isCurrentBookmarkTagSave({ ...current, currentRequestId: 8 }), false)
  assert.equal(isCurrentBookmarkTagSave({
    ...current,
    currentBookmarkId: 'bookmark-b'
  }), false)
})

test('note and bookmark AI share one persistent per-user rate-limit budget', async () => {
  const counts = new Map()
  const queryFn = async (_text, params) => {
    const keyDigest = params[1]
    const count = (counts.get(keyDigest) || 0) + 1
    counts.set(keyDigest, count)
    return {
      rows: [{
        request_count: count,
        retry_after_seconds: 60,
        window_expires_at: '2026-08-01T00:01:00.000Z'
      }]
    }
  }

  for (let index = 0; index < AI_RATE_LIMIT_MAX_REQUESTS; index += 1) {
    assert.equal((await consumeAiRateLimit('user-1', { queryFn })).allowed, true)
  }

  const blocked = await consumeAiRateLimit('user-1', { queryFn })
  assert.equal(blocked.allowed, false)
  assert.equal(
    (await consumeAiRateLimit('user-2', { queryFn })).allowed,
    true
  )
})

test('search, provider tests, notes and bookmark tags use the shared AI limiter', async () => {
  const [searchSource, noteSource, navigationSource] = await Promise.all([
    new URL('../src/routes/aiSearch.js', import.meta.url),
    new URL('../src/routes/noteAi.js', import.meta.url),
    new URL('../src/routes/navigation.js', import.meta.url)
  ].map(async (url) => fs.readFile(fileURLToPath(url), 'utf8')))

  assert.equal(
    (searchSource.match(/await enforceAiRateLimit\(request, reply\)/g) || []).length,
    2
  )
  assert.match(noteSource, /await enforceAiRateLimit\(request, reply/)
  assert.match(navigationSource, /await enforceAiRateLimit\(request, reply\)/)
})

test('bookmark AI tag endpoint reads owned server data and never trusts client metadata', async () => {
  const routeUrl = new URL('../src/routes/navigation.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(routeUrl), 'utf8')
  const routeSource = source.match(
    /fastify\.post\('\/bookmarks\/:bookmarkId\/ai\/tags'[\s\S]*?(?=\n  fastify\.post\('\/bookmarks')/
  )?.[0] || ''

  assert.match(routeSource, /requireOwnedBookmark/)
  assert.match(routeSource, /buildBookmarkAiTagInput\(bookmark\)/)
  assert.match(routeSource, /selectNoteAiProvider/)
  assert.match(routeSource, /await enforceAiRateLimit\(request, reply\)/)
  assert.doesNotMatch(routeSource, /request\.body/)
})

test('bookmark AI tag endpoint requires authentication before reading bookmark data', async () => {
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/bookmarks/read-only-probe/ai/tags',
      headers: {
        'content-type': 'application/json'
      },
      payload: {}
    })

    assert.equal(response.statusCode, 401)
    assert.match(response.json().error, /Authentication required/)
  } finally {
    await app.close()
  }
})

test('bookmark AI suggestions require confirmation before tags are persisted', async () => {
  const navigationUrl = new URL(
    '../../app/src/modules/navigation/Navigation.vue',
    import.meta.url
  )
  const panelUrl = new URL(
    '../../app/src/modules/navigation/components/BookmarkAiPanel.vue',
    import.meta.url
  )
  const apiUrl = new URL(
    '../../app/src/shared/services/navigationApi.js',
    import.meta.url
  )
  const formUrl = new URL(
    '../../app/src/modules/navigation/components/AddToNav.vue',
    import.meta.url
  )
  const cardUrl = new URL(
    '../../app/src/modules/navigation/components/NavItem.vue',
    import.meta.url
  )
  const [navigation, panel, api, form, card] = await Promise.all(
    [navigationUrl, panelUrl, apiUrl, formUrl, cardUrl].map(async (url) => (
      fs.readFile(fileURLToPath(url), 'utf8')
    ))
  )

  assert.match(api, /suggestBackendBookmarkTags/)
  assert.match(api, /body: JSON\.stringify\(\{\}\)/)
  assert.match(navigation, /mergeSuggestedNoteTags/)
  assert.match(navigation, /await updateBookmark\(bookmarkId, \{ tags: merged\.tags \}\)/)
  assert.match(navigation, /@suggest-tags="handleSuggestBookmarkTags"/)
  assert.match(navigation, /@apply-tags="handleApplyBookmarkTags"/)
  assert.match(navigation, /let aiTagSaveRequestId = 0/)
  assert.match(navigation, /const saveRequestId = \+\+aiTagSaveRequestId/)
  assert.match(navigation, /:can-generate-tags="canGenerateBookmarkTags"/)
  assert.match(panel, /v-if="!needsSetup && canGenerateTags"/)
  assert.match(panel, /确认后才会保存到书签/)
  assert.match(panel, /添加 \$\{tagResult\.tags\.length\} 个标签/)
  assert.match(form, /输入标签后按回车/)
  assert.match(card, /bookmark-card__tags/)
})
