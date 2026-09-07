<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { apiRequest } from '@/shared/services/apiClient'
import Icon from '@/shared/components/Icon.vue'

const props = defineProps({ state: { type: Object, default: () => ({}) }, writable: Boolean })
const emit = defineEmits(['saved'])
const form = reactive({
  smtpHost: '', smtpUsername: '', smtpPassword: '', smtpFromAddress: '',
  smtpFromName: 'DOMO NAV', adminRecipientsText: '', deliveryEnabled: false, registrationEnabled: false
})
const busy = ref('')
const error = ref('')
const message = ref('')
const savedFingerprint = ref('')
const verified = ref(false)
const fingerprint = () => JSON.stringify([form.smtpHost, form.smtpUsername, form.smtpFromAddress, form.smtpPassword])
const dirty = computed(() => fingerprint() !== savedFingerprint.value)
const passwordConfigured = computed(() => props.state.secrets?.smtpPasswordConfigured === true)
const canTest = computed(() => props.writable && !busy.value && !dirty.value && form.smtpHost && form.smtpUsername && form.smtpFromAddress && passwordConfigured.value)

watch(() => props.state, (state) => {
  Object.assign(form, state.config || {}, {
    smtpPassword: '', adminRecipientsText: (state.config?.adminRecipients || []).join(', ')
  })
  verified.value = state.verification?.smtpVerified === true
  savedFingerprint.value = fingerprint()
}, { immediate: true })

watch(fingerprint, (value) => {
  if (!savedFingerprint.value || value === savedFingerprint.value) return
  verified.value = false
  form.deliveryEnabled = false
  form.registrationEnabled = false
})

async function run(action, operation) {
  if (busy.value) return
  busy.value = action
  error.value = ''
  message.value = ''
  try {
    await operation()
    message.value = action === 'save' ? '系统通知配置已保存。' : 'SMTP 验证成功，可启用系统通知。'
    emit('saved')
  } catch (caught) {
    error.value = caught.message || '操作失败，请稍后重试。'
  } finally {
    busy.value = ''
  }
}

function save() {
  return run('save', () => apiRequest('/admin/integrations/system-mail', {
    method: 'PUT',
    body: JSON.stringify({
      smtpHost: form.smtpHost, smtpPort: 465, smtpUsername: form.smtpUsername,
      smtpFromAddress: form.smtpFromAddress, smtpFromName: form.smtpFromName,
      adminRecipients: form.adminRecipientsText.split(',').map((value) => value.trim()).filter(Boolean),
      deliveryEnabled: form.deliveryEnabled, registrationEnabled: form.registrationEnabled,
      ...(form.smtpPassword ? { smtpPassword: form.smtpPassword } : {})
    })
  }))
}
function testSmtp() {
  return run('test', () => apiRequest('/admin/integrations/system-mail/test-smtp', { method: 'POST' }))
}
</script>

<template>
  <form class="system-mail" @submit.prevent="save">
    <header><Icon name="bell" :size="22" /><div><h4>系统通知</h4><p>用于注册邮箱验证、审批结果和运维告警。</p></div></header>
    <fieldset :disabled="!writable || Boolean(busy)">
      <legend>SMTP 发送设置</legend>
      <div class="system-mail__fields">
        <label>SMTP 主机<input v-model.trim="form.smtpHost" type="text" autocomplete="off" placeholder="smtp.example.com"></label>
        <label>端口<input value="465 · TLS" readonly></label>
        <label>登录邮箱<input v-model.trim="form.smtpUsername" type="email" autocomplete="off"></label>
        <label>SMTP 密码<input v-model="form.smtpPassword" type="password" autocomplete="new-password" :placeholder="passwordConfigured ? '已安全保存，留空保持不变' : '输入邮箱密码或应用专用密码'"></label>
        <label>发件地址<input v-model.trim="form.smtpFromAddress" type="email"></label>
        <label>发件人名称<input v-model.trim="form.smtpFromName" type="text"></label>
      </div>
      <label>管理员通知邮箱（逗号分隔）<input v-model="form.adminRecipientsText" type="text"></label>
      <p>{{ dirty ? '请先保存连接配置，再测试 SMTP。' : verified ? 'SMTP 已验证' : 'SMTP 待验证' }}</p>
      <button type="button" :disabled="!canTest" @click="testSmtp">{{ busy === 'test' ? '验证中…' : '测试 SMTP' }}</button>
      <label class="system-mail__toggle"><input v-model="form.deliveryEnabled" type="checkbox" :disabled="!verified">启用系统通知发送</label>
      <label class="system-mail__toggle"><input v-model="form.registrationEnabled" type="checkbox" :disabled="!form.deliveryEnabled">启用注册邮箱验证与审批通知</label>
      <button type="submit">{{ busy === 'save' ? '保存中…' : '保存系统通知配置' }}</button>
    </fieldset>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" class="system-mail__error" role="alert">{{ error }}</p>
  </form>
</template>

<style scoped>
.system-mail { display: grid; gap: 16px; padding: 24px; border: 1px solid var(--border-color); border-radius: var(--radius-xl); background: var(--bg-card); }
.system-mail header { display: flex; gap: 14px; align-items: flex-start; }
.system-mail h4, .system-mail p { margin: 0; }
.system-mail p { color: var(--text-secondary); line-height: 1.7; font-size: .85rem; }
.system-mail fieldset { display: grid; gap: 16px; min-width: 0; padding: 18px; border: 1px solid var(--border-color); border-radius: 16px; }
.system-mail__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.system-mail label { display: grid; gap: 8px; min-width: 0; color: var(--text-primary); font-size: .85rem; }
.system-mail input:not([type="checkbox"]) { width: 100%; min-height: 44px; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--bg-secondary); color: var(--text-primary); }
.system-mail .system-mail__toggle { display: flex; align-items: center; min-height: 44px; }
.system-mail button { min-height: 44px; padding: 12px 18px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--accent-bg); color: var(--accent-color); cursor: pointer; }
.system-mail button:disabled { cursor: default; opacity: .55; }
.system-mail .system-mail__error { color: var(--danger-color, #b42318); }
@media (max-width: 600px) { .system-mail { padding: 16px; } .system-mail__fields { grid-template-columns: 1fr; } }
</style>
