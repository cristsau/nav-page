import { computed, ref } from 'vue'
import {
  bootstrapSystem,
  getCurrentUser,
  loginUser,
  logoutUser,
  registerUser,
  getApprovedUsers,
  getPendingRegistrationRequests,
  getRegistrationHistory,
  approveRegistration,
  rejectRegistration
} from '@/shared/db/database'
import {
  sendRegistrationNotification,
  syncTelegramApprovals,
  sendDecisionNotification
} from '@/shared/services/telegramApproval'
import {
  isBackendAuthEnabled,
  fetchBackendSession,
  loginWithBackend,
  loginWithBackendEmail,
  logoutWithBackend,
  updateBackendUsername,
  updateBackendPassword,
  fetchBackendSessions,
  revokeBackendSession,
  revokeOtherBackendSessions,
  revokeAllBackendSessions,
  fetchBackendRecoveryCodeStatus,
  rotateBackendRecoveryCodes,
  recoverBackendAccount,
  registerWithBackend,
  fetchBackendApprovedUsers,
  fetchBackendRegistrationRequests,
  approveBackendRegistration,
  rejectBackendRegistration
} from '@/shared/services/authApi'
import { syncBackendTelegramApprovals } from '@/shared/services/adminTelegramApi'
import {
  onApiUnauthorized,
  resetApiUnauthorizedNotification
} from '@/shared/services/apiClient'
import {
  createSessionCoordinator,
  DEFAULT_SESSION_REVALIDATE_INTERVAL_MS
} from '@/shared/services/sessionCoordinator'

const currentUser = ref(null)
const pendingRequests = ref([])
const approvedUsers = ref([])
const registrationHistory = ref([])
const initialized = ref(false)
const AUTH_SYNC_CHANNEL = 'domo-nav-auth-v1'
const AUTH_SYNC_STORAGE_KEY = 'domo-nav-auth-sync-v1'
const OFFLINE_SESSION_STORAGE_KEY = 'domo-nav-offline-session-v1'
const OFFLINE_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

let authChannel = null
let authLifecycleStarted = false
let authRevalidateTimer = null
let storageListener = null
let visibilityListener = null
let unauthorizedRedirectPending = false

function readOfflineSession() {
  if (typeof window === 'undefined') return null
  try {
    const stored = JSON.parse(window.localStorage?.getItem(OFFLINE_SESSION_STORAGE_KEY) || 'null')
    const validatedAt = Number(stored?.validatedAt || 0)
    if (
      !stored?.user?.id
      || !validatedAt
      || Date.now() - validatedAt > OFFLINE_SESSION_MAX_AGE_MS
    ) return null
    return stored
  } catch {
    return null
  }
}

function writeOfflineSession(user) {
  if (typeof window === 'undefined') return
  try {
    if (!user) {
      window.localStorage?.removeItem(OFFLINE_SESSION_STORAGE_KEY)
      return
    }
    const existing = readOfflineSession()
    window.localStorage?.setItem(OFFLINE_SESSION_STORAGE_KEY, JSON.stringify({
      validatedAt: user.offlineSession
        ? Number(existing?.validatedAt || Date.now())
        : Date.now(),
      user: {
        id: String(user.id),
        username: String(user.username || ''),
        role: String(user.role || 'user'),
        status: String(user.status || 'approved')
      }
    }))
  } catch {
    // Offline access remains best-effort when browser storage is unavailable.
  }
}

function commitCurrentSession(user) {
  currentUser.value = user || null
  writeOfflineSession(currentUser.value)
  if (currentUser.value) return

  pendingRequests.value = []
  approvedUsers.value = []
  registrationHistory.value = []
}

async function resolveCurrentSession() {
  if (isBackendAuthEnabled()) {
    try {
      return await fetchBackendSession()
    } catch (error) {
      if (Number(error?.status) === 401) throw error
      const cached = readOfflineSession()
      if (!cached?.user) throw error
      return {
        ...cached.user,
        offlineSession: true,
        offlineValidatedAt: cached.validatedAt
      }
    }
  }

  await bootstrapSystem()
  return getCurrentUser()
}

const sessionCoordinator = createSessionCoordinator({
  resolveSession: resolveCurrentSession,
  readCachedSession: () => currentUser.value,
  commitSession: commitCurrentSession
})

function clearCurrentAuthState({ resolved = true } = {}) {
  sessionCoordinator.invalidate({ resolved })
  initialized.value = Boolean(resolved)
}

function isSessionInvalidationMessage(value) {
  return value?.type === 'session-invalidated'
}

function redirectToLoginOnce(reason = 'session-expired') {
  if (typeof window === 'undefined' || unauthorizedRedirectPending) return
  if (
    window.location.pathname === '/auth'
    || window.location.pathname === '/auth/oauth-complete'
    || window.location.pathname === '/auth/oauth-complete/'
    || window.location.pathname === '/about'
    || window.location.pathname === '/about/'
    || window.location.pathname === '/privacy'
    || window.location.pathname === '/privacy/'
    || window.location.pathname.startsWith('/share/')
  ) return

  unauthorizedRedirectPending = true
  const redirect = `${window.location.pathname}${window.location.search}${window.location.hash}`
  const query = new URLSearchParams({ redirect, reason })
  window.location.assign(`/auth?${query.toString()}`)
}

function handleExternalSessionInvalidation(message) {
  if (!isSessionInvalidationMessage(message)) return
  clearCurrentAuthState()
  redirectToLoginOnce('session-invalidated')
}

function ensureAuthChannel() {
  if (typeof window === 'undefined' || authChannel) return authChannel
  if (typeof window.BroadcastChannel !== 'function') return null

  authChannel = new window.BroadcastChannel(AUTH_SYNC_CHANNEL)
  authChannel.addEventListener('message', (event) => {
    handleExternalSessionInvalidation(event.data)
  })
  return authChannel
}

function broadcastSessionInvalidation(reason) {
  if (typeof window === 'undefined') return

  const message = {
    type: 'session-invalidated',
    reason,
    at: Date.now(),
    nonce: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
  }

  const channel = ensureAuthChannel()
  if (channel) {
    channel.postMessage(message)
    return
  }

  try {
    window.localStorage?.setItem(AUTH_SYNC_STORAGE_KEY, JSON.stringify(message))
    window.localStorage?.removeItem(AUTH_SYNC_STORAGE_KEY)
  } catch {
    // Cross-tab notification is best-effort when neither browser mechanism works.
  }
}

function invalidateCurrentSession({
  broadcast = false,
  notifyOtherTabs = false,
  redirect = false,
  reason = 'session-invalidated'
} = {}) {
  const wasAuthenticated = Boolean(currentUser.value)
  clearCurrentAuthState()
  if (broadcast && (wasAuthenticated || notifyOtherTabs)) {
    broadcastSessionInvalidation(reason)
  }
  if (redirect) {
    redirectToLoginOnce(reason)
  }
}

async function refreshCurrentUser({ force = true } = {}) {
  const wasAuthenticated = Boolean(currentUser.value)
  const user = await sessionCoordinator.revalidate({ force })
  initialized.value = sessionCoordinator.isInitialized()

  if (wasAuthenticated && !user) {
    invalidateCurrentSession({
      broadcast: true,
      notifyOtherTabs: true,
      redirect: true,
      reason: 'session-expired'
    })
  }

  return user
}

async function revalidateSessionInBackground() {
  if (!isBackendAuthEnabled() || !sessionCoordinator.shouldRevalidate()) {
    return currentUser.value
  }

  try {
    return await refreshCurrentUser({ force: false })
  } catch {
    // A transient network failure must not turn an authenticated in-memory
    // session into a logout. The next visibility change can retry safely.
    return currentUser.value
  }
}

function startAuthSessionLifecycle() {
  if (authLifecycleStarted || typeof window === 'undefined') return
  authLifecycleStarted = true
  ensureAuthChannel()

  storageListener = (event) => {
    if (event.key !== AUTH_SYNC_STORAGE_KEY || !event.newValue) return
    try {
      handleExternalSessionInvalidation(JSON.parse(event.newValue))
    } catch {
      // Ignore malformed same-origin storage events.
    }
  }
  window.addEventListener('storage', storageListener)

  visibilityListener = () => {
    if (document.visibilityState === 'visible') {
      void revalidateSessionInBackground()
    }
  }
  document.addEventListener('visibilitychange', visibilityListener)

  authRevalidateTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') {
      void revalidateSessionInBackground()
    }
  }, DEFAULT_SESSION_REVALIDATE_INTERVAL_MS)
}

function stopAuthSessionLifecycle() {
  if (!authLifecycleStarted || typeof window === 'undefined') return

  if (storageListener) {
    window.removeEventListener('storage', storageListener)
    storageListener = null
  }
  if (visibilityListener) {
    document.removeEventListener('visibilitychange', visibilityListener)
    visibilityListener = null
  }
  if (authRevalidateTimer !== null) {
    window.clearInterval(authRevalidateTimer)
    authRevalidateTimer = null
  }
  authChannel?.close?.()
  authChannel = null
  authLifecycleStarted = false
}

onApiUnauthorized(() => {
  if (!isBackendAuthEnabled()) return
  invalidateCurrentSession({
    broadcast: true,
    redirect: true,
    reason: 'unauthorized'
  })
})

async function refreshAdminData() {
  if (currentUser.value?.role !== 'admin') {
    pendingRequests.value = []
    approvedUsers.value = []
    registrationHistory.value = []
    return
  }

  if (isBackendAuthEnabled()) {
    pendingRequests.value = await fetchBackendRegistrationRequests('pending')
    approvedUsers.value = await fetchBackendApprovedUsers()
    registrationHistory.value = await fetchBackendRegistrationRequests('all')
    return
  }

  pendingRequests.value = await getPendingRegistrationRequests()
  approvedUsers.value = await getApprovedUsers()
  registrationHistory.value = await getRegistrationHistory()
}

export function useAuth() {
  async function initAuth() {
    const user = await sessionCoordinator.initialize()
    initialized.value = sessionCoordinator.isInitialized()
    return user
  }

  async function refreshAll() {
    await refreshCurrentUser()
    await refreshAdminData()
  }

  function acceptAuthenticatedSession(user) {
    const accepted = sessionCoordinator.accept(user)
    initialized.value = true
    unauthorizedRedirectPending = false
    resetApiUnauthorizedNotification()
    return accepted
  }

  async function login(username, password, options = {}) {
    const user = isBackendAuthEnabled()
      ? await loginWithBackend(username, password, options)
      : await loginUser(username, password)

    const accepted = sessionCoordinator.accept(user)
    initialized.value = true
    unauthorizedRedirectPending = false
    resetApiUnauthorizedNotification()
    return accepted
  }

  async function loginWithEmail(proof) {
    if (!isBackendAuthEnabled()) throw new Error('当前认证模式不支持邮箱验证码。')
    const user = await loginWithBackendEmail(proof)
    const accepted = sessionCoordinator.accept(user)
    initialized.value = true
    unauthorizedRedirectPending = false
    resetApiUnauthorizedNotification()
    return accepted
  }

  async function logout() {
    if (isBackendAuthEnabled()) {
      await logoutWithBackend()
    } else {
      logoutUser()
    }

    invalidateCurrentSession({
      broadcast: true,
      reason: 'logout'
    })
  }

  async function getSessions() {
    if (!isBackendAuthEnabled()) return []
    return fetchBackendSessions()
  }

  async function updateUsername(payload) {
    if (!isBackendAuthEnabled()) {
      throw new Error('当前认证模式不支持修改用户名。')
    }

    const result = await updateBackendUsername(payload)
    sessionCoordinator.accept(result.user || currentUser.value)
    initialized.value = true
    return result
  }

  async function updatePassword(payload) {
    if (!isBackendAuthEnabled()) {
      throw new Error('当前认证模式不支持修改密码。')
    }

    const result = await updateBackendPassword(payload)
    invalidateCurrentSession({
      broadcast: true,
      reason: 'credentials-changed'
    })
    return result
  }

  async function revokeSession(sessionId) {
    if (!isBackendAuthEnabled()) {
      throw new Error('当前认证模式不支持会话管理。')
    }

    const result = await revokeBackendSession(sessionId)
    if (result.currentSessionRevoked) {
      invalidateCurrentSession({
        broadcast: true,
        reason: 'session-revoked'
      })
    }
    return result
  }

  async function revokeOtherSessions() {
    if (!isBackendAuthEnabled()) {
      throw new Error('当前认证模式不支持会话管理。')
    }
    return revokeOtherBackendSessions()
  }

  async function revokeAllSessions() {
    if (!isBackendAuthEnabled()) {
      throw new Error('当前认证模式不支持会话管理。')
    }

    const result = await revokeAllBackendSessions()
    invalidateCurrentSession({
      broadcast: true,
      reason: 'all-sessions-revoked'
    })
    return result
  }

  async function getRecoveryCodeStatus() {
    if (!isBackendAuthEnabled()) {
      return {
        configured: false,
        activeCodeCount: 0,
        generatedAt: null
      }
    }
    return fetchBackendRecoveryCodeStatus()
  }

  async function rotateRecoveryCodes(currentPassword) {
    if (!isBackendAuthEnabled()) {
      throw new Error('当前认证模式不支持恢复码。')
    }
    return rotateBackendRecoveryCodes(currentPassword)
  }

  async function recoverAccount(payload) {
    if (!isBackendAuthEnabled()) {
      throw new Error('当前认证模式不支持恢复码。')
    }

    const result = await recoverBackendAccount(payload)
    invalidateCurrentSession({
      broadcast: true,
      reason: 'account-recovered'
    })
    return result
  }

  async function register(payload) {
    if (isBackendAuthEnabled()) {
      return registerWithBackend(payload)
    }

    const request = await registerUser(payload)

    if (!request.autoApproved) {
      try {
        await sendRegistrationNotification(request)
      } catch (error) {
        console.error('Failed to notify Telegram about registration:', error)
      }
    }

    return request
  }

  async function approve(requestId) {
    if (isBackendAuthEnabled()) {
      const result = await approveBackendRegistration(requestId)
      await refreshAdminData()
      return result
    }

    const result = await approveRegistration(requestId, currentUser.value?.username || 'admin')

    try {
      await sendDecisionNotification(result, 'approved')
    } catch (error) {
      console.error('Failed to send approval notification:', error)
    }

    await refreshAdminData()
    return result
  }

  async function reject(requestId) {
    if (isBackendAuthEnabled()) {
      const result = await rejectBackendRegistration(requestId)
      await refreshAdminData()
      return result
    }

    const result = await rejectRegistration(requestId, currentUser.value?.username || 'admin')

    try {
      await sendDecisionNotification(result, 'rejected')
    } catch (error) {
      console.error('Failed to send rejection notification:', error)
    }

    await refreshAdminData()
    return result
  }

  async function syncTelegram() {
    if (isBackendAuthEnabled()) {
      const summary = await syncBackendTelegramApprovals()
      await refreshAdminData()
      return summary
    }

    const summary = await syncTelegramApprovals()
    await refreshAdminData()
    return summary
  }

  return {
    currentUser,
    pendingRequests,
    approvedUsers,
    registrationHistory,
    isAuthenticated: computed(() => Boolean(currentUser.value)),
    isAdmin: computed(() => currentUser.value?.role === 'admin'),
    backendAuthEnabled: computed(() => isBackendAuthEnabled()),
    initAuth,
    startAuthSessionLifecycle,
    stopAuthSessionLifecycle,
    revalidateSessionInBackground,
    refreshAll,
    login,
    acceptAuthenticatedSession,
    loginWithEmail,
    forgetSession: () => invalidateCurrentSession({ broadcast:true, reason:'password-changed' }),
    logout,
    updateUsername,
    updatePassword,
    getSessions,
    revokeSession,
    revokeOtherSessions,
    revokeAllSessions,
    getRecoveryCodeStatus,
    rotateRecoveryCodes,
    recoverAccount,
    register,
    approve,
    reject,
    syncTelegram
  }
}
