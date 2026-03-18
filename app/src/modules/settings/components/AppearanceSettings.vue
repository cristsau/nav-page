<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useTheme } from '@/shared/composables/useTheme'
import { useConfig, colorSchemes, borderRadiusOptions, cardSizeOptions } from '@/shared/composables/useConfig'

const { isDark, setTheme } = useTheme()
const { config, updateConfig } = useConfig()

// 主题模式
const themeMode = ref('system')

// 配色方案列表
const colorSchemeList = Object.entries(colorSchemes).map(([key, value]) => ({
  id: key,
  ...value
}))

// 当前配色
const currentScheme = computed(() => {
  return config.value.style?.colorScheme || 'cream'
})

// 圆角选项
const radiusList = Object.entries(borderRadiusOptions).map(([key, value]) => ({
  id: key,
  ...value
}))

// 卡片尺寸选项
const sizeList = Object.entries(cardSizeOptions).map(([key, value]) => ({
  id: key,
  ...value
}))

// 背景图预览
const bgPreview = computed(() => config.value.style?.backgroundImage || '')

onMounted(async () => {
  themeMode.value = localStorage.getItem('nav-theme') || 'system'
})

function handleThemeChange(mode) {
  themeMode.value = mode
  setTheme(mode)
}

function selectColorScheme(schemeId) {
  const scheme = colorSchemes[schemeId]
  if (scheme) {
    updateConfig('style.colorScheme', schemeId)
    updateConfig('style.accentColor', scheme.primary)
  }
}

function updateBorderRadius(size) {
  updateConfig('style.borderRadius', size)
}

function updateCardSize(size) {
  updateConfig('style.cardSize', size)
}

function toggleAnimations() {
  updateConfig('style.animationsEnabled', !config.value.style?.animationsEnabled)
}

function handleBgUpload(e) {
  const file = e.target.files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = (event) => {
    updateConfig('style.backgroundImage', event.target.result)
  }
  reader.readAsDataURL(file)
}

function clearBgImage() {
  updateConfig('style.backgroundImage', '')
}
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section__title">🎨 外观设置</h3>

    <!-- 主题模式 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">主题模式</div>
        <div class="settings-item__desc">选择界面主题</div>
      </div>
      <div class="settings-item__control">
        <div class="theme-options">
          <label class="theme-option" :class="{ 'is-active': themeMode === 'light' }">
            <input type="radio" value="light" :checked="themeMode === 'light'" @change="handleThemeChange('light')">
            <span class="theme-option__icon">☀️</span>
            <span class="theme-option__label">亮色</span>
          </label>
          <label class="theme-option" :class="{ 'is-active': themeMode === 'dark' }">
            <input type="radio" value="dark" :checked="themeMode === 'dark'" @change="handleThemeChange('dark')">
            <span class="theme-option__icon">🌙</span>
            <span class="theme-option__label">暗色</span>
          </label>
          <label class="theme-option" :class="{ 'is-active': themeMode === 'system' }">
            <input type="radio" value="system" :checked="themeMode === 'system'" @change="handleThemeChange('system')">
            <span class="theme-option__icon">💻</span>
            <span class="theme-option__label">跟随系统</span>
          </label>
        </div>
      </div>
    </div>

    <!-- 配色方案 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">配色方案</div>
        <div class="settings-item__desc">选择主题配色</div>
      </div>
      <div class="settings-item__control">
        <div class="color-schemes">
          <button
            v-for="scheme in colorSchemeList"
            :key="scheme.id"
            class="color-scheme"
            :class="{ 'is-active': currentScheme === scheme.id }"
            :style="{ '--scheme-color': scheme.primary }"
            @click="selectColorScheme(scheme.id)"
          >
            <span class="color-scheme__preview"></span>
            <span class="color-scheme__name">{{ scheme.name }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 圆角大小 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">圆角风格</div>
        <div class="settings-item__desc">调整界面元素的圆角大小</div>
      </div>
      <div class="settings-item__control">
        <div class="option-pills">
          <button
            v-for="item in radiusList"
            :key="item.id"
            class="option-pill"
            :class="{ 'is-active': config.style?.borderRadius === item.id }"
            @click="updateBorderRadius(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- 卡片尺寸 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">卡片大小</div>
        <div class="settings-item__desc">调整书签卡片的显示大小</div>
      </div>
      <div class="settings-item__control">
        <div class="option-pills">
          <button
            v-for="item in sizeList"
            :key="item.id"
            class="option-pill"
            :class="{ 'is-active': config.style?.cardSize === item.id }"
            @click="updateCardSize(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
    </div>

    <!-- 动画开关 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">动画效果</div>
        <div class="settings-item__desc">启用界面动画效果</div>
      </div>
      <div class="settings-item__control">
        <label class="toggle">
          <input
            type="checkbox"
            :checked="config.style?.animationsEnabled !== false"
            @change="toggleAnimations"
          >
          <span class="toggle__slider"></span>
        </label>
      </div>
    </div>

    <!-- 背景图 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">导航页背景图</div>
        <div class="settings-item__desc">自定义导航页背景</div>
      </div>
      <div class="settings-item__control">
        <div class="bg-upload">
          <div v-if="bgPreview" class="bg-preview">
            <img :src="bgPreview" alt="背景预览">
            <button class="bg-clear" @click="clearBgImage">✕</button>
          </div>
          <label class="upload-btn">
            {{ bgPreview ? '更换' : '上传图片' }}
            <input type="file" accept="image/*" hidden @change="handleBgUpload">
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

/* 主题选项 */
.theme-options {
  display: flex;
  gap: 8px;
}

.theme-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 14px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
}

.theme-option:hover {
  background: var(--bg-hover);
}

.theme-option.is-active {
  background: var(--accent-bg);
  box-shadow: 0 0 0 2px var(--accent-color);
}

.theme-option input {
  display: none;
}

.theme-option__icon {
  font-size: 20px;
  margin-bottom: 4px;
}

.theme-option__label {
  font-size: 12px;
  color: var(--text-secondary);
}

/* 配色方案 */
.color-schemes {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.color-scheme {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
}

.color-scheme:hover {
  background: var(--bg-hover);
}

.color-scheme.is-active {
  box-shadow: 0 0 0 2px var(--accent-color);
}

.color-scheme__preview {
  width: 28px;
  height: 28px;
  background: var(--scheme-color);
  border-radius: 50%;
  margin-bottom: 4px;
}

.color-scheme__name {
  font-size: 11px;
  color: var(--text-secondary);
}

/* 选项药丸 */
.option-pills {
  display: flex;
  gap: 8px;
}

.option-pill {
  padding: 8px 16px;
  background: var(--bg-secondary);
  border: none;
  border-radius: 20px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.option-pill:hover {
  background: var(--bg-hover);
}

.option-pill.is-active {
  background: var(--accent-color);
  color: #fff;
}

/* 开关 */
.toggle {
  position: relative;
  display: inline-block;
  width: 48px;
  height: 26px;
}

.toggle input {
  display: none;
}

.toggle__slider {
  position: absolute;
  inset: 0;
  background: var(--bg-tertiary);
  border-radius: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.toggle__slider::before {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  background: #fff;
  border-radius: 50%;
  transition: all 0.2s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.toggle input:checked + .toggle__slider {
  background: var(--accent-color);
}

.toggle input:checked + .toggle__slider::before {
  transform: translateX(22px);
}

/* 背景图上传 */
.bg-upload {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bg-preview {
  position: relative;
  width: 80px;
  height: 50px;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 2px solid var(--border-color);
}

.bg-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bg-clear {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
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

  .theme-options {
    justify-content: space-between;
  }

  .option-pills {
    justify-content: space-between;
  }
}
</style>
