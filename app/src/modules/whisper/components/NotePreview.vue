<script setup>
import Icon from '@/shared/components/Icon.vue'

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

const emit = defineEmits(['close', 'edit', 'ai', 'copyId', 'copyExtract'])

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
</script>

<template>
  <div v-if="show && note" class="preview-modal" @click.self="emit('close')">
    <div class="preview-card" role="dialog" aria-modal="true" :aria-label="note.title">
      <div class="preview-card__header">
        <div>
          <div class="preview-card__type">{{ note.type === 'memo' ? '备忘录' : '日记' }}</div>
          <h3 class="preview-card__title">{{ note.title }}</h3>
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
        <span>更新时间：{{ formatDate(note.updatedAt) }}</span>
        <span v-if="note.type === 'diary'">记录日期：{{ formatEntryDate(note.entryDate) }}</span>
        <span v-if="note.mood">心情：{{ note.mood }}</span>
        <span v-if="note.dueAt">截止时间：{{ formatDate(note.dueAt) }}</span>
        <span v-if="note.completed" class="preview-card__completed">
          <Icon name="circle-check" :size="14" /> 已完成
        </span>
        <span v-if="note.tags?.length">标签：{{ note.tags.join(' / ') }}</span>
      </div>

      <div class="preview-card__body">
        <div v-if="note.encrypted && !note._unlocked" class="preview-card__encrypted">
          该内容已加密，请先从笔记卡片解锁。
        </div>
        <pre v-else class="preview-card__content">{{ note.content }}</pre>
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

.preview-card__header,
.preview-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--border-light);
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
  margin-top: 6px;
  color: var(--text-primary);
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
  white-space: pre-wrap;
  line-height: 1.8;
  color: var(--text-primary);
}

.preview-card__encrypted {
  padding: 18px;
  border-radius: 16px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
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

  .btn {
    justify-content: center;
  }
}
</style>
