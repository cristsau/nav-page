<script setup>
import { nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GeneralSettings from './components/GeneralSettings.vue'
import AppearanceSettings from './components/AppearanceSettings.vue'
import SearchSettings from './components/SearchSettings.vue'
import BrowserIntegrationSettings from './components/BrowserIntegrationSettings.vue'
import DataSettings from './components/DataSettings.vue'
import UserManagementSettings from './components/UserManagementSettings.vue'
import Icon from '@/shared/components/Icon.vue'
import { useConfig } from '@/shared/composables/useConfig'
import { useAuth } from '@/shared/composables/useAuth'

const route = useRoute()
const router = useRouter()
const saving = ref(false)
const saveMessage = ref('')

const { persistConfigNow } = useConfig()
const { currentUser, logout, initAuth } = useAuth()

async function focusRequestedSection() {
  const section = String(route.query.section || '').trim()
  if (!section) return

  await nextTick()
  const target = document.getElementById(`settings-${section}`)
  if (!target) return

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'start'
  })
  target.focus({ preventScroll: true })
}

onMounted(async () => {
  await initAuth()
  await focusRequestedSection()
})

watch(
  () => route.query.section,
  () => focusRequestedSection()
)

function goBack() {
  router.push('/')
}

async function handleSave() {
  saving.value = true
  saveMessage.value = ''

  try {
    await persistConfigNow()
    saveMessage.value = '设置已保存并立即生效。'
  } catch (error) {
    saveMessage.value = error.message || '设置保存失败。'
  } finally {
    saving.value = false
  }
}

async function handleExit() {
  await logout()
  window.location.assign('/auth')
}
</script>

<template>
  <div class="page">
    <header class="header">
      <div class="header__left">
        <button class="header__btn" type="button" aria-label="返回导航页" title="返回导航页" @click="goBack">
          <Icon name="arrow-left" :size="20" />
        </button>
        <div>
          <h1 class="header__title">设置</h1>
          <p class="header__subtitle">当前用户：{{ currentUser?.username || '未登录' }}</p>
        </div>
      </div>
      <div class="header__actions">
        <button class="header__btn header__btn--primary" :disabled="saving" @click="handleSave">
          {{ saving ? '保存中...' : '保存' }}
        </button>
        <button class="header__btn" @click="handleExit">退出</button>
      </div>
    </header>

    <main class="main">
      <div v-if="saveMessage" class="save-message">{{ saveMessage }}</div>

      <div class="settings-container">
        <GeneralSettings />
        <AppearanceSettings />
        <SearchSettings id="settings-search" tabindex="-1" />
        <BrowserIntegrationSettings />
        <UserManagementSettings />
        <DataSettings />

        <div class="about-section">
          <div class="about-section__brand">
            <img class="about-section__logo" src="/domo-logo.png" alt="">
            <span>DOMO NAV</span>
          </div>
          <div class="about-section__info">
            <p class="about-section__version">版本 2.3.0</p>
            <p class="about-section__desc">
              面向个人与小团队的私有化导航工作台，已接入后端认证、PostgreSQL 云端数据、浏览器扩展和 AI 搜索代理。
            </p>
          </div>
          <div class="about-section__features">
            <span>后端认证</span>
            <span>PostgreSQL 云端数据</span>
            <span>浏览器扩展快速添加</span>
            <span>Telegram 审批</span>
            <span>AI 搜索代理</span>
          </div>
          <p class="about-section__signature">Design by CrisTsau</p>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: var(--bg-primary);
}

.header {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px;
  background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
  border-bottom: 1px solid var(--border-light);
  backdrop-filter: blur(18px);
}

.header__left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header__title {
  margin: 0;
  font-size: 22px;
  color: var(--text-primary);
}

.header__subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.header__actions {
  display: flex;
  gap: 10px;
}

.header__btn {
  min-width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 18px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: none;
  border-radius: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.header__btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.header__btn:disabled {
  opacity: 0.7;
  cursor: wait;
}

.main {
  max-width: 860px;
  margin: 0 auto;
  padding: 24px 24px 48px;
}

.save-message {
  margin-bottom: 16px;
  padding: 14px 16px;
  border-radius: 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  color: var(--text-secondary);
}

.settings-container {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.about-section {
  text-align: center;
  padding: 32px 24px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.about-section__brand {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.14em;
}

.about-section__logo {
  width: 52px;
  height: 52px;
  display: block;
  object-fit: contain;
  overflow: hidden;
  background: #fff;
  border: 1px solid var(--border-light);
  border-radius: 50%;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--text-primary) 10%, transparent);
}

.about-section__version {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.about-section__desc {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 20px;
  line-height: 1.7;
}

.about-section__features {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
}

.about-section__features span {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 8px 14px;
  background: var(--bg-secondary);
  border-radius: var(--radius-full);
}

.about-section__signature {
  margin: 18px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  letter-spacing: 0.08em;
}

@media (max-width: 640px) {
  .header,
  .main {
    padding-left: 16px;
    padding-right: 16px;
  }

  .header {
    flex-direction: column;
    align-items: stretch;
  }

  .header__actions {
    justify-content: stretch;
  }

  .header__btn {
    flex: 1;
  }
}
</style>
