import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { encryptEmailPayloadWithKey } from '../src/lib/emailCrypto.js'
import {
  defaultEmailNotificationAction,
  digestEmailNotificationRuleValue,
  emailImportanceScore,
  normalizeEmailNotificationRuleInput,
  normalizeEmailRuleMatchValue,
  previewEmailNotificationRule,
  publicEmailNotificationDecision,
  resolveEmailNotificationDecision,
  upsertEmailNotificationRule
} from '../src/lib/emailNotificationRules.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const KEY = Buffer.alloc(32, 7)

test('notification rule input normalizes all supported identities without weakening ownership', () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  assert.deepEqual(normalizeEmailNotificationRuleInput({
    accountId: ACCOUNT_ID.toUpperCase(),
    scope: 'sender',
    matchValue: ' Sender@Example.Test ',
    action: 'in_app_only',
    enabled: false,
    expiresAt
  }), {
    accountId: ACCOUNT_ID,
    scope: 'sender',
    action: 'in_app_only',
    priority: 400,
    matchValue: 'sender@example.test',
    enabled: false,
    expiresAt,
    criticalOverrideConfirmed: false,
    explanation: '这个发件人手动规则：仅在 DOMO NAV 站内提醒。'
  })
  assert.equal(normalizeEmailRuleMatchValue('domain', '@例子.测试', ACCOUNT_ID), 'xn--fsqu00a.xn--0zwm56d')
  assert.equal(normalizeEmailRuleMatchValue('category', 'SECURITY', ACCOUNT_ID), 'security')
  assert.equal(normalizeEmailRuleMatchValue('account', undefined, ACCOUNT_ID), ACCOUNT_ID)
  assert.throws(() => normalizeEmailRuleMatchValue('conversation', 'not-a-thread-key', ACCOUNT_ID))
  assert.throws(() => normalizeEmailNotificationRuleInput({
    accountId: ACCOUNT_ID,
    scope: 'account',
    action: 'delete'
  }))
})

test('notification rule match digests are keyed and domain separated', () => {
  const senderDigest = digestEmailNotificationRuleValue('sender', 'sender@example.test', KEY)
  assert.match(senderDigest, /^[0-9a-f]{64}$/)
  assert.notEqual(senderDigest, digestEmailNotificationRuleValue('domain', 'sender@example.test', KEY))
  assert.notEqual(senderDigest, digestEmailNotificationRuleValue('sender', 'other@example.test', KEY))
  assert.equal(senderDigest.includes('sender@example.test'), false)
  assert.throws(() => digestEmailNotificationRuleValue('sender', 'sender@example.test', Buffer.alloc(16)))
})

test('deterministic matcher applies specificity order and records an explainable hit', async () => {
  const updates = []
  const queryFn = async (sql, params) => {
    if (/SELECT id, scope, action/.test(sql)) {
      assert.equal(params[0], USER_ID)
      assert.equal(params[1], ACCOUNT_ID)
      assert.equal(params[2].length, 5)
      return {
        rows: [
          {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            scope: 'conversation',
            action: 'in_app_only',
            priority: 500,
            critical_override_confirmed: true,
            explanation: '当前会话手动规则：仅在 DOMO NAV 站内提醒。',
            updated_at: new Date()
          },
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            scope: 'sender',
            action: 'silent',
            priority: 400,
            critical_override_confirmed: true,
            explanation: '这个发件人手动规则：静默收件。',
            updated_at: new Date()
          }
        ]
      }
    }
    if (/UPDATE email_notification_rules/.test(sql)) {
      updates.push(params)
      return { rowCount: 1, rows: [] }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
  const decision = await resolveEmailNotificationDecision({
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    senderAddress: 'sender@example.test',
    category: 'personal',
    conversationKey: 'd'.repeat(64),
    tier: 2,
    queryFn,
    encryptionKey: KEY
  })
  assert.equal(decision.action, 'in_app_only')
  assert.equal(decision.ruleId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  assert.match(decision.reason, /当前会话/)
  assert.deepEqual(updates, [['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', USER_ID]])
})

test('critical email cannot be suppressed by an unconfirmed rule', async () => {
  const queryFn = async (sql) => {
    if (/SELECT id, scope, action/.test(sql)) {
      return {
        rows: [{
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          scope: 'sender',
          action: 'silent',
          priority: 400,
          critical_override_confirmed: false,
          explanation: '这个发件人手动规则：静默收件。',
          updated_at: new Date()
        }]
      }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
  const decision = await resolveEmailNotificationDecision({
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    senderAddress: 'security@example.test',
    category: 'security',
    conversationKey: null,
    tier: 1,
    queryFn,
    encryptionKey: KEY
  })
  assert.equal(decision.action, 'immediate')
  assert.equal(decision.ruleId, null)
  assert.equal(decision.protectedRule, true)
  assert.match(decision.reason, /安全保护/)
})

test('a paused suppressive rule does not require confirmation until it is enabled', async () => {
  const queryFn = async (sql) => {
    if (/SELECT 1 FROM email_accounts/.test(sql)) return { rowCount: 1, rows: [{ '?column?': 1 }] }
    if (/SELECT event\.id/.test(sql)) return { rowCount: 0, rows: [] }
    throw new Error(`unexpected SQL: ${sql}`)
  }
  const preview = await previewEmailNotificationRule({
    userId: USER_ID,
    payload: {
      accountId: ACCOUNT_ID,
      scope: 'category',
      matchValue: 'security',
      action: 'silent',
      enabled: false
    }
  }, { queryFn })
  assert.equal(preview.requiresCriticalConfirmation, false)
})

test('a concurrent first upsert preserves ciphertext bound to the winning rule id', async () => {
  const winningId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const winningCiphertext = encryptEmailPayloadWithKey({ value: 'sender@example.test' }, KEY, {
    context: `email-notification-rule:${USER_ID}:${winningId}`
  })
  let insertCandidateId = null
  const queryFn = async (sql, params) => {
    if (/SELECT 1 FROM email_accounts/.test(sql)) return { rowCount: 1, rows: [{ '?column?': 1 }] }
    if (/SELECT event\.id/.test(sql)) return { rowCount: 0, rows: [] }
    if (/SELECT id FROM email_notification_rules/.test(sql)) return { rowCount: 0, rows: [] }
    if (/INSERT INTO email_notification_rules/.test(sql)) {
      insertCandidateId = params[0]
      assert.notEqual(insertCandidateId, winningId)
      assert.match(sql, /ELSE email_notification_rules\.match_value_encrypted/)
      return {
        rowCount: 1,
        rows: [{
          id: winningId,
          user_id: USER_ID,
          account_id: ACCOUNT_ID,
          scope: 'sender',
          action: 'digest',
          priority: 400,
          match_value_digest: params[6],
          match_value_encrypted: winningCiphertext,
          enabled: true,
          critical_override_confirmed: false,
          expires_at: null,
          explanation: '这个发件人手动规则：仅进入邮件摘要。',
          hit_count: 0,
          last_hit_at: null,
          created_at: new Date(),
          updated_at: new Date()
        }]
      }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
  const result = await upsertEmailNotificationRule({
    userId: USER_ID,
    payload: {
      accountId: ACCOUNT_ID,
      scope: 'sender',
      matchValue: 'sender@example.test',
      action: 'digest'
    }
  }, { queryFn, encryptionKey: KEY })
  assert.ok(insertCandidateId)
  assert.equal(result.created, false)
  assert.equal(result.rule.id, winningId)
  assert.equal(result.rule.matchValue, 'sender@example.test')
})

test('default decision fields remain stable for mailbox and assistant clients', () => {
  assert.equal(defaultEmailNotificationAction(1), 'immediate')
  assert.equal(defaultEmailNotificationAction(2), 'digest')
  assert.equal(defaultEmailNotificationAction(3), 'silent')
  assert.equal(emailImportanceScore(1, 'high'), 95)
  assert.equal(emailImportanceScore(2, 'medium'), 65)
  assert.deepEqual(publicEmailNotificationDecision({ tier: 2, urgency: 'medium' }), {
    category: 'other',
    importanceScore: 65,
    notificationAction: 'digest',
    notificationReason: '默认策略：当天处理邮件进入摘要。',
    notificationRuleId: null
  })
})

test('API and delivery integration expose the agreed contract without plaintext storage', async () => {
  const [routes, scheduler, events, rules, securityEvents, migration] = await Promise.all([
    readFile(new URL('../src/routes/email.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/emailDigestScheduler.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/emailEvents.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/emailNotificationRules.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/securityEvents.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/db/migrations/039_email_notification_rules.sql', import.meta.url), 'utf8')
  ])
  for (const route of [
    "fastify.get('/email/notification-rules'",
    "fastify.post('/email/notification-rules'",
    "fastify.patch('/email/notification-rules/:ruleId'",
    "fastify.delete('/email/notification-rules/:ruleId'",
    "fastify.post('/email/notification-rules/preview'"
  ]) assert.ok(routes.includes(route), route)
  for (const field of [
    'threadKey', 'threadMessageCount', 'category', 'importanceScore',
    'notificationAction', 'notificationReason'
  ]) assert.ok(routes.includes(field) || events.includes(field) || rules.includes(field), field)
  assert.match(scheduler, /notification_action[\s\S]*= 'digest'/)
  assert.match(events, /resolveEmailNotificationDecision/)
  assert.match(events, /pushEnabled: action === 'immediate'/)
  assert.match(securityEvents, /email\.notification_rule\.create/)
  assert.match(securityEvents, /email\.notification_rule\.delete/)
  assert.doesNotMatch(migration, /\n\s*match_value\s+(?:TEXT|VARCHAR)/i)
})
