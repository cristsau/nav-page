<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useGroups, useBookmarks } from '@/shared/composables/useDB'
import { useConfig } from '@/shared/composables/useConfig'
import { COMMAND_ACTION_EVENT } from '@/shared/composables/useCommandPalette'
import SearchBox from '@/shared/components/SearchBox.vue'
import Icon from '@/shared/components/Icon.vue'
import { runBackendAiSearch, shouldUseBackendAiSearch } from '@/shared/services/aiSearchApi'
import { suggestBackendBookmarkTags } from '@/shared/services/navigationApi'
import { mergeSuggestedNoteTags } from '@/shared/utils/noteTags'
import NavGroup from './components/NavGroup.vue'
import AddToNav from './components/AddToNav.vue'
import BookmarkAiPanel from './components/BookmarkAiPanel.vue'
import {
  buildBookmarkAiPrompt,
  isCurrentBookmarkTagSave,
  resolveBookmarkGenerativeAiProvider,
  resolveBookmarkAiProvider
} from './navigationUi'
import {
  buildBookmarkOrderMap,
  buildNavigationReorderPayload,
  MAX_MANAGED_BOOKMARKS,
  moveId,
  moveIdBefore,
  orderRecords,
  selectManagementIds,
  sameIdOrder,
  toggleManagementSelection
} from './navigationManagement'

const router = useRouter()
const {
  groups,
  load: loadGroups,
  create: createGroup,
  update: updateGroup,
  remove: removeGroup,
  reorderAll: reorderNavigationItems
} = useGroups()
const {
  bookmarks,
  load: loadBookmarks,
  create: createBookmark,
  update: updateBookmark,
  remove: removeBookmark,
  moveMany: moveBookmarks,
  removeMany: removeBookmarks,
  checkHealth: checkBookmarkHealth,
  backendNavigationEnabled
} = useBookmarks()
const { config, getSiteName } = useConfig()

const showModal = ref(false)
const modalMode = ref('bookmark')
const editingItem = ref(null)
const defaultGroupId = ref('')
const activeGroupId = ref('')
const pendingGroupId = ref('')
const pendingBookmarkId = ref('')
const analyzingBookmarkId = ref('')
const savingItem = ref(false)
const status = ref({ message: '', type: '' })
const showBookmarkAi = ref(false)
const aiBookmark = ref(null)
const aiResult = ref(null)
const aiError = ref('')
const aiNeedsSetup = ref(false)
const aiTagResult = ref(null)
const aiTagLoading = ref(false)
const aiTagSaving = ref(false)
const aiTagError = ref('')
const aiTagMessage = ref('')
const searchBoxHost = ref(null)
const managementMode = ref('')
const managementBusy = ref(false)
const selectedBookmarkIds = ref([])
const moveTargetGroupId = ref('')
const groupOrderDraft = ref([])
const bookmarkOrderDrafts = ref({})
const sortDirty = ref(false)
let statusTimer = null
let aiRequestId = 0
let aiTagRequestId = 0
let aiTagSaveRequestId = 0
let aiTriggerElement = null
let navigationReady = false
let pendingNavigationCommand = ''

const canGenerateBookmarkTags = computed(() => (
  shouldUseBackendAiSearch()
  && Boolean(resolveBookmarkGenerativeAiProvider(config.value))
))
const orderedGroups = computed(() => orderRecords(groups.value, groupOrderDraft.value))
const orderedBookmarks = computed(() => {
  const ordered = []
  const groupedIds = new Set()

  for (const group of orderedGroups.value) {
    const groupBookmarks = bookmarks.value.filter((bookmark) => bookmark.groupId === group.id)
    ordered.push(...orderRecords(groupBookmarks, bookmarkOrderDrafts.value[group.id] || []))
    groupBookmarks.forEach((bookmark) => groupedIds.add(bookmark.id))
  }

  ordered.push(...bookmarks.value.filter((bookmark) => !groupedIds.has(bookmark.id)))
  return ordered
})
const currentBookmarks = computed(() => (
  orderedBookmarks.value.filter((bookmark) => bookmark.groupId === activeGroupId.value)
))
const currentSelectableBookmarkIds = computed(() => (
  currentBookmarks.value
    .slice(0, MAX_MANAGED_BOOKMARKS)
    .map((bookmark) => bookmark.id)
))
const selectedCount = computed(() => selectedBookmarkIds.value.length)
const allCurrentBookmarksSelected = computed(() => (
  currentSelectableBookmarkIds.value.length > 0
  && currentSelectableBookmarkIds.value.every((id) => selectedBookmarkIds.value.includes(id))
))
const availableMoveGroups = computed(() => (
  groups.value.filter((group) => group.id !== activeGroupId.value)
))

function resetSortDrafts() {
  groupOrderDraft.value = groups.value.map((group) => group.id)
  bookmarkOrderDrafts.value = buildBookmarkOrderMap(bookmarks.value, groups.value)
  sortDirty.value = false
}

function chooseDefaultMoveTarget() {
  if (!availableMoveGroups.value.some((group) => group.id === moveTargetGroupId.value)) {
    moveTargetGroupId.value = availableMoveGroups.value[0]?.id || ''
  }
}

function setManagementMode(mode) {
  if (managementBusy.value) return
  const nextMode = managementMode.value === mode ? '' : mode
  managementMode.value = nextMode
  selectedBookmarkIds.value = []

  if (nextMode === 'sort') {
    resetSortDrafts()
  } else {
    sortDirty.value = false
  }

  chooseDefaultMoveTarget()
}

function toggleBookmarkSelection(bookmark) {
  if (managementMode.value !== 'select' || bookmark.groupId !== activeGroupId.value) return
  const nextSelection = toggleManagementSelection(selectedBookmarkIds.value, bookmark.id)
  selectedBookmarkIds.value = nextSelection.ids
  if (nextSelection.limited) {
    setStatus(`一次最多选择 ${MAX_MANAGED_BOOKMARKS} 个书签，请先完成当前批次`, 'info')
  }
}

function toggleSelectAll() {
  if (allCurrentBookmarksSelected.value) {
    selectedBookmarkIds.value = []
    return
  }

  const nextSelection = selectManagementIds(currentBookmarks.value.map((bookmark) => bookmark.id))
  selectedBookmarkIds.value = nextSelection.ids
  if (nextSelection.limited) {
    setStatus(`当前组超过 ${MAX_MANAGED_BOOKMARKS} 项，已选择前 ${MAX_MANAGED_BOOKMARKS} 项`, 'info')
  }
}

function handleSortMove(payload = {}) {
  if (managementMode.value !== 'sort' || managementBusy.value) return
  const type = payload.type === 'bookmark' ? 'bookmark' : 'group'
  const groupId = String(payload.groupId || activeGroupId.value)
  const current = type === 'group'
    ? groupOrderDraft.value
    : (bookmarkOrderDrafts.value[groupId] || [])
  const next = payload.targetId
    ? moveIdBefore(current, payload.id, payload.targetId)
    : moveId(current, payload.id, payload.direction)

  if (sameIdOrder(current, next)) return
  if (type === 'group') {
    groupOrderDraft.value = next
  } else {
    bookmarkOrderDrafts.value = {
      ...bookmarkOrderDrafts.value,
      [groupId]: next
    }
  }
  sortDirty.value = true
}

async function handleMoveSelected() {
  if (!selectedCount.value || !moveTargetGroupId.value || managementBusy.value) return
  managementBusy.value = true
  try {
    const count = selectedCount.value
    await moveBookmarks(selectedBookmarkIds.value, moveTargetGroupId.value)
    selectedBookmarkIds.value = []
    resetSortDrafts()
    setStatus(`已移动 ${count} 个书签`, 'success')
  } catch (error) {
    setStatus(`移动失败，已恢复原列表：${error.message || '请稍后重试'}`, 'error')
  } finally {
    managementBusy.value = false
  }
}

async function handleDeleteSelected() {
  if (!selectedCount.value || managementBusy.value) return
  const count = selectedCount.value
  if (!confirm(`确定删除选中的 ${count} 个书签吗？此操作无法撤销。`)) return

  managementBusy.value = true
  try {
    await removeBookmarks(selectedBookmarkIds.value)
    selectedBookmarkIds.value = []
    resetSortDrafts()
    setStatus(`已删除 ${count} 个书签`, 'success')
  } catch (error) {
    setStatus(`批量删除失败：${error.message || '请稍后重试'}`, 'error')
  } finally {
    managementBusy.value = false
  }
}

async function handleHealthCheckSelected() {
  if (!selectedCount.value || managementBusy.value || !backendNavigationEnabled) return
  managementBusy.value = true
  try {
    const checked = await checkBookmarkHealth(selectedBookmarkIds.value)
    setStatus(`已检查 ${checked.length} 个链接；需登录或限流不会标记为失效`, 'success')
  } catch (error) {
    await loadData().catch(() => {})
    const checkedCount = Number(error.checkedCount || 0)
    setStatus(
      checkedCount > 0
        ? `已完成 ${checkedCount} 个链接后检查中断；已保留并同步完成结果：${error.message || '请稍后重试'}`
        : `链接检查未完成，已重新同步当前状态：${error.message || '请稍后重试'}`,
      'error'
    )
  } finally {
    managementBusy.value = false
  }
}

async function handleSaveSort() {
  if (!sortDirty.value || managementBusy.value) return
  managementBusy.value = true
  const payload = buildNavigationReorderPayload(
    groupOrderDraft.value,
    bookmarkOrderDrafts.value
  )

  try {
    await reorderNavigationItems(payload.groupIds, payload.bookmarkOrders)
    await loadData()
    resetSortDrafts()
    managementMode.value = ''
    setStatus('导航顺序已保存', 'success')
  } catch (error) {
    await loadData()
    resetSortDrafts()
    setStatus(
      `排序未保存，可能与其他页面更新冲突；已重新加载最新顺序：${error.message || '请稍后重试'}`,
      'error'
    )
  } finally {
    managementBusy.value = false
  }
}

function handleCancelSort() {
  if (managementBusy.value) return
  resetSortDrafts()
  managementMode.value = ''
}

async function loadData() {
  await Promise.all([loadGroups(), loadBookmarks()])
}

function setStatus(message, type = 'info') {
  status.value = { message, type }
  if (statusTimer) window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => {
    status.value = { message: '', type: '' }
  }, 3200)
}

function handleAddGroup() {
  modalMode.value = 'group'
  editingItem.value = null
  showModal.value = true
}

function handleEditGroup(group) {
  modalMode.value = 'group'
  editingItem.value = group
  showModal.value = true
}

async function handleDeleteGroup(group) {
  if (!confirm(`确定删除分组「${group.name}」及其所有书签吗？`)) {
    return
  }

  pendingGroupId.value = group.id
  try {
    await removeGroup(group.id)
    await loadData()
    if (activeGroupId.value === group.id) {
      activeGroupId.value = groups.value[0]?.id || ''
    }
    setStatus(`分组「${group.name}」已删除`, 'success')
  } catch (error) {
    console.error('Failed to delete group:', error)
    setStatus(`删除失败：${error.message || '请稍后重试'}`, 'error')
  } finally {
    pendingGroupId.value = ''
  }
}

function handleAddBookmark(group) {
  modalMode.value = 'bookmark'
  editingItem.value = null
  defaultGroupId.value = group?.id || activeGroupId.value || ''
  showModal.value = true
}

function handleEditBookmark(bookmark) {
  modalMode.value = 'bookmark'
  editingItem.value = bookmark
  showModal.value = true
}

async function handleAiBookmark(bookmark, triggerElement = null) {
  const requestId = ++aiRequestId
  aiTagRequestId += 1
  aiTagSaveRequestId += 1
  const providerId = resolveBookmarkAiProvider(config.value)

  if (triggerElement instanceof HTMLElement) {
    aiTriggerElement = triggerElement
  }
  aiBookmark.value = bookmark
  aiResult.value = null
  aiError.value = ''
  aiNeedsSetup.value = false
  aiTagResult.value = null
  aiTagLoading.value = false
  aiTagSaving.value = false
  aiTagError.value = ''
  aiTagMessage.value = ''
  showBookmarkAi.value = true

  if (!shouldUseBackendAiSearch() || !providerId) {
    aiNeedsSetup.value = true
    aiError.value = '请先在“设置 > 搜索设置”中启用并测试 ChatGPT / CLI Proxy，再回来使用书签 AI 分析。'
    return
  }

  analyzingBookmarkId.value = bookmark.id

  try {
    const prompt = buildBookmarkAiPrompt(bookmark, providerId)
    const result = await runBackendAiSearch(providerId, prompt, {
      webSearchEnabled: false,
      feature: 'bookmark_analysis'
    })
    if (requestId !== aiRequestId) return
    aiResult.value = result
  } catch (error) {
    if (requestId !== aiRequestId) return
    aiError.value = error.message || 'AI 分析失败，请稍后重试'
  } finally {
    if (requestId === aiRequestId) {
      analyzingBookmarkId.value = ''
    }
  }
}

async function closeBookmarkAi(restoreFocus = true) {
  const triggerElement = aiTriggerElement
  aiRequestId += 1
  aiTagRequestId += 1
  aiTagSaveRequestId += 1
  showBookmarkAi.value = false
  analyzingBookmarkId.value = ''
  aiTagLoading.value = false
  aiTagSaving.value = false

  if (restoreFocus && triggerElement?.isConnected) {
    await nextTick()
    triggerElement.focus()
  }
}

async function handleSuggestBookmarkTags() {
  const bookmarkId = aiBookmark.value?.id
  if (!bookmarkId || aiTagLoading.value || aiTagSaving.value) return

  if (!canGenerateBookmarkTags.value) {
    aiTagError.value = '智能标签需要服务器账户和 ChatGPT / OpenAI。'
    return
  }

  const requestId = ++aiTagRequestId
  aiTagLoading.value = true
  aiTagResult.value = null
  aiTagError.value = ''
  aiTagMessage.value = ''

  try {
    const result = await suggestBackendBookmarkTags(bookmarkId)
    if (requestId !== aiTagRequestId) return
    aiTagResult.value = result
  } catch (error) {
    if (requestId !== aiTagRequestId) return
    aiTagError.value = error.message || '智能标签生成失败，请稍后重试'
  } finally {
    if (requestId === aiTagRequestId) {
      aiTagLoading.value = false
    }
  }
}

async function handleApplyBookmarkTags() {
  if (aiTagSaving.value || !aiTagResult.value?.tags?.length) return

  const bookmark = bookmarks.value.find(
    (item) => item.id === aiBookmark.value?.id
  ) || aiBookmark.value
  if (!bookmark?.id) return

  const merged = mergeSuggestedNoteTags(bookmark.tags, aiTagResult.value.tags)
  if (!merged.added.length) {
    aiTagError.value = merged.limitReached
      ? '书签已达到 20 个标签上限。'
      : 'AI 建议与现有标签重复，没有需要添加的新标签。'
    return
  }

  const saveRequestId = ++aiTagSaveRequestId
  const bookmarkId = bookmark.id
  const isCurrentSave = () => isCurrentBookmarkTagSave({
    requestId: saveRequestId,
    currentRequestId: aiTagSaveRequestId,
    bookmarkId,
    currentBookmarkId: aiBookmark.value?.id,
    panelOpen: showBookmarkAi.value
  })
  aiTagSaving.value = true
  aiTagError.value = ''
  aiTagMessage.value = ''

  try {
    await updateBookmark(bookmarkId, { tags: merged.tags })
    if (!isCurrentSave()) return
    aiBookmark.value = { ...bookmark, tags: merged.tags }
    aiTagResult.value = null
    aiTagMessage.value = `已保存 ${merged.added.length} 个智能标签`
    setStatus(`已为「${bookmark.title}」添加智能标签`, 'success')
  } catch (error) {
    if (!isCurrentSave()) return
    aiTagError.value = error.message || '标签保存失败，请稍后重试'
  } finally {
    if (isCurrentSave()) {
      aiTagSaving.value = false
    }
  }
}

function openAiSettings() {
  closeBookmarkAi(false)
  router.push({ path: '/settings', query: { section: 'search' } })
}

async function handleDeleteBookmark(bookmark) {
  if (!confirm(`确定删除书签「${bookmark.title}」吗？`)) {
    return
  }

  pendingBookmarkId.value = bookmark.id
  try {
    await removeBookmark(bookmark.id)
    await loadBookmarks()
    setStatus(`书签「${bookmark.title}」已删除`, 'success')
  } catch (error) {
    console.error('Failed to delete bookmark:', error)
    setStatus(`删除失败：${error.message || '请稍后重试'}`, 'error')
  } finally {
    pendingBookmarkId.value = ''
  }
}

async function handleModalSubmit({ mode, data }) {
  if (savingItem.value) return
  savingItem.value = true

  try {
    const isEditing = Boolean(editingItem.value)
    if (mode === 'group') {
      if (isEditing) {
        await updateGroup(editingItem.value.id, data)
      } else {
        const newGroup = await createGroup(data)
        activeGroupId.value = newGroup.id
      }
    } else if (isEditing) {
      await updateBookmark(editingItem.value.id, data)
    } else {
      await createBookmark(data)
    }

    showModal.value = false
    editingItem.value = null
    await loadData()
    setStatus(
      `${mode === 'group' ? '分组' : '书签'}${isEditing ? '已更新' : '已添加'}`,
      'success'
    )
  } catch (error) {
    console.error('Failed to save navigation item:', error)
    setStatus(`保存失败：${error.message || '请稍后重试'}`, 'error')
  } finally {
    savingItem.value = false
  }
}

function runNavigationCommand(action) {
  if (action === 'create-bookmark') {
    handleAddBookmark()
    return
  }

  if (action === 'focus-site-search') {
    nextTick(() => {
      searchBoxHost.value?.querySelector('input[type="search"]')?.focus()
    })
  }
}

function handleCommandAction(event) {
  const action = event.detail?.action
  if (!['create-bookmark', 'focus-site-search'].includes(action)) return

  if (action === 'create-bookmark' && !navigationReady) {
    pendingNavigationCommand = action
    return
  }

  runNavigationCommand(action)
}

watch(activeGroupId, () => {
  if (managementMode.value === 'select') {
    selectedBookmarkIds.value = []
  }
  chooseDefaultMoveTarget()
})

onMounted(async () => {
  window.addEventListener(COMMAND_ACTION_EVENT, handleCommandAction)

  try {
    await loadData()
    if (groups.value.length > 0) {
      activeGroupId.value = groups.value[0].id
    }
  } finally {
    navigationReady = true
    if (pendingNavigationCommand) {
      const action = pendingNavigationCommand
      pendingNavigationCommand = ''
      runNavigationCommand(action)
    }
  }
})

onBeforeUnmount(() => {
  window.removeEventListener(COMMAND_ACTION_EVENT, handleCommandAction)
  if (statusTimer) window.clearTimeout(statusTimer)
  navigationReady = false
  pendingNavigationCommand = ''
})
</script>

<template>
  <div class="page">
    <main class="main" :class="{ 'has-management-bar': groups.length && managementMode }">
      <section class="search-section animate-fade-in">
        <h1 class="search-section__title">统一搜索</h1>
        <div ref="searchBoxHost">
          <SearchBox />
        </div>
      </section>

      <section class="content-section">
        <div v-if="groups.length" class="management-heading">
          <div>
            <p class="management-heading__eyebrow">导航管理</p>
            <p class="management-heading__hint">批量整理书签，或调整分组与当前分组书签的顺序。</p>
          </div>
          <div class="management-heading__modes" role="group" aria-label="导航管理模式">
            <button
              type="button"
              :class="{ 'is-active': managementMode === 'select' }"
              :aria-pressed="managementMode === 'select'"
              :disabled="managementBusy"
              @click="setManagementMode('select')"
            >
              <Icon name="check" :size="17" />
              <span>选择</span>
            </button>
            <button
              type="button"
              :class="{ 'is-active': managementMode === 'sort' }"
              :aria-pressed="managementMode === 'sort'"
              :disabled="managementBusy"
              @click="setManagementMode('sort')"
            >
              <Icon name="menu" :size="17" />
              <span>排序</span>
            </button>
          </div>
        </div>

        <div
          v-if="groups.length && managementMode === 'select'"
          class="management-bar management-bar--selection"
          :aria-busy="managementBusy"
        >
          <button
            type="button"
            :aria-pressed="allCurrentBookmarksSelected"
            :disabled="managementBusy || !currentBookmarks.length"
            @click="toggleSelectAll"
          >
            {{ allCurrentBookmarksSelected ? '取消全选' : '全选当前组' }}
          </button>
          <span class="management-bar__count" aria-live="polite">
            已选 {{ selectedCount }}/{{ MAX_MANAGED_BOOKMARKS }} 项
            <template v-if="currentBookmarks.length > MAX_MANAGED_BOOKMARKS">
              · 当前组共 {{ currentBookmarks.length }} 项
            </template>
          </span>
          <label class="management-bar__target">
            <span>移动到</span>
            <select v-model="moveTargetGroupId" :disabled="managementBusy || !availableMoveGroups.length">
              <option value="">选择分组</option>
              <option v-for="group in availableMoveGroups" :key="group.id" :value="group.id">
                {{ group.name }}
              </option>
            </select>
          </label>
          <button
            type="button"
            :disabled="managementBusy || !selectedCount || !moveTargetGroupId"
            @click="handleMoveSelected"
          >
            移动
          </button>
          <button
            type="button"
            :disabled="managementBusy || !selectedCount || !backendNavigationEnabled"
            :title="backendNavigationEnabled ? '检查所选链接' : '链接健康检查仅服务器账号支持'"
            @click="handleHealthCheckSelected"
          >
            <Icon name="refresh" :size="16" />
            <span>检查</span>
          </button>
          <button
            class="is-danger"
            type="button"
            :disabled="managementBusy || !selectedCount"
            @click="handleDeleteSelected"
          >
            <Icon name="trash" :size="16" />
            <span>删除</span>
          </button>
          <button type="button" :disabled="managementBusy" @click="setManagementMode('select')">
            完成
          </button>
        </div>

        <div
          v-else-if="groups.length && managementMode === 'sort'"
          class="management-bar management-bar--sort"
          :aria-busy="managementBusy"
        >
          <span class="management-bar__count">拖动手柄，或使用上下按钮调整；最后统一保存。</span>
          <button type="button" :disabled="managementBusy" @click="handleCancelSort">取消</button>
          <button
            class="is-primary"
            type="button"
            :disabled="managementBusy || !sortDirty"
            @click="handleSaveSort"
          >
            <Icon name="check" :size="16" />
            <span>{{ managementBusy ? '保存中' : '保存顺序' }}</span>
          </button>
        </div>

        <NavGroup
          :groups="orderedGroups"
          :bookmarks="orderedBookmarks"
          :active-group-id="activeGroupId"
          :pending-group-id="pendingGroupId"
          :pending-bookmark-id="pendingBookmarkId"
          :analyzing-bookmark-id="analyzingBookmarkId"
          :management-mode="managementMode"
          :management-busy="managementBusy"
          :selected-bookmark-ids="selectedBookmarkIds"
          @select-group="activeGroupId = $event.id"
          @add-group="handleAddGroup"
          @edit-group="handleEditGroup"
          @delete-group="handleDeleteGroup"
          @add-bookmark="handleAddBookmark"
          @ai-bookmark="handleAiBookmark"
          @edit-bookmark="handleEditBookmark"
          @delete-bookmark="handleDeleteBookmark"
          @toggle-bookmark="toggleBookmarkSelection"
          @sort-move="handleSortMove"
        />
      </section>

      <Transition name="status-slide">
        <div
          v-if="status.message"
          class="page-status"
          :class="`is-${status.type}`"
          role="status"
          aria-live="polite"
        >
          <Icon :name="status.type === 'error' ? 'circle-x' : 'circle-check'" :size="18" />
          <span>{{ status.message }}</span>
        </div>
      </Transition>

      <footer class="page-footer">
        <span>{{ getSiteName() }}</span>
        <span>Design by CrisTsau</span>
      </footer>
    </main>

    <AddToNav
      :show="showModal"
      :mode="modalMode"
      :groups="groups"
      :editing-item="editingItem"
      :default-group-id="defaultGroupId"
      :saving="savingItem"
      @close="showModal = false"
      @submit="handleModalSubmit"
    />

    <BookmarkAiPanel
      :show="showBookmarkAi"
      :bookmark="aiBookmark"
      :result="aiResult"
      :loading="Boolean(analyzingBookmarkId)"
      :error="aiError"
      :needs-setup="aiNeedsSetup"
      :tag-result="aiTagResult"
      :tag-loading="aiTagLoading"
      :tag-saving="aiTagSaving"
      :tag-error="aiTagError"
      :tag-message="aiTagMessage"
      :can-generate-tags="canGenerateBookmarkTags"
      @close="closeBookmarkAi"
      @retry="handleAiBookmark(aiBookmark)"
      @open-settings="openAiSettings"
      @suggest-tags="handleSuggestBookmarkTags"
      @apply-tags="handleApplyBookmarkTags"
    />
  </div>
</template>

<style scoped>
.page {
  min-height: calc(100vh - var(--app-shell-header-height, 64px));
  min-height: calc(100dvh - var(--app-shell-header-height, 64px));
  background: var(--bg-primary);
}

.main {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 0 24px 48px;
}

.search-section {
  padding: 28px 4px 22px;
  text-align: left;
}

.search-section :deep(.search-box__shortcut) {
  display: none;
}

.search-section :deep(.search-shell) {
  width: 100%;
}

.search-section :deep(.search-box) {
  min-height: 52px;
  padding: 3px;
  border-radius: 999px;
  box-shadow:
    0 12px 30px color-mix(in srgb, var(--text-primary) 7%, transparent),
    inset 0 1px color-mix(in srgb, white 62%, transparent);
}

.search-section :deep(.search-box__engine),
.search-section :deep(.search-box__btn) {
  min-height: 44px;
  border-radius: 999px;
}

.search-section :deep(.search-box__field) {
  min-height: 44px;
}

.search-section :deep(.search-box__input) {
  padding-block: 10px;
}

.search-section__title {
  margin: 0 0 10px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.14em;
}

.content-section {
  min-height: 300px;
}

.management-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 10px;
  padding: 0 4px;
}

.management-heading__eyebrow,
.management-heading__hint {
  margin: 0;
}

.management-heading__eyebrow {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 700;
}

.management-heading__hint {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 12px;
}

.management-heading__modes,
.management-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.management-heading__modes button,
.management-bar button,
.management-bar select {
  min-height: 44px;
  padding: 0 14px;
  color: var(--text-secondary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 13px;
  font: inherit;
}

.management-heading__modes button,
.management-bar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  cursor: pointer;
}

.management-heading__modes button.is-active,
.management-bar button.is-primary {
  color: #fff;
  background: var(--accent-color);
  border-color: var(--accent-color);
}

.management-heading__modes button:focus-visible,
.management-bar button:focus-visible,
.management-bar select:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.management-heading__modes button:disabled,
.management-bar button:disabled,
.management-bar select:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.management-bar {
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 10px;
  background: color-mix(in srgb, var(--bg-card) 94%, var(--accent-color) 6%);
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, var(--accent-color));
  border-radius: 16px;
  box-shadow: var(--shadow-sm);
}

.management-bar__count {
  min-width: 86px;
  color: var(--text-secondary);
  font-size: 13px;
}

.management-bar__target {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text-muted);
  font-size: 12px;
}

.management-bar__target select {
  max-width: 190px;
}

.management-bar button.is-danger {
  color: var(--error-color);
  border-color: color-mix(in srgb, var(--error-color) 42%, var(--border-color));
}

.management-bar--sort .management-bar__count {
  flex: 1;
}

.page-status {
  position: fixed;
  right: 24px;
  bottom: max(80px, calc(env(safe-area-inset-bottom) + 64px));
  z-index: 500;
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: min(420px, calc(100vw - 32px));
  padding: 13px 16px;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
}

.page-status.is-success {
  border-color: color-mix(in srgb, var(--success-color) 52%, var(--border-color));
}

.page-status.is-error {
  color: var(--error-color);
  border-color: color-mix(in srgb, var(--error-color) 55%, var(--border-color));
}

.status-slide-enter-active,
.status-slide-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.status-slide-enter-from,
.status-slide-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.page-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 32px;
  padding: 18px 6px 6px;
  border-top: 1px solid var(--border-light);
  color: var(--text-muted);
  font-size: 12px;
  letter-spacing: 0.06em;
}

@media (max-width: 640px) {
  .main {
    padding: 0 16px 48px;
  }

  .main.has-management-bar {
    padding-bottom: 180px;
  }

  .search-section {
    padding: 18px 0 16px;
  }

  .search-section__title {
    margin-bottom: 8px;
    font-size: 10px;
  }

  .page-footer {
    flex-direction: column;
  }

  .page-status {
    right: 16px;
    bottom: max(188px, calc(env(safe-area-inset-bottom) + 174px));
  }

  .main:not(.has-management-bar) .page-status {
    bottom: max(80px, calc(env(safe-area-inset-bottom) + 64px));
  }

  .management-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .management-heading__modes {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .management-heading__modes button {
    width: 100%;
  }

  .management-bar {
    position: fixed;
    right: 10px;
    bottom: max(86px, calc(env(safe-area-inset-bottom) + 76px));
    left: 10px;
    z-index: 420;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    max-height: min(46vh, 340px);
    margin: 0;
    overflow-y: auto;
    box-shadow: var(--shadow-lg);
  }

  .management-bar__count,
  .management-bar__target,
  .management-bar--sort .management-bar__count {
    grid-column: 1 / -1;
    width: 100%;
  }

  .management-bar__target select {
    min-width: 0;
    max-width: none;
    flex: 1;
  }

  .management-bar button {
    min-width: 0;
    padding: 0 9px;
  }

  .management-bar--sort {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .management-heading__modes button,
  .management-bar button,
  .management-bar select {
    transition: none;
  }
}
</style>
