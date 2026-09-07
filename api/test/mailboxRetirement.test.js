import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { enforceMailboxRetirement, RETIRED_MAIL_TOOLS, SYSTEM_MAIL_SQL, SYSTEM_MAIL_TYPES } from '../src/lib/mailboxRetirement.js'
import { normalizeSystemMailInput } from '../src/routes/systemIntegrations.js'
import { ASSISTANT_TOOL_DEFINITIONS } from '../src/lib/assistantTools.js'
import { buildAssistantPrompts } from '../src/lib/assistantContext.js'
import { normalizeAssistantAdvancedArguments, confirmAssistantAdvancedOperation, executeAssistantAdvancedReadTool } from '../src/lib/assistantAdvancedOperations.js'
import { deliverMailOutbox, startMailDeliveryScheduler } from '../src/lib/mailOutbox.js'

test('personal mail and mailbox OAuth endpoints are gone, not unauthenticated fallbacks', async () => {
  const app = createApp()
  try {
    for (const path of ['/email', '/email/events', '/email/accounts/a/messages', '/email/stream', '/admin/email', '/admin/integrations/mail', '/admin/integrations/mail/accounts', '/admin/oauth-integrations/email']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const response = await app.inject({ method, url: `/api${path}`, headers: { origin: config.corsOrigin.split(',')[0] } })
        assert.equal(response.statusCode, 410, `${method} ${path}`)
        assert.equal(response.json().code, 'MAILBOX_RETIRED')
        assert.equal(response.headers['cache-control'], 'no-store')
      }
    }
    for (const path of ['/admin/mail/status', '/admin/integrations', '/admin/oauth-integrations', '/notes']) {
      const response = await app.inject({ method: 'GET', url: `/api${path}` })
      assert.equal(response.statusCode, 401, path)
    }
    for (const path of ['/admin/mail/test', '/admin/integrations/system-mail/test-smtp']) {
      const response = await app.inject({ method: 'POST', url: `/api${path}`, headers: { origin: config.corsOrigin.split(',')[0] } })
      assert.equal(response.statusCode, 401, path)
    }
    assert.equal((await app.inject('/api/health')).statusCode, 200)
  } finally { await app.close() }
})

test('legacy stored enable flags cannot reactivate ingestion or cache growth', () => {
  const state = { emailIngestEnabled: true, emailDigestEnabled: true, emailSentAppendEnabled: true, emailCacheRetentionEnabled: true, imapProtocolReconciliationEnabled: true, imapSecondaryFolderSyncEnabled: true, mailDeliveryEnabled: true, webPushEnabled: true }
  enforceMailboxRetirement(state)
  for (const key of Object.keys(state).filter((key) => key.startsWith('email') || key.startsWith('imap'))) assert.equal(state[key], false)
  assert.equal(state.mailDeliveryEnabled, true)
  assert.equal(state.webPushEnabled, true)
})

test('system mail settings reject personal mailbox fields and never accept enable-by-extra-field', () => {
  assert.deepEqual(normalizeSystemMailInput({ smtpHost: 'smtp.example.test' }), { smtpHost: 'smtp.example.test', ingestEnabled: false, digestEnabled: false })
  for (const body of [null, [], { ingestEnabled: true }, { imapPassword: 'test' }, { ownerUsername: 'test' }]) assert.throws(() => normalizeSystemMailInput(body), TypeError)
})

test('mailbox AI tools are absent and legacy read/proposal calls fail before I/O', async () => {
  for (const name of RETIRED_MAIL_TOOLS) {
    assert.equal(ASSISTANT_TOOL_DEFINITIONS.some((tool) => tool.name === name), false)
    assert.throws(() => normalizeAssistantAdvancedArguments(name, {}), (error) => error.code === 'MAILBOX_RETIRED')
    await assert.rejects(executeAssistantAdvancedReadTool({ userId: 'test', toolName: name, queryFn: () => assert.fail('must not query') }), (error) => error.code === 'MAILBOX_RETIRED')
  }
  assert.ok(ASSISTANT_TOOL_DEFINITIONS.some((tool) => tool.name === 'create_diary'))
  assert.ok(ASSISTANT_TOOL_DEFINITIONS.some((tool) => tool.name === 'create_bookmark'))
  assert.match(buildAssistantPrompts('帮我读邮件', []).systemPrompt, /个人邮箱功能已下线/)
})

test('previously prepared or succeeded mail confirmations cannot execute or replay', async () => {
  for (const status of ['awaiting_confirmation', 'succeeded']) {
    let queries = 0
    await assert.rejects(confirmAssistantAdvancedOperation({
      userId: 'test', operationId: 'old-mail',
      withTransactionFn: (run) => run({ query: async () => { queries += 1; return { rows: [{ tool_name: 'send_email_draft', status, sensitive_payload: Buffer.from('unreadable') }] } } }),
      executeConfirmedFn: () => assert.fail('must not execute')
    }), (error) => error.code === 'MAILBOX_RETIRED')
    assert.equal(queries, 1)
  }
})

test('transactional SMTP selectors, cleanup and counts all enforce the system-only allowlist', async () => {
  const statements = []
  let released = false
  const client = {
    async query(sql) {
      statements.push(sql)
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
      if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] }
      return { rows: [], rowCount: 0 }
    },
    release() { released = true }
  }
  const result = await deliverMailOutbox({ poolInstance: { connect: async () => client }, policy: {}, systemOnly: true, runtimeConfig: { ...config, emailSourceKey: 'system' }, transportFactory: () => assert.fail('empty queue must not connect to SMTP') })
  assert.equal(result.sent, 0)
  assert.equal(released, true)
  const queueStatements = statements.filter((sql) => /FROM mail_outbox|UPDATE mail_outbox/.test(sql))
  assert.equal(queueStatements.length, 4)
  for (const sql of queueStatements) assert.ok(sql.includes(SYSTEM_MAIL_SQL))
  assert.ok(SYSTEM_MAIL_TYPES.includes('registration.verify'))
  assert.ok(SYSTEM_MAIL_TYPES.includes('maintenance.failed'))
  assert.ok(SYSTEM_MAIL_TYPES.includes('system.test'))
  assert.equal(SYSTEM_MAIL_TYPES.includes('user.mail'), false)
  assert.equal(SYSTEM_MAIL_TYPES.includes('email.digest'), false)
})

test('system-only restriction survives the scheduler callback', async () => {
  let observed
  const stop = startMailDeliveryScheduler({ enabled: true, policy: {}, systemOnly: true, deliveryFn: async (input) => { observed = input.systemOnly; return {} }, timerApi: { setInterval: () => ({ unref() {} }), clearInterval() {} } })
  await stop()
  assert.equal(observed, true)
})
