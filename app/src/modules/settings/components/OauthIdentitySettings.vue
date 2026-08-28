<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import {
  fetchOauthIdentities,
  fetchOauthLoginConfig,
  startOauthLink,
  unlinkOauthIdentity
} from '@/shared/services/oauthApi'

const route = useRoute()
const loading = ref(true)
const busy = ref('')
const currentPassword = ref('')
const message = ref('')
const error = ref('')
const identities = ref([])
const config = ref({ providers: { google: { enabled: false }, wechat: { enabled: false } } })
const availableProviders = computed(() => (
  ['google', 'wechat'].filter((provider) => config.value.providers?.[provider]?.enabled)
))

function label(provider) {
  return provider === 'google' ? 'Google' : '微信'
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未使用'
}

async function refresh() {
  loading.value = true
  try {
    const [identityResult, loginConfig] = await Promise.all([
      fetchOauthIdentities(),
      fetchOauthLoginConfig()
    ])
    identities.value = identityResult.identities || []
    config.value = loginConfig
  } catch (caught) {
    error.value = caught.message || '外部身份信息加载失败。'
  } finally {
    loading.value = false
  }
}

async function bind(provider) {
  if (!currentPassword.value) {
    error.value = '请输入当前密码后再绑定。'
    return
  }
  busy.value = provider
  message.value = ''
  error.value = ''
  try {
    const result = await startOauthLink(
      provider,
      currentPassword.value,
      '/settings?category=security'
    )
    currentPassword.value = ''
    window.location.assign(result.authorizationUrl)
  } catch (caught) {
    currentPassword.value = ''
    error.value = caught.message || '无法发起绑定，请稍后重试。'
    busy.value = ''
  }
}

async function unlink(identity) {
  if (!currentPassword.value) {
    error.value = '请输入当前密码后再解绑。'
    return
  }
  if (!window.confirm(`确定解绑 ${label(identity.provider)} 吗？密码登录仍会保留。`)) return
  busy.value = identity.id
  message.value = ''
  error.value = ''
  try {
    await unlinkOauthIdentity(identity.id, currentPassword.value)
    identities.value = identities.value.filter((item) => item.id !== identity.id)
    currentPassword.value = ''
    message.value = `${label(identity.provider)} 已解绑。`
  } catch (caught) {
    currentPassword.value = ''
    error.value = caught.message || '解绑失败，请稍后重试。'
  } finally {
    busy.value = ''
  }
}

onMounted(async () => {
  if (route.query.oauth_linked) message.value = `${label(route.query.oauth_linked)} 已安全绑定。`
  await refresh()
})
</script>

<template>
  <section class="oauth-card" aria-labelledby="oauth-identity-title">
    <header class="oauth-card__header">
      <div class="oauth-card__icon"><Icon name="link" :size="20" /></div>
      <div>
        <h4 id="oauth-identity-title">Google / 微信登录</h4>
        <p>外部账号必须先登录后绑定。Google 只接受已验证邮箱；微信只按稳定 Subject 绑定，不会按昵称合并。</p>
      </div>
    </header>
    <p v-if="message" class="oauth-notice oauth-notice--success" role="status">{{ message }}</p>
    <p v-if="error" class="oauth-notice oauth-notice--error" role="alert">{{ error }}</p>
    <label class="oauth-field">
      <span>当前密码</span>
      <input v-model="currentPassword" type="password" autocomplete="current-password" placeholder="绑定或解绑前验证身份">
    </label>
    <div v-if="identities.length" class="oauth-list">
      <article v-for="identity in identities" :key="identity.id" class="oauth-row">
        <div>
          <strong>{{ label(identity.provider) }}</strong>
          <small>绑定于 {{ formatDate(identity.createdAt) }} · 最近使用 {{ formatDate(identity.lastUsedAt) }}</small>
        </div>
        <button class="oauth-button oauth-button--danger" type="button" :disabled="Boolean(busy)" @click="unlink(identity)">
          {{ busy === identity.id ? '解绑中…' : '解绑' }}
        </button>
      </article>
    </div>
    <div v-if="availableProviders.length" class="oauth-actions">
      <button
        v-for="provider in availableProviders.filter((item) => !identities.some((identity) => identity.provider === item))"
        :key="provider"
        class="oauth-button"
        type="button"
        :disabled="Boolean(busy)"
        @click="bind(provider)"
      >
        <Icon name="link" :size="16" />
        {{ busy === provider ? '正在前往…' : `绑定 ${label(provider)}` }}
      </button>
    </div>
    <p v-else-if="!loading" class="oauth-empty">管理员尚未启用外部身份登录，密码、Passkey 与恢复码不受影响。</p>
  </section>
</template>

<style scoped>
.oauth-card { margin-top: 18px; padding: 20px; border: 1px solid var(--border-color); border-radius: var(--radius-lg); background: var(--bg-secondary); }
.oauth-card__header { display: flex; gap: 12px; align-items: flex-start; }
.oauth-card__header h4 { margin: 0 0 5px; color: var(--text-primary); }
.oauth-card__header p, .oauth-empty { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.65; }
.oauth-card__icon { display: grid; place-items: center; width: 42px; height: 42px; flex: 0 0 auto; border-radius: 14px; color: var(--accent-color); background: var(--accent-bg); }
.oauth-field { display: grid; gap: 7px; margin-top: 16px; color: var(--text-primary); font-size: 13px; }
.oauth-field input { min-height: 44px; padding: 0 13px; border: 1px solid var(--border-color); border-radius: 13px; background: var(--bg-primary); color: var(--text-primary); }
.oauth-list { display: grid; gap: 9px; margin-top: 14px; }
.oauth-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid var(--border-light); border-radius: 13px; background: var(--bg-primary); }
.oauth-row div { display: grid; gap: 4px; min-width: 0; }
.oauth-row strong { color: var(--text-primary); }
.oauth-row small { color: var(--text-secondary); }
.oauth-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 14px; }
.oauth-button { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 0 14px; border: 1px solid var(--border-color); border-radius: 13px; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; }
.oauth-button--danger { color: var(--danger-color); }
.oauth-button:disabled { opacity: .55; cursor: wait; }
.oauth-notice { margin: 14px 0 0; padding: 10px 12px; border-radius: 12px; font-size: 13px; }
.oauth-notice--success { background: var(--success-bg); color: var(--success-color); }
.oauth-notice--error { background: var(--danger-bg); color: var(--danger-color); }
.oauth-empty { margin-top: 14px; }
@media (max-width: 640px) { .oauth-row { align-items: stretch; flex-direction: column; } .oauth-button { width: 100%; } }
</style>
