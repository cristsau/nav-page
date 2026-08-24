<script setup>
import { computed, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  currentWebPushSubscriptionId,
  disableWebPushSubscription,
  enableWebPush,
  fetchWebPushStatus,
  sendWebPushTest,
  webPushBrowserCapability
} from '@/shared/services/webPushApi'

const status = ref(null)
const busy = ref(false)
const message = ref({ text: '', type: '' })
const capability = ref(webPushBrowserCapability())

const activeSubscriptions = computed(() => (
  status.value?.subscriptions?.filter((item) => item.active) || []
))

function setMessage(text, type = 'success') {
  message.value = { text, type }
}

function defaultDeviceLabel() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '当前设备'
  return `${platform} · ${new Date().toLocaleDateString('zh-CN')}`.slice(0, 80)
}

async function reload() {
  status.value = await fetchWebPushStatus()
  capability.value = webPushBrowserCapability()
}

async function enable() {
  if (busy.value || !status.value?.publicKey) return
  busy.value = true
  try {
    await enableWebPush({
      publicKey: status.value.publicKey,
      deviceLabel: defaultDeviceLabel()
    })
    await reload()
    setMessage('当前设备已启用后台提醒。关闭网页后也能收到通知。')
  } catch (error) {
    setMessage(error.message || '后台通知启用失败', 'error')
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
  busy.value = true
  try {
    await sendWebPushTest(currentWebPushSubscriptionId())
    setMessage('测试通知已发送，请查看系统通知中心。')
  } catch (error) {
    setMessage(error.message || '测试通知发送失败', 'error')
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
      <span :class="{ 'is-ready': status.configured && capability.supported }">
        {{ !status.configured ? '服务器未配置' : !capability.supported ? '当前浏览器不支持' : `通知权限：${capability.permission}` }}
      </span>
      <div class="push-settings__actions">
        <button
          type="button"
          :disabled="busy || !status.configured || !capability.supported"
          @click="enable"
        >
          <Icon name="bell" :size="16" />
          启用当前设备
        </button>
        <button type="button" :disabled="busy || !activeSubscriptions.length" @click="test">
          <Icon name="check" :size="16" />
          发送测试通知
        </button>
      </div>
    </div>

    <ul v-if="activeSubscriptions.length" class="push-settings__devices" aria-label="已启用通知的设备">
      <li v-for="subscription in activeSubscriptions" :key="subscription.id">
        <span>
          <strong>{{ subscription.deviceLabel || '未命名设备' }}</strong>
          <small>最近成功：{{ subscription.lastSuccessAt ? new Date(subscription.lastSuccessAt).toLocaleString('zh-CN') : '尚未测试' }}</small>
        </span>
        <button type="button" :disabled="busy" @click="remove(subscription)">
          <Icon name="trash" :size="16" />
          移除
        </button>
      </li>
    </ul>
    <p v-else-if="status" class="push-settings__empty">还没有启用后台通知的设备。</p>
    <p v-if="message.text" class="push-settings__message" :class="`is-${message.type}`" role="status">{{ message.text }}</p>
  </section>
</template>

<style scoped>
.push-settings { padding: 20px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 18px; }
.push-settings header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.push-settings h3 { margin: 0; color: var(--text-primary); font-size: 1rem; }
.push-settings header p { max-width: 720px; margin: 6px 0 0; color: var(--text-muted); font-size: .78rem; line-height: 1.65; }
.push-settings header > svg { color: var(--accent-color); }
.push-settings__state { display: flex; margin-top: 16px; padding: 14px; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; }
.push-settings__state > span { color: var(--text-muted); font-size: .78rem; }
.push-settings__state > span.is-ready { color: var(--success-color); }
.push-settings__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.push-settings button { display: inline-flex; min-height: 44px; padding: 0 13px; align-items: center; justify-content: center; gap: 7px; color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; cursor: pointer; }
.push-settings button:disabled { opacity: .5; cursor: not-allowed; }
.push-settings__devices { display: grid; gap: 8px; margin: 14px 0 0; padding: 0; list-style: none; }
.push-settings__devices li { display: flex; min-height: 62px; padding: 9px 10px 9px 14px; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 13px; }
.push-settings__devices span { display: grid; min-width: 0; gap: 4px; }
.push-settings__devices strong { overflow: hidden; color: var(--text-primary); font-size: .82rem; text-overflow: ellipsis; white-space: nowrap; }
.push-settings__devices small,
.push-settings__empty { color: var(--text-muted); font-size: .72rem; }
.push-settings__empty { margin: 14px 0 0; }
.push-settings__message { margin: 12px 0 0; color: var(--success-color); font-size: .76rem; }
.push-settings__message.is-error { color: var(--error-color); }
@media (max-width: 720px) {
  .push-settings__state,
  .push-settings__devices li { align-items: stretch; flex-direction: column; }
  .push-settings__actions,
  .push-settings__actions button,
  .push-settings__devices button { width: 100%; }
}
</style>
