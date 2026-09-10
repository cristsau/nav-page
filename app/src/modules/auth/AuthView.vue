<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import BotChallenge from '@/shared/components/BotChallenge.vue'
import EmailAuthForm from './EmailAuthForm.vue'
import { fetchAuthCapabilities } from '@/shared/services/authEmailApi'
import { useAuth } from '@/shared/composables/useAuth'
import {
  fetchBackendRegistrationConfig,
  resendBackendRegistrationEmail,
  verifyBackendRegistrationEmail
} from '@/shared/services/authApi'
import { fetchOauthLoginConfig, startOauthLogin } from '@/shared/services/oauthApi'
import { createPwaOauthController, isHomeScreenApp } from '@/shared/services/pwaOauth'
import { browserSupportsDeviceKeys, fetchDeviceKeyConfig, loginWithDeviceKey, deviceKeyMessage } from '@/shared/services/deviceKeyApi'

const route = useRoute()
const {
  backendAuthEnabled,
  initAuth,
  login,
  acceptAuthenticatedSession,
  recoverAccount,
  register
} = useAuth()

const activeTab = ref('login')
const recoveryMode = ref(false)
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const emailMode = ref(false)
const emailReset = ref(false)
const capabilities = ref({ emailLogin:false, emailPasswordReset:false })
async function loadEmailCapabilities() {
  if(!backendAuthEnabled.value)return
  try { capabilities.value=await fetchAuthCapabilities();emailMode.value=Boolean(capabilities.value.emailLogin) }
  catch { capabilities.value={emailLogin:false,emailPasswordReset:false} }
}
const registrationConfig = ref({ emailVerificationEnabled: false, emailRequired: false })
const showVerificationResend = ref(false)
// This is the result of this browser's request, not a public account-status lookup.
const registrationStatus = ref('')
const registrationUsesEmail = ref(true)
const pageTitle = ref(null)
const cardTitle = computed(() => {
  if (showVerificationResend.value) return '重发验证邮件'
  if (registrationStatus.value === 'email_pending') return '申请已提交，请验证邮箱'
  if (registrationStatus.value === 'pending') return '待管理员审核'
  if (registrationStatus.value === 'verifying') return '正在验证邮箱'
  if (registrationStatus.value === 'verify_error') return '邮箱验证未完成'
  if (registrationStatus.value === 'approved') return '账号已准备好'
  if (recoveryMode.value || emailReset.value) return '找回你的账号'
  return activeTab.value === 'register' ? '创建你的空间' : '欢迎回来'
})
const cardDescription = computed(() => {
  if (showVerificationResend.value) return '使用注册时的邮箱，获取新的验证链接。'
  if (registrationStatus.value) return '注册进度已为你整理在这里。'
  if (recoveryMode.value || emailReset.value) return '选择你已配置的恢复方式。'
  if (activeTab.value === 'register') return registrationConfig.value.emailVerificationEnabled
    ? '提交申请 → 验证邮箱 → 管理员审核'
    : '提交申请，管理员审核后即可使用。'
  return '收藏、记录与灵感，都在这里。'
})
async function focusPageTitle() {
  await nextTick()
  pageTitle.value?.focus()
}
function openVerificationResend() {
  clearFormSecrets()
  errorMessage.value = ''; successMessage.value = ''
  showVerificationResend.value = true
  focusPageTitle()
}
function closeVerificationResend() {
  showVerificationResend.value = false
  errorMessage.value = ''; successMessage.value = ''
  focusPageTitle()
}
const resendEmail = ref('')
const resendLoading = ref(false)
const oauthConfig = ref({ providers: { google: { enabled: false }, wechat: { enabled: false } } })
const oauthLoading = ref('')
const trustDevice = ref(false)
const deviceKeyReady = ref(false)
const passwordChallengeRequired = ref(false)
const loginChallenge = ref(null), registrationChallenge = ref(null), recoveryChallenge = ref(null), resendChallenge = ref(null)
async function loadDeviceKeys() {
  if (!backendAuthEnabled.value) return
  try { deviceKeyReady.value = (await fetchDeviceKeyConfig()).enabled && await browserSupportsDeviceKeys() }
  catch { deviceKeyReady.value = false }
}
async function handleDeviceKeyLogin() {
  if (loading.value) return
  loading.value = true; errorMessage.value = ''; successMessage.value = ''
  try {
    const result = await loginWithDeviceKey(trustDevice.value)
    acceptAuthenticatedSession(result.user)
    window.location.assign(redirectTarget.value)
  } catch (error) { errorMessage.value = deviceKeyMessage(error) }
  finally { loading.value = false }
}
const pwaState = ref('idle')
let pwaLogin = null
const pwaPending = computed(() => ['pending', 'reconnecting'].includes(pwaState.value))

function getPwaLogin() {
  if (!pwaLogin) pwaLogin = createPwaOauthController({
    onState: state => { pwaState.value = state; if (state === 'idle') oauthLoading.value = '' },
    onError: error => { errorMessage.value = error.message; oauthLoading.value = '' },
    onComplete: result => {
      acceptAuthenticatedSession(result.user)
      window.location.assign(redirectTarget.value)
    }
  })
  return pwaLogin
}

async function cancelPwaLogin() {
  try { await getPwaLogin().cancel() }
  catch { errorMessage.value = '暂时无法取消登录，请联网后重试。'; pwaState.value = 'reconnecting' }
}

const loginForm = ref({
  username: '',
  password: ''
})

const registerForm = ref({
  username: '',
  email: '',
  password: '',
  confirmPassword: ''
})

const recoveryForm = ref({
  username: '',
  recoveryCode: '',
  newPassword: '',
  confirmPassword: ''
})

const redirectTarget = computed(() => {
  const value = String(route.query.redirect || '/').trim()
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'

  try {
    const resolved = new URL(value, window.location.origin)
    if (resolved.origin !== window.location.origin) return '/'
    if (resolved.pathname === '/auth') return '/'
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return '/'
  }
})

async function loadRegistrationConfig() {
  if (!backendAuthEnabled.value) return
  try {
    registrationConfig.value = await fetchBackendRegistrationConfig()
  } catch {
    registrationConfig.value = { emailVerificationEnabled: false, emailRequired: false }
  }
}

async function loadOauthConfig() {
  if (!backendAuthEnabled.value) return
  try {
    oauthConfig.value = await fetchOauthLoginConfig()
  } catch {
    oauthConfig.value = { providers: { google: { enabled: false }, wechat: { enabled: false } } }
  }
}

async function verifyRegistrationFromLink() {
  const fragment = String(window.location.hash || '')
  if (!fragment.startsWith('#register-verify?')) return
  const params = new URLSearchParams(fragment.slice('#register-verify?'.length))
  const requestId = String(params.get('request') || '')
  const token = String(params.get('token') || '')
  // Remove email proof from browser history on success AND failure.
  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`)
  errorMessage.value = ''; successMessage.value = ''; showVerificationResend.value = false
  registrationStatus.value = 'verifying'
  registrationUsesEmail.value = true
  if (!requestId || !token || !backendAuthEnabled.value) {
    registrationStatus.value = 'verify_error'
    errorMessage.value = '邮箱验证链接不完整或当前不可用，请重新申请验证邮件。'
    await focusPageTitle()
    return
  }
  loading.value = true
  try {
    await verifyBackendRegistrationEmail(requestId, token)
    activeTab.value = 'login'
    registrationStatus.value = 'pending'
    successMessage.value = ''
    showVerificationResend.value = false
  } catch (error) {
    registrationStatus.value = 'verify_error'
    errorMessage.value = error.message || '邮箱验证链接无效或已过期。'
  } finally {
    loading.value = false
    await focusPageTitle()
  }
}

// Email links may target an auth tab that is already open (same component).
watch(() => route.hash, hash => {
  if (String(hash || '').startsWith('#register-verify?')) void verifyRegistrationFromLink()
})

onMounted(async () => {
  if (String(route.query.passwordChanged || '') === '1') {
    successMessage.value = '密码已修改，所有设备均已退出。请使用新密码重新登录。'
  }
  await Promise.all([
    initAuth(),
    loadEmailCapabilities(),
    loadDeviceKeys(),
    loadRegistrationConfig(),
    loadOauthConfig()
  ])
  const oauthError = String(route.query.oauth_error || '')
  if (oauthError) {
    errorMessage.value = oauthError === 'not_linked'
      ? '该外部账号尚未绑定。请先使用密码登录，再到账号安全中绑定。'
      : '外部登录未完成或已过期，请重新尝试。'
  }
  await verifyRegistrationFromLink()
  if (isHomeScreenApp() && oauthConfig.value.pwaHandoff) await getPwaLogin().restore()
})

onBeforeUnmount(() => { pwaLogin?.dispose(); clearFormSecrets() })
function clearFormSecrets() {
  clearRecoverySecrets()
  loginForm.value.password=''
  registerForm.value.password=''
  registerForm.value.confirmPassword=''
}

async function handleLogin() {
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''

  try {
    if (pwaPending.value) await getPwaLogin().cancel()
    await login(loginForm.value.username, loginForm.value.password, { trustDevice: trustDevice.value, turnstileToken: loginChallenge.value?.takeToken() })
    window.location.assign(String(redirectTarget.value))
  } catch (error) {
    if (String(error.code || '').startsWith('BOT_')) passwordChallengeRequired.value = true
    errorMessage.value = error.message || '登录失败，请稍后再试。'
  } finally {
    loading.value = false
  }
}

async function handleOauthLogin(provider) {
  if (oauthLoading.value) return
  oauthLoading.value = provider
  errorMessage.value = ''
  successMessage.value = ''
  try {
    if (isHomeScreenApp()) {
      if (!oauthConfig.value.pwaHandoff) throw new Error('桌面应用的 Google 登录正在升级，请暂用账号密码。')
      await getPwaLogin().start(provider, redirectTarget.value, trustDevice.value)
      return
    }
    const result = await startOauthLogin(provider, redirectTarget.value, trustDevice.value)
    window.location.assign(result.authorizationUrl)
  } catch (error) {
    errorMessage.value = error.message || '无法发起外部登录，请稍后重试。'
    oauthLoading.value = ''
  }
}

function openRecoveryMode() {
  recoveryForm.value.username = loginForm.value.username
  recoveryMode.value = true
  errorMessage.value = ''
  successMessage.value = ''
}

function clearRecoverySecrets() {
  recoveryForm.value.recoveryCode = ''
  recoveryForm.value.newPassword = ''
  recoveryForm.value.confirmPassword = ''
}

function closeRecoveryMode({ preserveUsername = true } = {}) {
  if (preserveUsername && recoveryForm.value.username) {
    loginForm.value.username = recoveryForm.value.username
  }
  clearRecoverySecrets()
  recoveryMode.value = false
  errorMessage.value = ''
}

function selectTab(tab) {
  clearFormSecrets()
  closeRecoveryMode({ preserveUsername: tab === 'login' })
  emailReset.value = false
  activeTab.value = tab
  registrationStatus.value = ''
  showVerificationResend.value = false
  successMessage.value = ''
}

function getRecoveryErrorMessage(error) {
  const value = String(error?.message || '')
  if (/too many/i.test(value)) {
    return '尝试次数过多，请稍后再试。'
  }
  if (/unable to recover account|invalid.+recovery/i.test(value)) {
    return '用户名或恢复码无效，恢复码也可能已经使用。'
  }
  if (/password must be at least/i.test(value)) {
    return '新密码至少需要 15 个字符。'
  }
  return value || '账号恢复失败，请稍后再试。'
}

async function handleRecovery() {
  errorMessage.value = ''
  successMessage.value = ''

  const username = recoveryForm.value.username.trim()
  const recoveryCode = recoveryForm.value.recoveryCode.trim()
  if (!username || !recoveryCode || !recoveryForm.value.newPassword) {
    errorMessage.value = '请填写用户名、恢复码和新密码。'
    return
  }

  if (Array.from(recoveryForm.value.newPassword).length < 15) {
    errorMessage.value = '新密码至少需要 15 个字符。'
    return
  }

  if (recoveryForm.value.newPassword !== recoveryForm.value.confirmPassword) {
    errorMessage.value = '两次输入的新密码不一致。'
    return
  }

  loading.value = true
  try {
    await recoverAccount({
      username,
      recoveryCode,
      newPassword: recoveryForm.value.newPassword,
      turnstileToken: recoveryChallenge.value?.takeToken()
    })

    loginForm.value = {
      username,
      password: ''
    }
    recoveryForm.value = {
      username: '',
      recoveryCode: '',
      newPassword: '',
      confirmPassword: ''
    }
    recoveryMode.value = false
    activeTab.value = 'login'
    successMessage.value = '密码已重设，所有设备均已退出。请使用新密码重新登录。'
  } catch (error) {
    errorMessage.value = getRecoveryErrorMessage(error)
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

  if (registrationConfig.value.emailRequired && !registerForm.value.email.trim()) {
    errorMessage.value = '请填写用于验证和接收审批结果的邮箱。'
    return
  }

  if (
    backendAuthEnabled.value
    && Array.from(registerForm.value.password).length < 15
  ) {
    errorMessage.value = '密码至少需要 15 个字符。'
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
      email: registerForm.value.email,
      password: registerForm.value.password,
      turnstileToken: registrationChallenge.value?.takeToken()
    })

    registrationStatus.value = request.autoApproved ? 'approved' : request.status === 'email_pending' ? 'email_pending' : 'pending'
    registrationUsesEmail.value = Boolean(request.email || request.status === 'email_pending')
    if (request.status === 'email_pending') {
      resendEmail.value = registerForm.value.email.trim()
    }
    showVerificationResend.value = false
    registerForm.value = {
      username: '',
      email: '',
      password: '',
      confirmPassword: ''
    }
    activeTab.value = 'login'
    recoveryMode.value = false
    await focusPageTitle()
  } catch (error) {
    errorMessage.value = error.message || '注册失败，请稍后再试。'
  } finally {
    loading.value = false
  }
}

async function handleResendVerification() {
  const email = resendEmail.value.trim()
  errorMessage.value = ''
  successMessage.value = ''
  if (!email) {
    errorMessage.value = '请输入注册时使用的邮箱。'
    return
  }
  resendLoading.value = true
  try {
    await resendBackendRegistrationEmail(email, resendChallenge.value?.takeToken())
    successMessage.value = '如果该邮箱存在待验证申请，新验证邮件已进入发送队列。请检查收件箱和垃圾邮件。'
  } catch (error) {
    errorMessage.value = error.message || '暂时无法重发验证邮件。'
  } finally {
    resendLoading.value = false
  }
}
</script>

<template>
  <div class="auth-page">
   <div class="auth-shell">
    <aside class="auth-story" aria-label="DOMO NAV 工作台">
      <p class="auth-story__eyebrow">YOUR PRIVATE WORKSPACE</p>
      <h2>给灵感一个归处，<br>让日常从容展开。</h2>
      <p class="auth-story__lead">常用网站、随手记录与重要时刻，<br>安放在属于你自己的空间。</p>
      <div class="auth-story__scene" aria-hidden="true">
        <div class="auth-story__tile"><Icon name="compass" :size="24" /><span>从收藏，抵达常用</span><i>NAVIGATION / 01</i></div>
        <div class="auth-story__tile"><Icon name="book" :size="24" /><span>把一闪而过，留在纸上</span><i>NOTES / 02</i></div>
        <div class="auth-story__tile"><Icon name="shield" :size="24" /><span>你的内容，由你掌握</span><i>PRIVATE / 03</i></div>
      </div>
      <p class="auth-story__foot">少一点寻找，多一点专注。</p>
    </aside>
    <div class="auth-card">
      <div class="auth-card__header">
        <div class="auth-card__brand">
          <img class="auth-card__logo" src="/icons/cristsau-mark-512-v2.png" alt="">
          <span>DOMO NAV</span>
        </div>
        <h1 ref="pageTitle" tabindex="-1" class="auth-card__title">{{ cardTitle }}</h1>
        <p class="auth-card__desc">{{ cardDescription }}</p>
      </div>

      <section v-if="pwaPending" class="auth-handoff" role="status" aria-live="polite">
        <Icon name="browser" :size="26" />
        <strong>{{ pwaState === 'reconnecting' ? '等待网络恢复' : '等待身份验证完成' }}</strong>
        <p>完成 Google 验证后，关闭那个窗口回到这里。我们会安全接续登录。</p>
        <button type="button" class="auth-provider" @click="getPwaLogin().check()">我已完成，继续登录</button>
        <button type="button" class="auth-link" @click="cancelPwaLogin">取消本次登录</button>
      </section>

      <section v-if="registrationStatus && !showVerificationResend" class="registration-result" aria-label="注册申请进度" aria-live="polite">
        <template v-if="registrationStatus === 'email_pending' || registrationStatus === 'pending'">
          <ol class="registration-steps">
            <li class="is-complete"><Icon name="check" :size="18" /><span>提交申请<small>已完成</small></span></li>
            <li v-if="registrationUsesEmail" :class="{ 'is-complete': registrationStatus === 'pending' }" :aria-current="registrationStatus === 'email_pending' ? 'step' : undefined"><Icon :name="registrationStatus === 'pending' ? 'check' : 'mail'" :size="18" /><span>验证邮箱<small>{{ registrationStatus === 'pending' ? '已完成' : '请打开验证邮件' }}</small></span></li>
            <li :aria-current="registrationStatus === 'pending' ? 'step' : undefined"><Icon name="shield" :size="18" /><span>管理员审核<small>{{ registrationStatus === 'pending' ? '等待审核' : '邮箱验证后进入审核' }}</small></span></li>
          </ol>
          <p v-if="registrationStatus === 'email_pending'">验证邮件已进入发送队列。请检查收件箱和垃圾邮件，点击邮件中的链接；验证完成后，申请才会进入管理员审核。</p>
          <p v-else>{{ registrationUsesEmail ? '邮箱验证已完成，' : '' }}申请正在等待管理员审核。审核通过后即可登录{{ registrationUsesEmail ? '，结果会通过邮件通知' : '' }}，请勿重复注册。</p>
        </template>
        <p v-else-if="registrationStatus === 'approved'">本地管理员已创建，请使用刚才的账号登录。</p>
        <p v-else-if="registrationStatus === 'verifying'">正在确认验证链接，请稍候。</p>
        <p v-else>链接可能不完整、已使用或已过期。你可以重新申请验证邮件。</p>
        <button v-if="['email_pending', 'verify_error'].includes(registrationStatus)" class="auth-provider" type="button" @click="openVerificationResend">没有收到邮件？重新发送</button>
        <button v-if="registrationStatus !== 'verifying'" class="auth-submit" type="button" @click="selectTab('login'); focusPageTitle()">返回登录</button>
      </section>

      <template v-if="!registrationStatus && !showVerificationResend">
      <div v-show="!pwaPending && !recoveryMode && !emailReset" class="auth-tabs auth-tabs--account" aria-label="登录或注册">
        <button
          class="auth-tab"
          :class="{ 'is-active': activeTab === 'login' }" :aria-pressed="activeTab === 'login'"
          type="button"
          @click="selectTab('login')"
        >
          登录
        </button>
        <button
          class="auth-tab"
          :class="{ 'is-active': activeTab === 'register' }" :aria-pressed="activeTab === 'register'"
          type="button"
          @click="selectTab('register')"
        >
          注册
        </button>
      </div>

      <div v-if="!pwaPending && activeTab === 'login' && !recoveryMode && !emailReset && backendAuthEnabled" class="auth-tabs" aria-label="登录方式">
        <button type="button" class="auth-tab" :class="{'is-active':emailMode}" :disabled="!capabilities.emailLogin" @click="emailMode=true">邮箱验证码</button>
        <button type="button" class="auth-tab" :class="{'is-active':!emailMode}" @click="emailMode=false">账号密码</button>
      </div>
      <p v-if="backendAuthEnabled && !capabilities.emailLogin && activeTab === 'login'" class="auth-card__desc">邮箱验证码暂不可用，请使用账号密码。</p>
      <label v-if="!pwaPending && activeTab === 'login' && !recoveryMode && !emailReset && backendAuthEnabled" class="auth-trust">
        <input v-model="trustDevice" type="checkbox" /><span>信任此设备 <small>最长 30 天保持登录，仅用于私人设备</small></span>
      </label>
      <EmailAuthForm v-if="!pwaPending && activeTab === 'login' && !recoveryMode && (emailMode || emailReset)"
        :key="emailReset ? 'reset' : 'login'" :mode="emailReset ? 'reset' : 'login'" :redirect-target="redirectTarget" :reset-available="capabilities.emailPasswordReset" :trust-device="trustDevice"
        :compact="true" :show-reset-link="false"
        @back="emailReset=false;emailMode=false" @reset="emailReset=true" />
      <form
        v-else-if="!pwaPending && activeTab === 'login' && !recoveryMode"
        class="auth-form"
        @submit.prevent="handleLogin"
      >
        <label class="auth-field">
          <span>用户名</span>
          <input v-model="loginForm.username" type="text" autocomplete="username">
        </label>
        <label class="auth-field">
          <span>密码</span>
          <input v-model="loginForm.password" type="password" autocomplete="current-password">
        </label>
        <BotChallenge v-if="passwordChallengeRequired" ref="loginChallenge" action="password_login" />
        <button class="auth-submit" type="submit" :disabled="loading">
          {{ loading ? '登录中...' : '登录' }}
        </button>
      </form>

      <form
        v-else-if="!pwaPending && activeTab === 'login'"
        class="auth-form"
        @submit.prevent="handleRecovery"
      >
        <div class="auth-form__heading">
          <h2>使用恢复码</h2>
          <p>输入一个未使用的恢复码并设置新密码。成功后，所有设备会立即退出。</p>
        </div>
        <label class="auth-field">
          <span>用户名</span>
          <input v-model="recoveryForm.username" type="text" autocomplete="username">
        </label>
        <label class="auth-field">
          <span>恢复码</span>
          <input
            v-model="recoveryForm.recoveryCode"
            type="text"
            autocomplete="one-time-code"
            autocapitalize="characters"
            spellcheck="false"
            placeholder="NAV-XXXX-XXXX-..."
          >
        </label>
        <label class="auth-field">
          <span>新密码</span>
          <input
            v-model="recoveryForm.newPassword"
            type="password"
            autocomplete="new-password"
            minlength="15"
          >
        </label>
        <label class="auth-field">
          <span>确认新密码</span>
          <input
            v-model="recoveryForm.confirmPassword"
            type="password"
            autocomplete="new-password"
            minlength="15"
          >
        </label>
        <BotChallenge v-if="backendAuthEnabled" ref="recoveryChallenge" action="account_recovery" />
        <button class="auth-submit" type="submit" :disabled="loading">
          {{ loading ? '重设中...' : '重设密码' }}
        </button>
        <button
          class="auth-link"
          type="button"
          :disabled="loading"
          @click="closeRecoveryMode"
        >
          返回密码登录
        </button>
      </form>

      <form v-else-if="!pwaPending" class="auth-form" @submit.prevent="handleRegister">
        <label class="auth-field">
          <span>用户名</span>
          <input v-model="registerForm.username" type="text" autocomplete="username">
        </label>
        <label v-if="registrationConfig.emailVerificationEnabled" class="auth-field">
          <span>邮箱</span>
          <input
            v-model="registerForm.email"
            type="email"
            autocomplete="email"
            :required="registrationConfig.emailRequired"
            placeholder="用于验证并接收审批结果"
          >
        </label>
        <label class="auth-field">
          <span>密码</span>
          <input
            v-model="registerForm.password"
            type="password"
            autocomplete="new-password"
            :minlength="backendAuthEnabled ? 15 : undefined"
          >
        </label>
        <label class="auth-field">
          <span>确认密码</span>
          <input
            v-model="registerForm.confirmPassword"
            type="password"
            autocomplete="new-password"
            :minlength="backendAuthEnabled ? 15 : undefined"
          >
        </label>
        <BotChallenge v-if="backendAuthEnabled" ref="registrationChallenge" action="register" />
        <button class="auth-submit" type="submit" :disabled="loading">
          {{ loading ? '提交中...' : '提交注册申请' }}
        </button>
      </form>

      <section v-if="!pwaPending && activeTab === 'login' && !recoveryMode && !emailReset" class="auth-alternatives" aria-label="其他登录和恢复方式">
        <button v-if="deviceKeyReady" class="auth-device-key" type="button" :disabled="loading" @click="handleDeviceKeyLogin">
          <Icon name="scan-face" :size="22" /><span>快捷登录<small>Face ID、Touch ID 或设备密码</small></span>
        </button>
        <button
          v-if="oauthConfig.providers.google.enabled"
          class="auth-provider"
          type="button"
          :disabled="Boolean(oauthLoading) || loading"
          @click="handleOauthLogin('google')"
        >
          <Icon name="link" :size="18" />
          {{ oauthLoading === 'google' ? '正在前往 Google…' : '使用 Google 登录' }}
        </button>
        <button
          v-if="oauthConfig.providers.wechat.enabled"
          class="auth-provider"
          type="button"
          :disabled="Boolean(oauthLoading) || loading"
          @click="handleOauthLogin('wechat')"
        >
          <Icon name="link" :size="18" />
          {{ oauthLoading === 'wechat' ? '正在前往微信…' : '使用微信登录' }}
        </button>
      </section>
      <details v-if="!pwaPending && activeTab === 'login' && !recoveryMode && !emailReset && backendAuthEnabled" class="auth-help">
        <summary>登录遇到问题？<Icon name="chevron-down" :size="16" /></summary>
        <div class="auth-help__links">
        <button v-if="capabilities.emailPasswordReset" class="auth-link" type="button" @click="emailReset=true; focusPageTitle()">忘记密码？通过邮箱重设</button>
        <button
          v-if="backendAuthEnabled"
          class="auth-link"
          type="button"
          :disabled="loading"
          @click="openRecoveryMode"
        >
          使用恢复码重设密码
        </button>
        <button v-if="registrationConfig.emailVerificationEnabled" class="auth-link" type="button" @click="openVerificationResend">重发注册验证邮件</button>
        </div>
      </details>
      </template>

      <form v-if="showVerificationResend" class="verification-resend" @submit.prevent="handleResendVerification">
        <div>
          <strong>没有收到验证邮件？</strong>
          <p>验证链接过期后可在这里重发。为了保护账号，页面不会透露该邮箱是否存在。</p>
        </div>
        <label class="auth-field">
          <span>注册邮箱</span>
          <input v-model="resendEmail" type="email" autocomplete="email" required>
        </label>
        <BotChallenge ref="resendChallenge" action="register_resend" />
        <button
          class="auth-provider"
          type="submit"
          :disabled="resendLoading || loading"
        >
          {{ resendLoading ? '重发中...' : '重发验证邮件' }}
        </button>
        <button class="auth-link" type="button" :disabled="resendLoading" @click="closeVerificationResend">{{ registrationStatus ? '返回申请进度' : '返回登录' }}</button>
      </form>

      <p v-if="errorMessage" role="alert" class="auth-message auth-message--error">{{ errorMessage }}</p>
      <p v-if="successMessage" role="status" class="auth-message auth-message--success">{{ successMessage }}</p>
      <nav class="auth-public-links" aria-label="DOMO NAV 公开信息">
        <RouterLink to="/about">关于 DOMO NAV</RouterLink>
        <span aria-hidden="true">·</span>
        <RouterLink to="/privacy">隐私政策</RouterLink>
      </nav>
      <p class="auth-signature">Design by CrisTsau</p>
    </div>
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
  width: 100%;
  min-width: 0;
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
  border-radius: 14px;
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
  color: var(--text-primary);
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

.verification-resend {
  display: grid;
  gap: 12px;
  margin-top: 18px;
  padding: 16px;
  border: 1px solid var(--border-light);
  border-radius: 18px;
  background: var(--bg-secondary);
}

.verification-resend strong {
  color: var(--text-primary);
}

.verification-resend p {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.auth-form__heading h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 18px;
}

.auth-form__heading p {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
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

.auth-divider {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: 12px;
}

.auth-divider::before,
.auth-divider::after {
  height: 1px;
  content: '';
  background: var(--border-light);
}

.auth-provider {
  min-height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.auth-provider:hover:not(:disabled) {
  border-color: var(--accent-color);
  background: var(--accent-bg);
}

.auth-provider:disabled {
  opacity: 0.65;
  cursor: wait;
}

.auth-provider-notice {
  margin: 0;
  padding: 11px 13px;
  border: 1px solid var(--border-light);
  border-radius: 14px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.auth-provider-notice a {
  color: var(--accent-color);
}

.auth-link {
  justify-self: center;
  border: none;
  padding: 6px 10px;
  background: transparent;
  color: var(--accent-color);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.auth-link:hover:not(:disabled) {
  text-decoration: underline;
}

.auth-link:disabled {
  opacity: 0.6;
  cursor: not-allowed;
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

.auth-public-links {
  display: flex;
  min-height: 44px;
  margin-top: 16px;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  color: var(--text-muted);
  font-size: 12px;
}

.auth-public-links a {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  color: var(--text-secondary);
}

.auth-public-links a:hover {
  color: var(--accent-color);
  text-decoration: underline;
  text-underline-offset: 4px;
}

.auth-signature {
  margin: 2px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 0.08em;
}

.auth-shell {width:min(1100px,100%);display:grid;grid-template-columns:1.08fr 1fr;gap:clamp(32px,6vw,84px);align-items:start}
.auth-story {min-width:0;color:var(--text-primary);padding:32px 0}
.auth-story__eyebrow {font-size:11px;letter-spacing:.22em;color:var(--text-secondary)}
.auth-story h2 {font-size:clamp(30px,3.2vw,44px);font-weight:550;line-height:1.4;letter-spacing:-.045em;margin:26px 0 20px}
.auth-story__lead {font-size:15px;color:var(--text-secondary);line-height:1.9}
.auth-story__scene {display:grid;gap:12px;margin:40px 0 28px}
.auth-story__tile {display:grid;grid-template-columns:28px 1fr;gap:6px 14px;align-items:center;padding:19px 22px;border:1px solid var(--border-color);border-radius:18px;background:color-mix(in srgb,var(--bg-card) 85%,transparent)}
.auth-story__tile:nth-child(2) {margin-left:22px}
.auth-story__tile:nth-child(3) {margin-right:22px}
.auth-story__tile :deep(svg) {grid-row:span 2;color:var(--text-secondary)}
.auth-story__tile span {font-size:14px}
.auth-story__tile i {font-style:normal;letter-spacing:.12em;font-size:9px;color:var(--text-secondary)}
.auth-story__foot {font-size:12px;color:var(--text-secondary);letter-spacing:.15em}
.auth-alternatives {display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.auth-alternatives>.auth-provider,.auth-alternatives>.auth-device-key {flex:1;min-width:150px}
.auth-help {margin-top:8px;border-top:1px solid var(--border-light);color:var(--text-primary);font-size:13px}
.auth-help summary {min-height:44px;display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;list-style:none}
.auth-help summary::-webkit-details-marker {display:none}
.auth-help summary:focus-visible {outline:3px solid var(--text-primary);outline-offset:3px}
.auth-help[open] summary svg {transform:rotate(180deg)}
.auth-help__links {display:grid;justify-items:start;gap:2px}
.auth-help__links .auth-link {justify-self:start;text-align:left}
.registration-result {display:grid;gap:16px;color:var(--text-primary)}
.registration-result>p {margin:0;font-size:14px;line-height:1.8;color:var(--text-secondary)}
.registration-steps {list-style:none;margin:0;padding:4px 16px;border:1px solid var(--border-light);border-radius:16px;background:var(--bg-secondary)}
.registration-steps li {display:flex;align-items:center;gap:14px;padding:14px 0;line-height:1.5;font-size:14px}
.registration-steps li+li {border-top:1px solid var(--border-light)}
.registration-steps small {display:block;font-size:12px;color:var(--text-secondary)}
.registration-steps [aria-current=step] {font-weight:700}
.registration-steps .is-complete svg {color:var(--text-primary)}
.auth-page button,.auth-page input {min-height:44px}
.auth-page button:focus-visible,.auth-page a:focus-visible {outline:3px solid var(--text-primary);outline-offset:3px}
.auth-field input {font-size:16px}
.auth-link {color:var(--text-primary)}
.auth-tab:disabled {opacity:.5;cursor:not-allowed}
.auth-message--error {color:var(--text-primary);border:1px solid #a34949}
.auth-message--success {color:var(--text-primary);border:1px solid #4f795e}
@media(max-width:850px) {
 .auth-page {padding:28px 18px}
 .auth-shell {max-width:500px;grid-template-columns:1fr;gap:0}
 .auth-story {display:none}
 .auth-card {padding:28px 24px}
}
@media(max-width:360px) {
 .auth-page {padding:16px 10px}
 .auth-card {padding:22px 16px;border-radius:22px}
 .auth-card__title {font-size:23px}
 .auth-tab {padding:12px 7px}
}
@media(prefers-reduced-motion:reduce) {.auth-page * {transition:none!important;animation:none!important}}

/* iPhone-inspired hierarchy: calm content surfaces, one clear primary action. */
.auth-page {min-height:100svh;background:var(--bg-secondary);padding:16px clamp(24px,5vw,72px)}
.auth-card {border-radius:26px;border-color:var(--border-light);box-shadow:0 16px 60px color-mix(in srgb,var(--text-primary) 5%,transparent);padding:24px}
.auth-card__header {margin-bottom:14px}
.auth-card__brand {padding:0;background:transparent;gap:12px;font-size:12px;letter-spacing:.14em;color:var(--text-secondary)}
.auth-card__logo {width:44px;height:44px;border-radius:13px}
.auth-card__title {font-size:30px;font-weight:750;line-height:1.25;letter-spacing:-.04em;margin:10px 0 6px}
.auth-card__desc {font-size:13px;line-height:1.65;margin:0}
.auth-tabs {padding:4px;gap:4px;border-radius:13px;margin-bottom:12px;background:var(--bg-secondary)}
.auth-tab {min-height:44px;padding:9px 10px;border-radius:10px;font-size:14px;font-weight:550;transition:background .18s ease,box-shadow .18s ease}
.auth-tab.is-active {color:var(--text-primary);background:var(--bg-card);box-shadow:0 1px 4px #00000014;font-weight:650}
.auth-tabs--account {background:transparent;padding:0;border-bottom:1px solid var(--border-light);border-radius:0;gap:22px;display:flex;margin-bottom:12px}
.auth-tabs--account .auth-tab {padding:6px 0;min-width:44px;background:transparent;border-radius:0;color:var(--text-secondary);box-shadow:none;border-bottom:2px solid transparent}
.auth-tabs--account .auth-tab.is-active {border-color:var(--text-primary);color:var(--text-primary)}
.auth-field {gap:7px;font-size:13px;font-weight:600}
.auth-field input {min-height:52px;border-radius:13px;border-color:var(--border-color);background:var(--bg-secondary);padding:14px;font-weight:400}
.auth-submit {min-height:50px;background:var(--text-primary);color:var(--bg-card);border-radius:14px;font-size:16px;font-weight:650;margin-top:8px}
.auth-provider {min-height:50px;background:var(--bg-card);border-radius:14px;font-size:15px}
.auth-trust {display:flex;align-items:center;gap:10px;min-height:44px;margin:0 0 12px;cursor:pointer}
.auth-trust input {appearance:none;-webkit-appearance:none;flex:0 0 44px;width:44px;height:44px;min-height:44px;border:0;border-radius:12px;background:var(--bg-secondary);position:relative;cursor:pointer}
.auth-trust input::before {content:'';position:absolute;inset:12px;border:1.5px solid var(--text-secondary);border-radius:6px}
.auth-trust input:checked::before {background:var(--text-primary);border-color:var(--text-primary)}
.auth-trust input:checked::after {content:'';position:absolute;left:18px;top:14px;width:7px;height:12px;border:solid var(--bg-card);border-width:0 2px 2px 0;transform:rotate(45deg)}
.auth-trust>span {font-size:14px;line-height:1.4;font-weight:550}.auth-trust small {display:block;font-weight:400;font-size:12px;color:var(--text-secondary);margin-top:3px}
.auth-device-key {display:flex;align-items:center;gap:8px;padding:10px;border:1px solid var(--border-color);border-radius:14px;background:var(--accent-bg);color:var(--text-primary);text-align:left}
.auth-device-key>span {flex:1;font-size:14px;font-weight:650}.auth-device-key small {display:block;font-size:11px;font-weight:400;color:var(--text-secondary);margin-top:2px}.auth-device-key:disabled {opacity:.6}
.auth-handoff {display:grid;gap:14px;padding:24px 20px;background:var(--bg-secondary);border:1px solid var(--border-light);border-radius:20px;text-align:center;justify-items:center}.auth-handoff strong {font-size:20px}.auth-handoff p {font-size:14px;line-height:1.7;color:var(--text-secondary)}.auth-handoff .auth-provider {width:100%}
.auth-story__tile {box-shadow:none;border-color:var(--border-light);border-radius:20px;background:var(--bg-card)}
.auth-card__desc,.auth-tabs--account .auth-tab,.auth-public-links a,.auth-trust small,.auth-device-key small,.auth-signature,.auth-handoff p {color:color-mix(in srgb,var(--text-secondary) 75%,var(--text-primary))}
.auth-public-links {margin-top:8px}
.auth-card :deep(.email-auth__form) {gap:12px}
@media(max-width:850px) {
 .auth-page {padding:max(18px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));align-items:start}
 .auth-shell {max-width:440px}.auth-card {border:0;background:transparent;box-shadow:none;padding:6px 0}.auth-card__header {margin-bottom:14px}
 .auth-card__title {font-size:28px;margin-top:14px}.auth-card__brand {font-size:11px}.auth-card__logo {width:40px;height:40px;border-radius:12px}
 .auth-tabs:not(.auth-tabs--account) {background:color-mix(in srgb,var(--text-primary) 6%,var(--bg-secondary))}
 .auth-field input {background:var(--bg-card)}.auth-trust input {background:var(--bg-card)}.auth-handoff {background:var(--bg-card)}
 .auth-public-links {margin-top:12px}.auth-signature {letter-spacing:.035em}
}
</style>
