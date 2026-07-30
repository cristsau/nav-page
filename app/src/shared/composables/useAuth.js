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
  logoutWithBackend,
  registerWithBackend,
  fetchBackendApprovedUsers,
  fetchBackendRegistrationRequests,
  approveBackendRegistration,
  rejectBackendRegistration
} from '@/shared/services/authApi'
import { syncBackendTelegramApprovals } from '@/shared/services/adminTelegramApi'

const currentUser = ref(null)
const pendingRequests = ref([])
const approvedUsers = ref([])
const registrationHistory = ref([])
const initialized = ref(false)

async function refreshCurrentUser() {
  currentUser.value = isBackendAuthEnabled()
    ? await fetchBackendSession()
    : await getCurrentUser()

  return currentUser.value
}

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
    if (initialized.value) return
    if (!isBackendAuthEnabled()) {
      await bootstrapSystem()
    }
    await refreshCurrentUser()
    await refreshAdminData()
    initialized.value = true
  }

  async function refreshAll() {
    if (!isBackendAuthEnabled()) {
      await bootstrapSystem()
    }
    await refreshCurrentUser()
    await refreshAdminData()
  }

  async function login(username, password) {
    const user = isBackendAuthEnabled()
      ? await loginWithBackend(username, password)
      : await loginUser(username, password)

    currentUser.value = user
    await refreshAdminData()
    return user
  }

  async function logout() {
    if (isBackendAuthEnabled()) {
      await logoutWithBackend()
    } else {
      logoutUser()
    }

    currentUser.value = null
    pendingRequests.value = []
    approvedUsers.value = []
    registrationHistory.value = []
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
    initAuth,
    refreshAll,
    login,
    logout,
    register,
    approve,
    reject,
    syncTelegram
  }
}
