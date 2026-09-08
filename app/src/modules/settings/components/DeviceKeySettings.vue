<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { useAuth } from '@/shared/composables/useAuth'
import { fetchDeviceKeyConfig, fetchDeviceKeys, browserSupportsDeviceKeys, enrollDeviceKey, removeDeviceKey, deviceKeyMessage } from '@/shared/services/deviceKeyApi'
const { forgetSession } = useAuth()
const enabled = ref(false), supported = ref(false), keys = ref([]), busy = ref(false)
const name = ref('我的设备'), password = ref(''), error = ref(''), message = ref(''), form = ref(false), removeId = ref('')
const formatDate = value => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value)) : '尚未使用'
async function refresh() { keys.value = (await fetchDeviceKeys()).keys }
onMounted(async () => {
  try {
    const config = await fetchDeviceKeyConfig()
    enabled.value = config.enabled
    supported.value = await browserSupportsDeviceKeys()
    if (enabled.value) await refresh()
  } catch { enabled.value = false }
})
onBeforeUnmount(() => { password.value = '' })
function openRegister() { form.value = true; removeId.value = ''; password.value = ''; error.value = ''; message.value = '' }
function openRemove(id) { form.value = true; removeId.value = id; password.value = ''; error.value = ''; message.value = '' }
function cancel() { if (!busy.value) { form.value = false; removeId.value = ''; password.value = ''; error.value = '' } }
async function submit() {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    if (removeId.value) {
      const result = await removeDeviceKey(removeId.value, password.value)
      if (result.currentSessionRevoked) { forgetSession(); window.location.assign('/auth'); return }
      message.value = '已移除此通行密钥，由它建立的登录会话也已撤销。'
    } else {
      await enrollDeviceKey({ name: name.value, currentPassword: password.value })
      message.value = '快捷登录已添加。下次需要登录时，可以使用设备验证。'
    }
    password.value = ''; form.value = false; removeId.value = ''
    await refresh()
  } catch (e) { error.value = deviceKeyMessage(e) }
  finally { password.value = ''; busy.value = false }
}
</script>

<template>
  <section v-if="enabled" class="device-key-settings" aria-labelledby="device-key-title">
    <header class="device-key-heading"><span class="device-key-symbol"><Icon name="scan-face" :size="23" /></span><div><h3 id="device-key-title">快捷登录</h3><p>Face ID、Touch ID 或设备密码 · 自愿开启</p></div></header>
    <p class="device-key-explanation">通行密钥由系统或密码管理器保存，DOMO NAV 不接收人脸数据。请保留账号密码及可用的恢复方式。</p>
    <ul v-if="keys.length" class="device-key-list">
      <li v-for="key in keys" :key="key.id"><Icon name="key" :size="19" /><div><strong>{{key.name}}</strong><small>{{key.synced ? '可同步的通行密钥' : '设备通行密钥'}} · 最近使用 {{formatDate(key.lastUsedAt)}}</small></div><button type="button" :disabled="busy" :aria-label="`移除 ${key.name}`" @click="openRemove(key.id)">移除</button></li>
    </ul>
    <form v-if="form" class="device-key-form" @submit.prevent="submit">
      <p v-if="removeId">移除此密钥后，它建立的登录会话将退出。密码和邮箱登录不受影响。</p>
      <label v-else>设备名称<input v-model="name" required maxlength="80" autocomplete="off" /></label>
      <label>验证当前账号密码<input v-model="password" required type="password" autocomplete="current-password" maxlength="2048" /></label>
      <div class="device-key-actions"><button class="device-key-primary" type="submit" :disabled="busy">{{busy ? '等待验证…' : removeId ? '验证并移除' : '验证并添加'}}</button><button type="button" :disabled="busy" @click="cancel">取消</button></div>
    </form>
    <button v-else-if="supported" type="button" class="device-key-add" @click="openRegister"><Icon name="plus" :size="19" />添加通行密钥<Icon name="chevron-right" :size="16" /></button>
    <p v-else class="device-key-explanation">当前浏览器未检测到可用的设备验证，请在支持的 iPhone Safari 或桌面网页版中设置。</p>
    <p v-if="message" role="status" class="device-key-message">{{message}}</p><p v-if="error" role="alert" class="device-key-error">{{error}}</p>
  </section>
</template>

<style scoped>
.device-key-settings{border:1px solid var(--border-light);border-radius:22px;background:var(--bg-card);padding:22px;margin-block:20px;color:var(--text-primary)}
.device-key-heading{display:flex;align-items:center;gap:13px}.device-key-symbol{display:grid;place-items:center;width:44px;height:44px;flex-shrink:0;border-radius:13px;background:var(--accent-bg);color:var(--accent-color)}
h3{font-size:18px;letter-spacing:-.02em;margin:0}.device-key-heading p,.device-key-explanation{font-size:13px;color:var(--text-secondary);line-height:1.6;margin:4px 0 0}.device-key-explanation{margin:16px 0}
.device-key-list{list-style:none;margin:20px 0 0;padding:0}.device-key-list li{display:flex;align-items:center;gap:12px;min-height:66px;border-top:1px solid var(--border-light)}.device-key-list li>div{flex:1;min-width:0}.device-key-list strong{display:block;overflow-wrap:anywhere;font-size:15px}.device-key-list small{display:block;font-size:12px;line-height:1.5;color:var(--text-secondary)}
button{font:inherit;font-size:14px;min-height:44px;border:0;background:transparent;color:var(--accent-color);cursor:pointer;padding:8px 12px;border-radius:10px}button:disabled{opacity:.6;cursor:wait}button:focus-visible,input:focus-visible{outline:3px solid var(--accent-color);outline-offset:3px}
.device-key-add{display:flex;gap:10px;align-items:center;width:100%;padding:10px 0;text-align:left;border-top:1px solid var(--border-light);margin-top:14px}.device-key-add :last-child{margin-left:auto}
.device-key-form{display:grid;gap:16px;margin-top:20px}.device-key-form label{display:grid;gap:8px;font-size:14px}.device-key-form input{font:inherit;font-size:16px;min-height:48px;padding:12px;border:1px solid var(--border-color);border-radius:12px;background:var(--bg-secondary);color:var(--text-primary)}
.device-key-actions{display:flex;gap:10px}.device-key-primary{background:var(--text-primary);color:var(--bg-card);padding-inline:18px}.device-key-message,.device-key-error{font-size:14px;line-height:1.6}.device-key-error{color:var(--text-primary);border-left:3px solid var(--error-color);padding-left:10px}
button{color:var(--text-primary)}
</style>
