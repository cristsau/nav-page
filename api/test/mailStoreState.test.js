import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRequestGenerationGate,
  defaultFolderId,
  emptyMessagePage,
  isMailInvalidationEvent,
  markPageInvalidated,
  mergeMessageItems,
  mergeMessagePage,
  pageKey
} from '../../app/src/modules/mail/mailState.js'

test('request generations reject superseded and pre-reset mailbox results', () => {
  const gate = createRequestGenerationGate()
  const firstInbox = gate.begin('account-a:inbox')
  const archive = gate.begin('account-a:archive')
  const secondInbox = gate.begin('account-a:inbox')

  assert.equal(gate.isCurrent(firstInbox), false)
  assert.equal(gate.isCurrent(secondInbox), true)
  assert.equal(gate.isCurrent(archive), true)

  gate.invalidate('account-a:archive')
  assert.equal(gate.isCurrent(archive), false)

  const beforeLogout = gate.begin('account-b:inbox')
  gate.reset()
  assert.equal(gate.isCurrent(beforeLogout), false)
  assert.equal(gate.isCurrent(gate.begin('account-b:inbox')), true)
})

test('mail pages are isolated by account and folder', () => {
  assert.equal(pageKey('account-a', 'inbox'), 'account-a:inbox')
  assert.equal(pageKey('account-b', 'inbox'), 'account-b:inbox')
})

test('message pages deduplicate, update and remain newest first', () => {
  const existing = [
    { id: 'older', subject: 'old', receivedAt: '2026-08-24T08:00:00Z' },
    { id: 'same', subject: 'before', receivedAt: '2026-08-25T08:00:00Z' }
  ]
  const incoming = [
    { id: 'same', subject: 'after', receivedAt: '2026-08-25T08:00:00Z' },
    { id: 'newer', subject: 'new', receivedAt: '2026-08-26T08:00:00Z' }
  ]
  const merged = mergeMessageItems(existing, incoming)
  assert.deepEqual(merged.map((item) => item.id), ['newer', 'same', 'older'])
  assert.equal(merged.find((item) => item.id === 'same').subject, 'after')
})

test('keyset load-more keeps cursor metadata and appends messages', () => {
  const first = mergeMessagePage(emptyMessagePage(), {
    messages: [{ id: 'm2', internalDate: '2026-08-26T08:00:00Z' }],
    nextCursor: 'cursor-1',
    hasMore: true
  }, { replace: true })
  const second = mergeMessagePage(first, {
    messages: [{ id: 'm1', internalDate: '2026-08-25T08:00:00Z' }],
    nextCursor: null,
    hasMore: false
  })
  assert.deepEqual(second.items.map((item) => item.id), ['m2', 'm1'])
  assert.equal(second.nextCursor, '')
  assert.equal(second.hasMore, false)
  assert.equal(second.loaded, true)
})

test('stale invalidations are ignored for numeric and ISO revisions', () => {
  const numeric = { ...emptyMessagePage(), revision: 20, loaded: true }
  assert.equal(markPageInvalidated(numeric, { revision: 19 }).changed, false)
  assert.equal(markPageInvalidated(numeric, { revision: 20 }).changed, true)
  assert.equal(markPageInvalidated(numeric, { revision: 21 }).changed, true)

  const iso = { ...emptyMessagePage(), revision: '2026-08-26T08:00:00.000Z', loaded: true }
  assert.equal(markPageInvalidated(iso, { revision: '2026-08-26T07:59:59.000Z' }).changed, false)
  assert.equal(markPageInvalidated(iso, { revision: '2026-08-26T08:00:01.000Z' }).changed, true)
})

test('inbox is preferred and the production mail.changed event invalidates', () => {
  assert.equal(defaultFolderId([
    { id: 'archive', specialUse: 'archive' },
    { id: 'inbox', specialUse: 'inbox' }
  ]), 'inbox')
  assert.equal(isMailInvalidationEvent('mail.changed'), true)
  assert.equal(isMailInvalidationEvent('heartbeat'), false)
})
