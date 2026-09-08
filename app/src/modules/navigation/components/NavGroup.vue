<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
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
  focusedBookmarkId: {
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
  },
  managementMode: {
    type: String,
    default: ''
  },
  managementBusy: {
    type: Boolean,
    default: false
  },
  selectedBookmarkIds: {
    type: Array,
    default: () => []
  }
})

const router = useRouter()

const emit = defineEmits([
  'selectGroup',
  'addGroup',
  'editGroup',
  'deleteGroup',
  'addBookmark',
  'aiBookmark',
  'editBookmark',
  'deleteBookmark',
  'toggleBookmark',
  'sortMove'
])

const activeGroupId = ref('')
const mobileActionGroup = ref(null)
const mobileGroupFirstAction = ref(null)
const mobileGroupActionSheet = ref(null)
let mobileGroupActionTrigger = null

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

const BOOKMARK_PAGE_SIZE = 40
const visibleCount = ref(BOOKMARK_PAGE_SIZE)
const visibleBookmarks = computed(() => activeBookmarks.value.slice(0, visibleCount.value))
watch(() => [activeGroup.value?.id, props.focusedBookmarkId], () => {
  const targetIndex = activeBookmarks.value.findIndex((bookmark) => bookmark.id === props.focusedBookmarkId)
  visibleCount.value = Math.max(BOOKMARK_PAGE_SIZE, Math.ceil((targetIndex + 1) / BOOKMARK_PAGE_SIZE) * BOOKMARK_PAGE_SIZE)
}, { immediate: true })
// Groups and bookmarks load independently. A deep link may arrive before its
// bookmark, so expand again when that record becomes available.
watch(() => activeBookmarks.value.findIndex((bookmark) => bookmark.id === props.focusedBookmarkId), (targetIndex) => {
  if (targetIndex >= 0) visibleCount.value = Math.max(visibleCount.value, Math.ceil((targetIndex + 1) / BOOKMARK_PAGE_SIZE) * BOOKMARK_PAGE_SIZE)
})

async function showMoreBookmarks() {
  const firstNew = activeBookmarks.value[visibleCount.value]?.id
  visibleCount.value += BOOKMARK_PAGE_SIZE
  await nextTick()
  Array.from(document.querySelectorAll('[data-bookmark-id]'))
    .find((element) => element.dataset.bookmarkId === firstNew)
    ?.querySelector('.bookmark-card__main')?.focus({ preventScroll: true })
}

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

function openSettingsSection(section) {
  router.push({
    path: '/settings',
    query: { section }
  })
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

function handleToggleBookmark(bookmark) {
  emit('toggleBookmark', bookmark)
}

function isBookmarkSelected(bookmark) {
  return props.selectedBookmarkIds.includes(bookmark.id)
}

function moveGroup(group, direction) {
  emit('sortMove', {
    type: 'group',
    id: group.id,
    direction
  })
}

function handleBookmarkSortMove(payload) {
  if (!activeGroup.value) return
  emit('sortMove', {
    ...payload,
    type: 'bookmark',
    groupId: activeGroup.value.id
  })
}

function writeSortDragData(event, payload) {
  if (!event.dataTransfer) return
  const value = JSON.stringify(payload)
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', value)
}

function readSortDragData(event) {
  try {
    return JSON.parse(event.dataTransfer?.getData('text/plain') || '{}')
  } catch {
    return {}
  }
}

function startGroupDrag(group, event) {
  if (props.managementMode !== 'sort' || props.managementBusy) {
    event.preventDefault()
    return
  }
  writeSortDragData(event, { type: 'group', id: group.id })
}

function allowGroupDrop(event) {
  if (props.managementMode !== 'sort' || props.managementBusy) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function dropGroup(group, event) {
  if (props.managementMode !== 'sort' || props.managementBusy) return
  const source = readSortDragData(event)
  if (source.type !== 'group' || !source.id) return
  event.preventDefault()
  emit('sortMove', {
    type: 'group',
    id: source.id,
    targetId: group.id
  })
}

function openMobileGroupActions(group, event) {
  event.stopPropagation()
  mobileGroupActionTrigger = event.currentTarget
  mobileActionGroup.value = group
  nextTick(() => mobileGroupFirstAction.value?.focus())
}

function closeMobileGroupActions(restoreFocus = true) {
  mobileActionGroup.value = null

  if (restoreFocus) {
    nextTick(() => mobileGroupActionTrigger?.focus())
  }
}

function trapMobileGroupActionFocus(event) {
  const focusable = Array.from(
    mobileGroupActionSheet.value?.querySelectorAll('button:not(:disabled)') || []
  )
  if (!focusable.length) return

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function runMobileGroupAction(action) {
  const group = mobileActionGroup.value
  if (!group) return

  closeMobileGroupActions()
  nextTick(() => {
    if (action === 'edit') {
      emit('editGroup', group)
    } else if (action === 'delete') {
      emit('deleteGroup', group)
    }
  })
}

function groupStyle(group) {
  return {
    '--group-color': group.color || 'var(--accent-color)'
  }
}

const mobileGroupMenuId = computed(() => (
  `group-actions-${String(mobileActionGroup.value?.id || 'current').replace(/[^a-z0-9_-]/gi, '-')}`
))
</script>

<template>
  <div class="nav-groups">
    <!-- 分组 Tab -->
    <div class="groups-tabs">
      <div class="groups-tabs__list" role="tablist" aria-label="导航分组">
        <div
          v-for="(group, groupIndex) in groups"
          :key="group.id"
          class="groups-tabs__tab"
          :class="{
            'is-active': activeGroup?.id === group.id,
            'is-sorting': managementMode === 'sort'
          }"
          :style="groupStyle(group)"
          role="presentation"
          @dragover="allowGroupDrop"
          @drop.stop="dropGroup(group, $event)"
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
          <span
            v-if="managementMode === 'sort'"
            class="groups-tabs__sort-actions"
            role="group"
            :aria-label="`${group.name} 排序操作`"
          >
            <button
              class="groups-tabs__drag-handle"
              type="button"
              draggable="true"
              :disabled="managementBusy"
              :aria-label="`拖动分组 ${group.name}`"
              title="拖动分组"
              @dragstart.stop="startGroupDrag(group, $event)"
            >
              <Icon name="menu" :size="15" />
            </button>
            <button
              type="button"
              :disabled="managementBusy || groupIndex === 0"
              :aria-label="`上移分组 ${group.name}`"
              @click.stop="moveGroup(group, -1)"
            >
              <Icon class="sort-chevron sort-chevron--up" name="chevron-down" :size="15" />
            </button>
            <button
              type="button"
              :disabled="managementBusy || groupIndex === groups.length - 1"
              :aria-label="`下移分组 ${group.name}`"
              @click.stop="moveGroup(group, 1)"
            >
              <Icon name="chevron-down" :size="15" />
            </button>
          </span>
          <span
            v-if="!managementMode"
            class="groups-tabs__actions"
            role="group"
            :aria-label="`${group.name} 分组操作`"
          >
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
          <button
            v-if="!managementMode"
            class="groups-tabs__mobile-more"
            type="button"
            aria-haspopup="dialog"
            :aria-controls="mobileActionGroup?.id === group.id ? mobileGroupMenuId : undefined"
            :aria-expanded="mobileActionGroup?.id === group.id"
            :aria-label="`更多分组操作：${group.name}`"
            @click="openMobileGroupActions(group, $event)"
          >
            <Icon name="more-horizontal" :size="20" />
          </button>
        </div>
      </div>
      <button
        v-if="!managementMode"
        class="groups-tabs__add"
        type="button"
        title="添加分组"
        aria-label="添加分组"
        @click="handleAddGroup"
      >
        <Icon name="plus" :size="18" />
        <span>新分组</span>
      </button>
    </div>

    <!-- 书签网格 -->
    <div class="bookmarks-container">
      <div
        class="bookmarks-grid"
        :class="{ 'bookmarks-grid--sorting': managementMode === 'sort' }"
      >
        <!-- 书签列表保持直接挂载，避免过渡状态让整组卡片滞留在不可见状态。 -->
        <NavItem
          v-for="(bookmark, bookmarkIndex) in visibleBookmarks"
          :key="bookmark.id"
          :bookmark="bookmark"
          :deleting="pendingBookmarkId === bookmark.id"
          :analyzing="analyzingBookmarkId === bookmark.id"
          :selection-mode="managementMode === 'select'"
          :sort-mode="managementMode === 'sort'"
          :selected="isBookmarkSelected(bookmark)"
          :management-busy="managementBusy"
          :sort-index="bookmarkIndex"
          :sort-count="activeBookmarks.length"
          @ai="handleAiBookmark"
          @edit="handleEditBookmark"
          @delete="handleDeleteBookmark"
          @toggle-selection="handleToggleBookmark"
          @sort-move="handleBookmarkSortMove"
        />

        <!-- 添加书签卡片：放在真实内容之后，避免低频操作占据首位。 -->
        <button
          v-if="activeGroup && !managementMode"
          class="bookmark-card bookmark-card--add"
          type="button"
          @click="handleAddBookmark"
        >
          <div class="bookmark-card__icon"><Icon name="plus" :size="28" /></div>
          <div class="bookmark-card__title">添加书签</div>
        </button>
      </div>

      <div v-if="activeBookmarks.length > BOOKMARK_PAGE_SIZE" class="bookmarks-pagination">
        <span role="status">已显示 {{ visibleBookmarks.length }} / {{ activeBookmarks.length }} 个收藏</span>
        <button v-if="visibleBookmarks.length < activeBookmarks.length" type="button"
          :disabled="managementBusy" @click="showMoreBookmarks">加载更多收藏</button>
      </div>

      <!-- 空状态 -->
      <div v-if="activeBookmarks.length === 0 && groups.length === 0" class="empty-state">
        <div class="empty-state__icon"><Icon name="folder" :size="42" /></div>
        <h2 class="empty-state__title">建立你的第一个导航分组</h2>
        <p class="empty-state__text">可以从空白分组开始，也可以恢复 DOMO NAV 导出的 JSON 备份。</p>
        <div class="empty-state__actions">
          <button class="btn btn--primary" type="button" @click="handleAddGroup">
            <Icon name="plus" :size="17" />创建第一个分组
          </button>
          <button class="btn btn--secondary" type="button" @click="openSettingsSection('data')">
            <Icon name="download" :size="17" />导入 NAV JSON
          </button>
          <button class="btn btn--secondary" type="button" @click="openSettingsSection('browser')">
            <Icon name="browser" :size="17" />安装快速收藏扩展
          </button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <Transition name="group-action-dialog">
        <div
          v-if="mobileActionGroup"
          class="group-action-overlay"
          @click.self="closeMobileGroupActions()"
          @keydown.esc.stop.prevent="closeMobileGroupActions()"
        >
          <section
            ref="mobileGroupActionSheet"
            :id="mobileGroupMenuId"
            class="group-action-sheet"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="`${mobileGroupMenuId}-title`"
            @keydown.tab="trapMobileGroupActionFocus"
          >
            <header class="group-action-sheet__header">
              <div>
                <div class="group-action-sheet__eyebrow">分组操作</div>
                <h2 :id="`${mobileGroupMenuId}-title`">{{ mobileActionGroup.name }}</h2>
              </div>
              <button type="button" aria-label="关闭分组操作" @click="closeMobileGroupActions()">
                <Icon name="close" :size="20" />
              </button>
            </header>
            <div class="group-action-sheet__actions">
              <button ref="mobileGroupFirstAction" type="button" @click="runMobileGroupAction('edit')">
                <Icon name="edit" :size="19" />
                <span>编辑分组</span>
              </button>
              <button
                class="is-danger"
                type="button"
                :disabled="pendingGroupId === mobileActionGroup.id"
                @click="runMobileGroupAction('delete')"
              >
                <Icon name="trash" :size="19" />
                <span>删除分组</span>
              </button>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.bookmarks-pagination {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 12px;
  margin-top: 20px;
  color: var(--text-secondary);
  font-size: 14px;
}
.bookmarks-pagination button {
  min-height: 44px;
  padding: 10px 18px;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  cursor: pointer;
}
.bookmarks-pagination button:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}
.nav-groups {
  margin-top: 20px;
}

/* Tab 样式 */
.groups-tabs {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 7px;
  background: var(--bg-secondary);
  border: 1px solid color-mix(in srgb, var(--border-light) 78%, transparent);
  border-radius: 18px;
  box-shadow: none;
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
  border-radius: 13px;
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
  border-color: var(--border-color);
  box-shadow: 0 1px 4px #0000000a;
}

.groups-tabs__tab.is-active .groups-tabs__main {
  font-weight: 700;
}

.groups-tabs__tab.is-active .groups-tabs__icon {
  background: color-mix(in srgb, var(--group-color) 20%, var(--bg-card));
  border-color: color-mix(in srgb, var(--group-color) 42%, transparent);
}

.groups-tabs__tab.is-active .groups-tabs__count {
  color: color-mix(in srgb, var(--group-color) 76%, var(--text-primary));
  background: color-mix(in srgb, var(--group-color) 14%, var(--bg-card));
}

.groups-tabs__main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 6px 9px;
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
  width: 28px;
  height: 28px;
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

.groups-tabs__sort-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 5px;
}

.groups-tabs__sort-actions button {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  padding: 0;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-card) 88%, var(--accent-color) 12%);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  cursor: pointer;
}

.groups-tabs__sort-actions button:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 1px;
}

.groups-tabs__sort-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.groups-tabs__drag-handle {
  cursor: grab !important;
  touch-action: none;
}

.groups-tabs__drag-handle:active {
  cursor: grabbing !important;
}

.sort-chevron--up {
  transform: rotate(180deg);
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

.groups-tabs__mobile-more {
  width: 44px;
  height: 44px;
  display: none;
  place-items: center;
  flex: 0 0 auto;
  margin: 1px 2px 1px 0;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 12px;
  cursor: pointer;
}

.groups-tabs__mobile-more:focus-visible {
  outline: 2px solid var(--group-color);
  outline-offset: 1px;
}

.groups-tabs__add {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 15px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--text-muted) 58%, var(--border-color));
  border-radius: 15px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  flex-shrink: 0;
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    border-color var(--transition-fast),
    transform var(--transition-fast),
    box-shadow var(--transition-fast);
}

.groups-tabs__add:hover {
  color: var(--accent-color);
  background: var(--accent-bg);
  border-color: color-mix(in srgb, var(--accent-color) 48%, var(--border-color));
  transform: translateY(-1px);
  box-shadow: 0 8px 18px color-mix(in srgb, var(--accent-color) 12%, transparent);
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
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
  align-items: stretch;
}

/* 添加书签卡片 */
.bookmark-card--add {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  width: 100%;
  min-height: 104px;
  padding: 14px;
  color: var(--text-secondary);
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--bg-secondary) 94%, white 6%), var(--bg-secondary));
  border: 1px dashed color-mix(in srgb, var(--accent-color) 38%, var(--border-color));
  border-radius: 16px;
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
  transform: translateY(-2px);
  box-shadow: 0 14px 30px color-mix(in srgb, var(--accent-color) 13%, transparent);
}

.bookmark-card--add:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 3px;
}

.bookmark-card--add .bookmark-card__icon {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  margin-bottom: 0;
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

.empty-state__title {
  margin: 0;
  color: var(--text-primary);
  font-size: 20px;
}

.empty-state__text {
  max-width: 560px;
  margin: 8px auto 22px;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.7;
}

.empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}

/* 按钮样式 */
.btn {
  min-height: 44px;
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

.btn--secondary {
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
}

.btn--secondary:hover {
  background: var(--bg-hover);
}

.group-action-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
  padding: clamp(20px, 5vh, 48px) 20px;
  background: color-mix(in srgb, black 54%, transparent);
  backdrop-filter: blur(5px);
  overscroll-behavior: contain;
}

.group-action-sheet {
  width: min(100%, 460px);
  max-height: min(620px, calc(100dvh - 64px));
  overflow: auto;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  box-shadow: var(--shadow-lg);
}

.group-action-dialog-enter-active,
.group-action-dialog-leave-active {
  transition: opacity 160ms ease;
}

.group-action-dialog-enter-active .group-action-sheet,
.group-action-dialog-leave-active .group-action-sheet {
  transition: transform 190ms var(--ease-smooth), opacity 160ms ease;
}

.group-action-dialog-enter-from,
.group-action-dialog-leave-to {
  opacity: 0;
}

.group-action-dialog-enter-from .group-action-sheet,
.group-action-dialog-leave-to .group-action-sheet {
  opacity: 0;
  transform: translateY(12px) scale(0.98);
}

.group-action-sheet__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--border-light);
}

.group-action-sheet__eyebrow {
  margin-bottom: 4px;
  color: var(--accent-color);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.08em;
}

.group-action-sheet h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 17px;
  line-height: 1.35;
}

.group-action-sheet__header button,
.group-action-sheet__actions button {
  min-width: 44px;
  min-height: 44px;
  color: var(--text-primary);
  background: transparent;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
}

.group-action-sheet__header button {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  background: var(--bg-secondary);
}

.group-action-sheet__actions {
  display: grid;
  gap: 6px;
  padding: 10px;
}

.group-action-sheet__actions button {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 11px 13px;
  text-align: left;
}

.group-action-sheet__actions button:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: -2px;
}

.group-action-sheet__actions button.is-danger {
  color: var(--error-color);
}

.group-action-sheet__actions button:disabled {
  opacity: 0.55;
  cursor: wait;
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
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }

  .bookmarks-grid--sorting {
    grid-template-columns: minmax(0, 1fr);
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

  .empty-state__actions {
    display: grid;
  }

  .group-action-overlay {
    align-items: flex-end;
    padding: 12px 12px max(12px, env(safe-area-inset-bottom));
  }

  .group-action-sheet {
    max-height: min(78dvh, 620px);
    border-radius: 24px 24px 18px 18px;
  }

  .group-action-dialog-enter-from .group-action-sheet,
  .group-action-dialog-leave-to .group-action-sheet {
    transform: translateY(24px);
  }
}

@media (hover: none) and (pointer: coarse), (max-width: 760px) {
  .groups-tabs__actions {
    display: none;
  }

  .groups-tabs__mobile-more {
    display: grid;
  }

  .groups-tabs__sort-actions button {
    width: 44px;
    height: 44px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .groups-tabs__tab,
  .groups-tabs__actions,
  .groups-tabs__sort-actions button,
  .groups-tabs__action,
  .groups-tabs__add,
  .bookmark-card--add,
  .group-action-dialog-enter-active,
  .group-action-dialog-leave-active,
  .group-action-dialog-enter-active .group-action-sheet,
  .group-action-dialog-leave-active .group-action-sheet {
    transition: none;
  }

  .groups-tabs__add:hover,
  .bookmark-card--add:hover {
    transform: none;
  }
}
</style>
