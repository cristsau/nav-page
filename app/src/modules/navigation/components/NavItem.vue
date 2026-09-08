<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useConfig } from '@/shared/composables/useConfig'
import Icon from '@/shared/components/Icon.vue'
import { resolveBookmarkPresentation } from '../navigationUi'
import { resolveBookmarkHealthPresentation } from '../navigationManagement'

const props = defineProps({
  bookmark: {
    type: Object,
    required: true
  },
  deleting: {
    type: Boolean,
    default: false
  },
  analyzing: {
    type: Boolean,
    default: false
  },
  selectionMode: {
    type: Boolean,
    default: false
  },
  sortMode: {
    type: Boolean,
    default: false
  },
  selected: {
    type: Boolean,
    default: false
  },
  managementBusy: {
    type: Boolean,
    default: false
  },
  sortIndex: {
    type: Number,
    default: 0
  },
  sortCount: {
    type: Number,
    default: 0
  }
})

const emit = defineEmits(['ai', 'edit', 'delete', 'toggleSelection', 'sortMove'])

const { config } = useConfig()
const faviconFailed = ref(false)
const showMobileActions = ref(false)
const mobileMoreButton = ref(null)
const mobileFirstAction = ref(null)
const mobileActionSheet = ref(null)

const cardStyle = computed(() => {
  const size = config.value.style.cardSize
  const sizes = {
    small: { minHeight: '92px', iconSize: '36px' },
    medium: { minHeight: '104px', iconSize: '44px' },
    large: { minHeight: '116px', iconSize: '50px' }
  }
  return sizes[size] || sizes.medium
})

const bookmarkPresentation = computed(() => resolveBookmarkPresentation(props.bookmark))
const healthPresentation = computed(() => resolveBookmarkHealthPresentation(props.bookmark))
const faviconUrl = computed(() => {
  if (props.bookmark.favicon) {
    return props.bookmark.favicon
  }

  try {
    const url = new URL(props.bookmark.url)
    return `${url.origin}/favicon.ico`
  } catch {
    return ''
  }
})
const fallbackStyle = computed(() => ({
  '--bookmark-fallback-hue': bookmarkPresentation.value.hue
}))
const mobileMenuId = computed(() => (
  `bookmark-actions-${String(props.bookmark.id || bookmarkPresentation.value.hash).replace(/[^a-z0-9_-]/gi, '-')}`
))

watch(
  () => [props.bookmark.favicon, props.bookmark.url],
  () => {
    faviconFailed.value = false
  }
)

function openUrl() {
  if (props.selectionMode) {
    emit('toggleSelection', props.bookmark)
    return
  }
  if (props.sortMode || props.managementBusy) return

  try {
    const url = new URL(props.bookmark.url)
    if (!['http:', 'https:'].includes(url.protocol)) return
    window.open(url.toString(), '_blank', 'noopener')
  } catch {
    // Invalid URLs are rejected when saving; keep this as a final safety guard.
  }
}

function toggleSelection(event) {
  event.stopPropagation()
  if (props.managementBusy) return
  emit('toggleSelection', props.bookmark)
}

function moveBookmark(direction) {
  if (props.managementBusy) return
  emit('sortMove', {
    id: props.bookmark.id,
    direction
  })
}

function startBookmarkDrag(event) {
  if (!props.sortMode || props.managementBusy || !event.dataTransfer) {
    event.preventDefault()
    return
  }
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', JSON.stringify({
    type: 'bookmark',
    id: props.bookmark.id
  }))
}

function allowBookmarkDrop(event) {
  if (!props.sortMode || props.managementBusy) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function dropBookmark(event) {
  if (!props.sortMode || props.managementBusy) return
  try {
    const source = JSON.parse(event.dataTransfer?.getData('text/plain') || '{}')
    if (source.type !== 'bookmark' || !source.id) return
    event.preventDefault()
    emit('sortMove', {
      id: source.id,
      targetId: props.bookmark.id
    })
  } catch {
    // Ignore drag payloads that do not belong to bookmark sorting.
  }
}

function handleEdit(e) {
  e.stopPropagation()
  emit('edit', props.bookmark)
}

function handleAi(e) {
  e.stopPropagation()
  emit('ai', props.bookmark, e.currentTarget)
}

function handleDelete(e) {
  e.stopPropagation()
  emit('delete', props.bookmark)
}

function openMobileActions(event) {
  event.stopPropagation()
  showMobileActions.value = true
  nextTick(() => mobileFirstAction.value?.focus())
}

function closeMobileActions(restoreFocus = true) {
  showMobileActions.value = false
  if (restoreFocus) {
    nextTick(() => mobileMoreButton.value?.focus())
  }
}

function trapMobileActionFocus(event) {
  const focusable = Array.from(
    mobileActionSheet.value?.querySelectorAll('button:not(:disabled)') || []
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

function runMobileAction(action) {
  showMobileActions.value = false

  nextTick(() => {
    mobileMoreButton.value?.focus()

    if (action === 'ai') {
      emit('ai', props.bookmark, mobileMoreButton.value)
    } else if (action === 'edit') {
      emit('edit', props.bookmark)
    } else if (action === 'delete') {
      emit('delete', props.bookmark)
    }
  })
}
</script>

<template>
  <article
    class="bookmark-card card-float"
    :data-bookmark-id="bookmark.id"
    :class="{
      'is-busy': deleting || analyzing || managementBusy,
      'is-selecting': selectionMode,
      'is-selected': selected,
      'is-sorting': sortMode
    }"
    :style="{ minHeight: cardStyle.minHeight }"
    :aria-busy="deleting || analyzing || managementBusy"
    @dragover="allowBookmarkDrop"
    @drop.stop="dropBookmark"
  >
    <button
      v-if="selectionMode"
      class="bookmark-card__selection"
      type="button"
      role="checkbox"
      :aria-checked="selected"
      :aria-label="`${selected ? '取消选择' : '选择'}书签 ${bookmark.title}`"
      :disabled="managementBusy"
      @click="toggleSelection"
    >
      <Icon name="check" :size="17" />
    </button>

    <div v-if="sortMode" class="bookmark-card__sort-actions" role="group" :aria-label="`${bookmark.title} 排序操作`">
      <button
        class="bookmark-card__drag-handle"
        type="button"
        draggable="true"
        :disabled="managementBusy"
        :aria-label="`拖动书签 ${bookmark.title}`"
        title="拖动书签"
        @dragstart.stop="startBookmarkDrag"
      >
        <Icon name="menu" :size="18" />
      </button>
      <button
        type="button"
        :disabled="managementBusy || sortIndex === 0"
        :aria-label="`上移书签 ${bookmark.title}`"
        @click.stop="moveBookmark(-1)"
      >
        <Icon class="bookmark-sort-chevron--up" name="chevron-down" :size="18" />
      </button>
      <button
        type="button"
        :disabled="managementBusy || sortIndex === sortCount - 1"
        :aria-label="`下移书签 ${bookmark.title}`"
        @click.stop="moveBookmark(1)"
      >
        <Icon name="chevron-down" :size="18" />
      </button>
    </div>

    <button
      class="bookmark-card__main"
      type="button"
      :aria-label="selectionMode
        ? `${selected ? '取消选择' : '选择'}书签 ${bookmark.title}`
        : sortMode
          ? `书签 ${bookmark.title} 正在排序`
          : `打开 ${bookmark.title}，${bookmarkPresentation.subtitle}`"
      :aria-pressed="selectionMode ? selected : undefined"
      :title="`${bookmark.title}\n${bookmarkPresentation.fullSubtitle}`"
      :disabled="deleting || analyzing || managementBusy"
      @click="openUrl"
    >
      <!-- 图标 -->
      <span
        class="bookmark-card__icon"
        :style="{ fontSize: cardStyle.iconSize, ...fallbackStyle }"
        aria-hidden="true"
      >
        <span class="bookmark-card__monogram">{{ bookmarkPresentation.monogram }}</span>
        <img
          v-if="faviconUrl && !faviconFailed"
          :src="faviconUrl"
          loading="lazy"
          decoding="async"
          alt=""
          @error="faviconFailed = true"
        >
      </span>

      <span class="bookmark-card__body">
        <!-- 标题 -->
        <span class="bookmark-card__title" :title="bookmark.title">{{ bookmark.title }}</span>
        <span class="bookmark-card__subtitle" :title="bookmarkPresentation.fullSubtitle">
          {{ bookmarkPresentation.subtitle }}
        </span>
        <span
          v-if="healthPresentation"
          class="bookmark-card__health"
          :class="`is-${healthPresentation.tone}`"
          :title="healthPresentation.httpStatus
            ? `${healthPresentation.label} · HTTP ${healthPresentation.httpStatus}`
            : healthPresentation.label"
        >
          {{ healthPresentation.label }}
          <span v-if="healthPresentation.httpStatus">{{ healthPresentation.httpStatus }}</span>
        </span>

        <!-- 描述（可选显示） -->
        <span
          v-if="config.layout.showDescription && bookmark.description"
          class="bookmark-card__desc"
        >
          {{ bookmark.description }}
        </span>
        <span
          v-if="bookmark.tags?.length"
          class="bookmark-card__tags"
          :aria-label="`标签：${bookmark.tags.join('、')}`"
        >
          <span v-for="tag in bookmark.tags.slice(0, 2)" :key="tag" class="bookmark-card__tag">
            {{ tag }}
          </span>
          <span v-if="bookmark.tags.length > 2" class="bookmark-card__tag-count">
            +{{ bookmark.tags.length - 2 }}
          </span>
        </span>
      </span>
    </button>

    <!-- 操作按钮：主链接排在前面，键盘用户先打开，再访问 AI / 编辑 / 删除。 -->
    <div v-if="!selectionMode && !sortMode" class="bookmark-card__actions" role="group" aria-label="书签操作">
      <button
        class="action-btn action-btn--ai"
        type="button"
        title="AI 分析"
        :aria-label="`用 AI 分析书签 ${bookmark.title}`"
        :disabled="deleting || analyzing"
        @click="handleAi"
      >
        <span v-if="analyzing" class="mini-spinner" aria-hidden="true"></span>
        <Icon v-else name="sparkles" :size="15" />
      </button>
      <button
        class="action-btn"
        type="button"
        title="编辑"
        :aria-label="`编辑书签 ${bookmark.title}`"
        :disabled="deleting || analyzing"
        @click="handleEdit"
      >
        <Icon name="edit" :size="15" />
      </button>
      <button
        class="action-btn action-btn--danger"
        type="button"
        title="删除"
        :aria-label="`删除书签 ${bookmark.title}`"
        :disabled="deleting || analyzing"
        @click="handleDelete"
      >
        <span v-if="deleting" class="mini-spinner" aria-hidden="true"></span>
        <Icon v-else name="trash" :size="15" />
      </button>
    </div>

    <button
      v-if="!selectionMode && !sortMode"
      ref="mobileMoreButton"
      class="bookmark-card__more"
      type="button"
      aria-haspopup="dialog"
      :aria-controls="mobileMenuId"
      :aria-expanded="showMobileActions"
      :aria-label="`更多书签操作：${bookmark.title}`"
      :disabled="deleting || analyzing"
      @click="openMobileActions"
    >
      <Icon name="more-horizontal" :size="21" />
    </button>

    <Teleport to="body">
      <Transition name="bookmark-action-dialog">
        <div
          v-if="showMobileActions"
          class="mobile-action-overlay"
          @click.self="closeMobileActions()"
          @keydown.esc.stop.prevent="closeMobileActions()"
        >
          <section
            ref="mobileActionSheet"
            :id="mobileMenuId"
            class="mobile-action-sheet"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="`${mobileMenuId}-title`"
            @keydown.tab="trapMobileActionFocus"
          >
            <header class="mobile-action-sheet__header">
              <div>
                <div class="mobile-action-sheet__eyebrow">书签操作</div>
                <h2 :id="`${mobileMenuId}-title`">{{ bookmark.title }}</h2>
              </div>
              <button type="button" aria-label="关闭书签操作" @click="closeMobileActions()">
                <Icon name="close" :size="20" />
              </button>
            </header>
            <div class="mobile-action-sheet__actions">
              <button ref="mobileFirstAction" type="button" @click="runMobileAction('ai')">
                <Icon name="sparkles" :size="19" />
                <span>AI 分析</span>
              </button>
              <button type="button" @click="runMobileAction('edit')">
                <Icon name="edit" :size="19" />
                <span>编辑书签</span>
              </button>
              <button class="is-danger" type="button" @click="runMobileAction('delete')">
                <Icon name="trash" :size="19" />
                <span>删除书签</span>
              </button>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>
  </article>
</template>

<style scoped>
.bookmark-card {
  position: relative;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  background: var(--bg-card);
  border-radius: 19px;
  text-align: left;
  box-shadow: 0 2px 10px color-mix(in srgb,var(--text-primary) 3%,transparent);
  border: 1px solid var(--border-light);
  transition:
    transform var(--transition-normal) var(--ease-smooth),
    box-shadow var(--transition-normal) var(--ease-smooth),
    border-color var(--transition-fast);
}

.bookmark-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-card-hover);
  border-color: color-mix(in srgb, var(--accent-color) 22%, var(--border-light));
}

.bookmark-card.is-busy {
  opacity: 0.65;
}

.bookmark-card.is-selected {
  border-color: color-mix(in srgb, var(--accent-color) 72%, var(--border-color));
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--accent-color) 16%, transparent),
    var(--shadow-card);
}

.bookmark-card.is-selecting:hover,
.bookmark-card.is-sorting:hover {
  transform: none;
}

.bookmark-card__selection,
.bookmark-card__sort-actions button {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-card) 90%, var(--accent-color) 10%);
  border: 1px solid var(--border-color);
  border-radius: 11px;
  cursor: pointer;
}

.bookmark-card__selection {
  position: absolute;
  top: 9px;
  left: 9px;
  z-index: 4;
}

.bookmark-card__selection[aria-checked='true'] {
  color: #fff;
  background: var(--accent-color);
  border-color: var(--accent-color);
}

.bookmark-card__selection:focus-visible,
.bookmark-card__sort-actions button:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.bookmark-card__sort-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  left: 8px;
  z-index: 4;
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}

.bookmark-card__sort-actions button:disabled,
.bookmark-card__selection:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.bookmark-card__drag-handle {
  margin-right: auto;
  cursor: grab !important;
  touch-action: none;
}

.bookmark-card__drag-handle:active {
  cursor: grabbing !important;
}

.bookmark-sort-chevron--up {
  transform: rotate(180deg);
}

.bookmark-card__main {
  width: 100%;
  min-height: inherit;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 14px 52px 14px 14px;
  color: inherit;
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
}

.bookmark-card__main:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: -3px;
  border-radius: inherit;
}

.bookmark-card__main:active {
  transform: scale(0.985);
}

.bookmark-card__main:disabled {
  cursor: wait;
}

.bookmark-card.is-selecting .bookmark-card__main {
  padding-left: 58px;
}

.bookmark-card.is-sorting .bookmark-card__main {
  padding-top: 58px;
}

.bookmark-card__actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: none;
  gap: 4px;
  z-index: 2;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-5px);
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.bookmark-card:hover .bookmark-card__actions,
.bookmark-card:focus-within .bookmark-card__actions {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg-card) 92%, var(--accent-color) 8%);
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, var(--accent-color) 18%);
  border-radius: 9px;
  cursor: pointer;
  backdrop-filter: blur(10px);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--text-primary) 10%, transparent);
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    border-color var(--transition-fast),
    transform var(--transition-fast);
  color: var(--text-secondary);
}

.action-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
  transform: scale(1.1);
}

.action-btn:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.action-btn:disabled {
  cursor: wait;
}

.action-btn--ai:hover:not(:disabled) {
  color: var(--accent-color);
  background: var(--accent-bg);
  border-color: color-mix(in srgb, var(--accent-color) 38%, transparent);
}

.action-btn--danger:hover:not(:disabled) {
  background: var(--error-color);
  border-color: var(--error-color);
  color: #fff;
}

.bookmark-card__icon {
  position: relative;
  width: 1em;
  height: 1em;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 0;
  filter: none;
}

.bookmark-card__monogram {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  color: hsl(var(--bookmark-fallback-hue) 88% 88%);
  background:
    linear-gradient(
      145deg,
      hsl(var(--bookmark-fallback-hue) 62% 27%),
      hsl(var(--bookmark-fallback-hue) 72% 17%)
    );
  border: 1px solid hsl(var(--bookmark-fallback-hue) 72% 42% / 0.42);
  border-radius: 13px;
  box-shadow: inset 0 1px hsl(0 0% 100% / 0.12);
  font-size: 0.36em;
  font-weight: 780;
  letter-spacing: 0.03em;
  line-height: 1;
}

.bookmark-card__icon img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 12px;
}

.bookmark-card__body {
  min-width: 0;
  display: grid;
  justify-items: start;
}

.bookmark-card__title {
  overflow-wrap: anywhere;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.3;
  display: -webkit-box;
  max-width: 100%;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  min-height: 0;
}

.bookmark-card__subtitle {
  display: block;
  max-width: 100%;
  margin-top: 5px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: ltr;
}

.bookmark-card__health {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 3px 7px;
  color: var(--text-muted);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 999px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.bookmark-card__health.is-success {
  color: var(--success-color);
  border-color: color-mix(in srgb, var(--success-color) 38%, var(--border-light));
}

.bookmark-card__health.is-warning {
  color: color-mix(in srgb, #b77828 78%, var(--text-primary));
  border-color: color-mix(in srgb, #b77828 38%, var(--border-light));
}

.bookmark-card__health.is-error {
  color: var(--error-color);
  border-color: color-mix(in srgb, var(--error-color) 42%, var(--border-light));
}

.bookmark-card__health.is-info {
  color: var(--accent-color);
  border-color: color-mix(in srgb, var(--accent-color) 38%, var(--border-light));
}

.bookmark-card__desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bookmark-card__tags {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 5px;
  max-width: 100%;
  margin-top: 8px;
}

.bookmark-card__tag,
.bookmark-card__tag-count {
  max-width: 78px;
  overflow: hidden;
  padding: 3px 7px;
  color: var(--accent-color);
  background: var(--accent-bg);
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bookmark-card__tag-count {
  flex: 0 0 auto;
  color: var(--text-secondary);
  background: var(--bg-secondary);
}

.bookmark-card__more {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid transparent;
  border-radius: 50%;
  box-shadow: none;
  cursor: pointer;
}

.bookmark-card__more:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.bookmark-card__main {
  padding-right: 64px;
}

.mobile-action-overlay {
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

.mobile-action-sheet {
  width: min(100%, 460px);
  max-height: min(620px, calc(100dvh - 64px));
  overflow: auto;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  box-shadow: var(--shadow-lg);
}

.bookmark-action-dialog-enter-active,
.bookmark-action-dialog-leave-active {
  transition: opacity 160ms ease;
}

.bookmark-action-dialog-enter-active .mobile-action-sheet,
.bookmark-action-dialog-leave-active .mobile-action-sheet {
  transition: transform 190ms var(--ease-smooth), opacity 160ms ease;
}

.bookmark-action-dialog-enter-from,
.bookmark-action-dialog-leave-to {
  opacity: 0;
}

.bookmark-action-dialog-enter-from .mobile-action-sheet,
.bookmark-action-dialog-leave-to .mobile-action-sheet {
  opacity: 0;
  transform: translateY(12px) scale(0.98);
}

.mobile-action-sheet__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--border-light);
}

.mobile-action-sheet__eyebrow {
  margin-bottom: 4px;
  color: var(--accent-color);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.08em;
}

.mobile-action-sheet h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 17px;
  line-height: 1.35;
}

.mobile-action-sheet__header button,
.mobile-action-sheet__actions button {
  min-width: 44px;
  min-height: 44px;
  color: var(--text-primary);
  background: transparent;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
}

.mobile-action-sheet__header button {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  background: var(--bg-secondary);
}

.mobile-action-sheet__actions {
  display: grid;
  gap: 6px;
  padding: 10px;
}

.mobile-action-sheet__actions button {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 11px 13px;
  text-align: left;
}

.mobile-action-sheet__actions button:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: -2px;
}

.mobile-action-sheet__actions button.is-danger {
  color: var(--error-color);
}

/* Fade transition */
.mini-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.75s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (hover: none) and (pointer: coarse), (max-width: 760px) {
  .bookmark-card__actions {
    display: none;
  }

  .bookmark-card__more {
    display: grid;
  }

  .bookmark-card__main {
    padding-right: 64px;
  }

  .bookmark-card__selection,
  .bookmark-card__sort-actions button {
    width: 44px;
    height: 44px;
  }
}

@media (max-width: 640px) {
  .mobile-action-overlay {
    align-items: flex-end;
    padding: 12px 12px max(12px, env(safe-area-inset-bottom));
  }

  .mobile-action-sheet {
    max-height: min(78dvh, 620px);
    border-radius: 24px 24px 18px 18px;
  }

  .bookmark-action-dialog-enter-from .mobile-action-sheet,
  .bookmark-action-dialog-leave-to .mobile-action-sheet {
    transform: translateY(24px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .bookmark-card,
  .bookmark-card__actions,
  .bookmark-card__main,
  .bookmark-card__selection,
  .bookmark-card__sort-actions button,
  .action-btn,
  .bookmark-action-dialog-enter-active,
  .bookmark-action-dialog-leave-active,
  .bookmark-action-dialog-enter-active .mobile-action-sheet,
  .bookmark-action-dialog-leave-active .mobile-action-sheet {
    transition: none;
  }

  .bookmark-card:hover,
  .action-btn:hover:not(:disabled) {
    transform: none;
  }
}
</style>
