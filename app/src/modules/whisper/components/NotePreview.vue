<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import CopyableNoteContent from './CopyableNoteContent.vue'
import CopyableValue from './CopyableValue.vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  note: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['close', 'edit', 'ai', 'copyId', 'copyExtract', 'copyValue'])
const dialogRef = ref(null)
let previouslyFocusedElement = null

function formatDate(timestamp) {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

function formatEntryDate(value) {
  if (!value) return '-'
  return new Date(`${value}T00:00:00`).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

function forwardCopy(payload) {
  emit('copyValue', payload)
}

function restorePreviousFocus() {
  if (previouslyFocusedElement instanceof HTMLElement && previouslyFocusedElement.isConnected) {
    previouslyFocusedElement.focus()
  }
  previouslyFocusedElement = null
}

function requestClose() {
  emit('close')
}

function handleDialogKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }

  if (event.key !== 'Tab' || !dialogRef.value) return

  const focusable = [...dialogRef.value.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((element) => element.getClientRects().length > 0)

  if (!focusable.length) {
    event.preventDefault()
    dialogRef.value.focus()
    return
  }

  const first = focusable[0]
  const last = focusable.at(-1)
  const active = document.activeElement

  if (event.shiftKey && (active === first || !dialogRef.value.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => props.show,
  async (show) => {
    if (show) {
      previouslyFocusedElement = document.activeElement
      await nextTick()
      dialogRef.value?.focus()
      return
    }

    await nextTick()
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
      previouslyFocusedElement = null
      return
    }

    restorePreviousFocus()
  }
)

onBeforeUnmount(restorePreviousFocus)
</script>

<template>
  <div v-if="show && note" class="preview-modal" @click.self="requestClose">
    <div
      ref="dialogRef"
      class="preview-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="note-preview-title"
      tabindex="-1"
      @keydown="handleDialogKeydown"
    >
      <div class="preview-card__header">
        <div>
          <div class="preview-card__type">{{ note.type === 'memo' ? '备忘录' : '日记' }}</div>
          <h3 id="note-preview-title" class="preview-card__title">
            <CopyableValue :value="note.title" label="标题" @copy="forwardCopy">
              {{ note.title }}
            </CopyableValue>
          </h3>
        </div>
        <button type="button" class="preview-card__close" aria-label="关闭预览" @click="emit('close')">
          <Icon name="close" :size="18" />
        </button>
      </div>

      <div class="preview-card__meta">
        <button
          v-if="note.numberId"
          type="button"
          class="preview-card__id"
          :aria-label="`复制笔记数字 ID ${note.numberId}`"
          @click="emit('copyId', note)"
        >
          <Icon name="copy" :size="13" /> ID #{{ note.numberId }}
        </button>
        <CopyableValue
          :value="formatDate(note.updatedAt)"
          label="更新时间"
          @copy="forwardCopy"
        >
          更新时间：{{ formatDate(note.updatedAt) }}
        </CopyableValue>
        <CopyableValue
          v-if="note.type === 'diary'"
          :value="formatEntryDate(note.entryDate)"
          label="记录日期"
          @copy="forwardCopy"
        >
          记录日期：{{ formatEntryDate(note.entryDate) }}
        </CopyableValue>
        <CopyableValue
          v-if="note.mood"
          :value="note.mood"
          label="心情"
          @copy="forwardCopy"
        >
          心情：{{ note.mood }}
        </CopyableValue>
        <CopyableValue
          v-if="note.dueAt"
          :value="formatDate(note.dueAt)"
          label="截止时间"
          @copy="forwardCopy"
        >
          截止时间：{{ formatDate(note.dueAt) }}
        </CopyableValue>
        <CopyableValue
          v-if="note.completed"
          value="已完成"
          label="完成状态"
          class="preview-card__completed"
          @copy="forwardCopy"
        >
          <Icon name="circle-check" :size="14" /> 已完成
        </CopyableValue>
        <CopyableValue
          v-if="note.tags?.length"
          :value="note.tags.join(' / ')"
          label="标签"
          @copy="forwardCopy"
        >
          标签：{{ note.tags.join(' / ') }}
        </CopyableValue>
      </div>

      <div class="preview-card__body">
        <div v-if="note.encrypted && !note._unlocked" class="preview-card__encrypted">
          该内容已加密，请先从笔记卡片解锁。
        </div>
        <div v-else class="preview-card__content">
          <div class="preview-card__copy-hint">
            <Icon name="copy" :size="13" />
            悬停高亮可复制单项，行尾按钮复制字段值或整行
          </div>
          <CopyableNoteContent :content="note.content" @copy="forwardCopy" />
          <div v-if="note.attachments?.length" class="preview-card__images" aria-label="笔记图片">
            <a
              v-for="(image, index) in note.attachments"
              :key="image.id || image.url"
              :href="image.url"
              class="preview-card__image"
              target="_blank"
              rel="noopener noreferrer"
              :aria-label="`打开图片 ${image.name || index + 1}`"
            >
              <img
                :src="image.url"
                :alt="image.name || `笔记图片 ${index + 1}`"
                loading="lazy"
              >
              <span>{{ image.name || `图片 ${index + 1}` }}</span>
            </a>
          </div>
        </div>
      </div>

      <div class="preview-card__footer">
        <button type="button" class="btn btn--secondary" @click="emit('close')">关闭</button>
        <button type="button" class="btn btn--secondary" @click="emit('copyExtract', note)">
          <Icon name="copy" :size="16" /> 快速复制
        </button>
        <button type="button" class="btn btn--secondary" @click="emit('ai', note)">
          <Icon name="sparkles" :size="16" /> AI 编辑
        </button>
        <button type="button" class="btn btn--primary" @click="emit('edit', note)">
          <Icon name="edit" :size="16" /> 编辑
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-modal {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
}

.preview-card {
  width: min(760px, 100%);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border-radius: 24px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.preview-card:focus {
  outline: none;
}

.preview-card__header,
.preview-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--border-light);
}

.preview-card__header > div {
  flex: 1 1 auto;
  min-width: 0;
}

.preview-card__footer {
  border-top: 1px solid var(--border-light);
  border-bottom: none;
  justify-content: flex-end;
}

.preview-card__type {
  font-size: 12px;
  color: var(--text-muted);
}

.preview-card__title {
  min-width: 0;
  margin-top: 6px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.preview-card__close {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 12px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
}

.preview-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 14px 22px 0;
  color: var(--text-muted);
  font-size: 12px;
}

.preview-card__meta > * {
  max-width: 100%;
}

.preview-card__id {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  color: var(--accent-color);
  background: var(--accent-bg);
  border: 0;
  border-radius: 999px;
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.preview-card__completed {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--success-color);
}

.preview-card__body {
  padding: 18px 22px;
  overflow: auto;
}

.preview-card__content {
  margin: 0;
  font: inherit;
  color: var(--text-primary);
}

.preview-card__copy-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  color: var(--text-muted);
  font-size: 11px;
}

.preview-card__encrypted {
  padding: 18px;
  border-radius: 16px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.preview-card__images {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid var(--border-light);
}

.preview-card__image {
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 16px;
  text-decoration: none;
}

.preview-card__image img {
  width: 100%;
  aspect-ratio: 4 / 3;
  display: block;
  object-fit: cover;
}

.preview-card__image span {
  display: block;
  padding: 8px 10px;
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 10px 18px;
  border: none;
  border-radius: 14px;
  cursor: pointer;
}

.btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.btn--secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

@media (max-width: 560px) {
  .preview-modal {
    align-items: flex-end;
    padding: 0;
  }

  .preview-card {
    max-height: 94vh;
    border-radius: 22px 22px 0 0;
  }

  .preview-card__footer {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .preview-card__close,
  .preview-card__id,
  .btn {
    min-height: 44px;
    justify-content: center;
  }

  .preview-card__images {
    grid-template-columns: 1fr;
  }
}
</style>
