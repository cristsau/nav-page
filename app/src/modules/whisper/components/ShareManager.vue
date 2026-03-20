<script setup>
import { ref, computed, onMounted } from 'vue'
import { createShare as createLocalShare, cancelShare as cancelLocalShare, getAllActiveShares as getLocalActiveShares } from '@/shared/db/database'
import { cancelBackendShare, createBackendShare, fetchBackendShares, shouldUseBackendNotes } from '@/shared/services/notesApi'

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

const emit = defineEmits(['close', 'shared', 'cancelled'])

// 分享设置
const expireOption = ref('forever')
const customDays = ref(7)
const shareLink = ref('')
const isSharing = ref(false)

// 过期时间选项
const expireOptions = [
  { value: 'forever', label: '永久有效' },
  { value: '1', label: '1天后过期' },
  { value: '7', label: '7天后过期' },
  { value: '30', label: '30天后过期' },
  { value: 'custom', label: '自定义天数' }
]

// 已有的分享
const existingShares = ref([])

// 计算过期时间
async function createShare(noteId, expireAt) {
  return shouldUseBackendNotes()
    ? createBackendShare(noteId, expireAt)
    : createLocalShare(noteId, expireAt)
}

async function cancelShare(shareId) {
  return shouldUseBackendNotes()
    ? cancelBackendShare(shareId)
    : cancelLocalShare(shareId)
}

async function getAllActiveShares(noteId) {
  return shouldUseBackendNotes()
    ? fetchBackendShares(noteId)
    : getLocalActiveShares()
}

function getExpireAt() {
  if (expireOption.value === 'forever') return null
  if (expireOption.value === 'custom') {
    return Date.now() + customDays.value * 24 * 60 * 60 * 1000
  }
  return Date.now() + parseInt(expireOption.value) * 24 * 60 * 60 * 1000
}

// 创建分享
async function handleShare() {
  if (!props.note || isSharing.value) return

  isSharing.value = true
  try {
    const expireAt = getExpireAt()
    const share = await createShare(props.note.id, expireAt)

    // 生成分享链接
    const baseUrl = window.location.origin
    shareLink.value = `${baseUrl}/share/${share.code}`

    // 复制到剪贴板
    await navigator.clipboard.writeText(shareLink.value)

    emit('shared', share)
    await loadExistingShares()
  } catch (e) {
    alert('分享失败：' + e.message)
  } finally {
    isSharing.value = false
  }
}

// 取消分享
async function handleCancelShare(shareId) {
  if (!confirm('确定取消分享？')) return

  await cancelShare(shareId)
  await loadExistingShares()
  emit('cancelled', shareId)
}

// 加载已有分享
async function loadExistingShares() {
  if (!props.note) return
  existingShares.value = await getAllActiveShares(props.note.id)
  if (!shouldUseBackendNotes()) {
    existingShares.value = existingShares.value.filter(s => s.noteId === props.note.id)
  }
}

// 格式化日期
function formatDate(timestamp) {
  if (!timestamp) return '永久'
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 复制链接
async function copyLink(link) {
  await navigator.clipboard.writeText(link)
  alert('链接已复制')
}

function close() {
  emit('close')
}

onMounted(() => {
  loadExistingShares()
})

// 监听显示状态
import { watch } from 'vue'
watch(() => props.show, (val) => {
  if (val) {
    loadExistingShares()
    shareLink.value = ''
    expireOption.value = 'forever'
  }
})
</script>

<template>
  <div v-if="show" class="share-modal" @click.self="close">
    <div class="share-content">
      <!-- 头部 -->
      <div class="share__header">
        <h3 class="share__title">🔗 分享笔记</h3>
        <button class="share__close" @click="close">✕</button>
      </div>

      <!-- 笔记信息 -->
      <div class="share__note-info">
        <div class="share__note-title">{{ note?.title }}</div>
        <div class="share__note-type">
          {{ note?.type === 'memo' ? '📋 备忘录' : '📖 日记' }}
          <span v-if="note?.encrypted">🔒 已加密</span>
        </div>
      </div>

      <!-- 已有分享 -->
      <div v-if="existingShares.length > 0" class="share__existing">
        <h4>已创建的分享</h4>
        <div v-for="share in existingShares" :key="share.id" class="share__item">
          <div class="share__item-info">
            <span class="share__code">{{ share.code }}</span>
            <span class="share__expire">
              {{ share.expireAt ? formatDate(share.expireAt) + ' 过期' : '永久有效' }}
            </span>
            <span class="share__views">浏览 {{ share.viewCount }} 次</span>
          </div>
          <div class="share__item-actions">
            <button class="btn-text" @click="copyLink(`${window.location.origin}/share/${share.code}`)">
              复制链接
            </button>
            <button class="btn-text btn-text--danger" @click="handleCancelShare(share.id)">
              取消分享
            </button>
          </div>
        </div>
      </div>

      <!-- 新建分享 -->
      <div class="share__new">
        <h4>创建新分享</h4>

        <!-- 过期时间 -->
        <div class="form-group">
          <label class="form-label">有效期</label>
          <div class="expire-options">
            <label
              v-for="opt in expireOptions"
              :key="opt.value"
              class="expire-option"
              :class="{ 'is-active': expireOption === opt.value }"
            >
              <input type="radio" :value="opt.value" v-model="expireOption">
              {{ opt.label }}
            </label>
          </div>
        </div>

        <!-- 自定义天数 -->
        <div v-if="expireOption === 'custom'" class="form-group">
          <input
            v-model.number="customDays"
            type="number"
            class="input"
            min="1"
            max="365"
            placeholder="天数"
          >
        </div>

        <!-- 创建按钮 -->
        <button
          class="btn btn--primary btn--block"
          :disabled="isSharing"
          @click="handleShare"
        >
          {{ isSharing ? '创建中...' : '创建分享链接' }}
        </button>

        <!-- 分享成功 -->
        <div v-if="shareLink" class="share__success">
          <p>✅ 分享链接已创建并复制到剪贴板</p>
          <div class="share__link">{{ shareLink }}</div>
        </div>
      </div>

      <!-- 提示 -->
      <div class="share__tips">
        <p v-if="note?.encrypted">
          ⚠️ 加密内容分享后，查看者需要输入密码才能解密
        </p>
        <p v-else>
          💡 分享链接可以让任何人查看这篇笔记
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.share-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.share-content {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  width: 100%;
  max-width: 500px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
  animation: scaleIn 0.2s var(--ease-bounce);
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.share__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-light);
}

.share__title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.share__close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.share__note-info {
  padding: 16px 24px;
  background: var(--bg-secondary);
}

.share__note-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.share__note-type {
  font-size: 13px;
  color: var(--text-muted);
}

.share__existing {
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-light);
}

.share__existing h4,
.share__new h4 {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.share__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  margin-bottom: 8px;
}

.share__item-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.share__code {
  font-family: monospace;
  font-size: 14px;
  color: var(--accent-color);
}

.share__expire,
.share__views {
  font-size: 12px;
  color: var(--text-muted);
}

.share__item-actions {
  display: flex;
  gap: 8px;
}

.btn-text {
  background: none;
  border: none;
  color: var(--accent-color);
  font-size: 13px;
  cursor: pointer;
  padding: 4px 8px;
}

.btn-text--danger {
  color: var(--error-color);
}

.share__new {
  padding: 20px 24px;
}

.form-group {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.expire-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.expire-option {
  padding: 8px 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-full);
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.expire-option:hover {
  background: var(--bg-hover);
}

.expire-option.is-active {
  background: var(--accent-color);
  color: #fff;
}

.expire-option input {
  display: none;
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
}

.input:focus {
  border-color: var(--accent-color);
}

.btn {
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

.btn--primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn--primary:disabled {
  opacity: 0.6;
}

.btn--block {
  width: 100%;
}

.share__success {
  margin-top: 16px;
  padding: 12px;
  background: var(--success-color);
  background: rgba(122, 159, 122, 0.1);
  border-radius: var(--radius-md);
}

.share__success p {
  color: var(--success-color);
  font-size: 14px;
  margin-bottom: 8px;
}

.share__link {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

.share__tips {
  padding: 16px 24px;
  background: var(--bg-secondary);
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}

.share__tips p {
  font-size: 13px;
  color: var(--text-muted);
}
</style>
