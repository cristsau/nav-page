import { computed, reactive, watch } from 'vue'
import { useAuth } from '@/shared/composables/useAuth'
import {
  createEmailMessageCommand,
  fetchEmailAccountSyncStatus,
  fetchEmailAccounts,
  fetchEmailEvent,
  fetchEmailFolders,
  fetchEmailMessage,
  fetchEmailMessageCommand,
  fetchEmailMessages,
  markEmailFolderAllRead,
  openEmailEventStream,
  requestEmailAccountSync,
  undoEmailMessageCommand
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
import {
  createMailSyncPollEpochGate,
  mailSyncFailureForRequest
} from './mailSyncState'
import { consumeMailSseBody, waitForMailReconnect } from './mailSse'

const PAGE_SIZE = 40
const FALLBACK_POLL_MS = 60_000
const SYNC_STATUS_FAST_POLL_MS = 1_200
const SYNC_STATUS_FAST_POLL_LIMIT = 25
const SYNC_STATUS_SLOW_POLL_MS = 10_000
const SYNC_STATUS_SLOW_POLL_LIMIT = 24
const COMMAND_POLL_MS = 900
const COMMAND_POLL_LIMIT = 150
const TERMINAL_COMMAND_STATUSES = new Set([
  'succeeded', 'failed', 'conflict', 'cancelled', 'canceled', 'undone', 'expired'
])

function initialMailState() {
  return {
    initialized: false,
    accounts: [],
    defaultAccountId: '',
    foldersByAccount: {},
    pages: {},
    activeAccountId: '',
    activeFolderId: '',
    searchQuery: '',
    searchFilter: 'all',
    searchMeta: null,
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
    lastRealtimeAt: '',
    syncState: 'idle',
    syncNotice: '',
    syncError: '',
    syncRequestGeneration: 0,
    syncCompletedGeneration: 0,
    syncRequestedAt: '',
    syncCompletedAt: '',
    commandsByLocation: {},
    commandBusy: false,
    commandError: '',
    markAllReadBusy: false,
    markAllReadNotice: ''
  }
}

const state = reactive(initialMailState())
const { currentUser: authCurrentUser } = useAuth()
const requestGate = createRequestGenerationGate()
const syncPollGate = createMailSyncPollEpochGate()

let accountsPromise = null
let boundAuthUserId = ''
let streamController = null
let streamPromise = null
let pollTimer = null
let refreshTimer = null
let syncStatusTimer = null
let syncRequest = null
const folderRequests = new Map()
const pageRefreshRequests = new Map()
const pageLoadMoreRequests = new Map()
const commandPollTimers = new Map()

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
  stopMailSyncStatusPolling({ invalidate: true })
  for (const timer of commandPollTimers.values()) globalThis.clearTimeout(timer)
  commandPollTimers.clear()
  requestGate.reset()
  accountsPromise = null
  syncRequest = null
  folderRequests.clear()
  pageRefreshRequests.clear()
  pageLoadMoreRequests.clear()
  boundAuthUserId = normalizedId(ownerUserId)
  Object.assign(state, initialMailState())
}

function normalizedCommand(payload, fallback = {}) {
  const source = payload?.command && typeof payload.command === 'object' ? payload.command : payload
  return {
    ...fallback,
    ...(source && typeof source === 'object' ? source : {}),
    id: normalizedId(source?.id || source?.commandId || fallback.id),
    locationId: normalizedId(source?.locationId || fallback.locationId),
    status: String(source?.status || fallback.status || 'scheduled').trim().toLowerCase(),
    undoUntil: source?.undoUntil || payload?.undoUntil || fallback.undoUntil || null,
    errorCode: String(source?.errorCode || source?.lastErrorCode || fallback.errorCode || '').trim(),
    errorMessage: String(source?.errorMessage || source?.lastError || fallback.errorMessage || '').trim()
  }
}

function commandCanUndo(command) {
  if (!command?.id || !['scheduled', 'queued', 'pending'].includes(String(command.status || '').toLowerCase())) return false
  const deadline = new Date(command.undoUntil || 0).getTime()
  return Number.isFinite(deadline) && deadline > Date.now()
}

function messageCommandExpected(message) {
  const remote = message?.remote && typeof message.remote === 'object' ? message.remote : message
  return {
    uidValidity: remote?.uidValidity ?? remote?.uid_validity ?? null,
    modseq: remote?.modseq ?? null,
    seen: message?.flags?.seen === true,
    flagged: message?.flags?.flagged === true,
    deleted: message?.flags?.deleted === true
  }
}

function newIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `mail-${Date.now()}-${Math.random().toString(16).slice(2)}`
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
  const searchKey = `${state.searchQuery}\u0000${state.searchFilter}`
  const existing = pageRefreshRequests.get(key)
  if (existing && existing.searchKey === searchKey && requestGate.isCurrent(existing.ticket) && (!replace || existing.replace)) {
    return existing.promise
  }

  const ticket = requestGate.begin(`messages:${key}`)
  let requestPromise
  requestPromise = (async () => {
    try {
      const payload = await fetchEmailMessages({
        accountId,
        folderId,
        limit: PAGE_SIZE,
        q: state.searchQuery,
        filter: state.searchFilter
      })
      if (!requestStillCurrent(ticket, ownerUserId)) return ensurePage(accountId, folderId)
      const current = ensurePage(accountId, folderId)
      state.pages[key] = mergeMessagePage(current, payload, { replace })
      state.searchMeta = payload?.search || null
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
  pageRefreshRequests.set(key, { promise: requestPromise, replace, ticket, searchKey })
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
        limit: PAGE_SIZE,
        q: state.searchQuery,
        filter: state.searchFilter
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
    stopMailSyncStatusPolling({ invalidate: true })
    syncRequest = null
    state.syncState = 'idle'
    state.syncNotice = ''
    state.syncError = ''
    state.syncRequestGeneration = 0
    state.syncCompletedGeneration = 0
    state.syncRequestedAt = ''
    state.syncCompletedAt = ''
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
  const searchActive = Boolean(state.searchQuery) || state.searchFilter !== 'all'
  await loadMailMessages({ replace: searchActive || !ensurePage(targetAccountId, state.activeFolderId).loaded })
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
  if (!page.loaded || page.invalidated || state.searchQuery || state.searchFilter !== 'all') {
    await loadMailMessages({ replace: true })
  }
}

export async function setMailSearch({ query = '', filter = 'all' } = {}) {
  if (!bindMailStoreToCurrentUser()) return emptyMessagePage()
  const normalizedQuery = String(query || '').trim().slice(0, 120)
  const allowedFilters = new Set(['all', 'unread', 'flagged', 'attachments'])
  const requestedFilter = String(filter || 'all').trim().toLowerCase()
  const normalizedFilter = allowedFilters.has(requestedFilter) ? requestedFilter : 'all'
  if (normalizedQuery === state.searchQuery && normalizedFilter === state.searchFilter) {
    return currentPage.value
  }
  state.searchQuery = normalizedQuery
  state.searchFilter = normalizedFilter
  state.searchMeta = null
  clearSelectedMailMessage()
  return loadMailMessages({ replace: true })
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

function commandForLocation(locationId) {
  return state.commandsByLocation[normalizedId(locationId)] || null
}

async function settleMailMessageCommand(command) {
  const status = String(command?.status || '').toLowerCase()
  const locationId = normalizedId(command?.locationId)
  if (!TERMINAL_COMMAND_STATUSES.has(status)) return
  if (['succeeded', 'undone'].includes(status)) {
    const movesLocation = ['archive', 'move', 'trash', 'delete'].includes(String(command?.action || '').toLowerCase())
    if (movesLocation && state.selectedMessageId === locationId) clearSelectedMailMessage()
    await refreshVisibleMailbox({ replace: true }).catch(() => {})
  }
}

function scheduleMailMessageCommandPoll(command, attempt = 0) {
  const commandId = normalizedId(command?.id)
  const locationId = normalizedId(command?.locationId)
  if (!commandId || !locationId || TERMINAL_COMMAND_STATUSES.has(String(command?.status || '').toLowerCase())) return
  const existing = commandPollTimers.get(commandId)
  if (existing) globalThis.clearTimeout(existing)
  const timer = globalThis.setTimeout(async () => {
    commandPollTimers.delete(commandId)
    if (attempt >= COMMAND_POLL_LIMIT || !currentAuthUserId()) return
    try {
      const payload = await fetchEmailMessageCommand(commandId)
      const latest = normalizedCommand(payload, commandForLocation(locationId) || command)
      state.commandsByLocation[locationId] = latest
      if (TERMINAL_COMMAND_STATUSES.has(latest.status)) await settleMailMessageCommand(latest)
      else scheduleMailMessageCommandPoll(latest, attempt + 1)
    } catch (error) {
      if (attempt + 1 < COMMAND_POLL_LIMIT) scheduleMailMessageCommandPoll(command, attempt + 1)
      else state.commandError = error?.message || '邮件操作状态读取失败'
    }
  }, COMMAND_POLL_MS)
  commandPollTimers.set(commandId, timer)
}

export async function executeMailMessageCommand({
  action,
  targetFolderId = '',
  confirm = '',
  locationId = state.selectedMessageId,
  message = state.selectedMessage
} = {}) {
  const ownerUserId = bindMailStoreToCurrentUser()
  const accountId = normalizedId(state.activeAccountId)
  const targetLocationId = normalizedId(locationId)
  const normalizedAction = String(action || '').trim().toLowerCase()
  const allowedActions = new Set(['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'move', 'trash', 'delete'])
  if (!ownerUserId || !accountId || !targetLocationId || !allowedActions.has(normalizedAction)) {
    throw new Error('邮件操作参数无效')
  }
  if (state.commandBusy) return commandForLocation(targetLocationId)
  state.commandBusy = true
  state.commandError = ''
  try {
    const payload = await createEmailMessageCommand({
      accountId,
      locationId: targetLocationId,
      action: normalizedAction,
      targetFolderId,
      idempotencyKey: newIdempotencyKey(),
      expected: messageCommandExpected(message),
      confirm
    })
    const command = normalizedCommand(payload, {
      locationId: targetLocationId,
      action: normalizedAction,
      targetFolderId: normalizedId(targetFolderId),
      status: 'scheduled'
    })
    state.commandsByLocation[targetLocationId] = command
    if (TERMINAL_COMMAND_STATUSES.has(command.status)) await settleMailMessageCommand(command)
    else scheduleMailMessageCommandPoll(command)
    return command
  } catch (error) {
    state.commandError = error?.message || '邮件操作提交失败'
    throw error
  } finally {
    state.commandBusy = false
  }
}

export async function markActiveMailFolderAllRead() {
  const ownerUserId = bindMailStoreToCurrentUser()
  const accountId = normalizedId(state.activeAccountId)
  const folderId = normalizedId(state.activeFolderId)
  if (!ownerUserId || !accountId || !folderId) throw new Error('当前没有可操作的邮件文件夹')
  if (state.markAllReadBusy) return null
  state.markAllReadBusy = true
  state.markAllReadNotice = ''
  state.commandError = ''
  try {
    const result = await markEmailFolderAllRead({
      accountId,
      folderId,
      idempotencyKey: newIdempotencyKey()
    })
    if (ownerUserId !== boundAuthUserId || accountId !== state.activeAccountId || folderId !== state.activeFolderId) {
      return result
    }
    const page = ensurePage(accountId, folderId)
    page.items = (Array.isArray(page.items) ? page.items : []).map((message) => ({
      ...message,
      unread: false,
      seen: true,
      flags: { ...(message.flags || {}), seen: true }
    }))
    const folder = activeFolders.value.find((item) => normalizedId(item.id) === folderId)
    if (folder) folder.unreadCount = 0
    const account = state.accounts.find((item) => normalizedId(item.id) === accountId)
    if (account) account.unreadCount = Math.max(0, Number(account.unreadCount || 0) - Number(result?.matched || 0))
    if (state.selectedMessage) {
      state.selectedMessage = {
        ...state.selectedMessage,
        unread: false,
        seen: true,
        flags: { ...(state.selectedMessage.flags || {}), seen: true }
      }
    }
    state.markAllReadNotice = Number(result?.matched || 0)
      ? `已提交 ${Number(result.matched)} 封邮件的已读同步。`
      : '当前文件夹没有未读邮件。'
    return result
  } catch (error) {
    state.commandError = error?.message || '一键已读提交失败'
    throw error
  } finally {
    if (ownerUserId === boundAuthUserId) state.markAllReadBusy = false
  }
}

export async function undoMailMessageCommand(locationId = state.selectedMessageId) {
  const targetLocationId = normalizedId(locationId)
  const current = commandForLocation(targetLocationId)
  if (!commandCanUndo(current)) throw new Error('该邮件操作已无法撤销')
  state.commandBusy = true
  state.commandError = ''
  try {
    const payload = await undoEmailMessageCommand(current.id)
    const command = normalizedCommand(payload, current)
    state.commandsByLocation[targetLocationId] = command
    if (TERMINAL_COMMAND_STATUSES.has(command.status)) await settleMailMessageCommand(command)
    else scheduleMailMessageCommandPoll(command)
    return command
  } catch (error) {
    state.commandError = error?.message || '撤销邮件操作失败'
    throw error
  } finally {
    state.commandBusy = false
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

function syncGeneration(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function syncStatusStillCurrent(accountId, ownerUserId, pollEpoch) {
  return Boolean(
    accountId
    && ownerUserId
    && accountId === state.activeAccountId
    && ownerUserId === boundAuthUserId
    && ownerUserId === currentAuthUserId()
    && syncPollGate.isCurrent(pollEpoch)
  )
}

function stopMailSyncStatusPolling({ invalidate = false } = {}) {
  if (syncStatusTimer) globalThis.clearTimeout(syncStatusTimer)
  syncStatusTimer = null
  if (invalidate) syncPollGate.invalidate()
}

function finishMailSyncStatus(payload = {}) {
  state.syncState = 'completed'
  state.syncError = ''
  state.syncCompletedAt = String(payload?.completedAt || new Date().toISOString())
  const lag = Math.max(0, Number(payload?.ingestLagMessages || 0))
  state.syncNotice = lag > 0
    ? `服务器已完成本轮检查，仍有 ${lag} 封邮件正在连续收录。`
    : '服务器同步已完成，邮件列表已刷新。'
  void refreshVisibleMailbox({ replace: true }).catch(() => {})
}

function scheduleMailSyncStatusPoll({ accountId, ownerUserId, generation, pollEpoch, attempt = 0 }) {
  if (!syncStatusStillCurrent(accountId, ownerUserId, pollEpoch)) return
  stopMailSyncStatusPolling()
  if (!syncStatusStillCurrent(accountId, ownerUserId, pollEpoch)) return
  const pollLimit = SYNC_STATUS_FAST_POLL_LIMIT + SYNC_STATUS_SLOW_POLL_LIMIT
  if (attempt >= pollLimit) {
    state.syncState = 'stalled'
    state.syncNotice = '服务器检查仍未回报完成；可再次点“立即收信”重新检查。'
    return
  }
  const pollDelay = attempt < SYNC_STATUS_FAST_POLL_LIMIT
    ? SYNC_STATUS_FAST_POLL_MS
    : SYNC_STATUS_SLOW_POLL_MS
  syncStatusTimer = globalThis.setTimeout(async () => {
    syncStatusTimer = null
    if (!syncStatusStillCurrent(accountId, ownerUserId, pollEpoch)) return
    try {
      const payload = await fetchEmailAccountSyncStatus(accountId)
      if (!syncStatusStillCurrent(accountId, ownerUserId, pollEpoch)) return
      const requested = syncGeneration(payload?.requestGeneration)
      const completed = syncGeneration(payload?.completedGeneration)
      state.syncRequestGeneration = Math.max(state.syncRequestGeneration, requested, generation)
      state.syncCompletedGeneration = Math.max(state.syncCompletedGeneration, completed)
      state.syncRequestedAt = String(payload?.requestedAt || state.syncRequestedAt || '')
      state.syncCompletedAt = String(payload?.completedAt || state.syncCompletedAt || '')
      const targetCompleted = generation > 0
        ? completed >= generation
        : payload?.pending === false
      if (targetCompleted) {
        finishMailSyncStatus(payload)
        return
      }
      const failure = mailSyncFailureForRequest(payload, state.syncRequestedAt)
      if (failure) {
        state.syncState = 'error'
        state.syncError = failure.code
        state.syncNotice = `服务器收信失败（错误代码：${failure.code}），可再次点“立即收信”重试。`
        return
      }
      state.syncState = 'waiting'
      state.syncError = ''
      state.syncNotice = '已请求服务器同步，正在等待新邮件…'
      if (!syncStatusStillCurrent(accountId, ownerUserId, pollEpoch)) return
      scheduleMailSyncStatusPoll({ accountId, ownerUserId, generation, pollEpoch, attempt: attempt + 1 })
    } catch {
      if (!syncStatusStillCurrent(accountId, ownerUserId, pollEpoch)) return
      scheduleMailSyncStatusPoll({ accountId, ownerUserId, generation, pollEpoch, attempt: attempt + 1 })
    }
  }, pollDelay)
}

export async function requestActiveMailboxSync() {
  const ownerUserId = bindMailStoreToCurrentUser()
  const accountId = normalizedId(state.activeAccountId)
  if (!ownerUserId || !accountId) throw new Error('当前没有可同步的邮箱账号')
  if (syncRequest?.accountId === accountId) return syncRequest.promise

  stopMailSyncStatusPolling()
  const pollEpoch = syncPollGate.begin()
  state.syncState = 'requesting'
  state.syncNotice = '正在请求服务器检查新邮件…'
  state.syncError = ''
  let requestPromise
  requestPromise = (async () => {
    try {
      const payload = await requestEmailAccountSync(accountId)
      if (!syncStatusStillCurrent(accountId, ownerUserId, pollEpoch)) return payload
      const generation = syncGeneration(payload?.generation ?? payload?.requestGeneration)
      const completed = syncGeneration(payload?.completedGeneration)
      const status = String(payload?.status || (payload?.coalesced ? 'coalesced' : 'queued')).toLowerCase()
      state.syncRequestGeneration = Math.max(state.syncRequestGeneration, generation)
      state.syncCompletedGeneration = Math.max(state.syncCompletedGeneration, completed)
      state.syncRequestedAt = String(payload?.requestedAt || new Date().toISOString())
      if (generation > 0 && completed >= generation) {
        finishMailSyncStatus(payload)
      } else {
        state.syncState = 'waiting'
        state.syncNotice = status === 'coalesced'
          ? '服务器已在检查邮箱，正在等待新邮件…'
          : '已请求服务器同步，正在等待新邮件…'
        scheduleMailSyncStatusPoll({ accountId, ownerUserId, generation, pollEpoch })
      }
      return payload
    } catch (error) {
      if (syncStatusStillCurrent(accountId, ownerUserId, pollEpoch)) {
        state.syncState = 'error'
        state.syncNotice = ''
        state.syncError = error?.message || '服务器收信请求失败'
      }
      throw error
    } finally {
      if (syncRequest?.promise === requestPromise) syncRequest = null
    }
  })()
  syncRequest = { accountId, promise: requestPromise }
  return requestPromise
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
  if (state.syncState === 'waiting') {
    state.syncNotice = '服务器已发现邮件更新，正在刷新列表…'
  }
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
    executeCommand: executeMailMessageCommand,
    markAllRead: markActiveMailFolderAllRead,
    undoCommand: undoMailMessageCommand,
    commandForLocation,
    commandCanUndo,
    loadMore: loadMoreMailMessages,
    search: setMailSearch,
    requestSync: requestActiveMailboxSync,
    refresh: refreshVisibleMailbox,
    clearSelection: clearSelectedMailMessage,
    startRealtime: startMailRealtime,
    stopRealtime: stopMailRealtime,
    deactivate: deactivateMailStore
  }
}
