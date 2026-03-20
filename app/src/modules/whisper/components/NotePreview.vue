<script setup>
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

const emit = defineEmits(['close', 'edit'])

function formatDate(timestamp) {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div v-if="show && note" class="preview-modal" @click.self="emit('close')">
    <div class="preview-card">
      <div class="preview-card__header">
        <div>
          <div class="preview-card__type">{{ note.type === 'memo' ? '备忘录' : '日记' }}</div>
          <h3 class="preview-card__title">{{ note.title }}</h3>
        </div>
        <button class="preview-card__close" @click="emit('close')">✕</button>
      </div>

      <div class="preview-card__meta">
        <span>更新时间：{{ formatDate(note.updatedAt) }}</span>
        <span v-if="note.tags?.length">标签：{{ note.tags.join(' / ') }}</span>
      </div>

      <div class="preview-card__body">
        <div v-if="note.encrypted" class="preview-card__encrypted">该内容已加密，请点击编辑后输入密码查看。</div>
        <pre v-else class="preview-card__content">{{ note.content }}</pre>
      </div>

      <div class="preview-card__footer">
        <button class="btn btn--secondary" @click="emit('close')">关闭</button>
        <button class="btn btn--primary" @click="emit('edit', note)">编辑</button>
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
</style>
