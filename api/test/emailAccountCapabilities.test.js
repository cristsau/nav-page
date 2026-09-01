import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  assertEmailAccountDeliveryReady,
  assertEmailAccountRemoteActionsReady,
  resolveEmailAccountDeliveryReadiness,
  resolveEmailAccountRemoteActionReadiness
} from '../src/lib/emailAccountDeliveryReadiness.js'

const ids = {
  userId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222'
}

const smtpOnly = {
  emailSourceKey: 'secondary-mail',
  emailOwnerUsername: 'cristsau',
  mailDeliveryEnabled: true,
  emailIngestEnabled: false
}

const imapOnly = {
  emailSourceKey: 'secondary-mail',
  emailOwnerUsername: 'cristsau',
  mailDeliveryEnabled: false,
  emailIngestEnabled: true
}

function accountQuery(row = { source_key: 'secondary-mail', owner_username: 'cristsau' }) {
  return async (sql, params) => {
    assert.match(String(sql), /account\.id = \$1 AND account\.user_id = \$2 AND account\.enabled = TRUE/)
    assert.deepEqual(params, [ids.accountId, ids.userId])
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
  }
}

test('delivery readiness is bound to the exact source and owner and requires verified SMTP', async () => {
  const ready = await resolveEmailAccountDeliveryReadiness({
    sourceKey: 'secondary-mail',
    ownerUsername: 'cristsau',
    runtimeConfigs: [smtpOnly]
  }, {
    statusFn: async (runtime) => {
      assert.equal(runtime, smtpOnly)
      return { configured: true, enabled: true }
    }
  })
  assert.deepEqual(ready, { ready: true, enabled: true, configured: true, reason: 'ready' })

  const wrongOwner = await resolveEmailAccountDeliveryReadiness({
    sourceKey: 'secondary-mail',
    ownerUsername: 'someone-else',
    runtimeConfigs: [smtpOnly]
  })
  assert.deepEqual(wrongOwner, {
    ready: false,
    enabled: false,
    configured: false,
    reason: 'account_not_configured'
  })

  const disabled = await resolveEmailAccountDeliveryReadiness({
    sourceKey: 'secondary-mail',
    ownerUsername: 'cristsau',
    runtimeConfigs: [imapOnly]
  })
  assert.equal(disabled.ready, false)
  assert.equal(disabled.reason, 'delivery_disabled')
})

test('remote action readiness requires an ingest runtime for the exact mailbox', async () => {
  assert.deepEqual(await resolveEmailAccountRemoteActionReadiness({
    sourceKey: 'secondary-mail',
    ownerUsername: 'cristsau',
    runtimeConfigs: [imapOnly]
  }), { ready: true, reason: 'ready' })

  assert.deepEqual(await resolveEmailAccountRemoteActionReadiness({
    sourceKey: 'secondary-mail',
    ownerUsername: 'cristsau',
    runtimeConfigs: [smtpOnly]
  }), { ready: false, reason: 'ingest_disabled' })
})

test('account assertions fail closed for disabled accounts and unavailable per-account capabilities', async () => {
  await assert.rejects(
    assertEmailAccountDeliveryReady({ ...ids, queryFn: accountQuery(null) }),
    (error) => error?.code === 'EMAIL_ACCOUNT_DELIVERY_UNAVAILABLE'
      && error?.reason === 'account_disabled'
      && error?.statusCode === 503
  )
  await assert.rejects(
    assertEmailAccountDeliveryReady({
      ...ids,
      queryFn: accountQuery(),
      runtimeConfigs: [imapOnly]
    }),
    (error) => error?.code === 'EMAIL_ACCOUNT_DELIVERY_UNAVAILABLE'
      && error?.reason === 'delivery_disabled'
  )
  await assert.rejects(
    assertEmailAccountRemoteActionsReady({
      ...ids,
      queryFn: accountQuery(),
      runtimeConfigs: [smtpOnly]
    }),
    (error) => error?.code === 'EMAIL_ACCOUNT_REMOTE_ACTIONS_UNAVAILABLE'
      && error?.reason === 'ingest_disabled'
  )
})

test('mail routes and UI expose and enforce per-account SMTP and IMAP capabilities', async () => {
  const [routes, drafts, view, detail, compose, list] = await Promise.all([
    readFile(new URL('../src/routes/email.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/emailDrafts.js', import.meta.url), 'utf8'),
    readFile(new URL('../../app/src/modules/mail/MailView.vue', import.meta.url), 'utf8'),
    readFile(new URL('../../app/src/modules/mail/components/MailMessageDetail.vue', import.meta.url), 'utf8'),
    readFile(new URL('../../app/src/modules/mail/components/MailComposeDialog.vue', import.meta.url), 'utf8'),
    readFile(new URL('../../app/src/modules/mail/components/MailMessageList.vue', import.meta.url), 'utf8')
  ])

  assert.match(routes, /deliveryReady: delivery\.ready/)
  assert.match(routes, /remoteActionsReady: remoteActions\.ready/)
  assert.match(routes, /await assertEmailAccountRemoteActionsReady\(/)
  assert.match(drafts, /await assertDeliveryReadyFn\([\s\S]*?accountId: row\.account_id/)
  assert.match(view, /const composeReady = computed/)
  assert.match(view, /const remoteActionsReady = computed/)
  assert.match(view, /@mark-all-read="markFolderAllRead"/)
  assert.match(detail, /deliveryReady: \{ type: Boolean, default: false \}/)
  assert.match(detail, /remoteActionsReady: \{ type: Boolean, default: false \}/)
  assert.match(detail, /:disabled="!deliveryReady"/)
  assert.match(detail, /:disabled="commandBusy \|\| !remoteActionsReady"/)
  assert.match(compose, /deliveryReady: \{ type: Boolean, default: false \}/)
  assert.match(compose, /props\.deliveryReady[\s\S]*?const canSave/)
  assert.match(list, /composeReady: \{ type: Boolean, default: false \}/)
  assert.match(list, /remoteActionsReady: \{ type: Boolean, default: false \}/)
})
