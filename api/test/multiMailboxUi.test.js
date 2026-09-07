import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}

test('active settings do not offer primary or secondary personal mailboxes', async () => {
  const component = await source('../../app/src/modules/settings/components/SystemIntegrationsSettings.vue')
  const oauth = await source('../../app/src/modules/settings/components/OauthIntegrationSettings.vue')
  assert.match(component, /SystemNotificationSettings/)
  assert.doesNotMatch(component, /secondaryMailAccounts|createManagedMailAccount|testManagedMailAccountImap/)
  assert.doesNotMatch(oauth, /emailOauth|testEmailOauth|saveEmailOauth/)
})

test('mail folder sidebar exposes account management without hiding the single account', async () => {
  const sidebar = await source('../../app/src/modules/mail/components/MailFolderSidebar.vue')
  assert.match(sidebar, /添加或管理邮箱账号/)
  assert.match(sidebar, /accounts\.length < 2 \? '添加第二邮箱'/)
  assert.match(sidebar, /currentUser\.value\?\.role === 'admin'/)
  assert.match(sidebar, /需要更多邮箱时，请联系管理员添加/)
  assert.doesNotMatch(sidebar, /v-if="accounts\.length > 1"/)
})
