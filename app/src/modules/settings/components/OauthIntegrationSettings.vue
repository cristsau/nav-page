<script setup>
import { onMounted, reactive, ref } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  fetchOauthIntegrationState,
  saveEmailOauthIntegration,
  saveIdentityOauthIntegration,
  testEmailOauthIntegration,
  testIdentityOauthIntegration
} from '@/shared/services/oauthApi'

const loading = ref(true)
const busy = ref('')
const writable = ref(false)
const callbacks = ref({ google: [], wechat: [] })
const message = ref('')
const error = ref('')
const identity = reactive({
  allowVerifiedEmailAutoLink: false,
  google: { enabled: false, clientId: '', clientSecret: '', secretConfigured: false },
  wechat: { enabled: false, clientId: '', clientSecret: '', secretConfigured: false }
})
const emailOauth = reactive({
  selectedProvider: '',
  google: { enabled: false, clientId: '', clientSecret: '', refreshToken: '', scope: 'https://mail.google.com/', clientSecretConfigured: false, refreshTokenConfigured: false },
  microsoft: { enabled: false, clientId: '', clientSecret: '', refreshToken: '', tenant: 'common', scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access', clientSecretConfigured: false, refreshTokenConfigured: false }
})

function applyState(state) {
  writable.value = state.writable === true
  callbacks.value = state.callbacks || { google: [], wechat: [] }
  Object.assign(identity, state.identity || {})
  Object.assign(identity.google, state.identity?.google || {}, { clientSecret: '' })
  Object.assign(identity.wechat, state.identity?.wechat || {}, { clientSecret: '' })
  Object.assign(emailOauth, { selectedProvider: state.emailOAuth?.selectedProvider || '' })
  for (const provider of ['google', 'microsoft']) {
    Object.assign(emailOauth[provider], state.emailOAuth?.[provider] || {}, {
      clientSecret: '',
      refreshToken: ''
    })
  }
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    applyState(await fetchOauthIntegrationState())
  } catch (caught) {
    error.value = caught.message || 'OAuth 集成配置加载失败。'
  } finally {
    loading.value = false
  }
}

async function saveIdentity() {
  busy.value = 'save-identity'
  message.value = ''
  error.value = ''
  try {
    const result = await saveIdentityOauthIntegration({
      allowVerifiedEmailAutoLink: identity.allowVerifiedEmailAutoLink,
      google: identity.google,
      wechat: identity.wechat
    })
    Object.assign(identity, result.identity)
    Object.assign(identity.google, result.identity.google, { clientSecret: '' })
    Object.assign(identity.wechat, result.identity.wechat, { clientSecret: '' })
    message.value = '外部身份配置已保存；Secret 不会回显。'
  } catch (caught) {
    error.value = caught.message || '外部身份配置保存失败。'
  } finally {
    busy.value = ''
  }
}

async function saveEmailOauth() {
  busy.value = 'save-email-oauth'
  message.value = ''
  error.value = ''
  try {
    const result = await saveEmailOauthIntegration({
      selectedProvider: emailOauth.selectedProvider,
      google: emailOauth.google,
      microsoft: emailOauth.microsoft
    })
    Object.assign(emailOauth, result.emailOAuth)
    for (const provider of ['google', 'microsoft']) {
      Object.assign(emailOauth[provider], result.emailOAuth[provider], { clientSecret: '', refreshToken: '' })
    }
    message.value = '邮箱 OAuth 配置已保存；Secret 与 Refresh Token 不会回显。'
  } catch (caught) {
    error.value = caught.message || '邮箱 OAuth 配置保存失败。'
  } finally {
    busy.value = ''
  }
}

async function testIdentity(provider) {
  busy.value = `test-${provider}`
  message.value = ''
  error.value = ''
  try {
    await testIdentityOauthIntegration(provider)
    message.value = `${provider === 'google' ? 'Google' : '微信'} 配置结构与可信端点检查通过；这不代表外部登录已成功。`
  } catch (caught) {
    error.value = caught.message || 'Provider 检查失败。'
  } finally { busy.value = '' }
}

async function testEmail(provider) {
  busy.value = `test-email-${provider}`
  message.value = ''
  error.value = ''
  try {
    await testEmailOauthIntegration(provider)
    message.value = `${provider === 'google' ? 'Google' : 'Microsoft'} Refresh Token 流结构检查通过；这不会伪造邮箱授权成功。`
  } catch (caught) {
    error.value = caught.message || '邮箱 OAuth 结构检查失败。'
  } finally { busy.value = '' }
}

onMounted(refresh)
</script>

<template>
  <section class="oauth-integration" aria-labelledby="oauth-integration-title">
    <header class="oauth-heading">
      <div class="oauth-heading__icon"><Icon name="link" :size="22" /></div>
      <div>
        <h4 id="oauth-integration-title">身份登录与邮箱 OAuth</h4>
        <p>默认关闭。Secret 只写入服务器 0600 文件，不会返回浏览器；没有真实凭据时只能保存与检查结构。</p>
      </div>
    </header>
    <p v-if="message" class="oauth-notice oauth-notice--success" role="status">{{ message }}</p>
    <p v-if="error" class="oauth-notice oauth-notice--error" role="alert">{{ error }}</p>

    <fieldset class="oauth-section" :disabled="loading || Boolean(busy) || !writable">
      <legend>Google OIDC / 微信开放平台</legend>
      <p class="oauth-help">双域回调必须在 Provider 控制台逐条精确登记。微信只使用 unionid/openid，不按昵称合并账号。</p>
      <div v-for="provider in ['google', 'wechat']" :key="provider" class="oauth-provider">
        <label class="oauth-toggle"><input v-model="identity[provider].enabled" type="checkbox"> 启用 {{ provider === 'google' ? 'Google' : '微信' }} 登录</label>
        <label><span>{{ provider === 'google' ? 'Client ID' : 'AppID' }}</span><input v-model="identity[provider].clientId" type="text" autocomplete="off"></label>
        <label><span>Client Secret</span><input v-model="identity[provider].clientSecret" type="password" autocomplete="new-password" :placeholder="identity[provider].secretConfigured ? '已安全保存，留空保持不变' : '未配置'"></label>
        <button class="oauth-button" type="button" @click="testIdentity(provider)">检查结构 / 发现端点</button>
        <ul class="oauth-callbacks"><li v-for="uri in callbacks[provider]" :key="uri"><code>{{ uri }}</code></li></ul>
      </div>
      <label class="oauth-toggle oauth-toggle--wide"><input v-model="identity.allowVerifiedEmailAutoLink" type="checkbox"> 允许 Google 已验证邮箱自动匹配已审批且邮箱已验证的现有账号</label>
      <button class="oauth-button oauth-button--primary" type="button" @click="saveIdentity">保存身份登录配置</button>
    </fieldset>

    <fieldset class="oauth-section" :disabled="loading || Boolean(busy) || !writable">
      <legend>OAuth-only 邮箱（Google / Microsoft）</legend>
      <p class="oauth-help">通用 Refresh Token Provider 可适配 IMAP XOAUTH2 与 SMTP OAuth2。无 Secret / Refresh Token 时不会启用。</p>
      <label><span>当前使用</span><select v-model="emailOauth.selectedProvider"><option value="">关闭，继续使用邮箱密码</option><option value="google">Google</option><option value="microsoft">Microsoft</option></select></label>
      <div v-for="provider in ['google', 'microsoft']" :key="provider" class="oauth-provider">
        <label class="oauth-toggle"><input v-model="emailOauth[provider].enabled" type="checkbox"> 启用 {{ provider === 'google' ? 'Google' : 'Microsoft' }} 邮箱 OAuth</label>
        <label><span>Client ID</span><input v-model="emailOauth[provider].clientId" type="text" autocomplete="off"></label>
        <label><span>Client Secret</span><input v-model="emailOauth[provider].clientSecret" type="password" autocomplete="new-password" :placeholder="emailOauth[provider].clientSecretConfigured ? '已安全保存，留空保持不变' : '未配置'"></label>
        <label><span>Refresh Token</span><input v-model="emailOauth[provider].refreshToken" type="password" autocomplete="new-password" :placeholder="emailOauth[provider].refreshTokenConfigured ? '已安全保存，留空保持不变' : '未配置'"></label>
        <label v-if="provider === 'microsoft'"><span>Tenant</span><input v-model="emailOauth.microsoft.tenant" type="text"></label>
        <label><span>Scope</span><input v-model="emailOauth[provider].scope" type="text"></label>
        <button class="oauth-button" type="button" @click="testEmail(provider)">检查 Refresh Token 流结构</button>
      </div>
      <button class="oauth-button oauth-button--primary" type="button" @click="saveEmailOauth">保存邮箱 OAuth 配置</button>
    </fieldset>
  </section>
</template>

<style scoped>
.oauth-integration { display: grid; gap: 18px; margin: 18px 0; padding: 22px; border: 1px solid var(--border-color); border-radius: var(--radius-xl); background: var(--bg-secondary); }
.oauth-heading { display: flex; align-items: flex-start; gap: 13px; }
.oauth-heading__icon { display: grid; place-items: center; width: 46px; height: 46px; flex: 0 0 auto; border-radius: 15px; color: var(--accent-color); background: var(--accent-bg); }
.oauth-heading h4 { margin: 0 0 6px; color: var(--text-primary); }
.oauth-heading p, .oauth-help { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.65; }
.oauth-section { display: grid; gap: 14px; min-width: 0; padding: 18px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); }
.oauth-section legend { padding: 0 8px; color: var(--text-primary); font-weight: 700; }
.oauth-provider { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; padding: 15px; border: 1px solid var(--border-light); border-radius: 14px; background: var(--bg-primary); }
.oauth-provider label, .oauth-section > label { display: grid; gap: 6px; color: var(--text-primary); font-size: 13px; }
.oauth-provider input, .oauth-section select { width: 100%; min-height: 44px; padding: 0 12px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--bg-secondary); color: var(--text-primary); }
.oauth-toggle { display: flex !important; align-items: center; gap: 8px; grid-column: 1 / -1; }
.oauth-toggle input { width: 20px; min-height: 20px; }
.oauth-toggle--wide { margin-top: 2px; }
.oauth-callbacks { grid-column: 1 / -1; display: grid; gap: 5px; margin: 0; padding-left: 19px; color: var(--text-secondary); overflow-wrap: anywhere; }
.oauth-button { min-height: 44px; padding: 0 14px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; }
.oauth-button--primary { justify-self: start; color: var(--button-text); background: var(--accent-color); border-color: var(--accent-color); }
.oauth-section:disabled { opacity: .7; }
.oauth-notice { margin: 0; padding: 11px 13px; border-radius: 12px; }
.oauth-notice--success { color: var(--success-color); background: var(--success-bg); }
.oauth-notice--error { color: var(--danger-color); background: var(--danger-bg); }
@media (max-width: 720px) { .oauth-integration { padding: 15px; } .oauth-provider { grid-template-columns: 1fr; } .oauth-button--primary { width: 100%; } }
</style>
