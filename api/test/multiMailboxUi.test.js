import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}

test('managed integration UI can add, switch, save and test one secondary mailbox', async () => {
  const [component, service] = await Promise.all([
    source('../../app/src/modules/settings/components/SystemIntegrationsSettings.vue'),
    source('../../app/src/shared/services/integrationApi.js')
  ])
  assert.match(service, /\/admin\/integrations\/mail\/accounts/)
  assert.match(service, /test-smtp/)
  assert.match(service, /test-imap/)
  assert.match(service, /encodeURIComponent\(accountId\)/)
  assert.match(component, /mailPrimaryManaged/)
  assert.match(component, /secondaryMailAccounts/)
  assert.match(component, /添加第二邮箱/)
  assert.match(component, /新邮箱（尚未保存）/)
  assert.match(component, /createManagedMailAccount/)
  assert.match(component, /saveManagedMailAccount/)
  assert.match(component, /testManagedMailAccountSmtp/)
  assert.match(component, /testManagedMailAccountImap/)
  assert.match(component, /mailOwnerLocked/)
  assert.match(component, /:readonly="mailOwnerLocked"/)
  assert.match(component, /账号保存后归属用户会锁定/)
  assert.match(component, /isSecondaryMailAccount\.value \? false : mail\.registrationEnabled/)
  assert.match(component, /isSecondaryMailAccount\.value \? false : mail\.digestEnabled/)
  assert.match(component, /if \(result\?\.warning\) warning\.value = String\(result\.warning\)/)
  assert.match(component, /class="notice notice--warning" role="status" aria-live="polite"/)
  assert.match(component, /'is-warning': Boolean\(warning\)/)
  assert.doesNotMatch(component, /smtpPassword\s*:\s*mailState/)
  assert.doesNotMatch(component, /imapPassword\s*:\s*mailState/)
})

test('mail folder sidebar exposes account management without hiding the single account', async () => {
  const sidebar = await source('../../app/src/modules/mail/components/MailFolderSidebar.vue')
  assert.match(sidebar, /添加或管理邮箱账号/)
  assert.match(sidebar, /accounts\.length < 2 \? '添加第二邮箱'/)
  assert.match(sidebar, /currentUser\.value\?\.role === 'admin'/)
  assert.match(sidebar, /需要更多邮箱时，请联系管理员添加/)
  assert.doesNotMatch(sidebar, /v-if="accounts\.length > 1"/)
})
