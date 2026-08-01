import Dexie from 'dexie'

export const CURRENT_USER_STORAGE_KEY = 'nav-current-user-id'
export const TELEGRAM_CONFIG_META_ID = 'telegram-config'

const SYSTEM_DB_NAME = 'NavPageSystemDB'
const USER_DB_PREFIX = 'NavPageDB_'
const MIN_NOTE_NUMBER_ID = 1000
const MAX_NOTE_NUMBER_ID = 999999999999999

const systemDb = new Dexie(SYSTEM_DB_NAME)
systemDb.version(1).stores({
  users: 'id, username, role, status, createdAt, updatedAt',
  registrationRequests: 'id, username, status, createdAt, updatedAt',
  meta: 'id'
})

const userDbCache = new Map()
let bootstrapPromise = null

function createUserDb(userId) {
  const db = new Dexie(`${USER_DB_PREFIX}${userId}`)
  db.version(1).stores({
    groups: 'id, name, order, createdAt',
    bookmarks: 'id, groupId, title, url, order, createdAt',
    notes: 'id, type, title, pinned, encrypted, createdAt, updatedAt',
    customEngines: 'id, name, order',
    shares: 'id, noteId, code, expireAt, createdAt',
    settings: 'id'
  })
  db.version(2).stores({
    groups: 'id, name, order, createdAt',
    bookmarks: 'id, groupId, title, url, order, createdAt',
    notes: 'id, numberId, type, title, pinned, encrypted, createdAt, updatedAt',
    customEngines: 'id, name, order',
    shares: 'id, noteId, code, expireAt, createdAt',
    settings: 'id'
  }).upgrade(async (transaction) => {
    const notes = await transaction.table('notes').toArray()
    if (notes.length) {
      await transaction.table('notes').bulkPut(ensureNoteNumberIds(notes))
    }
  })
  db.version(3).stores({
    groups: 'id, name, order, createdAt',
    bookmarks: 'id, groupId, title, url, order, createdAt',
    notes: 'id, &numberId, type, title, pinned, encrypted, createdAt, updatedAt',
    customEngines: 'id, name, order',
    shares: 'id, noteId, code, expireAt, createdAt',
    settings: 'id'
  }).upgrade(async (transaction) => {
    const notes = await transaction.table('notes').toArray()
    if (notes.length) {
      await transaction.table('notes').bulkPut(ensureNoteNumberIds(notes))
    }
  })
  return db
}

export function ensureNoteNumberIds(notes = []) {
  const normalized = notes.map((note) => ({ ...note }))
  const used = new Set()

  for (const note of normalized) {
    const value = Number(note.numberId)
    if (
      Number.isSafeInteger(value)
      && value >= MIN_NOTE_NUMBER_ID
      && value <= MAX_NOTE_NUMBER_ID
      && !used.has(value)
    ) {
      note.numberId = value
      used.add(value)
    } else {
      note.numberId = null
    }
  }

  let nextNumber = MIN_NOTE_NUMBER_ID
  for (const note of normalized) {
    if (note.numberId) continue
    while (used.has(nextNumber)) nextNumber += 1
    if (nextNumber > MAX_NOTE_NUMBER_ID) {
      throw new Error('笔记数字 ID 已达到上限')
    }
    note.numberId = nextNumber
    used.add(nextNumber)
    nextNumber += 1
  }

  return normalized
}

async function getNextNoteNumberId(db) {
  const notes = ensureNoteNumberIds(await db.notes.toArray())
  if (notes.length) {
    await db.notes.bulkPut(notes)
  }

  const nextNumber = notes.reduce(
    (largest, note) => Math.max(largest, Number(note.numberId) || 999),
    999
  ) + 1

  if (nextNumber > MAX_NOTE_NUMBER_ID) {
    throw new Error('笔记数字 ID 已达到上限')
  }

  return nextNumber
}

function getUserDb(userId = getCurrentUserId()) {
  if (!userId) return null
  if (!userDbCache.has(userId)) {
    userDbCache.set(userId, createUserDb(userId))
  }
  return userDbCache.get(userId)
}

export function getCurrentUserId() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage.getItem(CURRENT_USER_STORAGE_KEY)
}

export function setCurrentUserId(userId) {
  if (typeof window === 'undefined' || !window.localStorage) return
  if (userId) {
    window.localStorage.setItem(CURRENT_USER_STORAGE_KEY, userId)
  } else {
    window.localStorage.removeItem(CURRENT_USER_STORAGE_KEY)
  }
}

function requireUserDb() {
  const db = getUserDb()
  if (!db) {
    throw new Error('Not authenticated')
  }
  return db
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase()
}

function sanitizeUser(user) {
  if (!user) return null
  const { passwordHash, ...rest } = user
  return rest
}

async function hashText(text) {
  const encoder = new TextEncoder()
  const data = encoder.encode(String(text))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

async function verifyHash(text, hash) {
  return (await hashText(text)) === hash
}

export function generateId() {
  return crypto.randomUUID()
}

export function getTimestamp() {
  return Date.now()
}

export async function getMeta(id) {
  const item = await systemDb.meta.get(id)
  return item?.value
}

export async function setMeta(id, value) {
  await systemDb.meta.put({ id, value })
}

export async function getTelegramConfig() {
  await bootstrapSystem()
  return {
    enabled: false,
    botToken: '',
    adminChatId: '',
    ...(await getMeta(TELEGRAM_CONFIG_META_ID))
  }
}

export async function setTelegramConfig(config) {
  await bootstrapSystem()
  const normalized = {
    enabled: Boolean(config?.enabled),
    botToken: String(config?.botToken || '').trim(),
    adminChatId: String(config?.adminChatId || '').trim()
  }

  await setMeta(TELEGRAM_CONFIG_META_ID, normalized)
  return normalized
}

export async function bootstrapSystem() {
  if (!bootstrapPromise) {
    bootstrapPromise = systemDb.open()
  }

  await bootstrapPromise
}

export async function getCurrentUser() {
  await bootstrapSystem()
  const currentUserId = getCurrentUserId()
  if (!currentUserId) return null
  return sanitizeUser(await systemDb.users.get(currentUserId))
}

export async function loginUser(username, password) {
  await bootstrapSystem()
  const normalized = normalizeUsername(username)
  const user = await systemDb.users.where('username').equals(normalized).first()

  if (!user) {
    throw new Error('用户名不存在')
  }

  if (user.status !== 'approved') {
    throw new Error('账号尚未通过审批')
  }

  if (!(await verifyHash(password, user.passwordHash))) {
    throw new Error('密码错误')
  }

  user.lastLoginAt = getTimestamp()
  user.updatedAt = getTimestamp()
  await systemDb.users.put(user)

  const sanitized = sanitizeUser(user)
  setCurrentUserId(sanitized.id)
  return sanitized
}

export function logoutUser() {
  setCurrentUserId(null)
}

export async function registerUser({ username, password }) {
  await bootstrapSystem()
  const normalized = normalizeUsername(username)

  if (!normalized || !password) {
    throw new Error('请填写用户名和密码')
  }

  const passwordHash = await hashText(password)

  return systemDb.transaction(
    'rw',
    [systemDb.users, systemDb.registrationRequests],
    async () => {
      const existingUser = await systemDb.users.where('username').equals(normalized).first()
      if (existingUser) {
        throw new Error('用户名已存在')
      }

      const existingRequest = await systemDb.registrationRequests
        .where('username')
        .equals(normalized)
        .first()
      if (existingRequest && existingRequest.status === 'pending') {
        throw new Error('该账号正在等待审批')
      }

      const now = getTimestamp()
      const approvedUser = await systemDb.users.where('status').equals('approved').first()

      if (!approvedUser) {
        const initialAdmin = {
          id: `user-${generateId()}`,
          username: normalized,
          passwordHash,
          role: 'admin',
          status: 'approved',
          createdAt: now,
          updatedAt: now,
          approvedAt: now
        }
        await systemDb.users.put(initialAdmin)
        return {
          ...sanitizeUser(initialAdmin),
          autoApproved: true
        }
      }

      const request = {
        id: generateId(),
        username: normalized,
        passwordHash,
        status: 'pending',
        createdAt: now,
        updatedAt: now
      }

      await systemDb.registrationRequests.put(request)
      return request
    }
  )
}

export async function getApprovedUsers() {
  await bootstrapSystem()
  const users = await systemDb.users.toArray()
  return users
    .filter((user) => user.status === 'approved')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(sanitizeUser)
}

export async function getPendingRegistrationRequests() {
  await bootstrapSystem()
  const requests = await systemDb.registrationRequests.toArray()
  return requests
    .filter((request) => request.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function getRegistrationHistory() {
  await bootstrapSystem()
  const requests = await systemDb.registrationRequests.toArray()
  return requests.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function approveRegistration(requestId, decidedBy = 'local-admin') {
  await bootstrapSystem()
  const request = await systemDb.registrationRequests.get(requestId)

  if (!request) {
    throw new Error('注册申请不存在')
  }

  if (request.status !== 'pending') {
    return request
  }

  const now = getTimestamp()
  const userId = `user-${request.username}`

  await systemDb.users.put({
    id: userId,
    username: request.username,
    passwordHash: request.passwordHash,
    role: 'user',
    status: 'approved',
    createdAt: request.createdAt,
    updatedAt: now,
    approvedAt: now
  })

  const updatedRequest = {
    ...request,
    status: 'approved',
    updatedAt: now,
    decidedAt: now,
    decidedBy
  }

  await systemDb.registrationRequests.put(updatedRequest)
  return updatedRequest
}

export async function rejectRegistration(requestId, decidedBy = 'local-admin') {
  await bootstrapSystem()
  const request = await systemDb.registrationRequests.get(requestId)

  if (!request) {
    throw new Error('注册申请不存在')
  }

  const now = getTimestamp()
  const updatedRequest = {
    ...request,
    status: 'rejected',
    updatedAt: now,
    decidedAt: now,
    decidedBy
  }

  await systemDb.registrationRequests.put(updatedRequest)
  return updatedRequest
}

export async function findRegistrationRequestById(requestId) {
  await bootstrapSystem()
  return systemDb.registrationRequests.get(requestId)
}

// ========== Groups ==========

export async function getGroups() {
  const db = getUserDb()
  if (!db) return []
  return db.groups.orderBy('order').toArray()
}

export async function addGroup(group) {
  const db = requireUserDb()
  const count = await db.groups.count()
  const now = getTimestamp()
  const newGroup = {
    id: generateId(),
    name: group.name,
    icon: group.icon || 'D',
    color: group.color || '#3b82f6',
    order: count,
    collapsed: false,
    createdAt: now,
    updatedAt: now
  }
  await db.groups.add(newGroup)
  return newGroup
}

export async function updateGroup(id, updates) {
  const db = requireUserDb()
  await db.groups.update(id, {
    ...updates,
    updatedAt: getTimestamp()
  })
}

export async function deleteGroup(id) {
  const db = requireUserDb()
  await db.bookmarks.where('groupId').equals(id).delete()
  await db.groups.delete(id)
}

export async function reorderGroups(groupIds) {
  const db = requireUserDb()
  await db.transaction('rw', db.groups, async () => {
    for (let index = 0; index < groupIds.length; index += 1) {
      await db.groups.update(groupIds[index], { order: index })
    }
  })
}

export async function reorderNavigation(groupIds, bookmarkOrders) {
  const db = requireUserDb()
  const failConflict = () => {
    const conflict = new Error('导航数据已变化，请刷新后重试。')
    conflict.code = 'NAVIGATION_CONFLICT'
    throw conflict
  }
  const normalizeIds = (ids) => [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  )]
  const rawGroupIds = Array.isArray(groupIds) ? groupIds : []
  const orderedGroupIds = normalizeIds(rawGroupIds)
  if (
    !Array.isArray(groupIds)
    || orderedGroupIds.length !== rawGroupIds.length
    || !Array.isArray(bookmarkOrders)
  ) {
    failConflict()
  }

  const normalizedBookmarkOrders = bookmarkOrders.map((entry) => {
    if (!entry || !Array.isArray(entry.ids)) failConflict()
    const rawIds = Array.isArray(entry?.ids) ? entry.ids : []
    const ids = normalizeIds(rawIds)
    const groupId = String(entry?.groupId || '').trim()
    if (!groupId || ids.length !== rawIds.length) failConflict()
    return { groupId, ids }
  })
  const orderGroupIds = normalizedBookmarkOrders.map(({ groupId }) => groupId)
  const uniqueOrderGroupIds = [...new Set(orderGroupIds)]
  if (
    normalizedBookmarkOrders.length !== orderedGroupIds.length
    || uniqueOrderGroupIds.length !== orderGroupIds.length
    || uniqueOrderGroupIds.some((groupId) => !orderedGroupIds.includes(groupId))
  ) {
    failConflict()
  }

  const orderedBookmarkIds = normalizedBookmarkOrders.flatMap(({ ids }) => ids)
  if (new Set(orderedBookmarkIds).size !== orderedBookmarkIds.length) failConflict()

  await db.transaction('rw', db.groups, db.bookmarks, async () => {
    const [currentGroups, currentBookmarks] = await Promise.all([
      db.groups.toArray(),
      db.bookmarks.toArray()
    ])
    const currentGroupIds = currentGroups.map(({ id }) => String(id))
    const currentBookmarkIds = currentBookmarks.map(({ id }) => String(id))
    if (
      currentGroupIds.length !== orderedGroupIds.length
      || currentGroupIds.some((id) => !orderedGroupIds.includes(id))
      || currentBookmarkIds.length !== orderedBookmarkIds.length
      || currentBookmarkIds.some((id) => !orderedBookmarkIds.includes(id))
    ) {
      failConflict()
    }

    const currentBookmarkIdsByGroup = new Map(
      orderedGroupIds.map((groupId) => [
        groupId,
        currentBookmarks
          .filter((bookmark) => String(bookmark.groupId) === groupId)
          .map((bookmark) => String(bookmark.id))
      ])
    )
    for (const { groupId, ids } of normalizedBookmarkOrders) {
      const currentIds = currentBookmarkIdsByGroup.get(groupId) || []
      if (
        currentIds.length !== ids.length
        || currentIds.some((id) => !ids.includes(id))
      ) {
        failConflict()
      }
    }

    const groupsById = new Map(currentGroups.map((group) => [String(group.id), group]))
    const bookmarksById = new Map(
      currentBookmarks.map((bookmark) => [String(bookmark.id), bookmark])
    )
    const updatedGroups = orderedGroupIds.map((id, order) => ({
      ...groupsById.get(id),
      order
    }))
    const updatedBookmarks = normalizedBookmarkOrders.flatMap(({ groupId, ids }) => (
      ids.map((id, order) => ({
        ...bookmarksById.get(id),
        groupId,
        order
      }))
    ))

    if (updatedGroups.length) await db.groups.bulkPut(updatedGroups)
    if (updatedBookmarks.length) await db.bookmarks.bulkPut(updatedBookmarks)
  })
}

// ========== Bookmarks ==========

export async function getBookmarks(groupId) {
  const db = getUserDb()
  if (!db) return []
  if (groupId) {
    return db.bookmarks.where('groupId').equals(groupId).orderBy('order').toArray()
  }
  return db.bookmarks.orderBy('order').toArray()
}

export async function getAllBookmarks() {
  const db = getUserDb()
  if (!db) return []
  return db.bookmarks.orderBy('order').toArray()
}

export async function addBookmark(bookmark) {
  const db = requireUserDb()
  const count = await db.bookmarks.where('groupId').equals(bookmark.groupId).count()
  const now = getTimestamp()
  const newBookmark = {
    id: generateId(),
    groupId: bookmark.groupId,
    title: bookmark.title || 'Untitled',
    url: bookmark.url,
    favicon: bookmark.favicon || '',
    description: bookmark.description || '',
    tags: Array.isArray(bookmark.tags) ? [...bookmark.tags] : [],
    order: count,
    createdAt: now,
    updatedAt: now
  }
  await db.bookmarks.add(newBookmark)
  return newBookmark
}

export async function updateBookmark(id, updates) {
  const db = requireUserDb()
  await db.bookmarks.update(id, {
    ...updates,
    updatedAt: getTimestamp()
  })
}

export async function deleteBookmark(id) {
  await deleteBookmarks([id])
}

export async function deleteBookmarks(ids) {
  const db = requireUserDb()
  const bookmarkIds = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  )]
  if (!bookmarkIds.length) return

  await db.transaction('rw', db.bookmarks, async () => {
    const selected = (await db.bookmarks.bulkGet(bookmarkIds)).filter(Boolean)
    if (selected.length !== bookmarkIds.length) {
      throw new Error('部分书签已不存在，请刷新后重试。')
    }

    const affectedGroupIds = [...new Set(selected.map((bookmark) => bookmark.groupId))]
    await db.bookmarks.bulkDelete(bookmarkIds)

    const updates = []
    for (const groupId of affectedGroupIds) {
      const remaining = (await db.bookmarks.where('groupId').equals(groupId).toArray())
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      updates.push(...remaining.map((bookmark, order) => ({
        ...bookmark,
        order,
        updatedAt: getTimestamp()
      })))
    }
    if (updates.length) await db.bookmarks.bulkPut(updates)
  })
}

export async function moveBookmarks(ids, targetGroupId) {
  const db = requireUserDb()
  const bookmarkIds = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  )]
  const target = String(targetGroupId || '').trim()
  if (!bookmarkIds.length || !target) return

  await db.transaction('rw', db.groups, db.bookmarks, async () => {
    const targetGroup = await db.groups.get(target)
    if (!targetGroup) {
      throw new Error('目标分组已不存在，请刷新后重试。')
    }

    const selected = (await db.bookmarks.bulkGet(bookmarkIds)).filter(Boolean)
    if (selected.length !== bookmarkIds.length) {
      throw new Error('部分书签已不存在，请刷新后重试。')
    }

    const selectedIds = new Set(bookmarkIds)
    const affectedGroupIds = [...new Set([
      target,
      ...selected.map((bookmark) => bookmark.groupId)
    ])]
    const selectedById = new Map(selected.map((bookmark) => [bookmark.id, bookmark]))
    const moving = bookmarkIds.map((id) => selectedById.get(id))
    const updates = []

    for (const groupId of affectedGroupIds) {
      const current = (await db.bookmarks.where('groupId').equals(groupId).toArray())
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .filter((bookmark) => !selectedIds.has(bookmark.id))
      const ordered = groupId === target ? [...current, ...moving] : current

      updates.push(...ordered.map((bookmark, order) => ({
        ...bookmark,
        groupId,
        order
      })))
    }

    await db.bookmarks.bulkPut(updates)
  })
}

export async function reorderBookmarks(groupId, bookmarkIds) {
  const db = requireUserDb()
  await db.transaction('rw', db.bookmarks, async () => {
    for (let index = 0; index < bookmarkIds.length; index += 1) {
      await db.bookmarks.update(bookmarkIds[index], { order: index, groupId })
    }
  })
}

export async function searchBookmarks(query) {
  const db = getUserDb()
  if (!db) return []
  const lowerQuery = query.toLowerCase()
  const bookmarks = await db.bookmarks.toArray()
  return bookmarks.filter((bookmark) =>
    bookmark.title.toLowerCase().includes(lowerQuery) ||
    bookmark.url.toLowerCase().includes(lowerQuery) ||
    bookmark.description?.toLowerCase().includes(lowerQuery) ||
    bookmark.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery))
  )
}

// ========== Notes ==========

export async function getNotes(options = {}) {
  const db = getUserDb()
  if (!db) return []
  let notes = await db.notes.toArray()

  if (options.type) {
    notes = notes.filter((note) => note.type === options.type)
  }

  notes.sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned ? 1 : -1
    return b.updatedAt - a.updatedAt
  })

  return notes
}

export async function getNotesByDate(year, month) {
  const db = getUserDb()
  if (!db) return []
  const notes = await db.notes.where('type').equals('diary').toArray()
  return notes
    .filter((note) => {
      const date = new Date(note.entryDate ? `${note.entryDate}T00:00:00` : note.createdAt)
      return date.getFullYear() === year && date.getMonth() === month
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function getNote(id) {
  const db = getUserDb()
  if (!db) return null
  return db.notes.get(id)
}

export async function addNote(note) {
  const db = requireUserDb()
  return db.transaction('rw', db.notes, async () => {
    const now = getTimestamp()
    const newNote = {
      id: generateId(),
      numberId: await getNextNoteNumberId(db),
      type: note.type || 'memo',
      title: note.title || '无标题',
      content: note.content || '',
      encrypted: note.encrypted || false,
      password: note.password || '',
      pinned: note.pinned || false,
      share: {
        enabled: false,
        code: '',
        expireAt: null,
        viewCount: 0
      },
      tags: Array.isArray(note.tags) ? [...note.tags] : [],
      entryDate: note.type === 'diary'
        ? (note.entryDate || new Date(now).toISOString().slice(0, 10))
        : '',
      mood: note.type === 'diary' ? String(note.mood || '') : '',
      dueAt: note.type === 'memo' ? (note.dueAt || null) : null,
      completed: note.type === 'memo' && Boolean(note.completed),
      attachments: Array.isArray(note.attachments) ? [...note.attachments] : [],
      createdAt: now,
      updatedAt: now
    }
    await db.notes.add(newNote)
    return newNote
  })
}

export async function updateNote(id, updates) {
  const db = requireUserDb()
  await db.notes.update(id, {
    ...updates,
    updatedAt: getTimestamp()
  })
}

export async function deleteNote(id) {
  const db = requireUserDb()
  await db.shares.where('noteId').equals(id).delete()
  await db.notes.delete(id)
}

export async function toggleNotePin(id) {
  const db = requireUserDb()
  const note = await db.notes.get(id)
  if (note) {
    await db.notes.update(id, { pinned: !note.pinned, updatedAt: getTimestamp() })
  }
}

export async function searchNotes(query) {
  const db = getUserDb()
  if (!db) return []
  const lowerQuery = String(query || '').trim().toLowerCase()
  const numberQuery = /^#?\d+$/.test(lowerQuery)
    ? lowerQuery.replace(/^#/, '')
    : ''
  const notes = await db.notes.toArray()
  return notes.filter((note) =>
    !note.encrypted && (
      (numberQuery && String(note.numberId || '') === numberQuery) ||
      note.title.toLowerCase().includes(lowerQuery) ||
      note.content.toLowerCase().includes(lowerQuery) ||
      note.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery))
    )
  )
}

// ========== Search Engines ==========

export async function getCustomEngines() {
  const db = getUserDb()
  if (!db) return []
  return db.customEngines.orderBy('order').toArray()
}

export async function addCustomEngine(engine) {
  const db = requireUserDb()
  const count = await db.customEngines.count()
  const newEngine = {
    id: generateId(),
    name: engine.name,
    icon: engine.icon || 'S',
    url: engine.url,
    order: count,
    createdAt: getTimestamp()
  }
  await db.customEngines.add(newEngine)
  return newEngine
}

export async function updateCustomEngine(id, updates) {
  const db = requireUserDb()
  await db.customEngines.update(id, updates)
}

export async function deleteCustomEngine(id) {
  const db = requireUserDb()
  await db.customEngines.delete(id)
}

// ========== Shares ==========

export async function createShare(noteId, expireAt = null) {
  const db = requireUserDb()
  const note = await db.notes.get(noteId)
  if (!note) return null
  if (note.encrypted) {
    throw new Error('加密笔记不能创建公开分享')
  }

  const shareCode = generateShareCode()
  const share = {
    id: generateId(),
    noteId,
    code: shareCode,
    expireAt,
    viewCount: 0,
    createdAt: getTimestamp()
  }

  await db.shares.add(share)
  await db.notes.update(noteId, {
    share: {
      enabled: true,
      code: shareCode,
      expireAt,
      viewCount: 0
    },
    updatedAt: getTimestamp()
  })

  return share
}

export async function getShareByCode(code) {
  const db = getUserDb()
  if (!db) return null
  const share = await db.shares.where('code').equals(code).first()
  if (!share) return null
  if (share.expireAt && share.expireAt < getTimestamp()) return null

  const note = await db.notes.get(share.noteId)
  if (!note || note.encrypted) return null

  await db.shares.update(share.id, { viewCount: share.viewCount + 1 })
  return { share, note }
}

export async function getSharesByNote(noteId) {
  const db = getUserDb()
  if (!db) return []
  return db.shares.where('noteId').equals(noteId).toArray()
}

export async function getAllActiveShares() {
  const db = getUserDb()
  if (!db) return []
  const shares = await db.shares.toArray()
  const now = getTimestamp()
  return shares.filter((share) => !share.expireAt || share.expireAt > now)
}

export async function cancelShare(shareId) {
  const db = requireUserDb()
  const share = await db.shares.get(shareId)
  if (share) {
    await db.notes.update(share.noteId, {
      share: { enabled: false, code: '', expireAt: null, viewCount: 0 },
      updatedAt: getTimestamp()
    })
    await db.shares.delete(shareId)
  }
}

export async function deleteExpiredShares() {
  const db = requireUserDb()
  const now = getTimestamp()
  const expiredShares = await db.shares.where('expireAt').below(now).toArray()

  for (const share of expiredShares) {
    await db.notes.update(share.noteId, {
      share: { enabled: false, code: '', expireAt: null, viewCount: 0 }
    })
    await db.shares.delete(share.id)
  }
}

function generateShareCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const values = crypto.getRandomValues(new Uint32Array(8))
  let code = ''
  for (const value of values) {
    code += chars.charAt(value % chars.length)
  }
  return code
}

// ========== Settings ==========

export async function getSetting(id) {
  const db = getUserDb()
  if (!db) return undefined
  const setting = await db.settings.get(id)
  return setting?.value
}

export async function setSetting(id, value) {
  const db = requireUserDb()
  await db.settings.put({ id, value })
}

export async function getAllSettings() {
  const db = getUserDb()
  if (!db) return {}
  const settings = await db.settings.toArray()
  return Object.fromEntries(settings.map((setting) => [setting.id, setting.value]))
}

// ========== Import / Export ==========

export async function exportData() {
  const db = requireUserDb()
  const groups = await db.groups.toArray()
  const bookmarks = await db.bookmarks.toArray()
  const notes = await db.notes.toArray()
  const customEngines = await db.customEngines.toArray()
  const shares = await db.shares.toArray()
  const settings = await db.settings.toArray()

  return {
    version: 1,
    exportedAt: getTimestamp(),
    data: { groups, bookmarks, notes, customEngines, shares, settings }
  }
}

export async function importData(data) {
  const db = requireUserDb()
  await db.transaction('rw', [db.groups, db.bookmarks, db.notes, db.customEngines, db.shares, db.settings], async () => {
    await db.groups.clear()
    await db.bookmarks.clear()
    await db.notes.clear()
    await db.customEngines.clear()
    await db.shares.clear()
    await db.settings.clear()

    if (data.groups?.length) await db.groups.bulkAdd(data.groups)
    if (data.bookmarks?.length) await db.bookmarks.bulkAdd(data.bookmarks)
    if (data.notes?.length) await db.notes.bulkAdd(ensureNoteNumberIds(data.notes))
    if (data.customEngines?.length) await db.customEngines.bulkAdd(data.customEngines)
    if (data.shares?.length) await db.shares.bulkAdd(data.shares)
    if (data.settings?.length) await db.settings.bulkAdd(data.settings)
  })
}

export async function clearAllData() {
  const db = requireUserDb()
  await db.groups.clear()
  await db.bookmarks.clear()
  await db.notes.clear()
  await db.customEngines.clear()
  await db.shares.clear()
  await db.settings.clear()
}

export async function getLocalDataSummary() {
  const db = getUserDb()
  if (!db) {
    return {
      groups: 0,
      bookmarks: 0,
      notes: 0,
      customEngines: 0,
      shares: 0,
      settings: 0,
      total: 0
    }
  }

  const [groups, bookmarks, notes, customEngines, shares, settings] = await Promise.all([
    db.groups.count(),
    db.bookmarks.count(),
    db.notes.count(),
    db.customEngines.count(),
    db.shares.count(),
    db.settings.count()
  ])

  return {
    groups,
    bookmarks,
    notes,
    customEngines,
    shares,
    settings,
    total: groups + bookmarks + notes + customEngines + shares + settings
  }
}

export default systemDb
