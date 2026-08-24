import Dexie from 'dexie'
import { getCurrentUserId } from '@/shared/db/database'
import { apiRequest } from '@/shared/services/apiClient'

export const OFFLINE_SYNC_DB_NAME = 'NavPageOfflineSyncDB'
export const OFFLINE_SYNC_TAG = 'domo-nav-offline-sync'

const db = new Dexie(OFFLINE_SYNC_DB_NAME)
db.version(1).stores({
  notes: '[workspaceUserId+id], workspaceUserId, [workspaceUserId+updatedAt], [workspaceUserId+type], [workspaceUserId+syncState]',
  members: '[workspaceUserId+noteId+memberUserId], workspaceUserId, noteId, memberUserId, role',
  comments: '[workspaceUserId+id], workspaceUserId, noteId, parentId, status, [workspaceUserId+updatedAt]',
  mutations: '&operationId, userId, kind, state, [userId+state], createdAt, nextAttemptAt',
  blobs: '&id, userId, noteId, state, createdAt',
  meta: '[userId+key], userId, key'
})

const syncListeners = new Set()
let activeSyncPromise = null
let lifecycleInstalled = false
let pollTimer = null

function currentUserId() {
  return String(getCurrentUserId() || '').trim()
}

export function createOfflineUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16)
    const value = character === 'x' ? random : ((random & 0x3) | 0x8)
    return value.toString(16)
  })
}

function timestamp(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function normalizeCachedNote(note, userId, syncState = 'synced') {
  return {
    ...note,
    workspaceUserId: userId,
    syncState: note.syncState || syncState,
    cachedAt: timestamp()
  }
}

function emitSyncState(detail) {
  for (const listener of syncListeners) {
    try {
      listener(detail)
    } catch (error) {
      console.error('Offline sync listener failed:', error)
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('domo-nav:offline-sync', { detail }))
  }
}

export function onOfflineSyncState(listener) {
  if (typeof listener !== 'function') return () => {}
  syncListeners.add(listener)
  return () => syncListeners.delete(listener)
}

export async function getOfflineDeviceId() {
  const userId = currentUserId()
  if (!userId) return ''
  const existing = await db.meta.get([userId, 'device-id'])
  if (existing?.value) return existing.value
  const value = createOfflineUuid()
  await db.meta.put({ userId, key: 'device-id', value, updatedAt: timestamp() })
  return value
}

async function getCursor(userId) {
  return Number((await db.meta.get([userId, 'sync-cursor']))?.value || 0)
}

async function setCursor(userId, value) {
  await db.meta.put({
    userId,
    key: 'sync-cursor',
    value: Math.max(0, Number(value || 0)),
    updatedAt: timestamp()
  })
}

export async function getCachedWorkspaceNotes() {
  const userId = currentUserId()
  if (!userId) return []
  const notes = await db.notes.where('workspaceUserId').equals(userId).toArray()
  return notes.sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1
    return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
  })
}

export async function getCachedWorkspaceComments(noteId) {
  const userId = currentUserId()
  if (!userId) return []
  return (await db.comments.where('noteId').equals(noteId).toArray())
    .filter((comment) => comment.workspaceUserId === userId)
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
}

export async function getCachedWorkspaceMembers(noteId) {
  const userId = currentUserId()
  if (!userId) return []
  return (await db.members.where('noteId').equals(noteId).toArray())
    .filter((member) => member.workspaceUserId === userId)
}

async function cacheSnapshot(userId, snapshot) {
  const notes = (snapshot.notes || []).map((note) => normalizeCachedNote(note, userId))
  const members = (snapshot.members || []).map((member) => ({
    ...member,
    workspaceUserId: userId,
    memberUserId: member.userId,
    noteId: member.noteId || ''
  })).filter((member) => member.noteId)
  const comments = (snapshot.comments || []).map((comment) => ({
    ...comment,
    workspaceUserId: userId,
    authorUserId: comment.userId
  }))
  const pendingNotes = await db.notes
    .where('[workspaceUserId+syncState]')
    .anyOf([[userId, 'pending'], [userId, 'conflict'], [userId, 'failed']])
    .toArray()
  const pendingIds = new Set(pendingNotes.map((note) => note.id))

  await db.transaction('rw', db.notes, db.members, db.comments, db.meta, async () => {
    const existingNoteKeys = await db.notes.where('workspaceUserId').equals(userId).primaryKeys()
    const deletable = existingNoteKeys.filter((key) => !pendingIds.has(Array.isArray(key) ? key[1] : ''))
    if (deletable.length) await db.notes.bulkDelete(deletable)
    if (notes.length) await db.notes.bulkPut(notes.filter((note) => !pendingIds.has(note.id)))
    await db.members.where('workspaceUserId').equals(userId).delete()
    await db.comments.where('workspaceUserId').equals(userId).delete()
    if (members.length) await db.members.bulkPut(members)
    if (comments.length) await db.comments.bulkPut(comments)
    await setCursor(userId, snapshot.cursor)
  })
  return getCachedWorkspaceNotes()
}

async function bootstrapWorkspace(userId) {
  const deviceId = await getOfflineDeviceId()
  const label = `${navigator.platform || 'Browser'} · ${navigator.userAgentData?.brands?.[0]?.brand || 'Web'}`
    .slice(0, 120)
  const payload = await apiRequest(
    `/collaboration/sync/bootstrap?deviceId=${encodeURIComponent(deviceId)}&label=${encodeURIComponent(label)}`,
    { method: 'GET' }
  )
  return cacheSnapshot(userId, payload)
}

async function pullWorkspaceChanges(userId) {
  const deviceId = await getOfflineDeviceId()
  let cursor = await getCursor(userId)
  let changed = false
  let hasMore = true
  let pages = 0
  while (hasMore && pages < 20) {
    const payload = await apiRequest(
      `/collaboration/sync/changes?cursor=${cursor}&limit=500&deviceId=${encodeURIComponent(deviceId)}`,
      { method: 'GET' }
    )
    changed ||= Boolean(payload.events?.length)
    cursor = Number(payload.cursor || cursor)
    hasMore = Boolean(payload.hasMore)
    pages += 1
  }
  await setCursor(userId, cursor)
  return changed
}

export async function queueOfflineMutation(kind, payload, {
  operationId = createOfflineUuid(),
  optimisticNote = null
} = {}) {
  const userId = currentUserId()
  if (!userId) throw new Error('当前用户未登录')
  const createdAt = timestamp()
  await db.transaction('rw', db.mutations, db.notes, async () => {
    await db.mutations.put({
      operationId,
      userId,
      kind,
      payload,
      state: 'pending',
      attempts: 0,
      error: '',
      createdAt,
      updatedAt: createdAt,
      nextAttemptAt: createdAt
    })
    if (optimisticNote) {
      await db.notes.put(normalizeCachedNote({
        ...optimisticNote,
        syncState: 'pending',
        pendingOperationId: operationId
      }, userId, 'pending'))
    }
  })
  await requestBackgroundSync()
  emitSyncState({ state: 'pending', operationId, kind })
  return operationId
}

async function pendingMutations(userId, limit = 100) {
  const records = await db.mutations.where('userId').equals(userId).toArray()
  const now = Date.now()
  return records
    .filter((record) => ['pending', 'retry'].includes(record.state))
    .filter((record) => new Date(record.nextAttemptAt || 0).getTime() <= now)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(0, limit)
}

export async function flushOfflineMutations() {
  const userId = currentUserId()
  if (!userId) return { processed: 0, conflicts: 0, failed: 0 }
  const records = await pendingMutations(userId)
  if (!records.length) return { processed: 0, conflicts: 0, failed: 0 }
  emitSyncState({ state: 'syncing', count: records.length })
  let payload
  try {
    payload = await apiRequest('/collaboration/sync/mutations', {
      method: 'POST',
      body: JSON.stringify({
        mutations: records.map(({ operationId, kind, payload: operationPayload }) => ({
          operationId,
          kind,
          payload: operationPayload
        }))
      })
    })
  } catch (error) {
    const nextAttemptAt = timestamp(Date.now() + 30_000)
    await db.transaction('rw', db.mutations, async () => {
      for (const record of records) {
        await db.mutations.update(record.operationId, {
          state: 'retry',
          attempts: Number(record.attempts || 0) + 1,
          error: String(error.message || 'network error').slice(0, 500),
          updatedAt: timestamp(),
          nextAttemptAt
        })
      }
    })
    emitSyncState({ state: 'offline', error: error.message })
    throw error
  }

  let conflicts = 0
  let failed = 0
  await db.transaction('rw', db.mutations, db.notes, db.comments, async () => {
    for (const result of payload.results || []) {
      const record = records.find((item) => item.operationId === result.operationId)
      if (!record) continue
      if (result.status >= 200 && result.status < 300) {
        await db.mutations.delete(result.operationId)
        if (result.note) await db.notes.put(normalizeCachedNote(result.note, userId))
        if (result.comment) {
          await db.comments.put({
            ...result.comment,
            workspaceUserId: userId,
            authorUserId: result.comment.userId
          })
        }
        if (record.kind === 'note.delete') await db.notes.delete([userId, record.payload.id])
        if (record.kind === 'comment.delete') await db.comments.delete([userId, record.payload.id])
        continue
      }
      const state = result.status === 409 ? 'conflict' : 'failed'
      if (state === 'conflict') conflicts += 1
      else failed += 1
      await db.mutations.update(result.operationId, {
        state,
        error: String(result.error || 'sync failed').slice(0, 500),
        serverPayload: result,
        updatedAt: timestamp()
      })
      const noteId = record.payload.id || record.payload.noteId
      if (noteId) await db.notes.update([userId, noteId], { syncState: state })
    }
  })
  emitSyncState({ state: conflicts || failed ? 'attention' : 'synced', conflicts, failed })
  return { processed: records.length, conflicts, failed }
}

export async function synchronizeOfflineWorkspace({ forceBootstrap = false } = {}) {
  if (activeSyncPromise) return activeSyncPromise
  const userId = currentUserId()
  if (!userId) return []
  activeSyncPromise = (async () => {
    try {
      await flushOfflineMutations()
      const cursor = await getCursor(userId)
      const changed = cursor > 0 && !forceBootstrap
        ? await pullWorkspaceChanges(userId)
        : true
      const notes = changed
        ? await bootstrapWorkspace(userId)
        : await getCachedWorkspaceNotes()
      emitSyncState({ state: 'synced', cursor: await getCursor(userId) })
      return notes
    } finally {
      activeSyncPromise = null
    }
  })()
  return activeSyncPromise
}

export async function saveNoteOffline(note, existing = null) {
  const id = existing?.id || note.id || createOfflineUuid()
  const kind = existing?.id ? 'note.update' : 'note.create'
  const optimistic = {
    ...(existing || {}),
    ...note,
    id,
    revision: Number(existing?.revision || 1),
    createdAt: existing?.createdAt || timestamp(),
    updatedAt: timestamp(),
    accessRole: existing?.accessRole || 'owner'
  }
  await queueOfflineMutation(kind, {
    ...note,
    id,
    ...(existing?.id ? { revision: Number(existing.revision || 1) } : {})
  }, { optimisticNote: optimistic })
  try {
    await flushOfflineMutations()
  } catch {
    // The optimistic snapshot remains available until connectivity returns.
  }
  return (await db.notes.get([currentUserId(), id])) || optimistic
}

export async function saveCollaborativeNoteMetadataOffline(note, existing) {
  if (!existing?.id) throw new Error('协作笔记不存在')
  const optimistic = {
    ...existing,
    ...note,
    id: existing.id,
    updatedAt: timestamp(),
    syncState: 'pending'
  }
  await queueOfflineMutation('note.metadata', { ...note, id: existing.id }, {
    optimisticNote: optimistic
  })
  try {
    await flushOfflineMutations()
  } catch {
    // Metadata remains queued until connectivity returns.
  }
  return (await db.notes.get([currentUserId(), existing.id])) || optimistic
}

export async function deleteNoteOffline(note) {
  const userId = currentUserId()
  if (!userId || !note?.id) return
  await queueOfflineMutation('note.delete', { id: note.id })
  await db.notes.delete([userId, note.id])
  try {
    await flushOfflineMutations()
  } catch {
    // Deletion remains queued.
  }
}

export async function createCommentOffline(noteId, data) {
  const id = data.id || createOfflineUuid()
  const userId = currentUserId()
  const optimistic = {
    ...data,
    id,
    noteId,
    userId,
    workspaceUserId: userId,
    authorUserId: userId,
    status: 'open',
    createdAt: timestamp(),
    updatedAt: timestamp(),
    syncState: 'pending'
  }
  await db.comments.put(optimistic)
  await queueOfflineMutation('comment.create', { ...data, id, noteId })
  try {
    await flushOfflineMutations()
  } catch {
    // Comment remains queued.
  }
  return (await db.comments.get([userId, id])) || optimistic
}

export async function updateCommentOffline(noteId, commentId, body) {
  const userId = currentUserId()
  if (!userId) throw new Error('当前用户未登录')
  const existing = await db.comments.get([userId, commentId])
  if (!existing) throw new Error('离线缓存中没有这条评论')
  const optimistic = {
    ...existing,
    body,
    editedAt: timestamp(),
    updatedAt: timestamp(),
    syncState: 'pending'
  }
  await db.comments.put(optimistic)
  await queueOfflineMutation('comment.update', { id: commentId, noteId, body })
  try {
    await flushOfflineMutations()
  } catch {
    // Comment update remains queued.
  }
  return (await db.comments.get([userId, commentId])) || optimistic
}

export async function resolveCommentOffline(noteId, commentId, resolved = true) {
  const userId = currentUserId()
  if (!userId) throw new Error('当前用户未登录')
  const existing = await db.comments.get([userId, commentId])
  if (!existing) throw new Error('离线缓存中没有这条评论')
  const optimistic = {
    ...existing,
    status: resolved ? 'resolved' : 'open',
    resolvedAt: resolved ? timestamp() : null,
    updatedAt: timestamp(),
    syncState: 'pending'
  }
  await db.comments.put(optimistic)
  await queueOfflineMutation('comment.resolve', { id: commentId, noteId, resolved })
  try {
    await flushOfflineMutations()
  } catch {
    // Comment resolution remains queued.
  }
  return (await db.comments.get([userId, commentId])) || optimistic
}

export async function deleteCommentOffline(noteId, commentId) {
  const userId = currentUserId()
  if (!userId) throw new Error('当前用户未登录')
  await queueOfflineMutation('comment.delete', { id: commentId, noteId })
  await db.comments.delete([userId, commentId])
  try {
    await flushOfflineMutations()
  } catch {
    // Comment deletion remains queued.
  }
  return { ok: true, offline: true }
}

export async function requestBackgroundSync() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false
  try {
    const registration = await navigator.serviceWorker.ready
    if (!registration.sync?.register) return false
    await registration.sync.register(OFFLINE_SYNC_TAG)
    return true
  } catch {
    return false
  }
}

export function installOfflineSyncLifecycle({ intervalMs = 20_000 } = {}) {
  if (lifecycleInstalled || typeof window === 'undefined') return () => {}
  lifecycleInstalled = true
  const sync = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      synchronizeOfflineWorkspace().catch(() => {})
    }
  }
  window.addEventListener('online', sync)
  document.addEventListener('visibilitychange', sync)
  pollTimer = window.setInterval(sync, Math.max(10_000, intervalMs))
  return () => {
    window.removeEventListener('online', sync)
    document.removeEventListener('visibilitychange', sync)
    if (pollTimer) window.clearInterval(pollTimer)
    pollTimer = null
    lifecycleInstalled = false
  }
}

export async function offlineSyncSummary() {
  const userId = currentUserId()
  if (!userId) return { pending: 0, conflicts: 0, failed: 0 }
  const records = await db.mutations.where('userId').equals(userId).toArray()
  return {
    pending: records.filter((record) => ['pending', 'retry'].includes(record.state)).length,
    conflicts: records.filter((record) => record.state === 'conflict').length,
    failed: records.filter((record) => record.state === 'failed').length
  }
}
