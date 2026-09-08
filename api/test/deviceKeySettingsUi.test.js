import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('quick-login settings stay discoverable with explicit unavailable and retry states', async () => {
  const source = await read('app/src/modules/settings/components/DeviceKeySettings.vue')
  assert.match(source, /<section class="device-key-settings"/)
  assert.doesNotMatch(source, /<section v-if="enabled"/)
  assert.match(source, /v-else-if="loadError"/)
  assert.match(source, /v-else-if="!enabled"/)
  assert.match(source, /role="alert"/)
  assert.match(source, /@click="load"/)
  assert.match(source, /typeof config\.enabled !== 'boolean'/)
  assert.match(source, /Array\.isArray\(result\.keys\)/)
  assert.match(source, /两个域名的通行密钥和登录状态不会互通/)
  assert.match(source, /本页管理 \{\{currentDomain\}\} 的通行密钥/)
  assert.doesNotMatch(source, /:href="config|window\.location\.assign\(.*mainOrigin/)
})

test('quick-login settings keep password-protected explicit enrollment and secret clearing', async () => {
  const source = await read('app/src/modules/settings/components/DeviceKeySettings.vue')
  assert.match(source, /@click="openRegister"/)
  assert.match(source, /await enrollDeviceKey\(\{ name: name\.value, currentPassword: password\.value \}\)/)
  assert.match(source, /onBeforeUnmount\(\(\) => \{ password\.value = '' \}\)/)
  assert.match(source, /finally \{ password\.value = ''; busy\.value = false \}/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/)
  const account = await read('app/src/modules/settings/components/AccountSecuritySettings.vue')
  assert.ok(account.indexOf('<DeviceKeySettings />') < account.indexOf('<EmailAccountSettings @updated='))
})

test('mobile tab labels do not shrink and active-category scrolling stays within the strip', async () => {
  const source = await read('app/src/modules/settings/Settings.vue')
  assert.match(source, /\.category-tabs button \{[^}]*flex: 0 0 auto;[^}]*white-space: nowrap;/)
  assert.match(source, /\.category-tabs button > span \{[^}]*white-space: nowrap;/)
  assert.match(source, /tabs\.scrollLeft \+=/)
  assert.doesNotMatch(source, /selectedTab\.scrollIntoView/)
})
