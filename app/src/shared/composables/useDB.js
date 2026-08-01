import { ref } from 'vue'
import {
  getGroups,
  addGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
  reorderNavigation as reorderLocalNavigation,
  getBookmarks,
  getAllBookmarks,
  addBookmark,
  updateBookmark,
  deleteBookmark,
  deleteBookmarks,
  moveBookmarks as moveLocalBookmarks,
  reorderBookmarks,
  searchBookmarks
} from '@/shared/db/database'
import {
  shouldUseBackendNavigation,
  fetchBackendGroups,
  createBackendGroup,
  updateBackendGroup,
  deleteBackendGroup,
  reorderBackendGroups,
  reorderBackendNavigation,
  fetchBackendBookmarks,
  createBackendBookmark,
  updateBackendBookmark,
  deleteBackendBookmark,
  reorderBackendBookmarks,
  moveBackendBookmarks,
  deleteBackendBookmarks,
  checkBackendBookmarkHealth,
  searchBackendBookmarks
} from '@/shared/services/navigationApi'

const MAX_BULK_BOOKMARK_IDS = 100

export function useGroups() {
  const groups = ref([])
  const loading = ref(false)
  const error = ref(null)

  async function load() {
    loading.value = true
    error.value = null
    try {
      groups.value = shouldUseBackendNavigation()
        ? await fetchBackendGroups()
        : await getGroups()
    } catch (e) {
      error.value = e
      console.error('Failed to load groups:', e)
    } finally {
      loading.value = false
    }
  }

  async function create(group) {
    const newGroup = shouldUseBackendNavigation()
      ? await createBackendGroup(group)
      : await addGroup(group)

    groups.value.push(newGroup)
    return newGroup
  }

  async function update(id, updates) {
    const updatedGroup = shouldUseBackendNavigation()
      ? await updateBackendGroup(id, updates)
      : (await updateGroup(id, updates), { id, ...updates })

    const index = groups.value.findIndex((group) => group.id === id)
    if (index !== -1) {
      groups.value[index] = { ...groups.value[index], ...updatedGroup }
    }
  }

  async function remove(id) {
    if (shouldUseBackendNavigation()) {
      await deleteBackendGroup(id)
    } else {
      await deleteGroup(id)
    }

    groups.value = groups.value.filter((group) => group.id !== id)
  }

  async function reorder(newOrder) {
    if (shouldUseBackendNavigation()) {
      await reorderBackendGroups(newOrder)
    } else {
      await reorderGroups(newOrder)
    }

    const orderMap = new Map(newOrder.map((id, index) => [id, index]))
    groups.value.sort((a, b) => orderMap.get(a.id) - orderMap.get(b.id))
  }

  async function reorderAll(groupIds, bookmarkOrders) {
    if (shouldUseBackendNavigation()) {
      await reorderBackendNavigation(groupIds, bookmarkOrders)
    } else {
      await reorderLocalNavigation(groupIds, bookmarkOrders)
    }

    const orderMap = new Map(groupIds.map((id, index) => [id, index]))
    groups.value.sort((left, right) => orderMap.get(left.id) - orderMap.get(right.id))
  }

  return {
    groups,
    loading,
    error,
    load,
    create,
    update,
    remove,
    reorder,
    reorderAll
  }
}

export function useBookmarks() {
  const bookmarks = ref([])
  const loading = ref(false)
  const error = ref(null)
  const backendNavigationEnabled = shouldUseBackendNavigation()

  function normalizeIds(ids) {
    return [...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )]
  }

  function assertBulkLimit(ids) {
    if (ids.length <= MAX_BULK_BOOKMARK_IDS) return
    const limitError = new Error(`一次最多处理 ${MAX_BULK_BOOKMARK_IDS} 个书签。`)
    limitError.code = 'TOO_MANY_BOOKMARKS'
    throw limitError
  }

  async function loadAll() {
    bookmarks.value = backendNavigationEnabled
      ? await fetchBackendBookmarks()
      : await getAllBookmarks()
    return bookmarks.value
  }

  async function load(groupId) {
    loading.value = true
    error.value = null
    try {
      bookmarks.value = backendNavigationEnabled
        ? await fetchBackendBookmarks(groupId)
        : groupId
          ? await getBookmarks(groupId)
          : await getAllBookmarks()
    } catch (e) {
      error.value = e
      console.error('Failed to load bookmarks:', e)
    } finally {
      loading.value = false
    }
  }

  async function create(bookmark) {
    const newBookmark = backendNavigationEnabled
      ? await createBackendBookmark(bookmark)
      : await addBookmark(bookmark)

    bookmarks.value.push(newBookmark)
    return newBookmark
  }

  async function update(id, updates) {
    const updatedBookmark = backendNavigationEnabled
      ? await updateBackendBookmark(id, updates)
      : (await updateBookmark(id, updates), { id, ...updates })

    const index = bookmarks.value.findIndex((bookmark) => bookmark.id === id)
    if (index !== -1) {
      bookmarks.value[index] = { ...bookmarks.value[index], ...updatedBookmark }
    }
  }

  async function remove(id) {
    if (backendNavigationEnabled) {
      await deleteBackendBookmark(id)
    } else {
      await deleteBookmark(id)
    }

    bookmarks.value = bookmarks.value.filter((bookmark) => bookmark.id !== id)
  }

  async function reorder(groupId, newOrder) {
    const ids = normalizeIds(newOrder)
    const previous = bookmarks.value.map((bookmark) => ({ ...bookmark }))

    if (backendNavigationEnabled) {
      await reorderBackendBookmarks(groupId, ids)
    } else {
      await reorderBookmarks(groupId, ids)
    }

    const orderMap = new Map(ids.map((id, index) => [id, index]))
    const orderedGroup = previous
      .filter((bookmark) => bookmark.groupId === groupId)
      .sort((left, right) => (
        (orderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (orderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      ))
      .map((bookmark, index) => ({ ...bookmark, order: index }))
    bookmarks.value = [
      ...previous.filter((bookmark) => bookmark.groupId !== groupId),
      ...orderedGroup
    ]
  }

  async function moveMany(ids, targetGroupId) {
    const selectedIds = normalizeIds(ids)
    const target = String(targetGroupId || '').trim()
    if (!selectedIds.length || !target) return []
    assertBulkLimit(selectedIds)

    if (backendNavigationEnabled) {
      const moved = await moveBackendBookmarks(selectedIds, target)
      await loadAll()
      return moved
    }

    const snapshot = bookmarks.value.map((bookmark) => ({ ...bookmark }))
    const selectedSet = new Set(selectedIds)
    const moving = snapshot.filter((bookmark) => selectedSet.has(bookmark.id))
    await moveLocalBookmarks(selectedIds, target)
    await loadAll()
    return moving.map((bookmark) => ({ ...bookmark, groupId: target }))
  }

  async function removeMany(ids) {
    const selectedIds = normalizeIds(ids)
    if (!selectedIds.length) return 0
    assertBulkLimit(selectedIds)

    if (backendNavigationEnabled) {
      await deleteBackendBookmarks(selectedIds)
    } else {
      await deleteBookmarks(selectedIds)
    }

    await loadAll()
    return selectedIds.length
  }

  async function checkHealth(ids) {
    const selectedIds = normalizeIds(ids)
    if (!selectedIds.length) return []
    assertBulkLimit(selectedIds)
    if (!backendNavigationEnabled) {
      const unsupported = new Error('链接健康检查仅服务器账号支持。')
      unsupported.code = 'BACKEND_ONLY'
      throw unsupported
    }

    const checked = []
    for (let index = 0; index < selectedIds.length; index += 20) {
      const batch = selectedIds.slice(index, index + 20)
      try {
        const batchResult = await checkBackendBookmarkHealth(batch)
        checked.push(...batchResult)
        const batchById = new Map(batchResult.map((bookmark) => [bookmark.id, bookmark]))
        bookmarks.value = bookmarks.value.map((bookmark) => (
          batchById.has(bookmark.id)
            ? { ...bookmark, ...batchById.get(bookmark.id) }
            : bookmark
        ))
      } catch (error) {
        error.checkedCount = checked.length
        throw error
      }
    }
    return checked
  }

  async function search(query) {
    if (!query.trim()) {
      return []
    }

    return backendNavigationEnabled
      ? await searchBackendBookmarks(query)
      : await searchBookmarks(query)
  }

  return {
    bookmarks,
    loading,
    error,
    load,
    create,
    update,
    remove,
    reorder,
    moveMany,
    removeMany,
    checkHealth,
    backendNavigationEnabled,
    search
  }
}
