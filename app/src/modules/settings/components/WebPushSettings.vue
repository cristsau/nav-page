<script setup>
import { computed, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  currentWebPushSubscriptionId,
  disableWebPushSubscription,
  enableWebPush,
  fetchWebPushStatus,
  inspectCurrentWebPushDevice,
  sendWebPushTest,
  webPushBrowserCapability
} from '@/shared/services/webPushApi'
import {
  getActivePwaRegistration,
  getPwaRegistration,
  repairPwaRegistration
} from '@/shared/services/pwa'
import {
  currentActiveWebPushSubscription,
  webPushEnableLabel,
  webPushFailureMessage,
  webPushTestDisabledReason
} from '@/shared/services/webPushState'

const status = ref(null)
const busy = ref(false)
const message = ref({ text: '', type: '' })
const lastFailureStage = ref('')
const capability = ref(webPushBrowserCapability())
const currentSubscriptionId = ref(currentWebPushSubscriptionId())
const deviceState = ref({
  serviceWorkerReady: false,
  browserSubscribed: false,
  applicationServerKeyMatches: null,
  providerHost: ''
})

const activeSubscriptions = computed(() => (
  status.value?.subscriptions?.filter((item) => item.active) || []
))
const currentSubscription = computed(() => currentActiveWebPushSubscription(
  activeSubscriptions.value,
  currentSubscriptionId.value
))
const enableLabel = computed(() => (
  deviceState.value.serviceWorkerReady
    ? webPushEnableLabel({
      permission: capability.value.permission,
      currentSubscription: currentSubscription.value,
      keyMatches: deviceState.value.applicationServerKeyMatches
    })
    : '准备通知环境'
))
const testDisabledReason = computed(() => webPushTestDisabledReason({
  busy: busy.value,
  configured: status.value?.configured === true,
  supported: capability.value.supported,
  permission: capability.value.permission,
  serviceWorkerReady: deviceState.value.serviceWorkerReady,
  browserSubscribed: deviceState.value.browserSubscribed,
  keyMatches: deviceState.value.applicationServerKeyMatches,
  subscriptionId: currentSubscriptionId.value,
  currentSubscription: currentSubscription.value
}))

function setMessage(text, type = 'success') {
  message.value = { text, type }
}

function defaultDeviceLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '当前设备'
  return `${platform} · ${new Date().toLocaleDateString('zh-CN')}`.slice(0, 80)
}

async function reload() {
  const nextStatus = await fetchWebPushStatus()
  status.value = nextStatus
  capability.value = webPushBrowserCapability()
  currentSubscriptionId.value = currentWebPushSubscriptionId()
  deviceState.value = await inspectCurrentWebPushDevice({
    publicKey: nextStatus.publicKey || ''
  })
  capability.value = {
    supported: deviceState.value.supported,
    permission: deviceState.value.permission
  }
}

function refreshInBackground() {
  void reload().catch(() => {
    capability.value = webPushBrowserCapability()
  })
}

async function enable() {
  if (busy.value || !status.value?.publicKey) return
  busy.value = true
  lastFailureStage.value = ''
  if (!deviceState.value.serviceWorkerReady) {
    setMessage('正在准备本机通知环境…', 'progress')
    try {
      await getPwaRegistration()
      await reload()
      if (!deviceState.value.serviceWorkerReady) {
        const preparationError = new Error('Service Worker 尚未进入活动状态')
        preparationError.webPushStage = 'service-worker'
        throw preparationError
      }
      setMessage('通知环境已准备。请再次点击“启用当前设备”以允许通知并建立订阅。', 'success')
    } catch (error) {
      lastFailureStage.value = 'service-worker'
      setMessage(webPushFailureMessage(error, { stage: 'service-worker' }), 'error')
    } finally {
      busy.value = false
    }
    return
  }

  const preparedRegistration = getActivePwaRegistration()
  if (!preparedRegistration) {
    deviceState.value = { ...deviceState.value, serviceWorkerReady: false }
    setMessage('通知环境状态已变化，请先重新准备。', 'error')
    busy.value = false
    return
  }

  setMessage('正在建立浏览器订阅、服务器登记与测试投递…', 'progress')
  try {
    const result = await enableWebPush({
      publicKey: status.value.publicKey,
      deviceLabel: defaultDeviceLabel(),
      registration: preparedRegistration
    })
    if (result.requiresUserGestureRetry) {
      await reload()
      setMessage('旧订阅密钥已移除。请再次点击“启用当前设备”建立新订阅。', 'success')
      return
    }
    const enabledSubscriptionId = result.subscription?.id || currentWebPushSubscriptionId()
    if (!enabledSubscriptionId) {
      const registrationError = new Error('服务器没有返回当前设备订阅 ID')
      registrationError.webPushStage = 'server-registration'
      throw registrationError
    }
    currentSubscriptionId.value = enabledSubscriptionId
    await reload()
    try {
      await sendWebPushTest(enabledSubscriptionId)
    } catch (error) {
      setMessage(webPushFailureMessage(error, { stage: 'test-delivery' }), 'error')
      refreshInBackground()
      return
    }
    await reload()
    setMessage('当前设备已启用，测试通知已发送。收到后即可关闭网页继续接收到期提醒。')
  } catch (error) {
    lastFailureStage.value = error?.webPushStage || ''
    setMessage(webPushFailureMessage(error), 'error')
    if (lastFailureStage.value !== 'service-worker') refreshInBackground()
  } finally {
    busy.value = false
  }
}

async function repairServiceWorker() {
  if (busy.value) return
  busy.value = true
  try {
    await repairPwaRegistration()
    setMessage('本机旧通知环境已清理，正在重新载入 DOMO NAV…', 'progress')
    window.setTimeout(() => window.location.reload(), 250)
  } catch (error) {
    setMessage(`修复本机通知环境失败：${error.message || '请稍后重试'}`, 'error')
  } finally {
    busy.value = false
  }
}

async function remove(subscription) {
  if (busy.value) return
  busy.value = true
  try {
    await disableWebPushSubscription(subscription.id)
    await reload()
    setMessage('该设备的后台通知已关闭。')
  } catch (error) {
    setMessage(error.message || '关闭通知失败', 'error')
  } finally {
    busy.value = false
  }
}

async function test() {
  if (busy.value) return
  const subscriptionId = currentSubscription.value?.id || ''
  if (!subscriptionId) {
    setMessage(testDisabledReason.value || '请先完成当前设备登记', 'error')
    return
  }
  busy.value = true
  try {
    await sendWebPushTest(subscriptionId)
    await reload()
    setMessage('测试通知已发送，请查看系统通知中心。')
  } catch (error) {
    setMessage(webPushFailureMessage(error, { stage: 'test-delivery' }), 'error')
    refreshInBackground()
  } finally {
    busy.value = false
  }
}

onMounted(() => reload().catch((error) => setMessage(error.message, 'error')))
</script>

<template>
  <section class="push-settings" aria-labelledby="web-push-title">
    <header>
      <div>
        <h3 id="web-push-title">后台到期提醒</h3>
        <p>使用浏览器标准 Web Push；网页关闭后仍可送达。加密笔记只显示通用提示，不在通知中暴露标题或正文。</p>
        <p>iPhone / iPad 需先“添加到主屏幕”，再从主屏幕打开 DOMO NAV 并启用通知。</p>
      </div>
      <Icon name="bell" :size="22" />
    </header>

    <div v-if="status" class="push-settings__state">
      <div class="push-settings__summary">
        <span :class="{ 'is-ready': status.configured && capability.supported }">
          {{ !status.configured ? '服务器未配置' : !capability.supported ? '当前浏览器不支持' : `通知权限：${capability.permission}` }}
        </span>
        <div class="push-settings__steps" role="list" aria-label="当前设备通知启用进度">
          <span role="listitem" :class="{ 'is-ready': capability.permission === 'granted' }">1 系统权限</span>
          <span role="listitem" :class="{ 'is-ready': deviceState.browserSubscribed }">2 浏览器订阅</span>
          <span role="listitem" :class="{ 'is-ready': currentSubscription }">3 服务器登记</span>
        </div>
        <small v-if="deviceState.providerHost">Push 服务：{{ deviceState.providerHost }}</small>
      </div>
      <div class="push-settings__actions">
        <button
          type="button"
          :disabled="busy || !status.configured || !capability.supported"
          @click="enable"
        >
          <Icon name="bell" :size="16" />
          {{ enableLabel }}
        </button>
        <button
          v-if="lastFailureStage === 'service-worker'"
          type="button"
          :disabled="busy"
          @click="repairServiceWorker"
        >
          <Icon name="refresh" :size="16" />
          修复本机通知环境
        </button>
        <button
          type="button"
          :disabled="Boolean(testDisabledReason)"
          :title="testDisabledReason || '向当前设备发送测试通知'"
          @click="test"
        >
          <Icon name="check" :size="16" />
          发送测试通知
        </button>
      </div>
    </div>

    <p v-if="message.text" class="push-settings__message" :class="`is-${message.type}`" role="status" aria-live="polite">{{ message.text }}</p>

    <ul v-if="activeSubscriptions.length" class="push-settings__devices" aria-label="已启用通知的设备">
      <li v-for="subscription in activeSubscriptions" :key="subscription.id">
        <span>
          <strong>
            {{ subscription.deviceLabel || '未命名设备' }}
            <em v-if="subscription.id === currentSubscriptionId">当前设备</em>
          </strong>
          <small>最近成功：{{ subscription.lastSuccessAt ? new Date(subscription.lastSuccessAt).toLocaleString('zh-CN') : '尚未测试' }}</small>
        </span>
        <button type="button" :disabled="busy" @click="remove(subscription)">
          <Icon name="trash" :size="16" />
          移除
        </button>
      </li>
    </ul>
    <p v-else-if="status" class="push-settings__empty">还没有启用后台通知的设备。</p>
  </section>
</template>

<style scoped>
.push-settings { padding: 20px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 18px; }
.push-settings header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.push-settings h3 { margin: 0; color: var(--text-primary); font-size: 1rem; }
.push-settings header p { max-width: 720px; margin: 6px 0 0; color: var(--text-muted); font-size: .78rem; line-height: 1.65; }
.push-settings header > svg { color: var(--accent-color); }
.push-settings__state { display: flex; margin-top: 16px; padding: 14px; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; }
.push-settings__summary { display: grid; min-width: 0; gap: 8px; }
.push-settings__summary > span { color: var(--text-muted); font-size: .78rem; }
.push-settings__summary > span.is-ready { color: var(--success-color); }
.push-settings__summary > small { color: var(--text-muted); font-size: .68rem; overflow-wrap: anywhere; }
.push-settings__steps { display: flex; flex-wrap: wrap; gap: 6px; }
.push-settings__steps span { padding: 5px 8px; color: var(--text-muted); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 999px; font-size: .68rem; }
.push-settings__steps span.is-ready { color: var(--success-color); border-color: color-mix(in srgb, var(--success-color) 55%, var(--border-light)); }
.push-settings__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.push-settings button { display: inline-flex; min-height: 44px; padding: 0 13px; align-items: center; justify-content: center; gap: 7px; color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.push-settings button:disabled { opacity: .5; cursor: not-allowed; }
.push-settings__devices { display: grid; gap: 8px; margin: 14px 0 0; padding: 0; list-style: none; }
.push-settings__devices li { display: flex; min-height: 62px; padding: 9px 10px 9px 14px; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 13px; }
.push-settings__devices span { display: grid; min-width: 0; gap: 4px; }
.push-settings__devices strong { overflow: hidden; color: var(--text-primary); font-size: .82rem; text-overflow: ellipsis; white-space: nowrap; }
.push-settings__devices strong em { margin-left: 7px; padding: 2px 6px; color: var(--accent-color); background: var(--accent-bg); border-radius: 999px; font-size: .62rem; font-style: normal; font-weight: 650; }
.push-settings__devices small,
.push-settings__empty { color: var(--text-muted); font-size: .72rem; }
.push-settings__empty { margin: 14px 0 0; }
.push-settings__message { margin: 12px 0 0; color: var(--success-color); font-size: .76rem; }
.push-settings__message.is-error { color: var(--error-color); }
.push-settings__message.is-progress { color: var(--info-color); }
@media (max-width: 720px) {
  .push-settings__state,
  .push-settings__devices li { align-items: stretch; flex-direction: column; }
  .push-settings__actions,
  .push-settings__actions button,
  .push-settings__devices button { width: 100%; }
}
</style>
