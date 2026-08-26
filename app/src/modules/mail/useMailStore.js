import { computed, reactive, watch } from 'vue'
import { useAuth } from '@/shared/composables/useAuth'
import {
  fetchEmailAccounts,
  fetchEmailEvent,
  fetchEmailFolders,
  fetchEmailMessage,
  fetchEmailMessages,
  openEmailEventStream
} from '@/shared/services/emailApi'
import {
  createRequestGenerationGate,
  defaultFolderId,
  emptyMessagePage,
  isMailInvalidationEvent,
  markPageInvalidated,
  mergeMessagePage,
  pageKey
} from './mailState'
import { consumeMailSseBody, waitForMailReconnect } from './mailSse'

const PAGE_SIZE = 40
const FALLBACK_POLL_MS = 60_000

function initialMailState() {
  return {
    initialized: false,
    accounts: [],
    defaultAccountId: '',
    foldersByAccount: {},
    pages: {},
    activeAccountId: '',
    activeFolderId: '',
    selectedMessageId: '',
    selectedMessage: null,
    loadingAccounts: false,
    loadingFolders: false,
    loadingMessages: false,
    loadingMore: false,
    loadingDetail: false,
    errorMessage: '',
    streamState: 'idle',
    streamNotice: '',
    lastEventId: '',
    lastRealtimeAt: ''
  }
}

const state = reactive(initialMailState())
const { currentUser: authCurrentUser } = useAuth()
const requestGate = createRequestGenerationGate()

let accountsPromise = null
let boundAuthUserId = ''
let streamController = null
let streamPromise = null
let pollTimer = null
let refreshTimer = null
const folderRequests = new Map()
const pageRefreshRequests = new Map()
const pageLoadMoreRequests = new Map()

function arrayFrom(payload, key) {
  return Array.isArray(payload?.[key]) ? payload[key] : []
}

function normalizedId(value) {
  return String(value || '').trim()
}

function currentAuthUserId() {
  return normalizedId(authCurrentUser.value?.id)
}

function activePageKey() {
  return pageKey(state.activeAccountId, state.activeFolderId)
}

function updateLoadingFlags() {
  state.loadingFolders = folderRequests.has(state.activeAccountId)
  state.loadingMessages = pageRefreshRequests.has(activePageKey())
  state.loadingMore = pageLoadMoreRequests.has(activePageKey())
}

function requestStillCurrent(ticket, ownerUserId) {
  return Boolean(
    ownerUserId
    && ownerUserId === boundAuthUserId
    && ownerUserId === currentAuthUserId()
    && requestGate.isCurrent(ticket)
  )
}

function resetMailStore({ ownerUserId = '' } = {}) {
  stopMailRealtime()
  requestGate.reset()
  accountsPromise = null
  folderRequests.clear()
  pageRefreshRequests.clear()
  pageLoadMoreRequests.clear()
  boundAuthUserId = normalizedId(ownerUserId)
  Object.assign(state, initialMailState())
}

function bindMailStoreToCurrentUser() {
  const userId = currentAuthUserId()
  if (userId !== boundAuthUserId) resetMailStore({ ownerUserId: userId })
  return userId
}

watch(
  () => currentAuthUserId(),
  (userId, previousUserId) => {
    if (userId !== previousUserId) resetMailStore({ ownerUserId: userId })
  }
)

function accountExists(accountId) {
  return state.accounts.some((account) => normalizedId(account.id) === accountId)
}

function folderExists(accountId, folderId) {
  return arrayFrom(state.foldersByAccount, accountId)
    .some((folder) => normalizedId(folder.id) === folderId)
}

function ensurePage(accountId, folderId) {
  const key = pageKey(accountId, folderId)
  if (!state.pages[key]) state.pages[key] = emptyMessagePage()
  return state.pages[key]
}

const activeFolders = computed(() => (
  arrayFrom(state.foldersByAccount, state.activeAccountId)
))

const currentPage = computed(() => (
  state.pages[pageKey(state.activeAccountId, state.activeFolderId)] || emptyMessagePage()
))

const activeAccount = computed(() => (
  state.accounts.find((account) => normalizedId(account.id) === state.activeAccountId) || null
))

const activeFolder = computed(() => (
  activeFolders.value.find((folder) => normalizedId(folder.id) === state.activeFolderId) || null
))

function setError(error, fallback) {
  state.errorMessage = error?.message || fallback
}

export async function loadMailAccounts({ force = false } = {}) {
  const ownerUserId = bindMailStoreToCurrentUser()
  if (!ownerUserId) return []
  if (accountsPromise) return accountsPromise
  if (state.accounts.length && !force) return state.accounts
  state.loadingAccounts = true
  state.errorMessage = ''
  const ticket = requestGate.begin('accounts')
  let requestPromise
  requestPromise = fetchEmailAccounts()
    .then((payload) => {
      if (!requestStillCurrent(ticket, ownerUserId)) return state.accounts
      state.accounts = arrayFrom(payload, 'accounts')
      state.defaultAccountId = normalizedId(payload?.defaultAccountId)
      return state.accounts
    })
    .catch((error) => {
      if (!requestStillCurrent(ticket, ownerUserId)) return state.accounts
      setError(error, '邮箱账号读取失败')
      throw error
    })
    .finally(() => {
      if (accountsPromise === requestPromise) {
        state.loadingAccounts = false
        accountsPromise = null
      }
    })
  accountsPromise = requestPromise
  return accountsPromise
}

export async function loadMailFolders(accountId = state.activeAccountId, { force = false } = {}) {
  const ownerUserId = bindMailStoreToCurrentUser()
  const targetAccountId = normalizedId(accountId)
  if (!ownerUserId || !targetAccountId) return []
  if (!force && arrayFrom(state.foldersByAccount, targetAccountId).length) {
    return arrayFrom(state.foldersByAccount, targetAccountId)
  }
  const existing = folderRequests.get(targetAccountId)
  if (existing && (!force || existing.force)) return existing.promise

  const ticket = requestGate.begin(`folders:${targetAccountId}`)
  let requestPromise
  requestPromise = (async () => {
    try {
      const payload = await fetchEmailFolders(targetAccountId)
      if (!requestStillCurrent(ticket, ownerUserId)) {
        return arrayFrom(state.foldersByAccount, targetAccountId)
      }
      const folders = arrayFrom(payload, 'folders')
      state.foldersByAccount[targetAccountId] = folders
      return folders
    } catch (error) {
      if (!requestStillCurrent(ticket, ownerUserId)) {
        return arrayFrom(state.foldersByAccount, targetAccountId)
      }
      setError(error, '邮件文件夹读取失败')
      throw error
    } finally {
      if (folderRequests.get(targetAccountId)?.promise === requestPromise) {
        folderRequests.delete(targetAccountId)
        updateLoadingFlags()
      }
    }
  })()
  folderRequests.set(targetAccountId, { promise: requestPromise, force })
  updateLoadingFlags()
  return requestPromise
}

export async function loadMailMessages({ replace = true } = {}) {
  const ownerUserId = bindMailStoreToCurrentUser()
  const accountId = state.activeAccountId
  const folderId = state.activeFolderId
  if (!ownerUserId || !accountId || !folderId) return emptyMessagePage()
  const key = pageKey(accountId, folderId)
  const existing = pageRefreshRequests.get(key)
  if (existing && requestGate.isCurrent(existing.ticket) && (!replace || existing.replace)) {
    return existing.promise
  }

  const ticket = requestGate.begin(`messages:${key}`)
  let requestPromise
  requestPromise = (async () => {
    try {
      const payload = await fetchEmailMessages({ accountId, folderId, limit: PAGE_SIZE })
      if (!requestStillCurrent(ticket, ownerUserId)) return ensurePage(accountId, folderId)
      const current = ensurePage(accountId, folderId)
      state.pages[key] = mergeMessagePage(current, payload, { replace })
      return state.pages[key]
    } catch (error) {
      if (!requestStillCurrent(ticket, ownerUserId)) return ensurePage(accountId, folderId)
      setError(error, '邮件列表读取失败')
      throw error
    } finally {
      if (pageRefreshRequests.get(key)?.promise === requestPromise) {
        pageRefreshRequests.delete(key)
        updateLoadingFlags()
      }
    }
  })()
  pageRefreshRequests.set(key, { promise: requestPromise, replace, ticket })
  updateLoadingFlags()
  return requestPromise
}

export async function loadMoreMailMessages() {
  const ownerUserId = bindMailStoreToCurrentUser()
  const accountId = state.activeAccountId
  const folderId = state.activeFolderId
  if (!ownerUserId || !accountId || !folderId) return emptyMessagePage()
  const key = pageKey(accountId, folderId)
  const pendingRefresh = pageRefreshRequests.get(key)
  if (pendingRefresh) await pendingRefresh.promise.catch(() => {})
  if (
    ownerUserId !== boundAuthUserId
    || ownerUserId !== currentAuthUserId()
    || accountId !== state.activeAccountId
    || folderId !== state.activeFolderId
  ) return ensurePage(accountId, folderId)

  const current = ensurePage(accountId, folderId)
  if (!current.hasMore || !current.nextCursor) return current
  const existing = pageLoadMoreRequests.get(key)
  if (existing && requestGate.isCurrent(existing.ticket)) return existing.promise

  const ticket = requestGate.begin(`messages:${key}`)
  const cursor = current.nextCursor
  let requestPromise
  requestPromise = (async () => {
    try {
      const payload = await fetchEmailMessages({
        accountId,
        folderId,
        cursor,
        limit: PAGE_SIZE
      })
      if (!requestStillCurrent(ticket, ownerUserId)) return ensurePage(accountId, folderId)
      const latest = ensurePage(accountId, folderId)
      state.pages[key] = mergeMessagePage(latest, payload)
      return state.pages[key]
    } catch (error) {
      if (!requestStillCurrent(ticket, ownerUserId)) return ensurePage(accountId, folderId)
      setError(error, '更多邮件读取失败')
      throw error
    } finally {
      if (pageLoadMoreRequests.get(key)?.promise === requestPromise) {
        pageLoadMoreRequests.delete(key)
        updateLoadingFlags()
      }
    }
  })()
  pageLoadMoreRequests.set(key, { promise: requestPromise, cursor, ticket })
  updateLoadingFlags()
  return requestPromise
}

export async function selectMailAccount(accountId, { preferredFolderId = '' } = {}) {
  if (!bindMailStoreToCurrentUser()) return
  const targetAccountId = normalizedId(accountId)
  if (!accountExists(targetAccountId)) return
  const changed = targetAccountId !== state.activeAccountId
  state.activeAccountId = targetAccountId
  if (changed) {
    state.activeFolderId = ''
    state.lastEventId = ''
    clearSelectedMailMessage()
  }
  updateLoadingFlags()
  const folders = await loadMailFolders(targetAccountId)
  if (targetAccountId !== state.activeAccountId) return
  const requestedFolderId = normalizedId(preferredFolderId)
  state.activeFolderId = folderExists(targetAccountId, requestedFolderId)
    ? requestedFolderId
    : defaultFolderId(folders)
  updateLoadingFlags()
  await loadMailMessages({ replace: !ensurePage(targetAccountId, state.activeFolderId).loaded })
}

export async function selectMailFolder(folderId) {
  if (!bindMailStoreToCurrentUser()) return
  const targetFolderId = normalizedId(folderId)
  if (!folderExists(state.activeAccountId, targetFolderId)) return
  if (targetFolderId !== state.activeFolderId) {
    state.activeFolderId = targetFolderId
    clearSelectedMailMessage()
  }
  updateLoadingFlags()
  const page = ensurePage(state.activeAccountId, targetFolderId)
  if (!page.loaded || page.invalidated) await loadMailMessages({ replace: true })
}

export async function loadMailMessage(locationId) {
  const ownerUserId = bindMailStoreToCurrentUser()
  const targetLocationId = normalizedId(locationId)
  if (!ownerUserId || !targetLocationId || !state.activeAccountId || !state.activeFolderId) return null
  const accountId = state.activeAccountId
  const folderId = state.activeFolderId
  state.selectedMessageId = targetLocationId
  state.loadingDetail = true
  const ticket = requestGate.begin('detail')
  try {
    const payload = await fetchEmailMessage({
      accountId,
      locationId: targetLocationId,
      folderId
    })
    if (
      !requestStillCurrent(ticket, ownerUserId)
      || state.selectedMessageId !== targetLocationId
      || state.activeAccountId !== accountId
      || state.activeFolderId !== folderId
    ) return null
    state.selectedMessage = payload?.message || payload || null
    return state.selectedMessage
  } catch (error) {
    if (!requestStillCurrent(ticket, ownerUserId)) return null
    setError(error, '邮件详情读取失败')
    throw error
  } finally {
    if (requestStillCurrent(ticket, ownerUserId)) state.loadingDetail = false
  }
}

export async function loadLegacyMailEvent(emailEventId) {
  const ownerUserId = bindMailStoreToCurrentUser()
  const targetId = normalizedId(emailEventId)
  if (!ownerUserId || !targetId) return null
  state.selectedMessageId = `event:${targetId}`
  state.loadingDetail = true
  const ticket = requestGate.begin('detail')
  try {
    const message = await fetchEmailEvent(targetId)
    if (!requestStillCurrent(ticket, ownerUserId) || state.selectedMessageId !== `event:${targetId}`) return null
    state.selectedMessage = { ...message, legacyEvent: true }
    return state.selectedMessage
  } catch (error) {
    if (!requestStillCurrent(ticket, ownerUserId)) return null
    setError(error, '历史分类邮件读取失败')
    throw error
  } finally {
    if (requestStillCurrent(ticket, ownerUserId)) state.loadingDetail = false
  }
}

export function clearSelectedMailMessage() {
  requestGate.invalidate('detail')
  state.selectedMessageId = ''
  state.selectedMessage = null
  state.loadingDetail = false
}

export async function initializeMailStore({ accountId = '', folderId = '' } = {}) {
  const ownerUserId = bindMailStoreToCurrentUser()
  if (!ownerUserId) return
  await loadMailAccounts()
  if (ownerUserId !== boundAuthUserId || ownerUserId !== currentAuthUserId()) return
  const requestedAccountId = normalizedId(accountId)
  const targetAccountId = accountExists(requestedAccountId)
    ? requestedAccountId
    : normalizedId(state.activeAccountId || state.defaultAccountId || state.accounts[0]?.id)
  if (targetAccountId) {
    await selectMailAccount(targetAccountId, { preferredFolderId: folderId })
  }
  if (ownerUserId === boundAuthUserId && ownerUserId === currentAuthUserId()) {
    state.initialized = true
  }
}

async function refreshVisibleMailbox({ replace = false } = {}) {
  const ownerUserId = bindMailStoreToCurrentUser()
  const accountId = state.activeAccountId
  if (!ownerUserId || !accountId) return
  await loadMailFolders(accountId, { force: true })
  if (ownerUserId !== boundAuthUserId || accountId !== state.activeAccountId) return
  if (!folderExists(accountId, state.activeFolderId)) {
    state.activeFolderId = defaultFolderId(activeFolders.value)
    clearSelectedMailMessage()
  }
  if (state.activeFolderId) await loadMailMessages({ replace })
  if (state.selectedMessageId && !state.selectedMessageId.startsWith('event:')) {
    await loadMailMessage(state.selectedMessageId).catch(() => {})
  }
}

function scheduleMailboxRefresh({ replace = false } = {}) {
  if (refreshTimer) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void refreshVisibleMailbox({ replace }).catch(() => {})
  }, 350)
}

function applyStreamEvent({ event, id, payload } = {}) {
  if (id) state.lastEventId = id
  state.lastRealtimeAt = new Date().toISOString()
  const normalizedEvent = String(event || '').toLowerCase()
  if (normalizedEvent === 'ready') {
    // The server sends an authoritative reset marker rather than retaining an
    // unbounded replay log. Refresh after every reconnect so mail received
    // while the stream was down cannot be missed.
    if (payload?.reset === true) scheduleMailboxRefresh({ replace: true })
    return
  }
  if (normalizedEvent === 'heartbeat') return
  if (payload?.accountId && normalizedId(payload.accountId) !== state.activeAccountId) return

  const folderId = normalizedId(payload?.folderId || state.activeFolderId)
  if (folderId && payload && /folder\.counts$/.test(normalizedEvent)) {
    const folder = activeFolders.value.find((item) => normalizedId(item.id) === folderId)
    if (folder) {
      if (Number.isFinite(Number(payload.unreadCount))) folder.unreadCount = Number(payload.unreadCount)
      if (Number.isFinite(Number(payload.totalCount))) folder.totalCount = Number(payload.totalCount)
    }
  }
  if (!isMailInvalidationEvent(normalizedEvent)) return
  const key = pageKey(state.activeAccountId, folderId)
  const marked = markPageInvalidated(state.pages[key], { revision: payload?.revision })
  if (marked.changed) {
    requestGate.invalidate(`messages:${key}`)
    state.pages[key] = marked.page
  }
  scheduleMailboxRefresh({ replace: true })
}

function stopFallbackPolling() {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = null
}

function startFallbackPolling() {
  if (pollTimer) return
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') {
      void refreshVisibleMailbox({ replace: true }).catch(() => {})
    }
  }, FALLBACK_POLL_MS)
}

export function stopMailRealtime() {
  streamController?.abort()
  streamController = null
  streamPromise = null
  stopFallbackPolling()
  if (refreshTimer) window.clearTimeout(refreshTimer)
  refreshTimer = null
  state.streamState = 'idle'
  state.streamNotice = ''
}

export function startMailRealtime() {
  stopMailRealtime()
  const ownerUserId = bindMailStoreToCurrentUser()
  const accountId = state.activeAccountId
  if (!ownerUserId || !accountId) return null
  const controller = new AbortController()
  streamController = controller
  streamPromise = (async () => {
    let reconnectDelay = 1_000
    while (
      !controller.signal.aborted
      && ownerUserId === boundAuthUserId
      && ownerUserId === currentAuthUserId()
      && accountId === state.activeAccountId
    ) {
      try {
        state.streamState = 'connecting'
        state.streamNotice = '正在连接邮件实时更新…'
        const response = await openEmailEventStream({
          accountId,
          lastEventId: state.lastEventId,
          signal: controller.signal
        })
        state.streamState = 'live'
        state.streamNotice = '邮件正在实时更新'
        stopFallbackPolling()
        reconnectDelay = 1_000
        await consumeMailSseBody(response.body, {
          signal: controller.signal,
          onEvent: applyStreamEvent
        })
        if (!controller.signal.aborted) throw new Error('邮件实时连接已断开')
      } catch (error) {
        if (controller.signal.aborted) break
        state.streamState = 'polling'
        state.streamNotice = '实时连接中断，已切换为每分钟自动刷新'
        startFallbackPolling()
        const shouldRetry = await waitForMailReconnect(reconnectDelay, controller.signal)
        if (!shouldRetry) break
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
      }
    }
  })().finally(() => {
    if (streamController === controller) streamController = null
  })
  return streamPromise
}

export function deactivateMailStore() {
  resetMailStore({ ownerUserId: currentAuthUserId() })
}

export function useMailStore() {
  return {
    state,
    activeAccount,
    activeFolder,
    activeFolders,
    currentPage,
    initialize: initializeMailStore,
    selectAccount: selectMailAccount,
    selectFolder: selectMailFolder,
    loadMessage: loadMailMessage,
    loadLegacyEvent: loadLegacyMailEvent,
    loadMore: loadMoreMailMessages,
    refresh: refreshVisibleMailbox,
    clearSelection: clearSelectedMailMessage,
    startRealtime: startMailRealtime,
    stopRealtime: stopMailRealtime,
    deactivate: deactivateMailStore
  }
}
