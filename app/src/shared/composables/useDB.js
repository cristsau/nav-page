import { ref, watch } from 'vue'
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

// ========== 分组 Hook ==========

export function useGroups() {
  const groups = ref([])
  const loading = ref(false)
  const error = ref(null)

  async function load() {
    loading.value = true
    error.value = null
    try {
      groups.value = await getGroups()
    } catch (e) {
      error.value = e
      console.error('Failed to load groups:', e)
    } finally {
      loading.value = false
    }
  }

  async function create(group) {
    const newGroup = await addGroup(group)
    groups.value.push(newGroup)
    return newGroup
  }

  async function update(id, updates) {
    await updateGroup(id, updates)
    const index = groups.value.findIndex(g => g.id === id)
    if (index !== -1) {
      groups.value[index] = { ...groups.value[index], ...updates }
    }
  }

  async function remove(id) {
    await deleteGroup(id)
    groups.value = groups.value.filter(g => g.id !== id)
    // 同时清理相关的书签缓存
  }

  async function reorder(newOrder) {
    await reorderGroups(newOrder)
    // 重新排序本地数据
    const orderMap = new Map(newOrder.map((id, i) => [id, i]))
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

// ========== 书签 Hook ==========

export function useBookmarks() {
  const bookmarks = ref([])
  const loading = ref(false)
  const error = ref(null)

  async function load(groupId) {
    loading.value = true
    error.value = null
    try {
      bookmarks.value = groupId
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
    const newBookmark = await addBookmark(bookmark)
    bookmarks.value.push(newBookmark)
    return newBookmark
  }

  async function update(id, updates) {
    await updateBookmark(id, updates)
    const index = bookmarks.value.findIndex(b => b.id === id)
    if (index !== -1) {
      bookmarks.value[index] = { ...bookmarks.value[index], ...updates }
    }
  }

  async function remove(id) {
    await deleteBookmark(id)
    bookmarks.value = bookmarks.value.filter(b => b.id !== id)
  }

  async function reorder(groupId, newOrder) {
    await reorderBookmarks(groupId, newOrder)
    await load(groupId)
  }

  async function search(query) {
    if (!query.trim()) {
      return []
    }
    return await searchBookmarks(query)
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
