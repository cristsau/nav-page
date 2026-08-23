<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { useAuth } from '@/shared/composables/useAuth'

const {
  currentUser,
  backendAuthEnabled,
  updateUsername,
  updatePassword,
  browserSupportsPasskeys,
  getPasskeyConfig,
  getPasskeys,
  registerPasskey,
  deletePasskey,
  getSessions,
  revokeSession,
  revokeOtherSessions,
  revokeAllSessions,
  getRecoveryCodeStatus,
  rotateRecoveryCodes
} = useAuth()

const sessions = ref([])
const passkeys = ref([])
const passkeyConfig = ref({
  enabled: false,
  canonicalOrigin: '',
  rpId: '',
  passwordOnlyAliasMessage: ''
})
const passkeyBrowserSupported = ref(false)
const passkeyDisplayName = ref('我的 Passkey')
const passkeyCurrentPassword = ref('')
const passkeyAction = ref('')
const recoveryStatus = ref({
  configured: false,
  activeCodeCount: 0,
  generatedAt: null
})
const recoveryCodes = ref([])
const currentPassword = ref('')
const username = ref('')
const usernameCurrentPassword = ref('')
const usernameLoading = ref(false)
const passwordCurrentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordLoading = ref(false)
const loading = ref(false)
const sessionAction = ref('')
const recoveryLoading = ref(false)
const message = ref('')
const errorMessage = ref('')

const currentSession = computed(() => (
  sessions.value.find((session) => session.current) || null
))
const otherSessionCount = computed(() => (
  sessions.value.filter((session) => !session.current).length
))
const onCanonicalPasskeyOrigin = computed(() => (
  typeof window !== 'undefined'
  && Boolean(passkeyConfig.value.canonicalOrigin)
  && window.location.origin === passkeyConfig.value.canonicalOrigin
))
const canRegisterPasskey = computed(() => (
  passkeyConfig.value.enabled
  && onCanonicalPasskeyOrigin.value
  && passkeyBrowserSupported.value
))

watch(
  () => currentUser.value?.username,
  (value) => {
    if (!usernameCurrentPassword.value) username.value = String(value || '')
  },
  { immediate: true }
)

function formatDate(value) {
  if (!value) return '暂无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无记录'

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function describeUserAgent(userAgent) {
  const value = String(userAgent || '')
  if (!value) return '未知浏览器'

  let browser = '浏览器'
  if (/Edg\//.test(value)) browser = 'Microsoft Edge'
  else if (/Firefox\//.test(value)) browser = 'Firefox'
  else if (/CriOS\//.test(value)) browser = 'Chrome'
  else if (/Chrome\//.test(value)) browser = 'Chrome'
  else if (/Safari\//.test(value)) browser = 'Safari'

  let system = '未知系统'
  if (/iPhone/.test(value)) system = 'iPhone'
  else if (/iPad/.test(value)) system = 'iPad'
  else if (/Android/.test(value)) system = 'Android'
  else if (/Windows/.test(value)) system = 'Windows'
  else if (/Macintosh|Mac OS X/.test(value)) system = 'macOS'
  else if (/Linux/.test(value)) system = 'Linux'

  return `${browser} · ${system}`
}

function setFeedback({ message: nextMessage = '', error = '' } = {}) {
  message.value = nextMessage
  errorMessage.value = error
}

function getSecurityErrorMessage(error, fallback) {
  const value = String(error?.message || '')
  if (/too many/i.test(value)) {
    return '操作过于频繁，请稍后再试。'
  }
  if (/current password is incorrect/i.test(value)) {
    return '当前密码不正确。'
  }
  if (/current password is required/i.test(value)) {
    return '请输入当前密码。'
  }
  if (/session not found/i.test(value)) {
    return '该会话已失效，请刷新设备列表。'
  }
  if (/authentication required/i.test(value)) {
    return '登录状态已失效，请重新登录。'
  }
  if (/passkey.+only at|passkey management.+only at/i.test(value)) {
    return 'Passkey 只能在主域名 nav.skrskr.net 管理。'
  }
  if (/passkey authentication is not enabled/i.test(value)) {
    return '服务器暂未启用 Passkey。'
  }
  if (/unable to register|already exists/i.test(value)) {
    return '无法登记这个 Passkey，它可能已经绑定或验证已超时。'
  }
  if (/username is already in use|username already exists/i.test(value)) {
    return '这个用户名已经被使用，请换一个。'
  }
  if (/username of 1 to 128 characters/i.test(value)) {
    return '用户名需要为 1–128 个字符，且不能包含控制字符。'
  }
  if (/password must be at least 12 characters/i.test(value)) {
    return '新密码至少需要 12 个字符。'
  }
  if (/password must be 1024 characters or fewer/i.test(value)) {
    return '密码长度不能超过 1024 个字符。'
  }
  if (/new password must be different/i.test(value)) {
    return '新密码不能与当前密码相同。'
  }
  return value || fallback
}

async function handleUsernameUpdate() {
  if (usernameLoading.value) return
  if (!username.value.trim()) {
    setFeedback({ error: '请输入新用户名。' })
    return
  }
  if (!usernameCurrentPassword.value) {
    setFeedback({ error: '请输入当前密码以验证身份。' })
    return
  }

  usernameLoading.value = true
  setFeedback()
  try {
    const result = await updateUsername({
      username: username.value,
      currentPassword: usernameCurrentPassword.value
    })
    username.value = result.user?.username || username.value.trim().toLowerCase()
    usernameCurrentPassword.value = ''
    setFeedback({
      message: result.changed
        ? '用户名已更新，当前登录会话继续有效。'
        : '用户名没有变化。'
    })
  } catch (error) {
    usernameCurrentPassword.value = ''
    setFeedback({
      error: getSecurityErrorMessage(error, '用户名修改失败，请稍后重试。')
    })
  } finally {
    usernameLoading.value = false
  }
}

async function handlePasswordUpdate() {
  if (passwordLoading.value) return
  if (!passwordCurrentPassword.value) {
    setFeedback({ error: '请输入当前密码以验证身份。' })
    return
  }
  if (newPassword.value.length < 12) {
    setFeedback({ error: '新密码至少需要 12 个字符。' })
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    setFeedback({ error: '两次输入的新密码不一致。' })
    return
  }
  if (!window.confirm(
    '修改密码后，所有设备（包括当前设备）会立即退出登录。确定继续吗？'
  )) {
    return
  }

  passwordLoading.value = true
  setFeedback()
  try {
    await updatePassword({
      currentPassword: passwordCurrentPassword.value,
      newPassword: newPassword.value
    })
    passwordCurrentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    window.location.assign('/auth?passwordChanged=1')
  } catch (error) {
    passwordCurrentPassword.value = ''
    setFeedback({
      error: getSecurityErrorMessage(error, '密码修改失败，请稍后重试。')
    })
    passwordLoading.value = false
  }
}

async function refreshSecurityData() {
  if (!backendAuthEnabled.value || loading.value) return

  loading.value = true
  setFeedback()
  try {
    const [nextSessions, nextRecoveryStatus, nextPasskeyConfig, nextPasskeys] = await Promise.all([
      getSessions(),
      getRecoveryCodeStatus(),
      getPasskeyConfig(),
      getPasskeys()
    ])
    sessions.value = nextSessions
    recoveryStatus.value = nextRecoveryStatus
    passkeyConfig.value = nextPasskeyConfig
    passkeys.value = nextPasskeys
  } catch (error) {
    setFeedback({
      error: getSecurityErrorMessage(
        error,
        '账号安全信息加载失败，请稍后重试。'
      )
    })
  } finally {
    loading.value = false
  }
}

async function handleRegisterPasskey() {
  if (passkeyAction.value) return
  if (!passkeyDisplayName.value.trim()) {
    setFeedback({ error: '请填写 Passkey 名称。' })
    return
  }
  if (!passkeyCurrentPassword.value) {
    setFeedback({ error: '请输入当前密码以登记 Passkey。' })
    return
  }

  passkeyAction.value = 'register'
  setFeedback()
  try {
    const passkey = await registerPasskey({
      displayName: passkeyDisplayName.value,
      currentPassword: passkeyCurrentPassword.value
    })
    passkeys.value = [
      passkey,
      ...passkeys.value.filter((item) => item.id !== passkey.id)
    ]
    passkeyCurrentPassword.value = ''
    setFeedback({ message: 'Passkey 已登记，可在主域名登录页使用。' })
  } catch (error) {
    passkeyCurrentPassword.value = ''
    setFeedback({
      error: error?.name === 'NotAllowedError'
        ? 'Passkey 登记已取消或超时。'
        : getSecurityErrorMessage(error, 'Passkey 登记失败，请稍后重试。')
    })
  } finally {
    passkeyAction.value = ''
  }
}

async function handleDeletePasskey(passkey) {
  if (passkeyAction.value) return
  if (!passkeyCurrentPassword.value) {
    setFeedback({ error: '请输入当前密码后再删除 Passkey。' })
    return
  }
  if (!window.confirm(`确定删除“${passkey.displayName}”吗？此操作不会退出当前会话。`)) {
    return
  }

  passkeyAction.value = passkey.id
  setFeedback()
  try {
    await deletePasskey(passkey.id, passkeyCurrentPassword.value)
    passkeys.value = passkeys.value.filter((item) => item.id !== passkey.id)
    passkeyCurrentPassword.value = ''
    setFeedback({ message: 'Passkey 已删除。' })
  } catch (error) {
    passkeyCurrentPassword.value = ''
    setFeedback({
      error: getSecurityErrorMessage(error, 'Passkey 删除失败，请稍后重试。')
    })
  } finally {
    passkeyAction.value = ''
  }
}

async function handleRevokeSession(session) {
  if (sessionAction.value) return

  const prompt = session.current
    ? '确定退出当前设备吗？操作后需要重新登录。'
    : `确定撤销“${describeUserAgent(session.userAgent)}”的登录会话吗？该设备需要重新登录。`
  if (!window.confirm(prompt)) return

  sessionAction.value = session.id
  setFeedback()
  try {
    const result = await revokeSession(session.id)
    if (result.currentSessionRevoked) {
      window.location.assign('/auth')
      return
    }

    sessions.value = sessions.value.filter((item) => item.id !== session.id)
    setFeedback({ message: '该设备的登录会话已撤销。' })
  } catch (error) {
    setFeedback({
      error: getSecurityErrorMessage(
        error,
        '会话撤销失败，请稍后重试。'
      )
    })
  } finally {
    sessionAction.value = ''
  }
}

async function handleRevokeOthers() {
  if (!otherSessionCount.value || sessionAction.value) return
  if (!window.confirm(
    `确定撤销另外 ${otherSessionCount.value} 个设备的登录会话吗？当前设备会保持登录。`
  )) {
    return
  }

  sessionAction.value = 'others'
  setFeedback()
  try {
    const result = await revokeOtherSessions()
    sessions.value = currentSession.value ? [currentSession.value] : []
    setFeedback({
      message: `已撤销 ${Number(result.revokedCount || 0)} 个其他设备的会话。`
    })
  } catch (error) {
    setFeedback({
      error: getSecurityErrorMessage(
        error,
        '其他设备会话撤销失败，请稍后重试。'
      )
    })
  } finally {
    sessionAction.value = ''
  }
}

async function handleRevokeAll() {
  if (sessionAction.value) return
  if (!window.confirm(
    '确定退出所有设备吗？包括当前设备在内的全部会话会立即失效，需要重新登录。'
  )) {
    return
  }

  sessionAction.value = 'all'
  setFeedback()
  try {
    await revokeAllSessions()
    window.location.assign('/auth')
  } catch (error) {
    setFeedback({
      error: getSecurityErrorMessage(
        error,
        '全部会话撤销失败，请稍后重试。'
      )
    })
    sessionAction.value = ''
  }
}

async function handleRotateRecoveryCodes() {
  if (recoveryLoading.value) return
  if (!currentPassword.value) {
    setFeedback({ error: '请输入当前密码后再生成恢复码。' })
    return
  }

  if (
    recoveryStatus.value.configured
    && !window.confirm('生成新恢复码后，现有恢复码会立即失效。确定继续吗？')
  ) {
    return
  }

  recoveryLoading.value = true
  setFeedback()
  try {
    const result = await rotateRecoveryCodes(currentPassword.value)
    if (!result.codes.length) {
      throw new Error('服务器没有返回恢复码，请勿关闭页面并联系管理员。')
    }

    recoveryCodes.value = [...result.codes]
    recoveryStatus.value = {
      configured: true,
      activeCodeCount: result.codes.length,
      generatedAt: result.generatedAt
    }
    currentPassword.value = ''
    setFeedback({
      message: '新恢复码已生成。它们只显示这一次，请立即复制或下载并安全保存。'
    })
  } catch (error) {
    currentPassword.value = ''
    setFeedback({
      error: getSecurityErrorMessage(
        error,
        '恢复码生成失败，请稍后重试。'
      )
    })
  } finally {
    recoveryLoading.value = false
  }
}

function buildRecoveryCodeText() {
  return [
    'DOMO NAV 账号恢复码',
    `生成时间：${formatDate(recoveryStatus.value.generatedAt)}`,
    '',
    '每个恢复码只能使用一次。生成新恢复码会让旧恢复码失效。',
    '请像保管密码一样离线保存，不要上传到公开位置。',
    '',
    ...recoveryCodes.value
  ].join('\n')
}

async function copyRecoveryCodes() {
  if (!recoveryCodes.value.length) return

  try {
    const text = buildRecoveryCodeText()
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      try {
        textarea.select()
        if (!document.execCommand('copy')) {
          throw new Error('浏览器未允许复制')
        }
      } finally {
        textarea.remove()
      }
    }
    setFeedback({ message: '恢复码已复制到剪贴板。' })
  } catch (error) {
    setFeedback({
      error: error.message || '复制失败，请手动保存恢复码。'
    })
  }
}

function downloadRecoveryCodes() {
  if (!recoveryCodes.value.length) return

  const blob = new Blob([buildRecoveryCodeText()], {
    type: 'text/plain;charset=utf-8'
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `domo-nav-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  setFeedback({ message: '恢复码文件已下载，请移动到安全位置保存。' })
}

function hideRecoveryCodes() {
  recoveryCodes.value = []
  setFeedback({
    message: '恢复码已从当前页面隐藏，刷新后无法再次查看。'
  })
}

onMounted(() => {
  passkeyBrowserSupported.value = browserSupportsPasskeys()
  void refreshSecurityData()
})

onBeforeUnmount(() => {
  recoveryCodes.value = []
  currentPassword.value = ''
  usernameCurrentPassword.value = ''
  passwordCurrentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  passkeyCurrentPassword.value = ''
})
</script>

<template>
  <section v-if="backendAuthEnabled" class="security-section">
    <div class="section-heading">
      <div>
        <h3 class="section-heading__title">账号安全</h3>
        <p class="section-heading__desc">
          管理账号资料、Passkey、已登录设备和一次性恢复码。恢复码不会写入浏览器存储。
        </p>
      </div>
      <button
        class="button button--quiet"
        type="button"
        :disabled="loading"
        @click="refreshSecurityData"
      >
        <Icon name="refresh" :size="16" />
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <p v-if="message" class="feedback feedback--success" aria-live="polite">
      {{ message }}
    </p>
    <p v-if="errorMessage" class="feedback feedback--error" role="alert">
      {{ errorMessage }}
    </p>

    <div class="security-block">
      <div class="block-heading">
        <div>
          <h4>账户资料</h4>
          <p>修改登录用户名或密码。两项操作都需要验证当前密码。</p>
        </div>
      </div>

      <div class="account-forms">
        <form class="account-form" @submit.prevent="handleUsernameUpdate">
          <div class="account-form__heading">
            <Icon name="edit" :size="18" />
            <div>
              <strong>修改用户名</strong>
              <p>修改后当前会话继续有效，页面中的用户名会立即同步。</p>
            </div>
          </div>
          <div class="account-form__fields">
            <label class="security-field">
              <span>新用户名</span>
              <input
                v-model="username"
                name="username"
                type="text"
                autocomplete="username"
                maxlength="128"
                required
              >
            </label>
            <label class="security-field">
              <span>当前密码</span>
              <input
                v-model="usernameCurrentPassword"
                name="username-current-password"
                type="password"
                autocomplete="current-password"
                placeholder="用于确认是本人操作"
                required
              >
            </label>
          </div>
          <button
            class="button button--primary account-form__submit"
            type="submit"
            :disabled="usernameLoading || passwordLoading"
          >
            {{ usernameLoading ? '修改中...' : '保存用户名' }}
          </button>
        </form>

        <form class="account-form" @submit.prevent="handlePasswordUpdate">
          <div class="account-form__heading">
            <Icon name="lock" :size="18" />
            <div>
              <strong>修改密码</strong>
              <p>新密码至少 12 个字符；成功后所有设备都会退出登录。</p>
            </div>
          </div>
          <div class="account-form__fields">
            <label class="security-field">
              <span>当前密码</span>
              <input
                v-model="passwordCurrentPassword"
                name="password-current-password"
                type="password"
                autocomplete="current-password"
                required
              >
            </label>
            <label class="security-field">
              <span>新密码</span>
              <input
                v-model="newPassword"
                name="new-password"
                type="password"
                autocomplete="new-password"
                minlength="12"
                required
              >
            </label>
            <label class="security-field">
              <span>确认新密码</span>
              <input
                v-model="confirmPassword"
                name="confirm-password"
                type="password"
                autocomplete="new-password"
                minlength="12"
                required
              >
            </label>
          </div>
          <button
            class="button button--danger account-form__submit"
            type="submit"
            :disabled="passwordLoading || usernameLoading"
          >
            {{ passwordLoading ? '修改中...' : '修改密码并退出所有设备' }}
          </button>
        </form>
      </div>
    </div>

    <div class="security-block">
      <div class="block-heading">
        <div>
          <h4>Passkey</h4>
          <p>
            使用设备锁屏、指纹或面容登录。唯一 RP ID 为
            <code>{{ passkeyConfig.rpId || 'nav.skrskr.net' }}</code>。
          </p>
        </div>
        <span
          class="status-badge"
          :class="{ 'status-badge--active': passkeyConfig.enabled }"
        >
          {{ passkeyConfig.enabled ? '已启用' : '未启用' }}
        </span>
      </div>

      <div
        v-if="passkeyConfig.enabled && !onCanonicalPasskeyOrigin"
        class="passkey-notice"
      >
        当前别名域只保留密码登录。请前往
        <a :href="passkeyConfig.canonicalOrigin">{{ passkeyConfig.canonicalOrigin }}</a>
        管理和使用 Passkey。
      </div>
      <div v-else-if="!passkeyConfig.enabled" class="passkey-notice">
        服务器默认关闭 Passkey。管理员完成迁移与主域名验收后，可设置
        <code>NAV_WEBAUTHN_ENABLED=true</code> 启用。
      </div>
      <div
        v-else-if="!passkeyBrowserSupported"
        class="passkey-notice"
      >
        当前浏览器不支持 WebAuthn，不能登记新 Passkey。
      </div>

      <div v-if="onCanonicalPasskeyOrigin" class="passkey-form">
        <label class="security-field">
          <span>Passkey 名称</span>
          <input
            v-model="passkeyDisplayName"
            type="text"
            maxlength="128"
            placeholder="例如：iPhone 或办公电脑"
          >
        </label>
        <label class="security-field">
          <span>当前密码</span>
          <input
            v-model="passkeyCurrentPassword"
            type="password"
            autocomplete="current-password"
            placeholder="登记或删除前验证身份"
          >
        </label>
        <button
          class="button button--primary"
          type="button"
          :disabled="!canRegisterPasskey || Boolean(passkeyAction)"
          @click="handleRegisterPasskey"
        >
          <Icon name="key" :size="16" />
          {{ passkeyAction === 'register' ? '登记中...' : '登记新 Passkey' }}
        </button>
      </div>

      <div v-if="passkeys.length" class="passkey-list">
        <article v-for="passkey in passkeys" :key="passkey.id" class="passkey-card">
          <div class="session-card__icon">
            <Icon name="key" :size="20" />
          </div>
          <div class="passkey-card__content">
            <strong>{{ passkey.displayName }}</strong>
            <div class="session-card__meta">
              <span>{{ passkey.backedUp ? '已同步/备份' : '仅此设备' }}</span>
              <span>登记于：{{ formatDate(passkey.createdAt) }}</span>
              <span>最近使用：{{ formatDate(passkey.lastUsedAt) }}</span>
            </div>
          </div>
          <button
            v-if="onCanonicalPasskeyOrigin"
            class="button button--danger"
            type="button"
            :disabled="Boolean(passkeyAction)"
            @click="handleDeletePasskey(passkey)"
          >
            {{ passkeyAction === passkey.id ? '删除中...' : '删除' }}
          </button>
        </article>
      </div>
      <div v-else class="empty-state">
        当前账号还没有登记 Passkey，密码和恢复码登录仍然可用。
      </div>
    </div>

    <div class="security-block">
      <div class="block-heading">
        <div>
          <h4>登录设备</h4>
          <p>当前账号共有 {{ sessions.length }} 个有效会话。</p>
        </div>
        <div class="block-heading__actions">
          <button
            class="button button--quiet"
            type="button"
            :disabled="!otherSessionCount || Boolean(sessionAction)"
            @click="handleRevokeOthers"
          >
            撤销其他设备
          </button>
          <button
            class="button button--danger"
            type="button"
            :disabled="!sessions.length || Boolean(sessionAction)"
            @click="handleRevokeAll"
          >
            退出所有设备
          </button>
        </div>
      </div>

      <div v-if="loading" class="empty-state">正在读取登录设备...</div>
      <div v-else-if="!sessions.length" class="empty-state">
        没有检测到有效登录会话，请刷新后重试。
      </div>
      <div v-else class="session-list">
        <article
          v-for="session in sessions"
          :key="session.id"
          class="session-card"
          :class="{ 'session-card--current': session.current }"
        >
          <div class="session-card__icon">
            <Icon name="browser" :size="20" />
          </div>
          <div class="session-card__content">
            <div class="session-card__title">
              <span>{{ describeUserAgent(session.userAgent) }}</span>
              <span v-if="session.current" class="current-badge">当前设备</span>
            </div>
            <div class="session-card__meta">
              <span>IP：{{ session.ipAddress || '未记录' }}</span>
              <span>登录于：{{ formatDate(session.createdAt) }}</span>
              <span>最近活动：{{ formatDate(session.lastSeenAt) }}</span>
              <span>到期：{{ formatDate(session.expiresAt) }}</span>
            </div>
            <p
              v-if="session.userAgent"
              class="session-card__agent"
              :title="session.userAgent"
            >
              {{ session.userAgent }}
            </p>
          </div>
          <button
            class="button"
            :class="session.current ? 'button--danger' : 'button--quiet'"
            type="button"
            :disabled="Boolean(sessionAction)"
            @click="handleRevokeSession(session)"
          >
            {{
              sessionAction === session.id
                ? '处理中...'
                : session.current
                  ? '退出此设备'
                  : '撤销'
            }}
          </button>
        </article>
      </div>
    </div>

    <div class="security-block">
      <div class="block-heading">
        <div>
          <h4>账号恢复码</h4>
          <p>
            忘记密码时可使用一个恢复码重设密码。成功恢复会让所有设备退出。
          </p>
        </div>
        <span
          class="status-badge"
          :class="{ 'status-badge--active': recoveryStatus.configured }"
        >
          {{ recoveryStatus.configured ? '已配置' : '未配置' }}
        </span>
      </div>

      <div class="recovery-status">
        <div>
          <span>有效恢复码</span>
          <strong>{{ recoveryStatus.activeCodeCount }}</strong>
        </div>
        <div>
          <span>最近生成</span>
          <strong>{{ formatDate(recoveryStatus.generatedAt) }}</strong>
        </div>
      </div>

      <div class="recovery-form">
        <label class="security-field">
          <span>当前密码</span>
          <input
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            placeholder="验证身份后生成新恢复码"
            @keyup.enter="handleRotateRecoveryCodes"
          >
        </label>
        <button
          class="button button--primary"
          type="button"
          :disabled="recoveryLoading"
          @click="handleRotateRecoveryCodes"
        >
          <Icon name="lock" :size="16" />
          {{
            recoveryLoading
              ? '生成中...'
              : recoveryStatus.configured
                ? '轮换恢复码'
                : '生成恢复码'
          }}
        </button>
      </div>

      <div v-if="recoveryCodes.length" class="recovery-codes">
        <div class="recovery-codes__heading">
          <div>
            <strong>仅显示一次</strong>
            <p>关闭或刷新页面后无法再次查看这些恢复码。</p>
          </div>
          <div class="recovery-codes__actions">
            <button class="button button--quiet" type="button" @click="copyRecoveryCodes">
              <Icon name="copy" :size="16" />
              复制全部
            </button>
            <button class="button button--quiet" type="button" @click="downloadRecoveryCodes">
              <Icon name="download" :size="16" />
              下载文本
            </button>
          </div>
        </div>
        <ol class="recovery-codes__grid">
          <li v-for="code in recoveryCodes" :key="code">
            <code>{{ code }}</code>
          </li>
        </ol>
        <button class="button button--quiet" type="button" @click="hideRecoveryCodes">
          我已安全保存，隐藏恢复码
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.security-section {
  padding: 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.section-heading,
.block-heading,
.recovery-codes__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.section-heading {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-light);
}

.section-heading__title,
.block-heading h4 {
  margin: 0;
  color: var(--text-primary);
}

.section-heading__title {
  font-size: 16px;
  font-weight: 600;
}

.section-heading__desc,
.block-heading p,
.recovery-codes__heading p {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.security-block {
  padding: 20px 0;
  border-bottom: 1px solid var(--border-light);
}

.security-block:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.block-heading h4 {
  font-size: 14px;
}

.block-heading__actions,
.recovery-codes__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.button {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    opacity var(--transition-fast);
}

.button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.button--quiet {
  background: var(--bg-secondary);
  border-color: var(--border-light);
  color: var(--text-primary);
}

.button--quiet:hover:not(:disabled) {
  background: var(--bg-hover);
}

.button--primary {
  background: var(--accent-color);
  color: #fff;
}

.button--danger {
  background: color-mix(in srgb, var(--error-color) 12%, var(--bg-secondary));
  border-color: color-mix(in srgb, var(--error-color) 24%, transparent);
  color: var(--error-color);
}

.feedback {
  margin: 14px 0 0;
  padding: 11px 13px;
  border-radius: var(--radius-md);
  font-size: 13px;
  line-height: 1.5;
}

.feedback--success {
  background: color-mix(in srgb, #5a8a6a 14%, var(--bg-secondary));
  color: #5a8a6a;
}

.feedback--error {
  background: color-mix(in srgb, var(--error-color) 12%, var(--bg-secondary));
  color: var(--error-color);
}

.account-forms {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.account-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

.account-form__heading {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  color: var(--accent-color);
}

.account-form__heading > div {
  min-width: 0;
}

.account-form__heading strong {
  color: var(--text-primary);
  font-size: 14px;
}

.account-form__heading p {
  margin: 5px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.55;
}

.account-form__fields {
  display: grid;
  gap: 11px;
}

.account-form__submit {
  width: 100%;
  margin-top: auto;
}

.session-list {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}

.passkey-notice {
  margin-top: 16px;
  padding: 13px 14px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.65;
}

.passkey-notice a {
  color: var(--accent-color);
}

.passkey-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
  align-items: end;
  gap: 10px;
  margin-top: 16px;
}

.passkey-list {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}

.passkey-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

.passkey-card__content {
  min-width: 0;
  color: var(--text-primary);
  font-size: 14px;
}

.session-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

.session-card--current {
  border-color: color-mix(in srgb, var(--accent-color) 42%, var(--border-light));
  background: color-mix(in srgb, var(--accent-color) 7%, var(--bg-secondary));
}

.session-card__icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: var(--bg-card);
  color: var(--accent-color);
}

.session-card__content {
  min-width: 0;
}

.session-card__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
}

.current-badge,
.status-badge {
  flex: 0 0 auto;
  padding: 4px 8px;
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}

.current-badge,
.status-badge--active {
  background: var(--accent-bg);
  color: var(--accent-color);
}

.session-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 14px;
  margin-top: 7px;
  color: var(--text-secondary);
  font-size: 12px;
}

.session-card__agent {
  overflow: hidden;
  margin: 6px 0 0;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-state {
  margin-top: 16px;
  padding: 20px;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
}

.recovery-status {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 16px;
}

.recovery-status > div {
  display: grid;
  gap: 5px;
  padding: 13px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

.recovery-status span {
  color: var(--text-muted);
  font-size: 11px;
}

.recovery-status strong {
  overflow-wrap: anywhere;
  color: var(--text-primary);
  font-size: 13px;
}

.recovery-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 10px;
  margin-top: 14px;
}

.security-field {
  display: grid;
  gap: 7px;
  color: var(--text-primary);
  font-size: 13px;
}

.security-field input {
  width: 100%;
  padding: 11px 13px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  outline: none;
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.security-field input:focus {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 15%, transparent);
}

.recovery-codes {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--accent-color) 36%, var(--border-light));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent-color) 6%, var(--bg-secondary));
}

.recovery-codes__heading strong {
  color: var(--text-primary);
  font-size: 14px;
}

.recovery-codes__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 24px;
  margin: 16px 0;
  padding-left: 28px;
}

.recovery-codes__grid li {
  color: var(--text-muted);
}

.recovery-codes__grid code {
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
  user-select: all;
}

@media (max-width: 720px) {
  .section-heading,
  .block-heading,
  .recovery-codes__heading {
    align-items: stretch;
    flex-direction: column;
  }

  .block-heading__actions,
  .recovery-codes__actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .session-card {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .passkey-form {
    grid-template-columns: 1fr;
  }

  .passkey-card {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .session-card > .button,
  .passkey-card > .button {
    grid-column: 1 / -1;
    width: 100%;
  }

  .recovery-form {
    grid-template-columns: 1fr;
  }

  .account-forms {
    grid-template-columns: 1fr;
  }

  .recovery-codes__grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 480px) {
  .security-section {
    padding: 16px;
  }

  .block-heading__actions,
  .recovery-codes__actions,
  .recovery-status {
    grid-template-columns: 1fr;
  }

  .section-heading > .button,
  .block-heading__actions .button,
  .recovery-codes__actions .button {
    width: 100%;
  }
}
</style>
