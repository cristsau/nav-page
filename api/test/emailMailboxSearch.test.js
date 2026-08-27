import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMAIL_MAILBOX_SEARCH_LIMITS,
  mailboxFilterSql,
  mailboxMessageMatchesQuery,
  normalizeMailboxFilter,
  normalizeMailboxSearchQuery
} from '../src/lib/emailMailboxSearch.js'

test('mailbox search normalizes unicode and matches envelope plus encrypted body after decryption', () => {
  const message = {
    subject: '合同续签',
    preview: '请在本周确认',
    body: '项目编号 ＡＢＣ-１２３，需要 Cris 审批。',
    from: { name: '财务部', address: 'finance@example.com' },
    to: [{ name: 'Cris', address: 'cris@example.com' }],
    cc: []
  }
  assert.equal(normalizeMailboxSearchQuery('  ＡＢＣ-１２３  '), 'ABC-123')
  assert.equal(mailboxMessageMatchesQuery(message, 'abc-123'), true)
  assert.equal(mailboxMessageMatchesQuery(message, 'finance@example.com'), true)
  assert.equal(mailboxMessageMatchesQuery(message, '不存在'), false)
})

test('mailbox filters are explicit and translate only to fixed SQL fragments', () => {
  assert.equal(normalizeMailboxFilter('UNREAD'), 'unread')
  assert.equal(mailboxFilterSql('unread'), 'AND location.seen = FALSE')
  assert.equal(mailboxFilterSql('flagged'), 'AND location.flagged = TRUE')
  assert.equal(mailboxFilterSql('attachments'), 'AND message.has_attachments = TRUE')
  assert.equal(mailboxFilterSql('all'), '')
  assert.throws(() => normalizeMailboxFilter('anything'))
})

test('mailbox search bounds user input before encrypted-row scanning', () => {
  assert.equal(normalizeMailboxSearchQuery(''), '')
  assert.throws(() => normalizeMailboxSearchQuery('x'.repeat(
    EMAIL_MAILBOX_SEARCH_LIMITS.queryCharacters + 1
  )))
})
