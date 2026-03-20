import { ref } from 'vue'
import {
  getGroups,
  addGroup,
  updateGroup,
  deleteGroup,
  reorderGroups,
  getBookmarks,
  getAllBookmarks,
  addBookmark,
  updateBookmark,
  deleteBookmark,
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
  fetchBackendBookmarks,
  createBackendBookmark,
  updateBackendBookmark,
  deleteBackendBookmark,
  reorderBackendBookmarks,
  searchBackendBookmarks
} from '@/shared/services/navigationApi'

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

  return {
    groups,
    loading,
    error,
    load,
    create,
    update,
    remove,
    reorder
  }
}

export function useBookmarks() {
  const bookmarks = ref([])
  const loading = ref(false)
  const error = ref(null)

  async function load(groupId) {
    loading.value = true
    error.value = null
    try {
      bookmarks.value = shouldUseBackendNavigation()
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
    const newBookmark = shouldUseBackendNavigation()
      ? await createBackendBookmark(bookmark)
      : await addBookmark(bookmark)

    bookmarks.value.push(newBookmark)
    return newBookmark
  }

  async function update(id, updates) {
    const updatedBookmark = shouldUseBackendNavigation()
      ? await updateBackendBookmark(id, updates)
      : (await updateBookmark(id, updates), { id, ...updates })

    const index = bookmarks.value.findIndex((bookmark) => bookmark.id === id)
    if (index !== -1) {
      bookmarks.value[index] = { ...bookmarks.value[index], ...updatedBookmark }
    }
  }

  async function remove(id) {
    if (shouldUseBackendNavigation()) {
      await deleteBackendBookmark(id)
    } else {
      await deleteBookmark(id)
    }

    bookmarks.value = bookmarks.value.filter((bookmark) => bookmark.id !== id)
  }

  async function reorder(groupId, newOrder) {
    if (shouldUseBackendNavigation()) {
      await reorderBackendBookmarks(groupId, newOrder)
    } else {
      await reorderBookmarks(groupId, newOrder)
    }

    await load(groupId)
  }

  async function search(query) {
    if (!query.trim()) {
      return []
    }

    return shouldUseBackendNavigation()
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
    search
  }
}
