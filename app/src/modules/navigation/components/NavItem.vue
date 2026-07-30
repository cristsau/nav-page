<script setup>
import { computed } from 'vue'
import { useConfig } from '@/shared/composables/useConfig'
import Icon from '@/shared/components/Icon.vue'

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
  }
})

const emit = defineEmits(['ai', 'edit', 'delete'])

const { config } = useConfig()

const cardStyle = computed(() => {
  const size = config.value.style.cardSize
  const sizes = {
    small: { minHeight: '138px', iconSize: '34px' },
    medium: { minHeight: '154px', iconSize: '44px' },
    large: { minHeight: '174px', iconSize: '54px' }
  }
  return sizes[size] || sizes.medium
})

function openUrl() {
  try {
    const url = new URL(props.bookmark.url)
    if (!['http:', 'https:'].includes(url.protocol)) return
    window.open(url.toString(), '_blank', 'noopener')
  } catch {
    // Invalid URLs are rejected when saving; keep this as a final safety guard.
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

// 获取 favicon URL
function getFavicon(url) {
  if (props.bookmark.favicon) {
    return props.bookmark.favicon
  }
  try {
    const urlObj = new URL(url)
    return `${urlObj.origin}/favicon.ico`
  } catch {
    return ''
  }
}
</script>

<template>
  <article
    class="bookmark-card card-float"
    :class="{ 'is-busy': deleting || analyzing }"
    :style="{ minHeight: cardStyle.minHeight }"
    :aria-busy="deleting || analyzing"
  >
    <button
      class="bookmark-card__main"
      type="button"
      :aria-label="`打开 ${bookmark.title}`"
      :disabled="deleting || analyzing"
      @click="openUrl"
    >
      <!-- 图标 -->
      <span class="bookmark-card__icon" :style="{ fontSize: cardStyle.iconSize }">
        <Icon class="bookmark-card__icon-fallback" name="link" :size="28" />
        <img
          v-if="getFavicon(bookmark.url)"
          :src="getFavicon(bookmark.url)"
          alt=""
          @error="$event.target.style.display = 'none'"
        >
      </span>

      <!-- 标题 -->
      <span class="bookmark-card__title">{{ bookmark.title }}</span>

      <!-- 描述（可选显示） -->
      <span
        v-if="config.layout.showDescription && bookmark.description"
        class="bookmark-card__desc"
      >
        {{ bookmark.description }}
      </span>
    </button>

    <!-- 操作按钮：主链接排在前面，键盘用户先打开，再访问 AI / 编辑 / 删除。 -->
    <div class="bookmark-card__actions" role="group" aria-label="书签操作">
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
  </article>
</template>

<style scoped>
.bookmark-card {
  position: relative;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--bg-card) 96%, white 4%), var(--bg-card));
  border-radius: 22px;
  text-align: center;
  box-shadow:
    0 1px 0 color-mix(in srgb, white 72%, transparent) inset,
    var(--shadow-card);
  border: 1px solid color-mix(in srgb, var(--border-light) 76%, transparent);
  transition:
    transform var(--transition-normal) var(--ease-smooth),
    box-shadow var(--transition-normal) var(--ease-smooth),
    border-color var(--transition-fast);
}

.bookmark-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-card-hover);
  border-color: color-mix(in srgb, var(--accent-color) 22%, var(--border-light));
}

.bookmark-card.is-busy {
  opacity: 0.65;
}

.bookmark-card__main {
  width: 100%;
  min-height: inherit;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 15px 20px;
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

.bookmark-card__actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
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
  margin-bottom: 12px;
  color: var(--accent-color);
  filter: drop-shadow(0 7px 12px color-mix(in srgb, var(--accent-color) 14%, transparent));
}

.bookmark-card__icon img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 12px;
}

.bookmark-card__icon-fallback {
  color: currentColor;
}

.bookmark-card__title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  line-height: 1.3;
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

@media (hover: none), (pointer: coarse) {
  .bookmark-card__actions {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bookmark-card,
  .bookmark-card__actions,
  .bookmark-card__main,
  .action-btn {
    transition: none;
  }

  .bookmark-card:hover,
  .action-btn:hover:not(:disabled) {
    transform: none;
  }
}
</style>
