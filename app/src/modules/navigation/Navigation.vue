<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGroups, useBookmarks } from '@/shared/composables/useDB'
import { useTheme } from '@/shared/composables/useTheme'
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

const router = useRouter()
const { groups, load: loadGroups, create: createGroup, update: updateGroup, remove: removeGroup } = useGroups()
const { bookmarks, load: loadBookmarks, create: createBookmark, update: updateBookmark, remove: removeBookmark } = useBookmarks()
const { isDark, toggleTheme } = useTheme()
const { config, getSiteName, isModuleEnabled } = useConfig()

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
      webSearchEnabled: false
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

function goToSettings() {
  router.push('/settings')
}

function goToWhisper() {
  router.push('/whisper')
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
  navigationReady = false
  pendingNavigationCommand = ''
})
</script>

<template>
  <div class="page">
    <header class="header">
      <div class="header__logo">
        <span class="header__logo-icon">
          <img src="/domo-logo.png" alt="">
        </span>
        <span class="header__logo-text">{{ getSiteName() }}</span>
      </div>
      <div class="header__actions">
        <button
          v-if="isModuleEnabled('whisper')"
          class="header__btn"
          type="button"
          aria-label="打开日记和备忘录"
          title="日记与备忘录"
          @click="goToWhisper"
        >
          <Icon name="note" :size="19" />
        </button>
        <button
          class="header__btn"
          type="button"
          :aria-label="isDark ? '切到亮色模式' : '切到暗色模式'"
          :title="isDark ? '切到亮色模式' : '切到暗色模式'"
          @click="toggleTheme"
        >
          <Icon :name="isDark ? 'sun' : 'moon'" :size="19" />
        </button>
        <button class="header__btn" type="button" aria-label="打开设置" title="设置" @click="goToSettings">
          <Icon name="settings" :size="19" />
        </button>
      </div>
    </header>

    <main class="main">
      <section class="search-section animate-fade-in">
        <h1 class="search-section__title">搜索你想找的内容</h1>
        <div ref="searchBoxHost">
          <SearchBox />
        </div>
      </section>

      <section class="content-section">
        <NavGroup
          :groups="groups"
          :bookmarks="bookmarks"
          :active-group-id="activeGroupId"
          :pending-group-id="pendingGroupId"
          :pending-bookmark-id="pendingBookmarkId"
          :analyzing-bookmark-id="analyzingBookmarkId"
          @select-group="activeGroupId = $event.id"
          @add-group="handleAddGroup"
          @edit-group="handleEditGroup"
          @delete-group="handleDeleteGroup"
          @add-bookmark="handleAddBookmark"
          @ai-bookmark="handleAiBookmark"
          @edit-bookmark="handleEditBookmark"
          @delete-bookmark="handleDeleteBookmark"
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
  min-height: 100vh;
  background: var(--bg-primary);
}

.header {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height);
  padding: 0 24px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-light);
  backdrop-filter: blur(10px);
}

.header__logo {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header__logo-icon {
  width: 36px;
  height: 36px;
  display: block;
  overflow: hidden;
  background: #fff;
  border: 1px solid var(--border-light);
  border-radius: 50%;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--text-primary) 10%, transparent);
}

.header__logo-icon img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
}

.header__logo-text {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 1px;
}

.header__actions {
  display: flex;
  gap: 8px;
}

.header__btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-md);
  font-size: 18px;
  cursor: pointer;
  transition: all var(--transition-fast);
  color: var(--text-secondary);
}

.header__btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  transform: translateY(-1px);
}

.main {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 0 24px 48px;
}

.search-section {
  padding: 60px 0 40px;
  text-align: center;
}

.search-section :deep(.search-box__shortcut) {
  display: none;
}

.search-section__title {
  font-size: 28px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 32px;
}

.content-section {
  min-height: 300px;
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
  .header {
    padding: 0 16px;
  }

  .main {
    padding: 0 16px 32px;
  }

  .search-section {
    padding: 40px 0 24px;
  }

  .search-section__title {
    font-size: 22px;
    margin-bottom: 24px;
  }

  .page-footer {
    flex-direction: column;
  }

  .page-status {
    right: 16px;
    bottom: max(76px, calc(env(safe-area-inset-bottom) + 62px));
  }
}
</style>
