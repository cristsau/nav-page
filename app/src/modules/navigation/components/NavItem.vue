<script setup>
import { ref, computed } from 'vue'
import { useConfig } from '@/shared/composables/useConfig'

const props = defineProps({
  bookmark: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['edit', 'delete'])

const { config } = useConfig()
const showActions = ref(false)

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
  window.open(props.bookmark.url, '_blank')
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
    :style="{ width: cardStyle.width }"
    @click="openUrl"
    @mouseenter="showActions = true"
    @mouseleave="showActions = false"
  >
    <!-- 操作按钮 -->
    <Transition name="fade">
      <div v-if="showActions" class="bookmark-card__actions">
        <button class="action-btn" title="编辑" @click="handleEdit">
          ✏️
        </button>
        <button class="action-btn action-btn--danger" title="删除" @click="handleDelete">
          🗑️
        </button>
      </div>
    </Transition>

    <!-- 图标 -->
    <div class="bookmark-card__icon" :style="{ fontSize: cardStyle.iconSize }">
      <img
        v-if="getFavicon(bookmark.url)"
        :src="getFavicon(bookmark.url)"
        :alt="bookmark.title"
        @error="$event.target.style.display = 'none'"
      >
      <span v-else class="bookmark-card__icon-fallback">🔗</span>
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
  padding: 20px 12px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: center;
  box-shadow: var(--shadow-card);
  transition: all var(--transition-normal) var(--ease-smooth);
}

.bookmark-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-card-hover);
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
}

.action-btn:hover {
  background: var(--bg-hover);
  transform: scale(1.1);
}

.action-btn--danger:hover {
  background: var(--error-color);
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
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
