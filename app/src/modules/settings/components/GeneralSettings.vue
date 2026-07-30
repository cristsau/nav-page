<script setup>
import { ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { useConfig } from '@/shared/composables/useConfig'

const { config, updateConfig } = useConfig()
const DEFAULT_LOGO = '/domo-logo.png'

const siteName = ref('')
const favicon = ref(DEFAULT_LOGO)

watch(
  () => config.value.site,
  (site) => {
    if (!site) return
    siteName.value = site.name || 'DOMO NAV'
    favicon.value = site.favicon || DEFAULT_LOGO
  },
  { immediate: true, deep: true }
)

function saveSettings() {
  updateConfig('site', {
    name: siteName.value.trim() || 'DOMO NAV',
    icon: DEFAULT_LOGO,
    favicon: favicon.value || DEFAULT_LOGO
  })
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

function resetFavicon() {
  favicon.value = DEFAULT_LOGO
  saveSettings()
}
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section__title">基础设置</h3>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">网站名称</div>
        <div class="settings-item__desc">显示在浏览器标签、页面头部和品牌落款里。</div>
      </div>
      <div class="settings-item__control">
        <input v-model="siteName" type="text" class="input" placeholder="DOMO NAV" @change="saveSettings">
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">品牌 Logo</div>
        <div class="settings-item__desc">使用你提供的头像，统一显示在导航、登录页、关于页和浏览器扩展中。</div>
      </div>
      <div class="settings-item__control">
        <div class="brand-preview">
          <img :src="DEFAULT_LOGO" alt="">
          <span>DOMO NAV</span>
        </div>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">Favicon</div>
        <div class="settings-item__desc">上传浏览器标签页的小图标，便于区分 DOMO NAV。</div>
      </div>
      <div class="settings-item__control">
        <div class="favicon-upload">
          <div class="favicon-preview">
            <img :src="favicon" alt="favicon">
          </div>
          <label class="upload-btn">
            更换图片
            <input type="file" accept="image/*" hidden @change="handleFaviconUpload">
          </label>
          <button
            v-if="favicon !== DEFAULT_LOGO"
            class="favicon-reset"
            type="button"
            @click="resetFavicon"
          >
            <Icon name="refresh" :size="15" />
            恢复默认
          </button>
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

.brand-preview {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 180px;
  padding: 8px 14px 8px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 999px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.brand-preview img {
  width: 44px;
  height: 44px;
  display: block;
  object-fit: contain;
  background: #fff;
  border-radius: 50%;
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

.favicon-reset {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
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
  .input {
    width: 100%;
  }

  .favicon-upload {
    flex-wrap: wrap;
  }
}
</style>
