import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { runWebPushStage } from '../../app/src/shared/services/webPushTiming.js'
import {
  currentActiveWebPushSubscription,
  webPushEnableLabel,
  webPushFailureMessage,
  webPushTestDisabledReason
} from '../../app/src/shared/services/webPushState.js'

test('Web Push browser operations release the UI after a bounded timeout', async () => {
  await assert.rejects(
    runWebPushStage('browser-subscription', () => new Promise(() => {}), 5),
    (error) => (
      error.code === 'WEB_PUSH_TIMEOUT'
      && error.webPushStage === 'browser-subscription'
    )
  )

  const message = webPushFailureMessage(Object.assign(
    new Error('timed out'),
    { code: 'WEB_PUSH_TIMEOUT', webPushStage: 'browser-subscription' }
  ))
  assert.match(message, /按钮已恢复/)
  assert.match(message, /继续完成启用/)
})

test('Web Push test action is bound to the active subscription for this device', () => {
  const subscriptions = [
    { id: 'other', active: true },
    { id: 'current', active: true },
    { id: 'disabled', active: false }
  ]

  assert.deepEqual(
    currentActiveWebPushSubscription(subscriptions, 'current'),
    subscriptions[1]
  )
  assert.equal(currentActiveWebPushSubscription(subscriptions, 'missing'), null)
  assert.equal(currentActiveWebPushSubscription(subscriptions, 'disabled'), null)
})

test('Web Push state explains granted permission without a browser or server subscription', () => {
  const common = {
    busy: false,
    configured: true,
    supported: true,
    permission: 'granted',
    serviceWorkerReady: true,
    keyMatches: true,
    subscriptionId: '',
    currentSubscription: null
  }

  assert.match(
    webPushTestDisabledReason({ ...common, browserSubscribed: false }),
    /浏览器 Push 订阅尚未建立/
  )
  assert.match(
    webPushTestDisabledReason({ ...common, browserSubscribed: true }),
    /NAV 服务器登记/
  )
  assert.equal(
    webPushTestDisabledReason({
      ...common,
      browserSubscribed: true,
      subscriptionId: 'current',
      currentSubscription: { id: 'current', active: true }
    }),
    ''
  )
  assert.equal(
    webPushEnableLabel({ permission: 'granted', currentSubscription: null, keyMatches: true }),
    '继续完成启用'
  )
})

test('Web Push browser subscription failures provide actionable and redacted guidance', () => {
  const browserMessage = webPushFailureMessage(
    Object.assign(new Error('Registration failed at https://secret.push.invalid/token'), {
      webPushStage: 'browser-subscription'
    })
  )
  assert.match(browserMessage, /普通窗口/)
  assert.match(browserMessage, /InPrivate/)
  assert.doesNotMatch(browserMessage, /secret\.push\.invalid/)

  const serverMessage = webPushFailureMessage(
    new Error('Push endpoint provider is not allowed'),
    { stage: 'server-registration' }
  )
  assert.match(serverMessage, /NAV 服务器登记失败/)
})

test('Web Push settings automatically tests after registration and never falls back to another device', async () => {
  const source = await fs.readFile(
    new URL('../../app/src/modules/settings/components/WebPushSettings.vue', import.meta.url),
    'utf8'
  )

  assert.match(source, /sendWebPushTest\(enabledSubscriptionId\)/)
  assert.match(source, /const subscriptionId = currentSubscription\.value\?\.id \|\| ''/)
  assert.match(source, /Boolean\(testDisabledReason\)/)
  assert.doesNotMatch(source, /!activeSubscriptions\.length[^\n]*@click="test"/)
  assert.match(source, /1 系统权限/)
  assert.match(source, /2 浏览器订阅/)
  assert.match(source, /3 服务器登记/)
})

test('Web Push inspection and error recovery cannot leave the settings UI permanently busy', async () => {
  const [apiSource, settingsSource, pwaSource] = await Promise.all([
    fs.readFile(new URL('../../app/src/shared/services/webPushApi.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../app/src/modules/settings/components/WebPushSettings.vue', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../app/src/shared/services/pwa.js', import.meta.url), 'utf8')
  ])

  assert.match(apiSource, /runWebPushStage\('service-worker', getPwaRegistration, 8_000\)/)
  assert.match(apiSource, /runWebPushStage\([\s\S]*?'browser-subscription',[\s\S]*?getSubscription\(\),[\s\S]*?8_000/)
  assert.match(apiSource, /if \(error\?\.code !== 'WEB_PUSH_TIMEOUT'\) throw error/)
  assert.match(apiSource, /pushManager\.subscribe/)
  assert.match(settingsSource, /function refreshInBackground\(\)[\s\S]*?void reload\(\)/)
  assert.doesNotMatch(settingsSource, /catch \(error\) \{\s*await reload\(\)/)
  assert.match(pwaSource, /void registration\.update\(\)\.catch/)
  const registerFunction = pwaSource.match(
    /export async function registerPwa\(\) \{[\s\S]*?\n\}/
  )?.[0] || ''
  assert.doesNotMatch(registerFunction, /await registration\.update\(\)/)
})

test('Mail configuration uses native form submission for reliable iPhone touch handling', async () => {
  const source = await fs.readFile(
    new URL('../../app/src/modules/settings/components/SystemIntegrationsSettings.vue', import.meta.url),
    'utf8'
  )

  assert.match(source, /@submit\.prevent\.stop="saveMail"/)
  assert.match(source, /class="button button--primary"\s+type="submit"/)
  assert.match(source, /配置 \{\{ writable \? '可保存' : '只读' \}\}/)
  assert.match(source, /touch-action: manipulation/)
})
