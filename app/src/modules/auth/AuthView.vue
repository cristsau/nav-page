<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '@/shared/composables/useAuth'

const route = useRoute()
const { initAuth, login, register } = useAuth()

const activeTab = ref('login')
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const loginForm = ref({
  username: '',
  password: ''
})

const registerForm = ref({
  username: '',
  password: '',
  confirmPassword: ''
})

const redirectTarget = computed(() => route.query.redirect || '/')

onMounted(async () => {
  await initAuth()
})

async function handleLogin() {
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''

  try {
    await login(loginForm.value.username, loginForm.value.password)
    window.location.assign(String(redirectTarget.value))
  } catch (error) {
    errorMessage.value = error.message || '登录失败，请稍后再试。'
  } finally {
    loading.value = false
  }
}

async function handleRegister() {
  errorMessage.value = ''
  successMessage.value = ''

  if (!registerForm.value.username.trim() || !registerForm.value.password) {
    errorMessage.value = '请填写用户名和密码。'
    return
  }

  if (registerForm.value.password !== registerForm.value.confirmPassword) {
    errorMessage.value = '两次输入的密码不一致。'
    return
  }

  loading.value = true

  try {
    const request = await register({
      username: registerForm.value.username,
      password: registerForm.value.password
    })

    successMessage.value = request.autoApproved
      ? '本地管理员已创建，请使用刚才的账号登录。'
      : `注册申请已提交，等待管理员审批。申请编号：${request.id}`
    registerForm.value = {
      username: '',
      password: '',
      confirmPassword: ''
    }
    activeTab.value = 'login'
  } catch (error) {
    errorMessage.value = error.message || '注册失败，请稍后再试。'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-card">
      <div class="auth-card__header">
        <div class="auth-card__brand">
          <img class="auth-card__logo" src="/domo-logo.png" alt="">
          <span>DOMO NAV</span>
        </div>
        <h1 class="auth-card__title">账号登录与注册</h1>
        <p class="auth-card__desc">适合个人和小团队使用的私有化导航工作台。新用户注册后需要管理员审批。</p>
      </div>

      <div class="auth-tabs">
        <button
          class="auth-tab"
          :class="{ 'is-active': activeTab === 'login' }"
          @click="activeTab = 'login'"
        >
          登录
        </button>
        <button
          class="auth-tab"
          :class="{ 'is-active': activeTab === 'register' }"
          @click="activeTab = 'register'"
        >
          注册
        </button>
      </div>

      <div v-if="activeTab === 'login'" class="auth-form">
        <label class="auth-field">
          <span>用户名</span>
          <input v-model="loginForm.username" type="text" autocomplete="username">
        </label>
        <label class="auth-field">
          <span>密码</span>
          <input v-model="loginForm.password" type="password" autocomplete="current-password">
        </label>
        <button class="auth-submit" :disabled="loading" @click="handleLogin">
          {{ loading ? '登录中...' : '登录' }}
        </button>
      </div>

      <div v-else class="auth-form">
        <label class="auth-field">
          <span>用户名</span>
          <input v-model="registerForm.username" type="text" autocomplete="username">
        </label>
        <label class="auth-field">
          <span>密码</span>
          <input v-model="registerForm.password" type="password" autocomplete="new-password">
        </label>
        <label class="auth-field">
          <span>确认密码</span>
          <input v-model="registerForm.confirmPassword" type="password" autocomplete="new-password">
        </label>
        <button class="auth-submit" :disabled="loading" @click="handleRegister">
          {{ loading ? '提交中...' : '提交注册申请' }}
        </button>
      </div>

      <p v-if="errorMessage" class="auth-message auth-message--error">{{ errorMessage }}</p>
      <p v-if="successMessage" class="auth-message auth-message--success">{{ successMessage }}</p>
      <p class="auth-signature">Design by CrisTsau</p>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at top left, color-mix(in srgb, var(--accent-color) 18%, transparent), transparent 30%),
    linear-gradient(160deg, var(--bg-primary), var(--bg-secondary));
}

.auth-card {
  width: min(460px, 100%);
  padding: 32px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 28px;
  box-shadow: var(--shadow-card);
}

.auth-card__header {
  margin-bottom: 24px;
}

.auth-card__brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px 7px 7px;
  border-radius: 999px;
  background: var(--accent-bg);
  color: var(--accent-color);
  font-weight: 700;
  letter-spacing: 0.16em;
}

.auth-card__logo {
  width: 46px;
  height: 46px;
  display: block;
  object-fit: contain;
  overflow: hidden;
  background: #fff;
  border: 1px solid var(--border-light);
  border-radius: 50%;
}

.auth-card__title {
  margin: 18px 0 8px;
  font-size: 28px;
  color: var(--text-primary);
}

.auth-card__desc {
  color: var(--text-secondary);
  line-height: 1.6;
}

.auth-tabs {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  padding: 8px;
  margin-bottom: 20px;
  background: var(--bg-secondary);
  border-radius: 18px;
}

.auth-tab {
  border: none;
  border-radius: 14px;
  padding: 12px 16px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.auth-tab.is-active {
  background: var(--accent-color);
  color: #fff;
}

.auth-form {
  display: grid;
  gap: 14px;
}

.auth-field {
  display: grid;
  gap: 8px;
  color: var(--text-primary);
}

.auth-field input {
  width: 100%;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 14px 16px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  outline: none;
}

.auth-field input:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-color) 18%, transparent);
}

.auth-submit {
  margin-top: 8px;
  border: none;
  border-radius: 16px;
  padding: 14px 18px;
  background: var(--accent-color);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}

.auth-submit:disabled {
  opacity: 0.7;
  cursor: wait;
}

.auth-message {
  margin-top: 12px;
  line-height: 1.6;
  padding: 12px 14px;
  border-radius: 14px;
  font-size: 14px;
}

.auth-message--error {
  background: color-mix(in srgb, #d35b5b 14%, var(--bg-secondary));
  color: #d35b5b;
}

.auth-message--success {
  background: color-mix(in srgb, #5a8a6a 18%, var(--bg-secondary));
  color: #5a8a6a;
}

.auth-signature {
  margin: 18px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 0.08em;
}
</style>
