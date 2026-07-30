import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidSearchUrl,
  mapCustomSearchEngine,
  normalizeEngineMonogram,
  removeSearchEngineReferences
} from '../src/lib/searchEngines.js'

test('backend search engine mappings never expose emoji icons', () => {
  assert.equal(normalizeEngineMonogram('🔍 AI'), 'AI')
  assert.equal(normalizeEngineMonogram('✨'), 'S')
  assert.equal(
    mapCustomSearchEngine({ id: 'engine', name: 'Engine', icon: '🚀', url: 'https://example.com' }).icon,
    'S'
  )
})

test('custom search engine URLs accept only HTTP(S) destinations', () => {
  assert.equal(isValidSearchUrl('https://example.com/search?q={query}'), true)
  assert.equal(isValidSearchUrl('http://example.com/?q='), true)
  assert.equal(isValidSearchUrl('javascript:alert(1)'), false)
  assert.equal(isValidSearchUrl('data:text/html,test'), false)
})

test('deleting a custom engine removes every saved config reference', () => {
  const cleaned = removeSearchEngineReferences({
    searchEngine: 'custom-1',
    search: {
      quickAccessEngineIds: ['baidu', 'custom-1'],
      aggregate: {
        enabled: true,
        engines: ['custom-1', 'bing']
      }
    }
  }, 'custom-1')

  assert.equal(cleaned.searchEngine, 'baidu')
  assert.deepEqual(cleaned.search.quickAccessEngineIds, ['baidu'])
  assert.deepEqual(cleaned.search.aggregate.engines, ['bing'])
})
