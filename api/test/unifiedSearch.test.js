import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWebSearchUrl,
  buildUnifiedSearchResults,
  createHighlightedSegments,
  normalizeEngineMonogram
} from '../../app/src/shared/utils/unifiedSearch.js'

test('unified search ranks title matches and separates bookmarks from notes', () => {
  const result = buildUnifiedSearchResults({
    query: '项目',
    bookmarks: [
      {
        id: 'bookmark-1',
        title: '项目后台',
        url: 'https://example.com/admin',
        description: '发布入口',
        tags: []
      },
      {
        id: 'bookmark-2',
        title: '普通站点',
        url: 'https://example.com/project',
        description: '项目发布入口',
        tags: []
      }
    ],
    notes: [
      {
        id: 'note-1',
        type: 'memo',
        title: '项目发布检查',
        content: '先备份，再发布。',
        encrypted: false,
        tags: []
      }
    ]
  })

  assert.equal(result.total, 3)
  assert.equal(result.bookmarks[0].id, 'bookmark-1')
  assert.equal(result.notes[0].kindLabel, '备忘录')
  assert.equal(result.all.length, 3)
})

test('unified search never exposes encrypted notes and supports ID lookup', () => {
  const result = buildUnifiedSearchResults({
    query: '20260730',
    notes: [
      {
        id: '20260730',
        type: 'note',
        title: '普通笔记',
        content: '',
        encrypted: false
      },
      {
        id: '20260730-secret',
        type: 'note',
        title: '20260730 私密笔记',
        content: '敏感内容',
        encrypted: true
      }
    ]
  })

  assert.equal(result.notes.length, 1)
  assert.equal(result.notes[0].id, '20260730')
})

test('unified search never returns an executable bookmark URL', () => {
  const results = buildUnifiedSearchResults({
    query: 'unsafe',
    bookmarks: [{
      id: 'bookmark-unsafe',
      title: 'Unsafe shortcut',
      url: 'javascript:alert(1)',
      description: '',
      tags: []
    }]
  })

  assert.equal(results.bookmarks.length, 1)
  assert.equal(results.bookmarks[0].href, '')
})

test('unified search supports stable note number IDs with or without a hash', () => {
  const notes = [
    {
      id: 'note-uuid',
      numberId: 1007,
      type: 'diary',
      title: '七月日记',
      content: '今天完成了发布。',
      encrypted: false
    }
  ]

  for (const query of ['1007', '#1007']) {
    const result = buildUnifiedSearchResults({ query, notes })
    assert.equal(result.notes[0].id, 'note-uuid')
    assert.equal(result.notes[0].numberId, '1007')
    assert.match(result.notes[0].subtitle, /^#1007/)
  }
})

test('highlight segments preserve original text without HTML rendering', () => {
  assert.deepEqual(
    createHighlightedSegments('DOMO Nav DOMO', 'domo'),
    [
      { text: 'DOMO', match: true },
      { text: ' Nav ', match: false },
      { text: 'DOMO', match: true }
    ]
  )
})

test('web search URL supports an explicit query placeholder and legacy suffix URLs', () => {
  assert.equal(
    buildWebSearchUrl('https://example.com/search?q={query}&type=all', 'DOMO NAV'),
    'https://example.com/search?q=DOMO%20NAV&type=all'
  )
  assert.equal(
    buildWebSearchUrl('https://example.com/search?q=', 'DOMO NAV'),
    'https://example.com/search?q=DOMO%20NAV'
  )
})

test('search engine monograms accept only one or two Unicode letters or numbers', () => {
  assert.equal(normalizeEngineMonogram('ai'), 'AI')
  assert.equal(normalizeEngineMonogram('百'), '百')
  assert.equal(normalizeEngineMonogram('🔍 G!'), 'G')
  assert.equal(normalizeEngineMonogram('✨'), 'S')
})
