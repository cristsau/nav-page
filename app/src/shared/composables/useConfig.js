import { ref, watch, onMounted } from 'vue'
import { getSetting, setSetting } from '@/shared/db/database'

// 默认配置
const defaultConfig = {
  // 网站基础配置
  site: {
    name: 'NAV',
    icon: '📍',
    favicon: ''
  },

  // 默认搜索引擎
  searchEngine: 'baidu',

  // 搜索设置
  search: {
    aggregate: {
      enabled: false,
      engines: []
    }
  },

  // 模块显示
  modules: {
    navigation: true,
    whisper: true,
    settings: true
  },

  // 样式配置
  style: {
    colorScheme: 'cream',
    accentColor: '#a08060',
    borderRadius: 'medium',
    cardSize: 'medium',
    animationsEnabled: true
  },

  // 布局配置
  layout: {
    columns: 4,
    showDescription: true,
    showFavicon: true
  }
}

// 搜索引擎配置
export const searchEngines = {
  baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=', icon: '🔍' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=', icon: '🌐' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=', icon: '🔎' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=', icon: '🦆' },
  zhihu: { name: '知乎', url: 'https://www.zhihu.com/search?type=content&q=', icon: '📝' },
  bilibili: { name: 'B站', url: 'https://search.bilibili.com/all?keyword=', icon: '📺' },
  github: { name: 'GitHub', url: 'https://github.com/search?q=', icon: '🐙' },
  weibo: { name: '微博', url: 'https://s.weibo.com/weibo?q=', icon: '📢' }
}

// 配色方案
export const colorSchemes = {
  cream: {
    name: '奶油',
    primary: '#a08060',
    bg: '#faf8f5',
    bgSecondary: '#f5f2ed',
    bgCard: '#ffffff',
    textPrimary: '#4a4540',
    textSecondary: '#7a756d'
  },
  ocean: {
    name: '海洋',
    primary: '#5a8fa8',
    bg: '#f0f5f8',
    bgSecondary: '#e5eef3',
    bgCard: '#ffffff',
    textPrimary: '#3a5060',
    textSecondary: '#6a8090'
  },
  forest: {
    name: '森林',
    primary: '#5a8a6a',
    bg: '#f5f8f5',
    bgSecondary: '#e8f0e8',
    bgCard: '#ffffff',
    textPrimary: '#3a5040',
    textSecondary: '#6a8070'
  },
  rose: {
    name: '玫瑰',
    primary: '#c48a9a',
    bg: '#faf5f8',
    bgSecondary: '#f5e8ee',
    bgCard: '#ffffff',
    textPrimary: '#5a4050',
    textSecondary: '#8a7080'
  },
  lavender: {
    name: '薰衣草',
    primary: '#8a8ac4',
    bg: '#f5f5fa',
    bgSecondary: '#eaeaf5',
    bgCard: '#ffffff',
    textPrimary: '#404060',
    textSecondary: '#707090'
  },
  sunset: {
    name: '日落',
    primary: '#c48a6a',
    bg: '#faf8f5',
    bgSecondary: '#f5ece5',
    bgCard: '#ffffff',
    textPrimary: '#5a4a40',
    textSecondary: '#8a7060'
  }
}

// 圆角配置
export const borderRadiusOptions = {
  small: { radius: '8px', label: '紧凑' },
  medium: { radius: '16px', label: '标准' },
  large: { radius: '24px', label: '圆润' }
}

// 卡片尺寸配置
export const cardSizeOptions = {
  small: { width: '90px', iconSize: '32px', label: '紧凑' },
  medium: { width: '110px', iconSize: '44px', label: '标准' },
  large: { width: '130px', iconSize: '56px', label: '宽松' }
}

// 全局配置状态
const config = ref(JSON.parse(JSON.stringify(defaultConfig)))
let initialized = false
let saveTimeout = null
let watchInitialized = false

// 保存配置（防抖）
async function saveConfig() {
  if (saveTimeout) {
    clearTimeout(saveTimeout)
  }
  saveTimeout = setTimeout(async () => {
    try {
      await setSetting('appConfig', JSON.parse(JSON.stringify(config.value)))
    } catch (e) {
      console.error('Failed to save config:', e)
    }
  }, 300)
}

// 调整颜色亮度
function adjustColor(hex, percent) {
  if (!hex) return '#a08060'
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, Math.max(0, (num >> 16) + percent))
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + percent))
  const b = Math.min(255, Math.max(0, (num & 0x0000FF) + percent))
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)
}

// 应用样式配置（全局函数）
function applyStyleConfig() {
  const root = document.documentElement
  const { style, site } = config.value

  if (!style) return

  // 配色方案 - 应用完整配色
  const scheme = colorSchemes[style.colorScheme] || colorSchemes.cream
  const accentColor = style.accentColor || scheme.primary

  // 检查是否是暗色模式
  const isDark = root.classList.contains('dark')

  // 强调色（亮暗模式通用）
  root.style.setProperty('--accent-color', accentColor, 'important')
  root.style.setProperty('--accent-hover', adjustColor(accentColor, isDark ? 15 : -15), 'important')
  root.style.setProperty('--accent-light', adjustColor(accentColor, isDark ? -30 : 40), 'important')
  root.style.setProperty('--accent-bg', adjustColor(accentColor, isDark ? -30 : 45) + '20', 'important')

  // 背景色和文字色（根据模式调整）
  if (isDark) {
    // 暗色模式：基于配色方案生成暗色版本
    root.style.setProperty('--bg-primary', darkenColor(scheme.bg, 85), 'important')
    root.style.setProperty('--bg-secondary', darkenColor(scheme.bg, 80), 'important')
    root.style.setProperty('--bg-card', darkenColor(scheme.bg, 75), 'important')
    root.style.setProperty('--text-primary', lightenColor(scheme.textPrimary, 60), 'important')
    root.style.setProperty('--text-secondary', lightenColor(scheme.textSecondary, 40), 'important')
  } else {
    // 亮色模式
    root.style.setProperty('--bg-primary', scheme.bg, 'important')
    root.style.setProperty('--bg-secondary', scheme.bgSecondary, 'important')
    root.style.setProperty('--bg-card', scheme.bgCard, 'important')
    root.style.setProperty('--text-primary', scheme.textPrimary, 'important')
    root.style.setProperty('--text-secondary', scheme.textSecondary, 'important')
  }

  // 圆角
  const radius = borderRadiusOptions[style.borderRadius]?.radius || '16px'
  root.style.setProperty('--radius-md', radius, 'important')

  // 动画
  if (style.animationsEnabled === false) {
    root.classList.add('reduce-motion')
  } else {
    root.classList.remove('reduce-motion')
  }

  // 背景图
  if (style.backgroundImage) {
    root.style.setProperty('--bg-image', `url(${style.backgroundImage})`)
  } else {
    root.style.removeProperty('--bg-image')
  }

  // 网站标题
  if (site?.name) {
    document.title = site.name
  }

  // Favicon
  if (site?.favicon) {
    updateFavicon(site.favicon)
  }
}

// 变暗颜色
function darkenColor(hex, percent) {
  if (!hex) return '#1a1815'
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.max(0, (num >> 16) - percent)
  const g = Math.max(0, ((num >> 8) & 0x00FF) - percent)
  const b = Math.max(0, (num & 0x0000FF) - percent)
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)
}

// 变亮颜色
function lightenColor(hex, percent) {
  if (!hex) return '#e8e4dd'
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, (num >> 16) + percent)
  const g = Math.min(255, ((num >> 8) & 0x00FF) + percent)
  const b = Math.min(255, (num & 0x0000FF) + percent)
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)
}

// 更新 Favicon
function updateFavicon(favicon) {
  let link = document.querySelector("link[rel*='icon']")
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.href = favicon
}

// 全局监听配置变化
if (!watchInitialized) {
  watchInitialized = true
  watch(config, () => {
    saveConfig()
    applyStyleConfig()
  }, { deep: true })
}

export function useConfig() {
  onMounted(async () => {
    if (!initialized) {
      initialized = true
      await loadConfig()
    }
  })

  // 加载配置
  async function loadConfig() {
    try {
      const savedConfig = await getSetting('appConfig')
      if (savedConfig) {
        config.value = mergeDeep(JSON.parse(JSON.stringify(defaultConfig)), savedConfig)
      }
      applyStyleConfig()
    } catch (e) {
      console.error('Failed to load config:', e)
    }
  }

  // 深度合并
  function mergeDeep(target, source) {
    const output = { ...target }
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        output[key] = mergeDeep(target[key] || {}, source[key])
      } else if (source[key] !== undefined) {
        output[key] = source[key]
      }
    }
    return output
  }

  // 更新单个配置项
  function updateConfig(path, value) {
    const keys = path.split('.')
    let target = config.value

    for (let i = 0; i < keys.length - 1; i++) {
      if (!target[keys[i]]) {
        target[keys[i]] = {}
      }
      target = target[keys[i]]
    }

    target[keys[keys.length - 1]] = value
  }

  // 重置配置
  async function resetConfig() {
    config.value = JSON.parse(JSON.stringify(defaultConfig))
    applyStyleConfig()
    await setSetting('appConfig', config.value)
  }

  // 获取当前搜索引擎
  function getSearchEngine() {
    return searchEngines[config.value.searchEngine] || searchEngines.baidu
  }

  // 执行搜索
  function search(query) {
    const { search: searchConfig } = config.value

    if (searchConfig?.aggregate?.enabled && searchConfig.aggregate.engines?.length > 0) {
      searchConfig.aggregate.engines.forEach(engineId => {
        const engine = searchEngines[engineId]
        if (engine) {
          window.open(engine.url + encodeURIComponent(query), '_blank')
        }
      })
    } else {
      const engine = getSearchEngine()
      window.open(engine.url + encodeURIComponent(query), '_blank')
    }
  }

  // 检查模块是否启用
  function isModuleEnabled(moduleName) {
    return config.value.modules?.[moduleName] !== false
  }

  // 获取卡片样式
  function getCardStyle() {
    return cardSizeOptions[config.value.style?.cardSize] || cardSizeOptions.medium
  }

  // 获取网站名称
  function getSiteName() {
    return config.value.site?.name || 'NAV'
  }

  // 获取网站图标
  function getSiteIcon() {
    return config.value.site?.icon || '📍'
  }

  // 获取当前配色方案
  function getColorScheme() {
    return colorSchemes[config.value.style?.colorScheme] || colorSchemes.cream
  }

  return {
    config,
    updateConfig,
    resetConfig,
    getSearchEngine,
    search,
    isModuleEnabled,
    getCardStyle,
    getSiteName,
    getSiteIcon,
    getColorScheme,
    searchEngines,
    colorSchemes,
    borderRadiusOptions,
    cardSizeOptions
  }
}

// 导出全局配置
export const appConfig = config
