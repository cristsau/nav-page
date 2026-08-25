import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { waitForActiveRegistration } from '../../app/src/shared/services/pwa.js'
import {
  startWebPushSubscription,
  webPushPermissionBlockReason
} from '../../app/src/shared/services/webPushSubscription.js'
import {
  createRegistrationGeneration,
  isRootServiceWorkerScope
} from '../../app/src/shared/services/pwaRegistrationState.js'
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

test('Web Push subscription starts synchronously from the user gesture', async () => {
  let subscribeCalled = false
  const expectedSubscription = { endpoint: 'https://push.example.test/current' }
  const registration = {
    active: { state: 'activated' },
    pushManager: {
      subscribe(options) {
        subscribeCalled = true
        assert.equal(options.userVisibleOnly, true)
        assert.ok(options.applicationServerKey instanceof Uint8Array)
        return Promise.resolve(expectedSubscription)
      }
    }
  }

  const pending = startWebPushSubscription(registration, 'AQIDBA')
  assert.equal(subscribeCalled, true)
  assert.equal(await pending, expectedSubscription)
})

test('Web Push permission states keep default and granted actionable while denied is blocked', () => {
  assert.equal(webPushPermissionBlockReason('default'), '')
  assert.equal(webPushPermissionBlockReason('granted'), '')
  assert.match(webPushPermissionBlockReason('denied'), /未获允许/)
})

test('repair generation invalidates late registration results', async () => {
  const generation = createRegistrationGeneration()
  const captured = generation.current()
  let releaseLateResult
  let polluted = false
  const lateResult = new Promise((resolve) => {
    releaseLateResult = resolve
  }).then(() => {
    if (generation.isCurrent(captured)) polluted = true
  })

  generation.invalidate()
  releaseLateResult()
  await lateResult
  assert.equal(polluted, false)
})

test('PWA repair matches only the exact root scope and preserves sibling scopes', () => {
  assert.equal(isRootServiceWorkerScope('https://nav.example.test/', 'https://nav.example.test'), true)
  assert.equal(isRootServiceWorkerScope('https://nav.example.test/tools/', 'https://nav.example.test'), false)
  assert.equal(isRootServiceWorkerScope('https://other.example.test/', 'https://nav.example.test'), false)
  assert.equal(isRootServiceWorkerScope('not-a-url', 'https://nav.example.test'), false)
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
  const [apiSource, settingsSource, pwaSource, workerSource, nginxSource] = await Promise.all([
    fs.readFile(new URL('../../app/src/shared/services/webPushApi.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../app/src/modules/settings/components/WebPushSettings.vue', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../app/src/shared/services/pwa.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../app/public/sw.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../ovh/nginx.conf', import.meta.url), 'utf8')
  ])

  assert.match(apiSource, /runWebPushStage\('service-worker', inspectPwaRegistration, 8_000\)/)
  assert.match(apiSource, /runWebPushStage\([\s\S]*?'browser-subscription',[\s\S]*?getSubscription\(\),[\s\S]*?8_000/)
  assert.doesNotMatch(apiSource, /runWebPushStage\('service-worker', getPwaRegistration/)
  assert.doesNotMatch(apiSource, /Notification\.requestPermission/)
  assert.match(apiSource, /const pendingSubscription = startWebPushSubscription\(registration, publicKey\)/)
  assert.match(apiSource, /requiresUserGestureRetry: true/)
  assert.match(settingsSource, /function refreshInBackground\(\)[\s\S]*?void reload\(\)/)
  assert.doesNotMatch(settingsSource, /catch \(error\) \{\s*await reload\(\)/)
  assert.match(settingsSource, /if \(!deviceState\.value\.serviceWorkerReady\)/)
  assert.match(settingsSource, /await getPwaRegistration\(\)[\s\S]*?请再次点击/)
  assert.match(settingsSource, /const preparedRegistration = getActivePwaRegistration\(\)/)
  assert.match(settingsSource, /registration: preparedRegistration/)
  assert.match(settingsSource, /旧订阅密钥已移除。[\s\S]*?再次点击/)
  assert.match(settingsSource, /repairPwaRegistration/)
  assert.match(settingsSource, /修复本机通知环境/)
  assert.match(pwaSource, /let registrationPromise = null/)
  assert.match(pwaSource, /getRegistration\(currentClientUrl\(\)\)/)
  assert.match(pwaSource, /export function getActivePwaRegistration\(\)/)
  assert.doesNotMatch(pwaSource, /navigator\.serviceWorker\.ready/)
  assert.match(pwaSource, /读取本站 Service Worker 列表超时/)
  assert.match(pwaSource, /清理本站旧 Service Worker 超时/)
  assert.match(pwaSource, /registrationGeneration\.invalidate\(\)/)
  assert.match(pwaSource, /registrationPromise === pendingRegistration/)
  assert.match(pwaSource, /repairPromise === pendingRepair/)
  assert.match(pwaSource, /isRootServiceWorkerScope\(item\.scope, origin\)/)
  assert.match(pwaSource, /void activeRegistration\.update\(\)\.catch/)
  assert.match(workerSource, /Promise\.allSettled\([\s\S]*?SHELL_ASSETS\.map/)
  assert.match(workerSource, /SHELL_FETCH_TIMEOUT_MS = 4_000/)
  assert.match(workerSource, /Promise\.race\(/)
  assert.match(workerSource, /controller\.abort\(\)/)
  assert.doesNotMatch(workerSource, /fetch\('\/\.vite\/manifest\.json'/)
  assert.match(
    nginxSource,
    /location = \/manifest\.webmanifest \{[\s\S]*?default_type application\/manifest\+json;/
  )
  const registerFunction = pwaSource.match(
    /export async function registerPwa\(\) \{[\s\S]*?\n\}/
  )?.[0] || ''
  assert.doesNotMatch(registerFunction, /await registration\.update\(\)/)
})

test('Service Worker shell pre-cache releases install when an asset fetch never settles', async () => {
  const workerSource = await fs.readFile(
    new URL('../../app/public/sw.js', import.meta.url),
    'utf8'
  )
  const context = {
    AbortController,
    URL,
    Promise,
    Response,
    clearTimeout,
    setTimeout,
    caches: {
      async open() {
        return { put: async () => {} }
      },
      async keys() { return [] },
      async delete() { return true },
      async match() { return null }
    },
    fetch() {
      return new Promise(() => {})
    },
    indexedDB: { open() { throw new Error('not used') } },
    self: {
      addEventListener() {},
      clients: { claim: async () => {} },
      location: { origin: 'https://nav.example.test' },
      registration: { showNotification: async () => {} },
      skipWaiting: async () => {}
    }
  }
  vm.createContext(context)
  vm.runInContext(workerSource, context)

  const startedAt = Date.now()
  await context.cacheApplicationShell(5)
  assert.ok(Date.now() - startedAt < 200)
})

test('Service Worker activation resolves only after an active worker exists', async () => {
  const worker = new EventTarget()
  worker.state = 'installing'
  const registration = { active: null, installing: worker, waiting: null }
  const pending = waitForActiveRegistration(registration, 100)

  registration.active = { state: 'activated' }
  worker.state = 'activated'
  worker.dispatchEvent(new Event('statechange'))

  assert.equal(await pending, registration)
})

test('Service Worker activation rejects a redundant install without hanging', async () => {
  const worker = new EventTarget()
  worker.state = 'installing'
  const registration = { active: null, installing: worker, waiting: null }
  const pending = waitForActiveRegistration(registration, 100)

  worker.state = 'redundant'
  worker.dispatchEvent(new Event('statechange'))

  await assert.rejects(pending, (error) => (
    error.pwaStage === 'activation' && /安装已失效/.test(error.message)
  ))
})

test('a waiting first-install Service Worker is asked to activate', async () => {
  const worker = new EventTarget()
  worker.state = 'installed'
  const messages = []
  worker.postMessage = (payload) => messages.push(payload)
  const registration = { active: null, installing: null, waiting: worker }
  const pending = waitForActiveRegistration(registration, 100)

  assert.deepEqual(messages, [{ type: 'SKIP_WAITING' }])
  registration.active = { state: 'activated' }
  worker.state = 'activated'
  worker.dispatchEvent(new Event('statechange'))
  assert.equal(await pending, registration)
})

test('an installing Service Worker is asked to activate when it transitions to waiting', async () => {
  const worker = new EventTarget()
  worker.state = 'installing'
  const messages = []
  worker.postMessage = (payload) => messages.push(payload)
  const registration = { active: null, installing: worker, waiting: null }
  const pending = waitForActiveRegistration(registration, 100)

  assert.deepEqual(messages, [])
  registration.installing = null
  registration.waiting = worker
  worker.state = 'installed'
  worker.dispatchEvent(new Event('statechange'))
  assert.deepEqual(messages, [{ type: 'SKIP_WAITING' }])

  registration.active = { state: 'activated' }
  registration.waiting = null
  worker.state = 'activated'
  worker.dispatchEvent(new Event('statechange'))
  assert.equal(await pending, registration)
})

test('Mail configuration uses native form submission for reliable iPhone touch handling', async () => {
  const source = await fs.readFile(
    new URL('../../app/src/modules/settings/components/SystemIntegrationsSettings.vue', import.meta.url),
    'utf8'
  )

  assert.match(source, /@submit\.prevent\.stop="saveMail"/)
  assert.match(source, /class="button button--primary"\s+type="submit"/)
  assert.match(source, /配置 \{\{ writable \? '可保存' : '只读' \}\}/)
  assert.match(source, /配置已保存，可测试/)
  assert.match(source, /必须填写，例如当前 NAV 用户名/)
  assert.match(source, /保存时将 SMTP 密码复制给 IMAP/)
  assert.match(source, /touch-action: manipulation/)
})
