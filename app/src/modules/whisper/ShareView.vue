<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getShareByCode as getLocalShareByCode } from '@/shared/db/database'
import { fetchBackendShareByCode, shouldUseBackendNotes } from '@/shared/services/notesApi'
import { decrypt } from '@/shared/utils/crypto'
import Icon from '@/shared/components/Icon.vue'

const route = useRoute()
const router = useRouter()

const loading = ref(true)
const error = ref('')
const note = ref(null)
const share = ref(null)
const showPasswordModal = ref(false)
const password = ref('')
const decryptedContent = ref('')
const decryptError = ref(false)

async function getShareByCode(code) {
  return shouldUseBackendNotes()
    ? fetchBackendShareByCode(code)
    : getLocalShareByCode(code)
}

onMounted(async () => {
  const code = route.params.code
  if (!code) {
    error.value = '无效的分享链接'
    loading.value = false
    return
  }

  const result = await getShareByCode(code)
  if (!result) {
    error.value = '分享链接不存在或已过期'
    loading.value = false
    return
  }

  share.value = result.share
  note.value = result.note
  loading.value = false
})

async function handleDecrypt() {
  if (!password.value) return

  const result = await decrypt(note.value.content, password.value)
  if (result) {
    decryptedContent.value = result
    showPasswordModal.value = false
    decryptError.value = false
  } else {
    decryptError.value = true
  }
}

function goHome() {
  router.push('/')
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <div class="share-page">
    <div v-if="loading" class="loading-state">
      <Icon class="loading__spinner" name="refresh" :size="20" />
      <span>加载中...</span>
    </div>

    <div v-else-if="error" class="error-state">
      <div class="error-state__icon">
        <Icon name="circle-x" :size="44" />
      </div>
      <div class="error-state__title">{{ error }}</div>
      <button class="btn btn--primary" @click="goHome">返回首页</button>
    </div>

    <div v-else class="share-content">
      <div class="share-header">
        <div class="share-header__type">
          <Icon :name="note.type === 'memo' ? 'list' : 'book'" :size="15" />
          <span>{{ note.type === 'memo' ? '备忘录' : '日记' }}</span>
        </div>
        <h1 class="share-header__title">{{ note.title }}</h1>
        <div class="share-header__meta">
          <span>分享于 {{ formatDate(share.createdAt) }}</span>
          <span>·</span>
          <span>浏览 {{ share.viewCount }} 次</span>
        </div>
      </div>

      <div class="share-body">
        <div v-if="!note.encrypted" class="share-body__content">
          {{ note.content }}
        </div>

        <div v-else class="share-body__encrypted">
          <div v-if="decryptedContent" class="share-body__content">
            {{ decryptedContent }}
          </div>
          <div v-else class="share-body__locked">
            <div class="locked-icon">
              <Icon name="lock" :size="36" />
            </div>
            <div class="locked-text">内容已加密</div>
            <button class="btn btn--primary" @click="showPasswordModal = true">
              输入密码查看
            </button>
          </div>
        </div>

        <div v-if="!note.encrypted && note.attachments?.length" class="share-body__images">
          <a
            v-for="(image, index) in note.attachments"
            :key="image.id || image.url"
            :href="image.url"
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

        <div v-if="note.tags?.length" class="share-body__tags">
          <span v-for="tag in note.tags" :key="tag" class="tag">{{ tag }}</span>
        </div>
      </div>

      <div class="share-footer">
        <p>Powered by DOMO NAV · Design by CrisTsau</p>
      </div>
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
.share-page {
  min-height: 100vh;
  background: var(--bg-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.loading-state {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--text-muted);
}

.loading__spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.error-state {
  text-align: center;
}

.error-state__icon {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  margin-inline: auto;
  margin-bottom: 16px;
  color: var(--error-color);
  background: color-mix(in srgb, var(--error-color) 10%, transparent);
  border-radius: 50%;
}

.error-state__title {
  font-size: 18px;
  color: var(--text-primary);
  margin-bottom: 24px;
}

.share-content {
  width: 100%;
  max-width: 720px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.share-header {
  padding: 32px 32px 24px;
  border-bottom: 1px solid var(--border-light);
}

.share-header__type {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.share-header__title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 12px;
}

.share-header__meta {
  font-size: 13px;
  color: var(--text-muted);
  display: flex;
  gap: 8px;
}

.share-body {
  padding: 32px;
}

.share-body__content {
  font-size: 15px;
  line-height: 1.8;
  color: var(--text-primary);
  white-space: pre-wrap;
}

.share-body__encrypted {
  min-height: 200px;
}

.share-body__images {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 24px;
}

.share-body__images a {
  min-width: 0;
  overflow: hidden;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 16px;
  text-decoration: none;
}

.share-body__images img {
  width: 100%;
  aspect-ratio: 4 / 3;
  display: block;
  object-fit: cover;
}

.share-body__images span {
  display: block;
  padding: 9px 11px;
  overflow: hidden;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-body__locked {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
}

.locked-icon {
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  margin-bottom: 16px;
  color: var(--accent-color);
  background: var(--accent-bg);
  border-radius: 50%;
}

.locked-text {
  font-size: 16px;
  color: var(--text-secondary);
  margin-bottom: 20px;
}

.share-body__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--border-light);
}

.tag {
  padding: 4px 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-full);
  font-size: 12px;
  color: var(--text-secondary);
}

.share-footer {
  padding: 20px 32px;
  background: var(--bg-secondary);
  text-align: center;
}

.share-footer p {
  font-size: 12px;
  color: var(--text-muted);
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
  padding: 32px;
  border-radius: var(--radius-lg);
  width: 320px;
  text-align: center;
}

.password-modal__content h3 {
  margin-bottom: 20px;
  color: var(--text-primary);
}

.password-modal__content .input {
  width: 100%;
  padding: 12px 16px;
  margin-bottom: 8px;
}

.error {
  color: var(--error-color);
  font-size: 12px;
  margin-bottom: 16px;
}

.password-modal__actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 20px;
}

.btn {
  padding: 10px 24px;
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
}

.input:focus {
  border-color: var(--accent-color);
}

@media (max-width: 640px) {
  .share-header,
  .share-body {
    padding: 24px 20px;
  }

  .share-body__images {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .loading__spinner {
    animation: none;
  }
}
</style>
