<script setup>
import { ref, onMounted, watch } from 'vue'
import { useConfig } from '@/shared/composables/useConfig'

const { config, updateConfig } = useConfig()

// 本地表单
const siteName = ref('')
const siteIcon = ref('')
const favicon = ref('')

// 预设图标
const presetIcons = [
  '📍', '🚀', '⭐', '🎯', '💡', '🔥', '🌟', '📌',
  '🔖', '🏷️', '🏠', '🌈', '☀️', '🌙', '⚡', '💎'
]

// 监听 config 变化
watch(() => config.value.site, (site) => {
  if (site) {
    siteName.value = site.name || 'NAV'
    siteIcon.value = site.icon || '📍'
    favicon.value = site.favicon || ''
  }
}, { immediate: true, deep: true })

function saveSettings() {
  updateConfig('site', {
    name: siteName.value,
    icon: siteIcon.value,
    favicon: favicon.value
  })
}

function selectIcon(icon) {
  siteIcon.value = icon
  saveSettings()
}

function handleFaviconUpload(e) {
  const file = e.target.files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = (event) => {
    favicon.value = event.target.result
    saveSettings()
  }
  reader.readAsDataURL(file)
}

function clearFavicon() {
  favicon.value = ''
  saveSettings()
}
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section__title">🏠 基础设置</h3>

    <!-- 网站名称 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">网站名称</div>
        <div class="settings-item__desc">显示在浏览器标签和页面顶部</div>
      </div>
      <div class="settings-item__control">
        <input
          v-model="siteName"
          type="text"
          class="input"
          placeholder="NAV"
          @change="saveSettings"
        >
      </div>
    </div>

    <!-- 网站图标 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">网站图标</div>
        <div class="settings-item__desc">选择或自定义图标</div>
      </div>
      <div class="settings-item__control">
        <div class="icon-selector">
          <div class="icon-preview">{{ siteIcon }}</div>
          <div class="icon-grid">
            <button
              v-for="icon in presetIcons"
              :key="icon"
              class="icon-btn"
              :class="{ 'is-active': siteIcon === icon }"
              @click="selectIcon(icon)"
            >
              {{ icon }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Favicon -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">浏览器图标 (Favicon)</div>
        <div class="settings-item__desc">显示在浏览器标签的小图标</div>
      </div>
      <div class="settings-item__control">
        <div class="favicon-upload">
          <div v-if="favicon" class="favicon-preview">
            <img :src="favicon" alt="favicon">
            <button class="favicon-clear" @click="clearFavicon">✕</button>
          </div>
          <label class="upload-btn">
            {{ favicon ? '更换' : '上传图片' }}
            <input type="file" accept="image/*" hidden @change="handleFaviconUpload">
          </label>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-section {
  margin-bottom: 24px;
  padding: 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.settings-section__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-light);
}

.settings-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 0;
  border-bottom: 1px solid var(--border-light);
}

.settings-item:last-child {
  border-bottom: none;
}

.settings-item__info {
  flex: 1;
  padding-right: 20px;
}

.settings-item__label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.settings-item__desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.settings-item__control {
  flex-shrink: 0;
}

.input {
  width: 200px;
  padding: 10px 14px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color 0.2s;
}

.input:focus {
  border-color: var(--accent-color);
}

/* 图标选择器 */
.icon-selector {
  width: 240px;
}

.icon-preview {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  font-size: 28px;
  margin-bottom: 12px;
  border: 2px solid var(--border-color);
}

.icon-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 4px;
}

.icon-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.icon-btn:hover {
  background: var(--bg-hover);
  transform: scale(1.1);
}

.icon-btn.is-active {
  background: var(--accent-color);
  box-shadow: 0 0 0 2px var(--accent-light);
}

/* Favicon 上传 */
.favicon-upload {
  display: flex;
  align-items: center;
  gap: 12px;
}

.favicon-preview {
  position: relative;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border-radius: 6px;
  overflow: hidden;
}

.favicon-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.favicon-clear {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--error-color);
  color: #fff;
  border: none;
  border-radius: 50%;
  font-size: 10px;
  cursor: pointer;
}

.upload-btn {
  padding: 8px 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.upload-btn:hover {
  background: var(--bg-hover);
}

@media (max-width: 640px) {
  .settings-item {
    flex-direction: column;
    gap: 12px;
  }

  .settings-item__info {
    padding-right: 0;
  }

  .settings-item__control {
    width: 100%;
  }

  .input,
  .icon-selector {
    width: 100%;
  }
}
</style>
