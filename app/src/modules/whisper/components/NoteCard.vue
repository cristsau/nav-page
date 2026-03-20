<script setup>
import { computed, ref } from 'vue'
import { decrypt } from '@/shared/utils/crypto'

const props = defineProps({
  note: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['preview', 'edit', 'delete', 'togglePin', 'share'])

const showPasswordModal = ref(false)
const password = ref('')
const decryptedContent = ref('')
const decryptError = ref(false)

const isEncrypted = computed(() => props.note.encrypted)
const isPinned = computed(() => props.note.pinned)

const previewContent = computed(() => {
  if (isEncrypted.value) {
    return '已加密内容，点击解密后可预览'
  }

  if (decryptedContent.value) {
    return decryptedContent.value
  }

  return props.note.content?.slice(0, 100) || ''
})

function formatDate(timestamp) {
  const date = new Date(timestamp)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  return date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

async function handleDecrypt() {
  if (!password.value) return

  const result = await decrypt(props.note.content, password.value)
  if (result) {
    decryptedContent.value = result
    showPasswordModal.value = false
    decryptError.value = false
  } else {
    decryptError.value = true
  }
}
</script>

<template>
  <div class="note-card card-float" :class="{ 'is-pinned': isPinned, 'is-encrypted': isEncrypted }" @click="emit('preview', note)">
    <div v-if="isPinned" class="note-card__pin">📌</div>

    <div class="note-card__type">
      {{ note.type === 'memo' ? '备忘录' : '日记' }}
    </div>

    <div class="note-card__title">{{ note.title }}</div>

    <div class="note-card__content">
      {{ previewContent }}
      <span v-if="!isEncrypted && note.content?.length > 100">...</span>
    </div>

    <div class="note-card__footer">
      <span class="note-card__date">{{ formatDate(note.updatedAt) }}</span>
      <span v-if="note.share?.enabled" class="note-card__share-status">已分享</span>
    </div>

    <div class="note-card__actions" @click.stop>
      <button class="action-btn" :title="isPinned ? '取消置顶' : '置顶'" @click="emit('togglePin', note)">
        {{ isPinned ? '📌' : '📍' }}
      </button>
      <button v-if="isEncrypted && !decryptedContent" class="action-btn" title="解密查看" @click="showPasswordModal = true">
        🔐
      </button>
      <button class="action-btn" title="分享" @click="emit('share', note)">
        🔗
      </button>
      <button class="action-btn" title="编辑" @click="emit('edit', note)">
        ✏️
      </button>
      <button class="action-btn action-btn--danger" title="删除" @click="emit('delete', note)">
        🗑
      </button>
    </div>

    <div v-if="showPasswordModal" class="password-modal" @click.self="showPasswordModal = false">
      <div class="password-modal__content">
        <h3>输入密码解密</h3>
        <input
          v-model="password"
          type="password"
          class="input"
          placeholder="请输入密码"
          @keydown.enter="handleDecrypt"
        >
        <p v-if="decryptError" class="error">密码错误</p>
        <div class="password-modal__actions">
          <button class="btn btn--secondary" @click="showPasswordModal = false">取消</button>
          <button class="btn btn--primary" @click="handleDecrypt">解密</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.note-card {
  position: relative;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  padding: 16px;
  box-shadow: var(--shadow-card);
  transition: all var(--transition-normal) var(--ease-smooth);
  cursor: pointer;
}

.note-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-card-hover);
}

.note-card.is-pinned {
  border-left: 3px solid var(--accent-color);
}

.note-card.is-encrypted {
  background: linear-gradient(135deg, var(--bg-card) 0%, var(--bg-secondary) 100%);
}

.note-card__pin {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 14px;
}

.note-card__type {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.note-card__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.note-card__content {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 12px;
  min-height: 42px;
}

.note-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
}

.note-card__share-status {
  color: var(--success-color);
}

.note-card__actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.note-card:hover .note-card__actions {
  opacity: 1;
}

.action-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-xs);
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

.password-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.password-modal__content {
  background: var(--bg-card);
  padding: 24px;
  border-radius: var(--radius-lg);
  width: 320px;
  text-align: center;
}

.password-modal__content h3 {
  margin-bottom: 16px;
  color: var(--text-primary);
}

.input {
  width: 100%;
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.error {
  color: var(--error-color);
  font-size: 12px;
  margin: 10px 0 0;
}

.password-modal__actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 16px;
}

.btn {
  padding: 8px 20px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 500;
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
