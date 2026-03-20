<script setup>
import { ref, watch } from 'vue'
import { useConfig } from '@/shared/composables/useConfig'

const { config, updateConfig } = useConfig()

const siteName = ref('')
const siteIcon = ref('')
const customIcon = ref('')
const favicon = ref('')

const presetIcons = ['🧭', '🌐', '📚', '📝', '⚡', '🎯', '📌', '💼', '🧠', '🛠', '🏠', '🚀', '☀️', '🌙', '⚙️', '🔖']

watch(
  () => config.value.site,
  (site) => {
    if (!site) return
    siteName.value = site.name || 'NAV'
    siteIcon.value = site.icon || '🧭'
    customIcon.value = site.icon || ''
    favicon.value = site.favicon || ''
  },
  { immediate: true, deep: true }
)

function saveSettings() {
  updateConfig('site', {
    name: siteName.value.trim() || 'NAV',
    icon: siteIcon.value || customIcon.value || '🧭',
    favicon: favicon.value
  })
}

function selectIcon(icon) {
  siteIcon.value = icon
  customIcon.value = icon
  saveSettings()
}

function applyCustomIcon() {
  const icon = customIcon.value.trim()
  if (!icon) return
  siteIcon.value = icon.slice(0, 2)
  saveSettings()
}

function handleFaviconUpload(event) {
  const file = event.target.files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = (loadEvent) => {
    favicon.value = loadEvent.target.result
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
    <h3 class="settings-section__title">基础设置</h3>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">网站名称</div>
        <div class="settings-item__desc">显示在浏览器标签和页面顶部</div>
      </div>
      <div class="settings-item__control">
        <input v-model="siteName" type="text" class="input" placeholder="NAV" @change="saveSettings">
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">网站图标</div>
        <div class="settings-item__desc">支持预设图标，也支持输入自己的 Emoji 或短文字</div>
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
          <div class="custom-icon-row">
            <input
              v-model="customIcon"
              type="text"
              class="input input--small"
              placeholder="输入自定义图标"
              @keydown.enter.prevent="applyCustomIcon"
            >
            <button class="btn btn--secondary" @click="applyCustomIcon">应用</button>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">Favicon</div>
        <div class="settings-item__desc">上传浏览器标签的小图标</div>
      </div>
      <div class="settings-item__control">
        <div class="favicon-upload">
          <div v-if="favicon" class="favicon-preview">
            <img :src="favicon" alt="favicon">
            <button class="favicon-clear" @click="clearFavicon">×</button>
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
  width: 220px;
  padding: 10px 14px;
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

.input--small {
  width: 160px;
}

.icon-selector {
  width: 260px;
}

.icon-preview {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  font-size: 30px;
  margin-bottom: 12px;
  border: 2px solid var(--border-color);
}

.icon-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 6px;
}

.icon-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}

.icon-btn.is-active {
  background: var(--accent-color);
  box-shadow: 0 0 0 2px var(--accent-light);
}

.custom-icon-row {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.favicon-upload {
  display: flex;
  align-items: center;
  gap: 12px;
}

.favicon-preview {
  position: relative;
  width: 36px;
  height: 36px;
  background: var(--bg-secondary);
  border-radius: 8px;
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
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: var(--error-color);
  color: #fff;
  cursor: pointer;
}

.upload-btn,
.btn {
  padding: 8px 16px;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-md);
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
}

@media (max-width: 640px) {
  .settings-item {
    flex-direction: column;
    gap: 12px;
  }

  .settings-item__info,
  .settings-item__control,
  .input,
  .icon-selector,
  .input--small {
    width: 100%;
  }

  .custom-icon-row {
    flex-direction: column;
  }
}
</style>
