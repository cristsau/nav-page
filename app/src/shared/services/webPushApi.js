import { apiRequest } from './apiClient'
import { getPwaRegistration } from './pwa'
import { runWebPushStage } from './webPushTiming'

const LOCAL_SUBSCRIPTION_ID_KEY = 'domo-nav-web-push-subscription-id'

function stagedWebPushError(error, stage) {
  const wrapped = new Error(error?.message || 'Web Push operation failed')
  wrapped.name = error?.name || 'Error'
  wrapped.status = Number(error?.status || 0)
  wrapped.code = String(error?.code || '')
  wrapped.webPushStage = stage
  wrapped.cause = error
  return wrapped
}

function applicationServerKey(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = `${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)))
}

function equalApplicationServerKey(subscription, publicKey) {
  const existing = subscription?.options?.applicationServerKey
  if (!existing) return false
  const left = new Uint8Array(existing)
  const right = applicationServerKey(publicKey)
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function webPushBrowserCapability() {
  return {
    supported: Boolean(
      globalThis.isSecureContext
      && typeof navigator !== 'undefined'
      && 'serviceWorker' in navigator
      && 'PushManager' in window
      && 'Notification' in window
    ),
    permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  }
}

export function fetchWebPushStatus() {
  return apiRequest('/web-push/status')
}

export async function inspectCurrentWebPushDevice({ publicKey = '' } = {}) {
  const capability = webPushBrowserCapability()
  const result = {
    ...capability,
    serviceWorkerReady: false,
    browserSubscribed: false,
    applicationServerKeyMatches: null,
    providerHost: '',
    localSubscriptionId: currentWebPushSubscriptionId(),
    errorStage: ''
  }
  if (!capability.supported) return result

  let registration
  try {
    registration = await getPwaRegistration()
  } catch {
    result.errorStage = 'service-worker'
    return result
  }
  if (!registration) {
    result.errorStage = 'service-worker'
    return result
  }
  result.serviceWorkerReady = true

  let subscription
  try {
    subscription = await registration.pushManager.getSubscription()
  } catch {
    result.errorStage = 'browser-subscription'
    return result
  }
  if (!subscription) return result

  result.browserSubscribed = true
  if (publicKey) {
    result.applicationServerKeyMatches = equalApplicationServerKey(subscription, publicKey)
  }
  try {
    result.providerHost = new URL(subscription.endpoint).hostname
  } catch {
    result.providerHost = ''
  }
  return result
}

export async function enableWebPush({ publicKey, deviceLabel }) {
  if (!webPushBrowserCapability().supported) {
    throw new Error('当前浏览器或安装方式不支持后台通知')
  }
  const permission = await runWebPushStage(
    'permission',
    () => Notification.requestPermission()
  )
  if (permission !== 'granted') {
    throw stagedWebPushError(new Error('通知权限未获允许'), 'permission')
  }
  const registration = await runWebPushStage('service-worker', getPwaRegistration)
  if (!registration) throw stagedWebPushError(new Error('Service Worker 尚未就绪'), 'service-worker')
  let subscription = await runWebPushStage(
    'browser-subscription',
    () => registration.pushManager.getSubscription()
  )
  if (subscription && !equalApplicationServerKey(subscription, publicKey)) {
    await runWebPushStage('browser-subscription', () => subscription.unsubscribe())
    subscription = null
  }
  if (!subscription) {
    subscription = await runWebPushStage(
      'browser-subscription',
      () => registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey)
      })
    )
  }
  const result = await runWebPushStage(
    'server-registration',
    () => apiRequest('/web-push/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        deviceLabel
      })
    })
  )
  if (result.subscription?.id) {
    localStorage.setItem(LOCAL_SUBSCRIPTION_ID_KEY, result.subscription.id)
  }
  return result
}

export async function disableWebPushSubscription(subscriptionId, { unsubscribeLocal = false } = {}) {
  await apiRequest(`/web-push/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE'
  })
  if (unsubscribeLocal || localStorage.getItem(LOCAL_SUBSCRIPTION_ID_KEY) === subscriptionId) {
    const registration = await getPwaRegistration()
    const subscription = await registration?.pushManager?.getSubscription?.()
    await subscription?.unsubscribe?.()
    localStorage.removeItem(LOCAL_SUBSCRIPTION_ID_KEY)
  }
}

export function currentWebPushSubscriptionId() {
  return localStorage.getItem(LOCAL_SUBSCRIPTION_ID_KEY) || ''
}

export function sendWebPushTest(subscriptionId = currentWebPushSubscriptionId()) {
  return apiRequest('/web-push/test', {
    method: 'POST',
    body: JSON.stringify({ subscriptionId: subscriptionId || null })
  })
}
