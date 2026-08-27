import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEmailAiCacheKey,
  deriveEmailResourceVersion,
  deriveEmailThreadResourceVersion,
  EmailAiResponseCache,
  loadOwnedEmailThread,
  searchOwnedEmails
} from '../src/lib/emailAiCopilot.js'

function row(index, overrides = {}) {
  return {
    message_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    account_id: '11111111-1111-4111-8111-111111111111',
    folder_id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    location_id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
    user_id: '22222222-2222-4222-8222-222222222222',
    source_key: 'primary',
    canonical_hash: String(index).padStart(64, 'a').slice(-64),
    thread_key_hash: 'f'.repeat(64),
    received_at: new Date(Date.UTC(2026, 7, index, 8)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 7, index, 9)).toISOString(),
    ...overrides
  }
}

function decrypted(index, text = `第 ${index} 封邮件正文`) {
  return {
    envelope: {
      subject: `项目进展 ${index}`,
      sender: { name: `成员 ${index}`, address: `member${index}@example.test` },
      to: [],
      cc: []
    },
    content: { text }
  }
}

test('email thread loading is user/account scoped, bounded and chronological', async () => {
  const rows = [row(3), row(2), row(1)]
  const calls = []
  const messages = await loadOwnedEmailThread({
    userId: rows[0].user_id,
    messageRow: rows[0],
    maximum: 2,
    queryFn: async (sql, params) => {
      calls.push({ sql, params })
      return { rows: rows.slice(0, 2) }
    },
    decryptMessage: async (item) => decrypted(Number(item.message_id.slice(-1)))
  })

  assert.match(calls[0].sql, /message\.user_id = \$1 AND message\.account_id = \$2/)
  assert.match(calls[0].sql, /thread_key_hash = \$3/)
  assert.equal(calls[0].params[3], 2)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].messageId, rows[1].message_id)
  assert.equal(messages[1].messageId, rows[0].message_id)
  assert.match(messages[0].resourceVersion, /^[0-9a-f]{64}$/)
})

test('cross-mail search scans a hard bounded recent window and returns cited sources', async () => {
  const calls = []
  const rows = [
    row(1),
    row(2),
    row(3)
  ]
  const sources = await searchOwnedEmails({
    userId: rows[0].user_id,
    search: '部署 报告',
    candidateLimit: 9_999,
    resultLimit: 99,
    queryFn: async (sql, params) => {
      calls.push({ sql, params })
      return { rows }
    },
    decryptMessage: async (item) => {
      const index = Number(item.message_id.slice(-1))
      return decrypted(index, index === 2 ? '部署报告需要周五提交。 OTP 123456' : '普通通知')
    }
  })

  assert.match(calls[0].sql, /WHERE message\.user_id = \$1/)
  assert.match(calls[0].sql, /LEFT JOIN LATERAL/)
  assert.match(calls[0].sql, /candidate\.expunged_at IS NULL/)
  assert.equal(calls[0].params[1], 200)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].sourceId, 'M1')
  assert.equal(sources[0].messageId, rows[1].message_id)
  assert.equal(sources[0].folderId, rows[1].folder_id)
  assert.equal(sources[0].locationId, rows[1].location_id)
  assert.doesNotMatch(sources[0].text, /123456/)
})

test('email AI cache is TTL bounded and returns defensive copies', () => {
  let now = 1_000
  const cache = new EmailAiResponseCache({ maximum: 2, ttlMs: 1_000, now: () => now })
  cache.set('one', { text: 'first' })
  cache.set('two', { text: 'second' })
  const first = cache.get('one')
  first.text = 'changed'
  assert.equal(cache.get('one').text, 'first')
  cache.set('three', { text: 'third' })
  assert.equal(cache.get('two'), null)
  now = 2_001
  assert.equal(cache.get('one'), null)
})

test('email AI versions and cache keys change with resources and trusted controls', () => {
  const first = row(1)
  const second = row(2)
  const firstVersion = deriveEmailResourceVersion(first)
  const threadVersion = deriveEmailThreadResourceVersion([
    { resourceVersion: firstVersion },
    { resourceVersion: deriveEmailResourceVersion(second) }
  ])
  assert.notEqual(firstVersion, threadVersion)
  const base = buildEmailAiCacheKey({
    userId: first.user_id,
    action: 'ask',
    resourceVersion: threadVersion,
    instruction: '发生了什么？',
    model: 'gpt-5.6-sol'
  })
  const changed = buildEmailAiCacheKey({
    userId: first.user_id,
    action: 'ask',
    resourceVersion: threadVersion,
    instruction: '下一步是什么？',
    model: 'gpt-5.6-sol'
  })
  assert.notEqual(base, changed)
  const nextDay = buildEmailAiCacheKey({
    userId: first.user_id,
    action: 'ask',
    resourceVersion: threadVersion,
    instruction: '发生了什么？',
    model: 'gpt-5.6-sol',
    calendarDate: '2026-08-28'
  })
  assert.notEqual(base, nextDay)
})
