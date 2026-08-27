import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createEmailAiConfirmationToken,
  deriveEmailAiConfirmationSecret,
  EmailAiConfirmationError,
  verifyEmailAiConfirmationToken
} from '../src/lib/emailAiConfirmation.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const OPERATION_ID = '33333333-3333-4333-8333-333333333333'
const RESOURCE_VERSION = 'a'.repeat(64)
const SECRET = deriveEmailAiConfirmationSecret(Buffer.alloc(32, 7))
const PARAMS = {
  title: '邮件待办',
  content: '根据邮件整理',
  tags: ['邮件'],
  dueAt: null,
  remindBeforeMinutes: 0
}

function token(now = Date.parse('2026-08-27T10:00:00Z')) {
  return createEmailAiConfirmationToken({
    userId: USER_ID,
    messageId: MESSAGE_ID,
    resourceVersion: RESOURCE_VERSION,
    kind: 'create_memo',
    params: PARAMS,
    operationId: OPERATION_ID,
    ttlSeconds: 300,
    now
  }, SECRET)
}

test('email AI confirmation binds identity, resource, params and operation id', () => {
  const verified = verifyEmailAiConfirmationToken(token(), {
    userId: USER_ID,
    messageId: MESSAGE_ID,
    resourceVersion: RESOURCE_VERSION,
    kind: 'create_memo',
    params: PARAMS,
    operationId: OPERATION_ID
  }, SECRET, { now: Date.parse('2026-08-27T10:02:00Z') })

  assert.equal(verified.userId, USER_ID)
  assert.equal(verified.messageId, MESSAGE_ID)
  assert.equal(verified.operationId, OPERATION_ID)
  assert.equal(verified.expiresAt, '2026-08-27T10:05:00.000Z')
})

test('email AI confirmation rejects changed params and changed resource versions', () => {
  assert.throws(
    () => verifyEmailAiConfirmationToken(token(), {
      userId: USER_ID,
      messageId: MESSAGE_ID,
      resourceVersion: RESOURCE_VERSION,
      kind: 'create_memo',
      params: { ...PARAMS, title: '被篡改' },
      operationId: OPERATION_ID
    }, SECRET, { now: Date.parse('2026-08-27T10:01:00Z') }),
    (error) => error instanceof EmailAiConfirmationError
      && error.code === 'email_ai_confirmation_mismatch'
  )
  assert.throws(
    () => verifyEmailAiConfirmationToken(token(), {
      userId: USER_ID,
      messageId: MESSAGE_ID,
      resourceVersion: 'b'.repeat(64),
      kind: 'create_memo',
      params: PARAMS,
      operationId: OPERATION_ID
    }, SECRET, { now: Date.parse('2026-08-27T10:01:00Z') }),
    /邮件或提议已变化/
  )
})

test('email AI confirmation rejects tampering and expiry', () => {
  const signed = token()
  const tampered = `${signed.slice(0, -1)}${signed.endsWith('A') ? 'B' : 'A'}`
  assert.throws(
    () => verifyEmailAiConfirmationToken(tampered, {
      userId: USER_ID,
      messageId: MESSAGE_ID,
      resourceVersion: RESOURCE_VERSION,
      kind: 'create_memo',
      params: PARAMS,
      operationId: OPERATION_ID
    }, SECRET),
    /令牌无效/
  )
  assert.throws(
    () => verifyEmailAiConfirmationToken(signed, {
      userId: USER_ID,
      messageId: MESSAGE_ID,
      resourceVersion: RESOURCE_VERSION,
      kind: 'create_memo',
      params: PARAMS,
      operationId: OPERATION_ID
    }, SECRET, { now: Date.parse('2026-08-27T10:06:00Z') }),
    (error) => error.code === 'email_ai_confirmation_expired'
  )
})

test('email AI confirmation supports diary proposals but rejects fictional note kinds', () => {
  const diaryParams = {
    title: '邮件日记',
    content: '今日邮件回顾',
    tags: ['邮件'],
    entryDate: '2026-08-27',
    mood: '平静'
  }
  const signed = createEmailAiConfirmationToken({
    userId: USER_ID,
    messageId: MESSAGE_ID,
    resourceVersion: RESOURCE_VERSION,
    kind: 'create_diary',
    params: diaryParams,
    operationId: OPERATION_ID,
    ttlSeconds: 300,
    now: Date.parse('2026-08-27T10:00:00Z')
  }, SECRET)
  assert.equal(verifyEmailAiConfirmationToken(signed, {
    userId: USER_ID,
    messageId: MESSAGE_ID,
    resourceVersion: RESOURCE_VERSION,
    kind: 'create_diary',
    params: diaryParams,
    operationId: OPERATION_ID
  }, SECRET, { now: Date.parse('2026-08-27T10:01:00Z') }).kind, 'create_diary')
  assert.throws(() => createEmailAiConfirmationToken({
    userId: USER_ID,
    messageId: MESSAGE_ID,
    resourceVersion: RESOURCE_VERSION,
    kind: 'create_note',
    params: diaryParams,
    operationId: OPERATION_ID,
    ttlSeconds: 300,
    now: Date.parse('2026-08-27T10:00:00Z')
  }, SECRET), /\u4e0d\u652f\u6301/)
})
