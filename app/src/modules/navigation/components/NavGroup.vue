<script setup>
import { computed, ref } from 'vue'
import NavItem from './NavItem.vue'

const props = defineProps({
  groups: {
    type: Array,
    default: () => []
  },
  bookmarks: {
    type: Array,
    default: () => []
  }
})

const emit = defineEmits([
  'selectGroup',
  'addGroup',
  'editGroup',
  'deleteGroup',
  'addBookmark',
  'editBookmark',
  'deleteBookmark'
])

const activeGroupId = ref('')

// 当前选中的分组
const activeGroup = computed(() => {
  if (!activeGroupId.value && props.groups.length > 0) {
    return props.groups[0]
  }
  return props.groups.find(g => g.id === activeGroupId.value) || props.groups[0]
})

// 当前分组的书签
const activeBookmarks = computed(() => {
  if (!activeGroup.value) return []
  return props.bookmarks.filter(b => b.groupId === activeGroup.value.id)
})

// 选择分组
function selectGroup(group) {
  activeGroupId.value = group.id
  emit('selectGroup', group)
}

function handleAddGroup() {
  emit('addGroup')
}

function handleEditGroup(group, e) {
  e.stopPropagation()
  emit('editGroup', group)
}

function handleDeleteGroup(group, e) {
  e.stopPropagation()
  emit('deleteGroup', group)
}

function handleAddBookmark() {
  emit('addBookmark', activeGroup.value)
}

function handleEditBookmark(bookmark) {
  emit('editBookmark', bookmark)
}

function handleDeleteBookmark(bookmark) {
  emit('deleteBookmark', bookmark)
}
</script>

<template>
  <div class="nav-groups">
    <!-- 分组 Tab -->
    <div class="groups-tabs">
      <div class="groups-tabs__list">
        <div
          v-for="group in groups"
          :key="group.id"
          class="groups-tabs__tab"
          :class="{ 'is-active': activeGroup?.id === group.id }"
          @click="selectGroup(group)"
        >
          <span class="groups-tabs__icon">{{ group.icon }}</span>
          <span class="groups-tabs__name">{{ group.name }}</span>
          <button
            class="groups-tabs__edit"
            title="编辑"
            @click="handleEditGroup(group, $event)"
          >
            ✏️
          </button>
          <button
            class="groups-tabs__delete"
            title="删除"
            @click="handleDeleteGroup(group, $event)"
          >
            ×
          </button>
        </div>
      </div>
      <button class="groups-tabs__add" title="添加分组" @click="handleAddGroup">
        ➕
      </button>
    </div>

    <!-- 书签网格 -->
    <div class="bookmarks-container">
      <Transition name="tab-slide" mode="out-in">
        <div :key="activeGroup?.id" class="bookmarks-grid">
          <!-- 添加书签卡片 -->
          <div class="bookmark-card bookmark-card--add" @click="handleAddBookmark">
            <div class="bookmark-card__icon">➕</div>
            <div class="bookmark-card__title">添加书签</div>
          </div>

          <!-- 书签列表 -->
          <TransitionGroup name="list">
            <NavItem
              v-for="bookmark in activeBookmarks"
              :key="bookmark.id"
              :bookmark="bookmark"
              @edit="handleEditBookmark"
              @delete="handleDeleteBookmark"
            />
          </TransitionGroup>
        </div>
      </Transition>

      <!-- 空状态 -->
      <div v-if="activeBookmarks.length === 0 && groups.length === 0" class="empty-state">
        <div class="empty-state__icon">📭</div>
        <div class="empty-state__text">还没有分组</div>
        <button class="btn btn--primary" @click="handleAddGroup">
          创建第一个分组
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.nav-groups {
  margin-top: 32px;
}

/* Tab 样式 */
.groups-tabs {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
  padding: 8px;
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  overflow-x: auto;
}

.groups-tabs__list {
  display: flex;
  gap: 8px;
  flex: 1;
}

.groups-tabs__tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  background: transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--transition-fast);
}

.groups-tabs__tab:hover {
  background: var(--bg-hover);
}

.groups-tabs__tab.is-active {
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
}

.groups-tabs__tab.is-active::after {
  content: '';
  position: absolute;
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
  width: 20px;
  height: 3px;
  background: var(--accent-color);
  border-radius: var(--radius-full);
}

.groups-tabs__icon {
  font-size: 18px;
}

.groups-tabs__name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.groups-tabs__edit,
.groups-tabs__delete {
  opacity: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-xs);
  cursor: pointer;
  font-size: 10px;
  transition: all var(--transition-fast);
}

.groups-tabs__tab:hover .groups-tabs__edit,
.groups-tabs__tab:hover .groups-tabs__delete {
  opacity: 1;
}

.groups-tabs__edit:hover {
  background: var(--bg-hover);
}

.groups-tabs__delete:hover {
  background: var(--error-color);
  color: #fff;
}

.groups-tabs__add {
  padding: 12px 16px;
  background: var(--accent-color);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 16px;
  transition: all var(--transition-fast);
  flex-shrink: 0;
}

.groups-tabs__add:hover {
  background: var(--accent-hover);
  transform: scale(1.05);
}

/* 书签网格 */
.bookmarks-container {
  min-height: 200px;
}

.bookmarks-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 16px;
  justify-items: center;
}

/* 添加书签卡片 */
.bookmark-card--add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 110px;
  padding: 20px 12px;
  background: var(--bg-secondary);
  border: 2px dashed var(--border-color);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-normal) var(--ease-smooth);
}

.bookmark-card--add:hover {
  background: var(--accent-bg);
  border-color: var(--accent-color);
  transform: translateY(-4px);
}

.bookmark-card--add .bookmark-card__icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.bookmark-card--add .bookmark-card__title {
  font-size: 14px;
  color: var(--text-secondary);
}

/* 空状态 */
.empty-state {
  text-align: center;
  padding: 60px 20px;
}

.empty-state__icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-state__text {
  font-size: 16px;
  color: var(--text-secondary);
  margin-bottom: 20px;
}

/* 按钮样式 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 24px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.btn--primary:hover {
  background: var(--accent-hover);
}

/* Tab 切换动画 */
.tab-slide-enter-active,
.tab-slide-leave-active {
  transition: all 0.3s var(--ease-smooth);
}

.tab-slide-enter-from {
  opacity: 0;
  transform: translateX(20px);
}

.tab-slide-leave-to {
  opacity: 0;
  transform: translateX(-20px);
}

/* 列表动画 */
.list-enter-active,
.list-leave-active {
  transition: all 0.3s var(--ease-smooth);
}

.list-enter-from {
  opacity: 0;
  transform: translateY(20px);
}

.list-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

@media (max-width: 640px) {
  .groups-tabs {
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .groups-tabs__tab {
    padding: 10px 14px;
  }

  .bookmarks-grid {
    grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
    gap: 12px;
  }
}
</style>
