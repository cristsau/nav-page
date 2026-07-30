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
  }
})

const emit = defineEmits(['edit', 'delete'])

const { config } = useConfig()

const cardStyle = computed(() => {
  const size = config.value.style.cardSize
  const sizes = {
    small: { width: '90px', iconSize: '32px' },
    medium: { width: '110px', iconSize: '44px' },
    large: { width: '130px', iconSize: '56px' }
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
  <div
    class="bookmark-card card-float"
    :class="{ 'is-deleting': deleting }"
    :style="{ width: cardStyle.width }"
    role="link"
    tabindex="0"
    :aria-label="`打开 ${bookmark.title}`"
    @click="openUrl"
    @keydown.enter.prevent="openUrl"
    @keydown.space.prevent="openUrl"
  >
    <!-- 操作按钮 -->
    <div class="bookmark-card__actions">
        <button
          class="action-btn"
          type="button"
          title="编辑"
          :aria-label="`编辑书签 ${bookmark.title}`"
          :disabled="deleting"
          @click="handleEdit"
        >
          <Icon name="edit" :size="15" />
        </button>
        <button
          class="action-btn action-btn--danger"
          type="button"
          title="删除"
          :aria-label="`删除书签 ${bookmark.title}`"
          :disabled="deleting"
          @click="handleDelete"
        >
          <span v-if="deleting" class="mini-spinner" aria-hidden="true"></span>
          <Icon v-else name="trash" :size="15" />
        </button>
    </div>

    <!-- 图标 -->
    <div class="bookmark-card__icon" :style="{ fontSize: cardStyle.iconSize }">
      <img
        v-if="getFavicon(bookmark.url)"
        :src="getFavicon(bookmark.url)"
        :alt="bookmark.title"
        @error="$event.target.style.display = 'none'"
      >
      <Icon v-else class="bookmark-card__icon-fallback" name="link" :size="28" />
    </div>

    <!-- 标题 -->
    <div class="bookmark-card__title">{{ bookmark.title }}</div>

    <!-- 描述（可选显示） -->
    <div
      v-if="config.layout.showDescription && bookmark.description"
      class="bookmark-card__desc"
    >
      {{ bookmark.description }}
    </div>
  </div>
</template>

<style scoped>
.bookmark-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 44px 12px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: center;
  box-shadow: var(--shadow-card);
  transition: all var(--transition-normal) var(--ease-smooth);
  border: 1px solid transparent;
}

.bookmark-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-card-hover);
}

.bookmark-card:focus-visible {
  border-color: var(--accent-color);
}

.bookmark-card.is-deleting {
  opacity: 0.65;
  pointer-events: none;
}

.bookmark-card:active {
  transform: translateY(-2px) scale(0.98);
}

.bookmark-card__actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 1;
  transform: none;
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.bookmark-card:hover .bookmark-card__actions,
.bookmark-card:focus-within .bookmark-card__actions {
  opacity: 1;
  transform: translateY(0);
}

.action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  transition: all var(--transition-fast);
  color: var(--text-muted);
}

.action-btn:hover {
  background: var(--bg-hover);
  transform: scale(1.1);
}

.action-btn--danger:hover {
  background: var(--error-color);
  color: #fff;
}

.bookmark-card__icon {
  width: 1em;
  height: 1em;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 12px;
}

.bookmark-card__icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: 8px;
}

.bookmark-card__icon-fallback {
  font-size: 1em;
}

.bookmark-card__title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  line-height: 1.3;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bookmark-card__desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
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
  }
}
</style>
