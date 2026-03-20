<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useTheme } from '@/shared/composables/useTheme'
import { useConfig, colorSchemes, borderRadiusOptions, cardSizeOptions } from '@/shared/composables/useConfig'

const { isDark, setTheme } = useTheme()
const { config, updateConfig, setColorScheme } = useConfig()

const themeMode = ref('system')
const currentScheme = computed(() => config.value.style?.colorScheme || 'cream')
const activeSchemeMeta = computed(() => {
  return currentScheme.value === 'custom'
    ? { name: '自定义', ...(config.value.style?.customTheme || {}) }
    : (colorSchemes[currentScheme.value] || colorSchemes.cream)
})

const colorSchemeList = computed(() => [
  ...Object.entries(colorSchemes).map(([key, value]) => ({ id: key, ...value }))
])

const radiusList = Object.entries(borderRadiusOptions).map(([key, value]) => ({ id: key, ...value }))
const sizeList = Object.entries(cardSizeOptions).map(([key, value]) => ({ id: key, ...value }))
const bgPreview = computed(() => config.value.style?.backgroundImage || '')

const customTheme = computed(() => config.value.style?.customTheme || {})

const livePreviewStyle = computed(() => {
  const scheme = activeSchemeMeta.value
  const accent = scheme.primary

  if (isDark.value) {
    return {
      '--preview-bg': scheme.darkBg,
      '--preview-surface': scheme.darkBgCard,
      '--preview-soft': scheme.darkBgSecondary,
      '--preview-accent': accent,
      '--preview-text': scheme.darkTextPrimary,
      '--preview-muted': scheme.darkTextSecondary
    }
  }

  return {
    '--preview-bg': scheme.bg,
    '--preview-surface': scheme.bgCard,
    '--preview-soft': scheme.bgSecondary,
    '--preview-accent': accent,
    '--preview-text': scheme.textPrimary,
    '--preview-muted': scheme.textSecondary
  }
})

function forceApplyThemeTokens() {
  const root = document.documentElement
  const scheme = activeSchemeMeta.value
  const accent = scheme.primary

  root.style.setProperty('--accent-color', accent, 'important')

  if (isDark.value) {
    root.style.setProperty('--bg-primary', scheme.darkBg, 'important')
    root.style.setProperty('--bg-secondary', scheme.darkBgSecondary, 'important')
    root.style.setProperty('--bg-card', scheme.darkBgCard, 'important')
    root.style.setProperty('--text-primary', scheme.darkTextPrimary, 'important')
    root.style.setProperty('--text-secondary', scheme.darkTextSecondary, 'important')
    root.style.setProperty('--accent-bg', `${accent}38`, 'important')
  } else {
    root.style.setProperty('--bg-primary', scheme.bg, 'important')
    root.style.setProperty('--bg-secondary', scheme.bgSecondary, 'important')
    root.style.setProperty('--bg-card', scheme.bgCard, 'important')
    root.style.setProperty('--text-primary', scheme.textPrimary, 'important')
    root.style.setProperty('--text-secondary', scheme.textSecondary, 'important')
    root.style.setProperty('--accent-bg', `${accent}22`, 'important')
  }
}

onMounted(() => {
  themeMode.value = localStorage.getItem('nav-theme') || 'system'
  forceApplyThemeTokens()
})

watch([currentScheme, isDark, () => config.value.style?.customTheme], () => {
  forceApplyThemeTokens()
}, { deep: true, immediate: true })

function handleThemeChange(mode) {
  themeMode.value = mode
  setTheme(mode)
}

async function selectColorScheme(schemeId) {
  await setColorScheme(schemeId)
}

function updateCustomTheme(key, value) {
  updateConfig(`style.customTheme.${key}`, value)
  if (currentScheme.value !== 'custom') {
    updateConfig('style.colorScheme', 'custom')
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

function handleBgUpload(event) {
  const file = event.target.files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = (loadEvent) => {
    updateConfig('style.backgroundImage', loadEvent.target.result)
  }
  reader.readAsDataURL(file)
}

function clearBgImage() {
  updateConfig('style.backgroundImage', '')
}
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section__title">外观设置</h3>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">主题模式</div>
        <div class="settings-item__desc">选择亮色、暗色或跟随系统</div>
      </div>
      <div class="settings-item__control">
        <div class="theme-options">
          <label class="theme-option" :class="{ 'is-active': themeMode === 'light' }">
            <input type="radio" value="light" :checked="themeMode === 'light'" @change="handleThemeChange('light')">
            <span class="theme-option__label">亮色</span>
          </label>
          <label class="theme-option" :class="{ 'is-active': themeMode === 'dark' }">
            <input type="radio" value="dark" :checked="themeMode === 'dark'" @change="handleThemeChange('dark')">
            <span class="theme-option__label">暗色</span>
          </label>
          <label class="theme-option" :class="{ 'is-active': themeMode === 'system' }">
            <input type="radio" value="system" :checked="themeMode === 'system'" @change="handleThemeChange('system')">
            <span class="theme-option__label">跟随系统</span>
          </label>
        </div>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">配色方案</div>
        <div class="settings-item__desc">内置方案和自定义方案都可切换</div>
      </div>
      <div class="settings-item__control">
        <div class="color-schemes">
          <button
            v-for="scheme in colorSchemeList"
            :key="scheme.id"
            class="color-scheme"
            :class="{ 'is-active': currentScheme === scheme.id }"
            :style="{ '--scheme-color': scheme.primary || customTheme.primary || '#6b8c7a' }"
            @click="selectColorScheme(scheme.id)"
          >
            <span class="color-scheme__preview"></span>
            <span class="color-scheme__name">{{ scheme.name }}</span>
          </button>
        </div>
      </div>
    </div>

    <div class="theme-preview" :style="livePreviewStyle">
      <div class="theme-preview__meta">
        <span class="theme-preview__badge">{{ activeSchemeMeta.name }}</span>
        <span class="theme-preview__badge">{{ isDark ? 'dark' : 'light' }}</span>
      </div>
      <div class="theme-preview__canvas">
        <div class="theme-preview__surface">
          <div class="theme-preview__dot"></div>
          <div class="theme-preview__line theme-preview__line--strong"></div>
          <div class="theme-preview__line"></div>
        </div>
        <button class="theme-preview__button">Preview</button>
      </div>
    </div>

    <div class="settings-item settings-item--stack">
      <div class="settings-item__info">
        <div class="settings-item__label">自定义主题</div>
        <div class="settings-item__desc">设置主色、亮色背景和暗色背景，选中后会作为“自定义”方案生效</div>
      </div>
      <div class="custom-theme-grid">
        <label class="color-field">
          <span>主色</span>
          <input :value="customTheme.primary" type="color" @input="updateCustomTheme('primary', $event.target.value)">
        </label>
        <label class="color-field">
          <span>亮色背景</span>
          <input :value="customTheme.bg" type="color" @input="updateCustomTheme('bg', $event.target.value)">
        </label>
        <label class="color-field">
          <span>亮色次背景</span>
          <input :value="customTheme.bgSecondary" type="color" @input="updateCustomTheme('bgSecondary', $event.target.value)">
        </label>
        <label class="color-field">
          <span>亮色卡片</span>
          <input :value="customTheme.bgCard" type="color" @input="updateCustomTheme('bgCard', $event.target.value)">
        </label>
        <label class="color-field">
          <span>暗色背景</span>
          <input :value="customTheme.darkBg" type="color" @input="updateCustomTheme('darkBg', $event.target.value)">
        </label>
        <label class="color-field">
          <span>暗色次背景</span>
          <input :value="customTheme.darkBgSecondary" type="color" @input="updateCustomTheme('darkBgSecondary', $event.target.value)">
        </label>
        <label class="color-field">
          <span>暗色卡片</span>
          <input :value="customTheme.darkBgCard" type="color" @input="updateCustomTheme('darkBgCard', $event.target.value)">
        </label>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">圆角风格</div>
        <div class="settings-item__desc">调整页面元素的圆角大小</div>
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

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">卡片大小</div>
        <div class="settings-item__desc">调整导航卡片的显示尺寸</div>
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

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">动画效果</div>
        <div class="settings-item__desc">启用页面动画效果</div>
      </div>
      <div class="settings-item__control">
        <label class="toggle">
          <input type="checkbox" :checked="config.style?.animationsEnabled !== false" @change="toggleAnimations">
          <span class="toggle__slider"></span>
        </label>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">导航页背景图</div>
        <div class="settings-item__desc">自定义导航页背景</div>
      </div>
      <div class="settings-item__control">
        <div class="bg-upload">
          <div v-if="bgPreview" class="bg-preview">
            <img :src="bgPreview" alt="背景预览">
            <button class="bg-clear" @click="clearBgImage">×</button>
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

.settings-item--stack {
  display: block;
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

.theme-options,
.option-pills,
.color-schemes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.theme-option,
.option-pill,
.color-scheme {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  color: var(--text-primary);
}

.theme-option.is-active,
.option-pill.is-active,
.color-scheme.is-active {
  background: var(--accent-bg);
  box-shadow: 0 0 0 2px var(--accent-color);
}

.theme-option input {
  display: none;
}

.color-scheme__preview {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--scheme-color);
}

.theme-preview {
  margin: 4px 0 20px;
  padding: 16px;
  background: var(--preview-bg);
  border: 1px solid color-mix(in srgb, var(--preview-accent) 35%, transparent);
  border-radius: 18px;
}

.theme-preview__meta,
.theme-preview__canvas {
  display: flex;
  align-items: center;
  gap: 12px;
}

.theme-preview__badge {
  padding: 4px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--preview-accent) 24%, var(--preview-soft));
  color: var(--preview-text);
  font-size: 12px;
}

.theme-preview__canvas {
  margin-top: 12px;
  justify-content: space-between;
}

.theme-preview__surface {
  flex: 1;
  padding: 14px;
  background: var(--preview-surface);
  border-radius: 14px;
}

.theme-preview__dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--preview-accent);
  margin-bottom: 10px;
}

.theme-preview__line {
  height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--preview-muted) 55%, transparent);
  margin-top: 8px;
}

.theme-preview__line--strong {
  width: 60%;
  background: color-mix(in srgb, var(--preview-text) 80%, transparent);
}

.theme-preview__button {
  padding: 10px 18px;
  border: none;
  border-radius: 999px;
  background: var(--preview-accent);
  color: #fff;
  font-weight: 600;
}

.custom-theme-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.color-field {
  display: grid;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 13px;
}

.color-field input {
  width: 100%;
  height: 42px;
  padding: 4px;
  border: none;
  border-radius: 12px;
  background: var(--bg-secondary);
}

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
}

.toggle input:checked + .toggle__slider {
  background: var(--accent-color);
}

.toggle input:checked + .toggle__slider::before {
  transform: translateX(22px);
}

.bg-upload {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bg-preview {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 12px;
  overflow: hidden;
}

.bg-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bg-clear,
.upload-btn {
  padding: 8px 14px;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
}

@media (max-width: 760px) {
  .settings-item {
    flex-direction: column;
    gap: 12px;
  }

  .custom-theme-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 520px) {
  .custom-theme-grid {
    grid-template-columns: 1fr;
  }
}
</style>
