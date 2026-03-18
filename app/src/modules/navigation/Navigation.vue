<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useGroups, useBookmarks } from '@/shared/composables/useDB'
import { useTheme } from '@/shared/composables/useTheme'
import { useConfig } from '@/shared/composables/useConfig'
import SearchBox from '@/shared/components/SearchBox.vue'
import NavGroup from './components/NavGroup.vue'
import AddToNav from './components/AddToNav.vue'

const router = useRouter()
const { groups, load: loadGroups, create: createGroup, update: updateGroup, remove: removeGroup } = useGroups()
const { bookmarks, load: loadBookmarks, create: createBookmark, update: updateBookmark, remove: removeBookmark } = useBookmarks()
const { isDark, toggleTheme } = useTheme()
const { config, getSiteName, getSiteIcon, isModuleEnabled } = useConfig()

// 弹窗状态
const showModal = ref(false)
const modalMode = ref('bookmark') // bookmark | group
const editingItem = ref(null)
const defaultGroupId = ref('')

// 当前选中的分组
const activeGroupId = ref('')

// 加载数据
async function loadData() {
  await Promise.all([loadGroups(), loadBookmarks()])
}

// ========== 分组操作 ==========

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
  if (!confirm(`确定删除分组「${group.name}」及其所有书签？`)) {
    return
  }
  await removeGroup(group.id)
  await loadData()
}

// ========== 书签操作 ==========

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

async function handleDeleteBookmark(bookmark) {
  if (!confirm(`确定删除书签「${bookmark.title}」？`)) {
    return
  }
  await removeBookmark(bookmark.id)
  await loadBookmarks()
}

// ========== 表单提交 ==========

async function handleModalSubmit({ mode, data }) {
  if (mode === 'group') {
    if (editingItem.value) {
      await updateGroup(editingItem.value.id, data)
    } else {
      const newGroup = await createGroup(data)
      activeGroupId.value = newGroup.id
    }
  } else {
    if (editingItem.value) {
      await updateBookmark(editingItem.value.id, data)
    } else {
      await createBookmark(data)
    }
  }

  showModal.value = false
  editingItem.value = null
  await loadData()
}

// ========== 导航 ==========

function goToSettings() {
  router.push('/settings')
}

function goToWhisper() {
  router.push('/whisper')
}

// 初始化
onMounted(async () => {
  await loadData()
  if (groups.value.length > 0) {
    activeGroupId.value = groups.value[0].id
  }
})
</script>

<template>
  <div class="page">
    <!-- 顶部导航 -->
    <header class="header">
      <div class="header__logo">
        <span class="header__logo-icon">{{ getSiteIcon() }}</span>
        <span class="header__logo-text">{{ getSiteName() }}</span>
      </div>
      <div class="header__actions">
        <button
          v-if="isModuleEnabled('whisper')"
          class="header__btn"
          title="时光"
          @click="goToWhisper"
        >
          📖
        </button>
        <button class="header__btn" :title="isDark ? '亮色模式' : '暗色模式'" @click="toggleTheme">
          {{ isDark ? '☀️' : '🌙' }}
        </button>
        <button class="header__btn" title="设置" @click="goToSettings">
          ⚙️
        </button>
      </div>
    </header>

    <!-- 主内容 -->
    <main class="main">
      <!-- 搜索区域 -->
      <section class="search-section animate-fade-in">
        <h1 class="search-section__title">搜索你想找的内容</h1>
        <SearchBox />
      </section>

      <!-- 分组和书签 -->
      <section class="content-section">
        <NavGroup
          :groups="groups"
          :bookmarks="bookmarks"
          @add-group="handleAddGroup"
          @edit-group="handleEditGroup"
          @delete-group="handleDeleteGroup"
          @add-bookmark="handleAddBookmark"
          @edit-bookmark="handleEditBookmark"
          @delete-bookmark="handleDeleteBookmark"
        />
      </section>
    </main>

    <!-- 添加/编辑弹窗 -->
    <AddToNav
      :show="showModal"
      :mode="modalMode"
      :groups="groups"
      :editing-item="editingItem"
      :default-group-id="defaultGroupId"
      @close="showModal = false"
      @submit="handleModalSubmit"
    />
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--bg-primary);
}

/* 顶部导航 */
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
  font-size: 24px;
}

.header__logo-text {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 2px;
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
}

.header__btn:hover {
  background: var(--bg-hover);
  transform: scale(1.05);
}

/* 主内容 */
.main {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 0 24px 48px;
}

/* 搜索区域 */
.search-section {
  padding: 60px 0 40px;
  text-align: center;
}

.search-section__title {
  font-size: 28px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 32px;
}

/* 内容区域 */
.content-section {
  min-height: 300px;
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
}
</style>
