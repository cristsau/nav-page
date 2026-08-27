import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('mail reminder rules manager uses the bounded notification rule APIs', async () => {
  const [manager, api] = await Promise.all([
    source('app/src/modules/mail/components/MailNotificationRulesManagerDialog.vue'),
    source('app/src/shared/services/emailApi.js')
  ])

  assert.match(manager, /fetchEmailNotificationRules/)
  assert.match(manager, /updateEmailNotificationRule/)
  assert.match(manager, /deleteEmailNotificationRule/)
  assert.match(manager, /previewEmailNotificationRule/)
  assert.match(manager, /createEmailNotificationRule/)
  assert.match(manager, /scope: 'account'/)
  assert.match(api, /GET\s+\/email\/notification-rules/)
  assert.match(api, /PATCH\s+\/email\/notification-rules\/\:id/)
  assert.match(api, /DELETE\s+\/email\/notification-rules\/\:id/)
})

test('mail reminder rules manager exposes state, expiry, hit summaries and explicit deletion confirmation', async () => {
  const manager = await source('app/src/modules/mail/components/MailNotificationRulesManagerDialog.vue')

  assert.match(manager, /ruleIsActive/)
  assert.match(manager, /rule\?\.state === 'expired'/)
  assert.match(manager, /rule\.expiresAt/)
  assert.match(manager, /rule\?\.hitCount/)
  assert.match(manager, /rule\?\.lastHitAt/)
  assert.match(manager, /确认删除/)
  assert.match(manager, /deleteConfirmId/)
  assert.match(manager, /EMAIL_CRITICAL_NOTIFICATION_CONFIRMATION_REQUIRED/)
  assert.match(manager, /criticalOverrideConfirmed: true/)
})

test('mail reminder rules entry is available in desktop sidebar and mobile folder sheet', async () => {
  const [view, sidebar, sheet] = await Promise.all([
    source('app/src/modules/mail/MailView.vue'),
    source('app/src/modules/mail/components/MailFolderSidebar.vue'),
    source('app/src/modules/mail/components/MailFolderSheet.vue')
  ])

  assert.match(sidebar, /提醒规则/)
  assert.match(sidebar, /emit\('manage-rules'\)/)
  assert.match(sheet, /@manage-rules="emit\('manage-rules'\)"/)
  assert.match(view, /MailNotificationRulesManagerDialog/)
  assert.match(view, /@manage-rules="openRulesManager"/)
})

test('mail reminder rules manager is keyboard accessible and restores focus', async () => {
  const manager = await source('app/src/modules/mail/components/MailNotificationRulesManagerDialog.vue')

  assert.match(manager, /role="dialog"/)
  assert.match(manager, /aria-modal="true"/)
  assert.match(manager, /event\.key === 'Escape'/)
  assert.match(manager, /event\.key !== 'Tab'/)
  assert.match(manager, /restoreTarget\?\.focus/)
  assert.match(manager, /width: 44px; height: 44px/)
  assert.doesNotMatch(manager, /[\u{1F300}-\u{1FAFF}]/u)
})
