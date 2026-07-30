<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import NavItem from './NavItem.vue'

const props = defineProps({
  groups: {
    type: Array,
    default: () => []
  },
  bookmarks: {
    type: Array,
    default: () => []
  },
  activeGroupId: {
    type: String,
    default: ''
  },
  pendingGroupId: {
    type: String,
    default: ''
  },
  pendingBookmarkId: {
    type: String,
    default: ''
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

watch(
  () => props.activeGroupId,
  (value) => {
    if (value) activeGroupId.value = value
  },
  { immediate: true }
)

watch(
  () => props.groups,
  (value) => {
    if (!value.some((group) => group.id === activeGroupId.value)) {
      activeGroupId.value = value[0]?.id || ''
    }
  },
  { deep: true }
)

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
      <div class="groups-tabs__list" role="tablist" aria-label="导航分组">
        <div
          v-for="group in groups"
          :key="group.id"
          class="groups-tabs__tab"
          :class="{ 'is-active': activeGroup?.id === group.id }"
          role="tab"
          :aria-selected="activeGroup?.id === group.id"
          :tabindex="activeGroup?.id === group.id ? 0 : -1"
          @click="selectGroup(group)"
          @keydown.enter.prevent="selectGroup(group)"
          @keydown.space.prevent="selectGroup(group)"
        >
          <span class="groups-tabs__icon">{{ group.icon }}</span>
          <span class="groups-tabs__name">{{ group.name }}</span>
          <button
            class="groups-tabs__edit"
            title="编辑"
            type="button"
            :aria-label="`编辑分组 ${group.name}`"
            @click="handleEditGroup(group, $event)"
          >
            <Icon name="edit" :size="14" />
          </button>
          <button
            class="groups-tabs__delete"
            title="删除"
            type="button"
            :aria-label="`删除分组 ${group.name}`"
            :disabled="pendingGroupId === group.id"
            @click="handleDeleteGroup(group, $event)"
          >
            <span v-if="pendingGroupId === group.id" class="mini-spinner" aria-hidden="true"></span>
            <Icon v-else name="trash" :size="14" />
          </button>
        </div>
      </div>
      <button class="groups-tabs__add" type="button" title="添加分组" aria-label="添加分组" @click="handleAddGroup">
        <Icon name="plus" :size="18" />
      </button>
    </div>

    <!-- 书签网格 -->
    <div class="bookmarks-container">
      <Transition name="tab-slide" mode="out-in">
        <div :key="activeGroup?.id" class="bookmarks-grid">
          <!-- 添加书签卡片 -->
          <button v-if="activeGroup" class="bookmark-card bookmark-card--add" type="button" @click="handleAddBookmark">
            <div class="bookmark-card__icon"><Icon name="plus" :size="28" /></div>
            <div class="bookmark-card__title">添加书签</div>
          </button>

          <!-- 书签列表 -->
          <TransitionGroup name="list">
            <NavItem
              v-for="bookmark in activeBookmarks"
              :key="bookmark.id"
              :bookmark="bookmark"
              :deleting="pendingBookmarkId === bookmark.id"
              @edit="handleEditBookmark"
              @delete="handleDeleteBookmark"
            />
          </TransitionGroup>
        </div>
      </Transition>

      <!-- 空状态 -->
      <div v-if="activeBookmarks.length === 0 && groups.length === 0" class="empty-state">
        <div class="empty-state__icon"><Icon name="folder" :size="42" /></div>
        <div class="empty-state__text">还没有分组</div>
        <button class="btn btn--primary" type="button" @click="handleAddGroup">
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
  opacity: 1;
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
  color: var(--text-muted);
}

.groups-tabs__tab:hover .groups-tabs__edit,
.groups-tabs__tab:hover .groups-tabs__delete,
.groups-tabs__tab:focus-within .groups-tabs__edit,
.groups-tabs__tab:focus-within .groups-tabs__delete {
  opacity: 1;
}

.groups-tabs__edit:hover {
  background: var(--bg-hover);
}

.groups-tabs__delete:hover {
  background: var(--error-color);
  color: #fff;
}

.groups-tabs__delete:disabled {
  opacity: 1;
  cursor: wait;
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
  color: #fff;
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
  color: var(--text-secondary);
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
  display: flex;
  justify-content: center;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.mini-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.75s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
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

@media (hover: none), (pointer: coarse) {
  .groups-tabs__edit,
  .groups-tabs__delete {
    opacity: 1;
  }
}
</style>
