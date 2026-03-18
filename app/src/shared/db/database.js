import Dexie from 'dexie'

// 创建数据库实例
const db = new Dexie('NavPageDB')

// 定义数据库结构 - 版本2，添加新表
db.version(2).stores({
  // 书签分组
  groups: 'id, name, order, createdAt',
  // 书签/导航链接
  bookmarks: 'id, groupId, title, url, order, createdAt',
  // 时光笔记（原便签）
  notes: 'id, type, title, pinned, encrypted, createdAt, updatedAt',
  // 自定义搜索引擎
  customEngines: 'id, name, order',
  // 分享记录
  shares: 'id, noteId, expireAt, createdAt',
  // 设置
  settings: 'id'
})

// 生成 UUID
export function generateId() {
  return crypto.randomUUID()
}

// 获取当前时间戳
export function getTimestamp() {
  return Date.now()
}

// ========== 分组操作 ==========

export async function getGroups() {
  return db.groups.orderBy('order').toArray()
}

export async function addGroup(group) {
  const count = await db.groups.count()
  const newGroup = {
    id: generateId(),
    name: group.name,
    icon: group.icon || '📁',
    color: group.color || '#3b82f6',
    order: count,
    collapsed: false,
    createdAt: getTimestamp(),
    updatedAt: getTimestamp()
  }
  await db.groups.add(newGroup)
  return newGroup
}

export async function updateGroup(id, updates) {
  await db.groups.update(id, {
    ...updates,
    updatedAt: getTimestamp()
  })
}

export async function deleteGroup(id) {
  await db.bookmarks.where('groupId').equals(id).delete()
  await db.groups.delete(id)
}

export async function reorderGroups(groupIds) {
  await db.transaction('rw', db.groups, async () => {
    for (let i = 0; i < groupIds.length; i++) {
      await db.groups.update(groupIds[i], { order: i })
    }
  })
}

// ========== 书签操作 ==========

export async function getBookmarks(groupId) {
  if (groupId) {
    return db.bookmarks.where('groupId').equals(groupId).orderBy('order').toArray()
  }
  return db.bookmarks.orderBy('order').toArray()
}

export async function getAllBookmarks() {
  return db.bookmarks.orderBy('order').toArray()
}

export async function addBookmark(bookmark) {
  const count = await db.bookmarks.where('groupId').equals(bookmark.groupId).count()
  const newBookmark = {
    id: generateId(),
    groupId: bookmark.groupId,
    title: bookmark.title || 'Untitled',
    url: bookmark.url,
    favicon: bookmark.favicon || '',
    description: bookmark.description || '',
    tags: bookmark.tags || [],
    order: count,
    createdAt: getTimestamp(),
    updatedAt: getTimestamp()
  }
  await db.bookmarks.add(newBookmark)
  return newBookmark
}

export async function updateBookmark(id, updates) {
  await db.bookmarks.update(id, {
    ...updates,
    updatedAt: getTimestamp()
  })
}

export async function deleteBookmark(id) {
  await db.bookmarks.delete(id)
}

export async function reorderBookmarks(groupId, bookmarkIds) {
  await db.transaction('rw', db.bookmarks, async () => {
    for (let i = 0; i < bookmarkIds.length; i++) {
      await db.bookmarks.update(bookmarkIds[i], { order: i, groupId })
    }
  })
}

export async function searchBookmarks(query) {
  const lowerQuery = query.toLowerCase()
  const bookmarks = await db.bookmarks.toArray()
  return bookmarks.filter(b =>
    b.title.toLowerCase().includes(lowerQuery) ||
    b.url.toLowerCase().includes(lowerQuery) ||
    b.description?.toLowerCase().includes(lowerQuery) ||
    b.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
  )
}

// ========== 时光笔记操作 ==========

export async function getNotes(options = {}) {
  let notes = await db.notes.toArray()

  // 按类型过滤
  if (options.type) {
    notes = notes.filter(n => n.type === options.type)
  }

  // 排序：置顶优先，然后按更新时间倒序
  notes.sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned ? 1 : -1
    return b.updatedAt - a.updatedAt
  })

  return notes
}

export async function getNotesByDate(year, month) {
  const notes = await db.notes.where('type').equals('diary').toArray()
  return notes.filter(n => {
    const date = new Date(n.createdAt)
    return date.getFullYear() === year && date.getMonth() === month
  }).sort((a, b) => b.createdAt - a.createdAt)
}

export async function getNote(id) {
  return db.notes.get(id)
}

export async function addNote(note) {
  const newNote = {
    id: generateId(),
    type: note.type || 'memo', // memo(备忘录) | diary(日记)
    title: note.title || '无标题',
    content: note.content || '',
    encrypted: note.encrypted || false,
    password: note.password || '', // 加密后的密码hash
    pinned: note.pinned || false,
    share: {
      enabled: false,
      code: '',
      expireAt: null,
      viewCount: 0
    },
    tags: note.tags || [],
    createdAt: getTimestamp(),
    updatedAt: getTimestamp()
  }
  await db.notes.add(newNote)
  return newNote
}

export async function updateNote(id, updates) {
  await db.notes.update(id, {
    ...updates,
    updatedAt: getTimestamp()
  })
}

export async function deleteNote(id) {
  // 同时删除相关分享
  await db.shares.where('noteId').equals(id).delete()
  await db.notes.delete(id)
}

export async function toggleNotePin(id) {
  const note = await db.notes.get(id)
  if (note) {
    await db.notes.update(id, { pinned: !note.pinned, updatedAt: getTimestamp() })
  }
}

export async function searchNotes(query) {
  const lowerQuery = query.toLowerCase()
  const notes = await db.notes.toArray()
  return notes.filter(n =>
    !n.encrypted && (
      n.title.toLowerCase().includes(lowerQuery) ||
      n.content.toLowerCase().includes(lowerQuery) ||
      n.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
    )
  )
}

// ========== 自定义搜索引擎操作 ==========

export async function getCustomEngines() {
  return db.customEngines.orderBy('order').toArray()
}

export async function addCustomEngine(engine) {
  const count = await db.customEngines.count()
  const newEngine = {
    id: generateId(),
    name: engine.name,
    icon: engine.icon || '🔍',
    url: engine.url, // 使用 {query} 作为占位符
    order: count,
    createdAt: getTimestamp()
  }
  await db.customEngines.add(newEngine)
  return newEngine
}

export async function updateCustomEngine(id, updates) {
  await db.customEngines.update(id, updates)
}

export async function deleteCustomEngine(id) {
  await db.customEngines.delete(id)
}

// ========== 分享操作 ==========

export async function createShare(noteId, expireAt = null) {
  const note = await db.notes.get(noteId)
  if (!note) return null

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

  // 更新笔记的分享状态
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
  const share = await db.shares.where('code').equals(code).first()
  if (!share) return null

  // 检查是否过期
  if (share.expireAt && share.expireAt < getTimestamp()) {
    return null
  }

  // 增加查看次数
  await db.shares.update(share.id, { viewCount: share.viewCount + 1 })

  // 获取笔记内容
  const note = await db.notes.get(share.noteId)
  return { share, note }
}

export async function getSharesByNote(noteId) {
  return db.shares.where('noteId').equals(noteId).toArray()
}

export async function getAllActiveShares() {
  const shares = await db.shares.toArray()
  const now = getTimestamp()
  return shares.filter(s => !s.expireAt || s.expireAt > now)
}

export async function cancelShare(shareId) {
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
  const now = getTimestamp()
  const expiredShares = await db.shares.where('expireAt').below(now).toArray()
  for (const share of expiredShares) {
    await db.notes.update(share.noteId, {
      share: { enabled: false, code: '', expireAt: null, viewCount: 0 }
    })
    await db.shares.delete(share.id)
  }
}

// 生成分享码
function generateShareCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

// ========== 设置操作 ==========

export async function getSetting(id) {
  const setting = await db.settings.get(id)
  return setting?.value
}

export async function setSetting(id, value) {
  await db.settings.put({ id, value })
}

export async function getAllSettings() {
  const settings = await db.settings.toArray()
  return Object.fromEntries(settings.map(s => [s.id, s.value]))
}

// ========== 数据导入导出 ==========

export async function exportData() {
  const groups = await db.groups.toArray()
  const bookmarks = await db.bookmarks.toArray()
  const notes = await db.notes.toArray()
  const customEngines = await db.customEngines.toArray()
  const shares = await db.shares.toArray()
  const settings = await db.settings.toArray()

  return {
    version: 2,
    exportedAt: getTimestamp(),
    data: { groups, bookmarks, notes, customEngines, shares, settings }
  }
}

export async function importData(data) {
  await db.transaction('rw', [db.groups, db.bookmarks, db.notes, db.customEngines, db.shares, db.settings], async () => {
    await db.groups.clear()
    await db.bookmarks.clear()
    await db.notes.clear()
    await db.customEngines.clear()
    await db.shares.clear()
    await db.settings.clear()

    if (data.groups?.length) await db.groups.bulkAdd(data.groups)
    if (data.bookmarks?.length) await db.bookmarks.bulkAdd(data.bookmarks)
    if (data.notes?.length) await db.notes.bulkAdd(data.notes)
    if (data.customEngines?.length) await db.customEngines.bulkAdd(data.customEngines)
    if (data.shares?.length) await db.shares.bulkAdd(data.shares)
    if (data.settings?.length) await db.settings.bulkAdd(data.settings)
  })
}

export async function clearAllData() {
  await db.groups.clear()
  await db.bookmarks.clear()
  await db.notes.clear()
  await db.customEngines.clear()
  await db.shares.clear()
  await db.settings.clear()
}

export default db
