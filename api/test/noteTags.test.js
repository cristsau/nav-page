import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_AI_NOTE_TAGS,
  MAX_NOTE_TAGS,
  normalizeExistingNoteTags,
  normalizeNoteTag,
  parseNoteAiTags,
  selectSuggestedNoteTags
} from '../src/lib/noteTags.js'
import {
  normalizeNoteTag as normalizeFrontendNoteTag
} from '../../app/src/shared/utils/noteTags.js'

test('note tags are normalized with NFKC and deduplicated case-insensitively', () => {
  assert.equal(normalizeNoteTag('  ## Ｄｏｃｋｅｒ  部署  '), 'Docker 部署')
  assert.deepEqual(
    normalizeExistingNoteTags(['Docker', 'docker', '  运维  ', '', null]),
    ['Docker', '运维']
  )
})

test('sensitive or non-tag values are rejected', () => {
  for (const value of [
    'https://example.com',
    'name@example.com',
    '11010519491231002X',
    '1234567890',
    'sk-abcdefghijklmnopqrstuvwxyz',
    'token-abcdefghijklmnopqrstuvwxyz',
    'api key abcdefgh123456',
    'api_key: abcdefgh123456',
    'token abcdefgh123456',
    'secret = abcdefgh123456',
    'client_secret abcdefgh123456',
    'api key abcdefghijkl',
    'client_secret abcdefghijkl',
    'api key abcdefgh',
    'client_secret abcdefgh',
    'password abcdefgh',
    'token abcdefgh',
    'sk-abcdefgh',
    'pk-abcdefgh',
    'token-abcdefgh',
    'API_KEY="abc123456789"',
    '"apiKey": "abc123456789"',
    "token='abc123456789'",
    'ghp_abcdefghijklmnop',
    'AIzaSyA1234567890abcde',
    'Bearer abcdefghijkl',
    'AKIAIOSFODNN7EXAMPLE',
    'example.com',
    '10.0.0.1',
    '127.0.0.1:18080',
    'ap.skrskr.net',
    'localhost:3000',
    'localhost',
    'localhost/api',
    'localhost:3000/api',
    '[2001:db8::1]:443',
    '[2001:db8::1]:443/api',
    '2001:db8::1%eth0',
    '::ffff:192.0.2.128',
    '例子.中国',
    'ssh://10.0.0.8',
    'ftp://example.com'
  ]) {
    assert.equal(normalizeNoteTag(value), '')
    assert.equal(normalizeFrontendNoteTag(value), '')
  }
})

test('ordinary descriptive tags stay valid in backend and frontend normalizers', () => {
  for (const value of [
    'Docker',
    '部署',
    '反向代理',
    'NodeJS',
    'Oracle JP',
    'api-key-rotation',
    'access-token-rotation',
    'client-secret-handling',
    'secret-management',
    'password-security',
    'token-security',
    'sk-learning',
    'pk-analysis'
  ]) {
    assert.equal(normalizeNoteTag(value), value)
    assert.equal(normalizeFrontendNoteTag(value), value)
  }
})

test('AI tag parser accepts strict JSON and fenced JSON objects', () => {
  assert.deepEqual(
    parseNoteAiTags('{"tags":["Docker","部署","docker"]}', ['已有']),
    ['Docker', '部署']
  )
  assert.deepEqual(
    parseNoteAiTags('```json\n{"tags":["运维"]}\n```'),
    ['运维']
  )
  assert.deepEqual(parseNoteAiTags('{"tags":[]}'), [])
})

test('AI tag parser rejects malformed or ambiguous payloads', () => {
  for (const value of [
    '["部署"]',
    '{"labels":["部署"]}',
    '{"tags":"部署"}',
    '{"tags":["部署"],"explanation":"额外文字"}',
    '{"tags":["部署",123]}',
    '建议如下：{"tags":["部署"]}',
    '{"tags":'
  ]) {
    assert.throws(
      () => parseNoteAiTags(value),
      /AI 标签结果格式无效/
    )
  }
})

test('AI suggestions preserve existing tags and respect per-run and total limits', () => {
  const candidates = Array.from({ length: 10 }, (_, index) => `标签${index + 1}`)
  assert.equal(
    selectSuggestedNoteTags([], candidates).length,
    MAX_AI_NOTE_TAGS
  )

  const existing = Array.from({ length: MAX_NOTE_TAGS - 2 }, (_, index) => `已有${index + 1}`)
  assert.deepEqual(
    selectSuggestedNoteTags(existing, ['新增一', '新增二', '新增三']),
    ['新增一', '新增二']
  )
  assert.deepEqual(
    selectSuggestedNoteTags(['Docker'], ['docker', 'Ｄｏｃｋｅｒ']),
    []
  )
})
