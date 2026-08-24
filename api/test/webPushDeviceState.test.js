import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import {
  currentActiveWebPushSubscription,
  webPushEnableLabel,
  webPushFailureMessage,
  webPushTestDisabledReason
} from '../../app/src/shared/services/webPushState.js'

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
