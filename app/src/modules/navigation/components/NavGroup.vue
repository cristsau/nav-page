<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import NavItem from './NavItem.vue'
import { resolveGroupIcon } from '../navigationUi'

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
  },
  analyzingBookmarkId: {
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
  'aiBookmark',
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

function handleGroupKeydown(group, event) {
  const currentIndex = props.groups.findIndex((item) => item.id === group.id)
  if (currentIndex < 0) return

  let nextIndex = currentIndex
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % props.groups.length
  else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + props.groups.length) % props.groups.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = props.groups.length - 1
  else return

  event.preventDefault()
  const nextGroup = props.groups[nextIndex]
  selectGroup(nextGroup)
  const tabs = event.currentTarget
    .closest('[role="tablist"]')
    ?.querySelectorAll('[role="tab"]')
  tabs?.[nextIndex]?.focus()
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

function handleAiBookmark(bookmark, triggerElement) {
  emit('aiBookmark', bookmark, triggerElement)
}

function handleDeleteBookmark(bookmark) {
  emit('deleteBookmark', bookmark)
}

function groupStyle(group) {
  return {
    '--group-color': group.color || 'var(--accent-color)'
  }
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
          :style="groupStyle(group)"
          role="presentation"
        >
          <button
            class="groups-tabs__main"
            type="button"
            role="tab"
            :aria-selected="activeGroup?.id === group.id"
            :tabindex="activeGroup?.id === group.id ? 0 : -1"
            @click="selectGroup(group)"
            @keydown="handleGroupKeydown(group, $event)"
          >
            <span class="groups-tabs__icon" aria-hidden="true">
              <Icon :name="resolveGroupIcon(group.icon, group.name)" :size="17" />
            </span>
            <span class="groups-tabs__name">{{ group.name }}</span>
            <span class="groups-tabs__count" aria-hidden="true">
              {{ bookmarks.filter((bookmark) => bookmark.groupId === group.id).length }}
            </span>
          </button>
          <span class="groups-tabs__actions" role="group" :aria-label="`${group.name} 分组操作`">
            <button
              class="groups-tabs__action"
              title="编辑分组"
              type="button"
              :aria-label="`编辑分组 ${group.name}`"
              @click="handleEditGroup(group, $event)"
            >
              <Icon name="edit" :size="13" />
            </button>
            <button
              class="groups-tabs__action groups-tabs__action--danger"
              title="删除分组"
              type="button"
              :aria-label="`删除分组 ${group.name}`"
              :disabled="pendingGroupId === group.id"
              @click="handleDeleteGroup(group, $event)"
            >
              <span v-if="pendingGroupId === group.id" class="mini-spinner" aria-hidden="true"></span>
              <Icon v-else name="trash" :size="13" />
            </button>
          </span>
        </div>
      </div>
      <button class="groups-tabs__add" type="button" title="添加分组" aria-label="添加分组" @click="handleAddGroup">
        <Icon name="plus" :size="18" />
        <span>新分组</span>
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
              :analyzing="analyzingBookmarkId === bookmark.id"
              @ai="handleAiBookmark"
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
  margin-top: 36px;
}

/* Tab 样式 */
.groups-tabs {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 26px;
  padding: 9px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--bg-secondary) 96%, white 4%), var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--border-light) 78%, transparent);
  border-radius: 22px;
  box-shadow: 0 1px 0 color-mix(in srgb, white 66%, transparent) inset;
}

.groups-tabs__list {
  display: flex;
  gap: 8px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--accent-color) 24%, transparent) transparent;
}

.groups-tabs__tab {
  position: relative;
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  min-width: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 15px;
  white-space: nowrap;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.groups-tabs__tab:hover {
  background: color-mix(in srgb, var(--bg-hover) 82%, transparent);
}

.groups-tabs__tab.is-active {
  background: var(--bg-card);
  border-color: color-mix(in srgb, var(--group-color) 32%, var(--border-light));
  box-shadow:
    0 8px 22px color-mix(in srgb, var(--group-color) 10%, transparent),
    0 1px 0 color-mix(in srgb, white 72%, transparent) inset;
}

.groups-tabs__main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  color: var(--text-primary);
  background: transparent;
  border: 0;
  border-radius: 14px;
  cursor: pointer;
  font: inherit;
}

.groups-tabs__main:focus-visible {
  outline: 2px solid var(--group-color);
  outline-offset: 2px;
}

.groups-tabs__icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  color: var(--group-color);
  background: color-mix(in srgb, var(--group-color) 11%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--group-color) 17%, transparent);
  border-radius: 10px;
}

.groups-tabs__name {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.groups-tabs__count {
  min-width: 22px;
  padding: 3px 6px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--bg-tertiary) 76%, transparent);
  border-radius: 999px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.groups-tabs__actions {
  width: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  transform: translateX(-4px);
  transition:
    width var(--transition-fast),
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.groups-tabs__tab:hover .groups-tabs__actions,
.groups-tabs__tab:focus-within .groups-tabs__actions {
  width: 53px;
  padding-right: 5px;
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
}

.groups-tabs__action {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  color: var(--text-muted);
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.groups-tabs__action:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.groups-tabs__action--danger:hover:not(:disabled) {
  background: var(--error-color);
  color: #fff;
}

.groups-tabs__action:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 1px;
}

.groups-tabs__action:disabled {
  cursor: wait;
}

.groups-tabs__add {
  min-height: 46px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 15px;
  background: var(--accent-color);
  border: 1px solid color-mix(in srgb, var(--accent-hover) 70%, transparent);
  border-radius: 15px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  flex-shrink: 0;
  color: #fff;
  box-shadow: 0 8px 20px color-mix(in srgb, var(--accent-color) 22%, transparent);
  transition:
    background var(--transition-fast),
    transform var(--transition-fast),
    box-shadow var(--transition-fast);
}

.groups-tabs__add:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
  box-shadow: 0 10px 24px color-mix(in srgb, var(--accent-color) 28%, transparent);
}

.groups-tabs__add:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 3px;
}

/* 书签网格 */
.bookmarks-container {
  min-height: 200px;
}

.bookmarks-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 15px;
  align-items: stretch;
}

/* 添加书签卡片 */
.bookmark-card--add {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 154px;
  padding: 20px 12px;
  color: var(--text-secondary);
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--bg-secondary) 94%, white 6%), var(--bg-secondary));
  border: 1px dashed color-mix(in srgb, var(--accent-color) 38%, var(--border-color));
  border-radius: 22px;
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    border-color var(--transition-fast),
    transform var(--transition-normal) var(--ease-smooth),
    box-shadow var(--transition-normal) var(--ease-smooth);
}

.bookmark-card--add:hover {
  background: var(--accent-bg);
  border-color: var(--accent-color);
  transform: translateY(-4px);
  box-shadow: 0 14px 30px color-mix(in srgb, var(--accent-color) 13%, transparent);
}

.bookmark-card--add:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 3px;
}

.bookmark-card--add .bookmark-card__icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  margin-bottom: 8px;
  color: var(--accent-color);
  background: color-mix(in srgb, var(--accent-color) 11%, transparent);
  border-radius: 14px;
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
    align-items: stretch;
    padding: 7px;
  }

  .groups-tabs__list {
    -webkit-overflow-scrolling: touch;
  }

  .bookmarks-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .groups-tabs__add {
    width: 46px;
    padding: 0;
  }

  .groups-tabs__add span {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
}

@media (hover: none), (pointer: coarse) {
  .groups-tabs__actions {
    width: 53px;
    padding-right: 5px;
    opacity: 1;
    pointer-events: auto;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .groups-tabs__tab,
  .groups-tabs__actions,
  .groups-tabs__action,
  .groups-tabs__add,
  .bookmark-card--add,
  .tab-slide-enter-active,
  .tab-slide-leave-active,
  .list-enter-active,
  .list-leave-active {
    transition: none;
  }

  .groups-tabs__add:hover,
  .bookmark-card--add:hover {
    transform: none;
  }
}
</style>
