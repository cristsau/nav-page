<script setup>
import { useRouter } from 'vue-router'
import GeneralSettings from './components/GeneralSettings.vue'
import AppearanceSettings from './components/AppearanceSettings.vue'
import SearchSettings from './components/SearchSettings.vue'
import DataSettings from './components/DataSettings.vue'

const router = useRouter()

function goBack() {
  router.push('/')
}
</script>

<template>
  <div class="page">
    <!-- 顶部导航 -->
    <header class="header">
      <div class="header__left">
        <button class="header__btn" @click="goBack">←</button>
        <h1 class="header__title">⚙️ 设置</h1>
      </div>
    </header>

    <!-- 设置内容 -->
    <main class="main">
      <div class="settings-container">
        <!-- 基础设置 -->
        <GeneralSettings />

        <!-- 外观设置 -->
        <AppearanceSettings />

        <!-- 搜索设置 -->
        <SearchSettings />

        <!-- 数据管理 -->
        <DataSettings />

        <!-- 关于 -->
        <div class="about-section">
          <div class="about-section__logo">📍 NAV</div>
          <div class="about-section__info">
            <p class="about-section__version">版本 2.0.0</p>
            <p class="about-section__desc">轻量化、扁平化奶油风格的个人导航页</p>
          </div>
          <div class="about-section__features">
            <span>✨ 模块化设计</span>
            <span>🎨 自定义主题</span>
            <span>🔒 本地加密</span>
            <span>🔗 一键分享</span>
          </div>
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

/* 顶部导航 */
.header {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height);
  padding: 0 24px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-light);
}

.header__left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header__btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-md);
  font-size: 18px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.header__btn:hover {
  background: var(--bg-hover);
}

.header__title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

/* 主内容 */
.main {
  max-width: 800px;
  margin: 0 auto;
  padding: 24px;
  padding-bottom: 48px;
}

.settings-container {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* 关于区块 */
.about-section {
  text-align: center;
  padding: 32px 24px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.about-section__logo {
  font-size: 32px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 12px;
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
}

.about-section__features {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 16px;
}

.about-section__features span {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 6px 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-full);
}

@media (max-width: 640px) {
  .header {
    padding: 0 16px;
  }

  .main {
    padding: 16px;
  }
}
</style>
