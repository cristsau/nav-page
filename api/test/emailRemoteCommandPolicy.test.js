import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertPermanentDeleteAllowed,
  buildEmailRemoteCommandRequestHash,
  classifyRemoteCommandFailure,
  compareEmailRemoteSnapshot,
  EMAIL_REMOTE_DELETE_CONFIRMATION,
  EmailRemoteCommandError,
  normalizeEmailRemoteCommandRequest,
  retryDelaySeconds
} from '../src/lib/emailRemoteCommandPolicy.js'

const EXPECTED = Object.freeze({
  uidValidity: '123',
  modseq: '456',
  seen: false,
  flagged: false,
  deleted: false
})

function request(overrides = {}) {
  return {
    action: 'mark_read',
    idempotencyKey: 'mail-command:0123456789abcdef',
    expected: EXPECTED,
    ...overrides
  }
}

test('remote command input has bounded actions, idempotency and immutable state preconditions', () => {
  const normalized = normalizeEmailRemoteCommandRequest(request())
  assert.equal(normalized.action, 'mark_read')
  assert.deepEqual(normalized.expected, EXPECTED)
  assert.equal(normalized.targetFolderId, null)
  assert.throws(
    () => normalizeEmailRemoteCommandRequest(request({ action: 'reply' })),
    EmailRemoteCommandError
  )
  assert.throws(
    () => normalizeEmailRemoteCommandRequest(request({ idempotencyKey: 'short' })),
    /idempotency key/i
  )
  assert.throws(
    () => normalizeEmailRemoteCommandRequest(request({ expected: { ...EXPECTED, seen: 'false' } })),
    /Expected seen state/
  )
})

test('permanent delete requires a literal confirmation and a trash-like remote state', () => {
  assert.throws(
    () => normalizeEmailRemoteCommandRequest(request({ action: 'delete' })),
    (error) => error.code === 'REMOTE_DELETE_CONFIRMATION_REQUIRED'
  )
  const normalized = normalizeEmailRemoteCommandRequest(request({
    action: 'delete',
    confirm: EMAIL_REMOTE_DELETE_CONFIRMATION
  }))
  assert.equal(normalized.permanentConfirmed, true)
  assert.doesNotThrow(() => assertPermanentDeleteAllowed({ specialUse: 'trash', deleted: false }))
  assert.doesNotThrow(() => assertPermanentDeleteAllowed({ specialUse: 'inbox', deleted: true }))
  assert.throws(
    () => assertPermanentDeleteAllowed({ specialUse: 'inbox', deleted: false }),
    (error) => error.code === 'REMOTE_DELETE_NOT_ALLOWED'
  )
})

test('idempotency hash covers target and expected remote state but never the key itself', () => {
  const command = normalizeEmailRemoteCommandRequest(request())
  const base = buildEmailRemoteCommandRequestHash({
    accountId: '11111111-1111-1111-1111-111111111111',
    locationId: '22222222-2222-2222-2222-222222222222',
    command
  })
  const replay = buildEmailRemoteCommandRequestHash({
    accountId: '11111111-1111-1111-1111-111111111111',
    locationId: '22222222-2222-2222-2222-222222222222',
    command: normalizeEmailRemoteCommandRequest(request({
      idempotencyKey: 'another-command:0123456789abcdef'
    }))
  })
  assert.equal(base, replay)
  const changed = buildEmailRemoteCommandRequestHash({
    accountId: '11111111-1111-1111-1111-111111111111',
    locationId: '22222222-2222-2222-2222-222222222222',
    command: normalizeEmailRemoteCommandRequest(request({
      expected: { ...EXPECTED, modseq: '457' }
    }))
  })
  assert.notEqual(base, changed)
})

test('MODSEQ conflicts stop writes while already-satisfied flag retries reconcile safely', () => {
  assert.deepEqual(
    compareEmailRemoteSnapshot(EXPECTED, { ...EXPECTED, modseq: '999' }, { action: 'mark_read' }),
    { ok: false, code: 'REMOTE_STATE_CHANGED' }
  )
  assert.deepEqual(
    compareEmailRemoteSnapshot(EXPECTED, { ...EXPECTED, modseq: '999', seen: true }, { action: 'mark_read' }),
    { ok: true, alreadySatisfied: true }
  )
  assert.deepEqual(
    compareEmailRemoteSnapshot(EXPECTED, { ...EXPECTED, uidValidity: '124' }, { action: 'mark_read' }),
    { ok: false, code: 'REMOTE_UIDVALIDITY_CHANGED' }
  )
})

test('ambiguous flag failures are retryable but move/delete ambiguity is a terminal conflict', () => {
  assert.equal(classifyRemoteCommandFailure({
    action: 'star', errorCode: 'REMOTE_COMMAND_RESULT_UNKNOWN', mutationStarted: true
  }), 'retry')
  assert.equal(classifyRemoteCommandFailure({
    action: 'move', errorCode: 'ECONNRESET', mutationStarted: true
  }), 'conflict')
  assert.equal(classifyRemoteCommandFailure({
    action: 'mark_read', errorCode: 'ECONNRESET', mutationStarted: false
  }), 'retry')
  assert.deepEqual([1, 2, 8, 20].map(retryDelaySeconds), [2, 4, 256, 300])
})
