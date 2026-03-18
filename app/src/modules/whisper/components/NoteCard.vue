<script setup>
import { ref, computed } from 'vue'
import { encrypt, decrypt, obfuscate } from '@/shared/utils/crypto'

const props = defineProps({
  note: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['edit', 'delete', 'togglePin', 'share'])

const showPasswordModal = ref(false)
const password = ref('')
const decryptedContent = ref('')
const decryptError = ref(false)

// 是否加密
const isEncrypted = computed(() => props.note.encrypted)

// 是否置顶
const isPinned = computed(() => props.note.pinned)

// 预览内容
const previewContent = computed(() => {
  if (isEncrypted.value) {
    return '🔒 内容已加密'
  }
  if (decryptedContent.value) {
    return decryptedContent.value
  }
  return props.note.content?.slice(0, 100) || ''
})

// 格式化日期
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

// 解密内容
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

function handleEdit() {
  emit('edit', props.note)
}

function handleDelete() {
  emit('delete', props.note)
}

function handleTogglePin() {
  emit('togglePin', props.note)
}

function handleShare() {
  emit('share', props.note)
}
</script>

<template>
  <div class="note-card card-float" :class="{ 'is-pinned': isPinned, 'is-encrypted': isEncrypted }">
    <!-- 置顶标记 -->
    <div v-if="isPinned" class="note-card__pin">📌</div>

    <!-- 类型标记 -->
    <div class="note-card__type">
      {{ note.type === 'memo' ? '📋 备忘录' : '📖 日记' }}
    </div>

    <!-- 标题 -->
    <div class="note-card__title">{{ note.title }}</div>

    <!-- 内容预览 -->
    <div class="note-card__content">
      {{ previewContent }}
      <span v-if="!isEncrypted && note.content?.length > 100">...</span>
    </div>

    <!-- 底部信息 -->
    <div class="note-card__footer">
      <span class="note-card__date">{{ formatDate(note.updatedAt) }}</span>

      <!-- 分享状态 -->
      <span v-if="note.share?.enabled" class="note-card__share-status">
        🔗 已分享
      </span>
    </div>

    <!-- 操作按钮 -->
    <div class="note-card__actions">
      <button class="action-btn" :title="isPinned ? '取消置顶' : '置顶'" @click="handleTogglePin">
        {{ isPinned ? '📌' : '📍' }}
      </button>
      <button v-if="isEncrypted && !decryptedContent" class="action-btn" title="解密查看" @click="showPasswordModal = true">
        🔓
      </button>
      <button class="action-btn" title="分享" @click="handleShare">
        🔗
      </button>
      <button class="action-btn" title="编辑" @click="handleEdit">
        ✏️
      </button>
      <button class="action-btn action-btn--danger" title="删除" @click="handleDelete">
        🗑️
      </button>
    </div>

    <!-- 密码输入弹窗 -->
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

/* 密码弹窗 */
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

.password-modal__content .input {
  width: 100%;
  padding: 12px;
  margin-bottom: 8px;
}

.error {
  color: var(--error-color);
  font-size: 12px;
  margin-bottom: 12px;
}

.password-modal__actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 16px;
}

/* 按钮样式 */
.btn {
  padding: 8px 20px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.btn--secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.input {
  width: 100%;
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  outline: none;
  transition: all var(--transition-fast);
}

.input:focus {
  border-color: var(--accent-color);
}
</style>
