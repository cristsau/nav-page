import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWorkspaceSearchSql,
  escapeLikePattern,
  makeWorkspaceSearchSnippet,
  normalizeWorkspaceSearchQuery,
  parseExactNoteNumberId,
  resetWorkspaceSearchCapabilityCache,
  searchWorkspaceForUser
} from '../src/lib/workspaceSearch.js'

test('workspace query normalization and LIKE escaping preserve literal user input', () => {
  assert.equal(normalizeWorkspaceSearchQuery('  ＡＰＩ\u0000   部署  '), 'api 部署')
  assert.equal(escapeLikePattern('100%_\\done'), '100\\%\\_\\\\done')
  assert.equal(parseExactNoteNumberId('#1000'), 1000)
  assert.equal(parseExactNoteNumberId('999'), null)
  assert.equal(parseExactNoteNumberId('1000 or 1=1'), null)
})

test('baseline SQL hard-excludes encrypted notes and uses stable parameterized ranking', () => {
  const sql = buildWorkspaceSearchSql({ fuzzy: false })
  assert.match(sql, /note\.encrypted = FALSE/)
  assert.match(sql, /note\.number_id = \$4/)
  assert.match(sql, /LIKE \$3 ESCAPE E'\\\\'/)
  assert.match(sql, /ORDER BY score DESC, updated_at DESC, kind ASC, id ASC/)
  assert.doesNotMatch(sql, /similarity\(| % \$2/)
  assert.match(buildWorkspaceSearchSql({ fuzzy: true }), /similarity\(/)
})

test('pg_trgm runtime failure safely retries the zero-extension query', async () => {
  resetWorkspaceSearchCapabilityCache()
  const calls = []
  const queryFn = async (sql, params) => {
    calls.push({ sql, params })
    if (/FROM pg_extension/.test(sql)) return { rows: [{ enabled: true }] }
    if (/similarity\(/.test(sql)) {
      throw Object.assign(new Error('function similarity does not exist'), { code: '42883' })
    }
    return {
      rows: [{
        id: '00000000-0000-4000-8000-000000000001',
        kind: 'note',
        kind_label: '备忘录',
        number_id: '1000',
        title: '部署摘要',
        subtitle: '#1000 · OVH',
        snippet_source: '服务已经迁移到 OVH。',
        raw_href: '/whisper?note=ignored',
        score: 1400,
        match_reasons: ['数字 ID 精确匹配'],
        updated_at: '2026-08-24T00:00:00Z'
      }]
    }
  }

  const result = await searchWorkspaceForUser({
    userId: '00000000-0000-4000-8000-000000000099',
    search: '#1000',
    queryFn
  })

  assert.equal(calls.length, 3)
  assert.equal(result.fuzzyEnabled, false)
  assert.equal(result.total, 1)
  assert.deepEqual(result.notes[0].matchReasons, ['数字 ID 精确匹配'])
  assert.equal(result.notes[0].href, '/whisper?note=00000000-0000-4000-8000-000000000001')
})

test('workspace snippets are bounded around the matching Chinese text', () => {
  const prefix = '前置信息'.repeat(40)
  const snippet = makeWorkspaceSearchSnippet(`${prefix}目标配置后续内容`, '目标配置', 60)
  assert.ok(snippet.startsWith('…'))
  assert.match(snippet, /目标配置/)
  assert.ok(snippet.length <= 62)
})
