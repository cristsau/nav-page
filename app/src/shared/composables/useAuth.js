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

const currentUser = ref(null)
const pendingRequests = ref([])
const approvedUsers = ref([])
const registrationHistory = ref([])
const initialized = ref(false)

async function refreshCurrentUser() {
  currentUser.value = await getCurrentUser()
  return currentUser.value
}

async function refreshAdminData() {
  if (currentUser.value?.role !== 'admin') {
    pendingRequests.value = []
    approvedUsers.value = []
    registrationHistory.value = []
    return
  }

  pendingRequests.value = await getPendingRegistrationRequests()
  approvedUsers.value = await getApprovedUsers()
  registrationHistory.value = await getRegistrationHistory()
}

export function useAuth() {
  async function initAuth() {
    if (initialized.value) return
    await bootstrapSystem()
    await refreshCurrentUser()
    await refreshAdminData()
    initialized.value = true
  }

  async function refreshAll() {
    await bootstrapSystem()
    await refreshCurrentUser()
    await refreshAdminData()
  }

  async function login(username, password) {
    const user = await loginUser(username, password)
    currentUser.value = user
    await refreshAdminData()
    return user
  }

  async function logout() {
    logoutUser()
    currentUser.value = null
    pendingRequests.value = []
    approvedUsers.value = []
    registrationHistory.value = []
  }

  async function register(payload) {
    const request = await registerUser(payload)

    try {
      await sendRegistrationNotification(request)
    } catch (error) {
      console.error('Failed to notify Telegram about registration:', error)
    }

    return request
  }

  async function approve(requestId) {
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
