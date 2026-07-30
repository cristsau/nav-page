import { ref, watch, onMounted } from 'vue'
import { getCurrentUserId, getSetting, setSetting, getCustomEngines } from '@/shared/db/database'
import { runBackendAiSearch, shouldUseBackendAiSearch } from '@/shared/services/aiSearchApi'
import { fetchBackendCustomSearchEngines, shouldUseBackendSearchEngines } from '@/shared/services/searchEnginesApi'
import { fetchBackendSetting, saveBackendSetting, shouldUseBackendSettings } from '@/shared/services/settingsApi'

const defaultCustomTheme = {
  primary: '#6b8c7a',
  bg: '#f4f7f5',
  bgSecondary: '#e8eee9',
  bgCard: '#ffffff',
  textPrimary: '#243228',
  textSecondary: '#5f7265',
  darkBg: '#141917',
  darkBgSecondary: '#1e2722',
  darkBgCard: '#26332c',
  darkTextPrimary: '#edf5ef',
  darkTextSecondary: '#b7c8bc'
}

const defaultConfig = {
  site: {
    name: 'DOMO NAV',
    icon: 'D',
    favicon: ''
  },
  searchEngine: 'baidu',
  search: {
    aggregate: {
      enabled: false,
      engines: []
    },
    quickAccessEngineIds: ['baidu', 'google', 'bing', 'brave'],
    hiddenEngineIds: ['zhihu', 'bilibili', 'weibo'],
    providers: {
      chatgpt: {
        enabled: false,
        mode: 'api',
        apiMode: '',
        endpoint: 'https://api.openai.com/v1/responses',
        apiKey: '',
        model: 'gpt-5.6-terra',
        cliProxyBaseUrl: '',
        webSearchEnabled: true,
        reasoningEffort: 'low'
      },
      brave: {
        enabled: false,
        endpoint: 'https://api.search.brave.com/res/v1/web/search',
        apiKey: ''
      },
      openclaw: {
        enabled: false,
        baseUrl: '',
        endpoint: '',
        apiKey: '',
        model: ''
      }
    }
  },
  modules: {
    navigation: true,
    whisper: true,
    settings: true
  },
  style: {
    colorScheme: 'cream',
    accentColor: '#a08060',
    borderRadius: 'medium',
    cardSize: 'medium',
    animationsEnabled: true,
    backgroundImage: '',
    customTheme: { ...defaultCustomTheme }
  },
  layout: {
    columns: 4,
    showDescription: true,
    showFavicon: true
  }
}

export const searchEngines = {
  baidu: { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=', icon: '百', type: 'web', isBuiltIn: true },
  google: { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=', icon: 'G', type: 'web', isBuiltIn: true },
  bing: { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=', icon: 'B', type: 'web', isBuiltIn: true },
  brave: { id: 'brave', name: 'Brave Search', url: 'https://search.brave.com/search?q=', icon: 'BR', type: 'web', isBuiltIn: true },
  openclaw: { id: 'openclaw', name: 'OpenClaw', url: 'https://ai.skrskr.net/', icon: 'OC', type: 'openclaw', isBuiltIn: true },
  chatgpt: { id: 'chatgpt', name: 'ChatGPT Search', url: 'https://chatgpt.com/', icon: 'AI', type: 'chatgpt', isBuiltIn: true },
  zhihu: { id: 'zhihu', name: '知乎', url: 'https://www.zhihu.com/search?type=content&q=', icon: '知', type: 'web', isBuiltIn: true },
  bilibili: { id: 'bilibili', name: 'Bilibili', url: 'https://search.bilibili.com/all?keyword=', icon: '哔', type: 'web', isBuiltIn: true },
  github: { id: 'github', name: 'GitHub', url: 'https://github.com/search?q=', icon: 'GH', type: 'web', isBuiltIn: true },
  weibo: { id: 'weibo', name: '微博', url: 'https://s.weibo.com/weibo?q=', icon: '微', type: 'web', isBuiltIn: true }
}

export const colorSchemes = {
  cream: {
    name: '奶油',
    primary: '#a08060',
    bg: '#faf8f5',
    bgSecondary: '#f5f2ed',
    bgCard: '#ffffff',
    textPrimary: '#4a4540',
    textSecondary: '#7a756d',
    darkBg: '#1e1815',
    darkBgSecondary: '#2a211d',
    darkBgCard: '#372b25',
    darkTextPrimary: '#f1e8df',
    darkTextSecondary: '#c7b7a7'
  },
  ocean: {
    name: '海洋',
    primary: '#5a8fa8',
    bg: '#f0f5f8',
    bgSecondary: '#e5eef3',
    bgCard: '#ffffff',
    textPrimary: '#3a5060',
    textSecondary: '#6a8090',
    darkBg: '#0f1820',
    darkBgSecondary: '#152734',
    darkBgCard: '#1e3648',
    darkTextPrimary: '#e3f1f7',
    darkTextSecondary: '#9fc2d4'
  },
  forest: {
    name: '森林',
    primary: '#5a8a6a',
    bg: '#f5f8f5',
    bgSecondary: '#e8f0e8',
    bgCard: '#ffffff',
    textPrimary: '#3a5040',
    textSecondary: '#6a8070',
    darkBg: '#121915',
    darkBgSecondary: '#1a2a20',
    darkBgCard: '#24382b',
    darkTextPrimary: '#e6f2e8',
    darkTextSecondary: '#a9c7b0'
  },
  rose: {
    name: '玫瑰',
    primary: '#c48a9a',
    bg: '#faf5f8',
    bgSecondary: '#f5e8ee',
    bgCard: '#ffffff',
    textPrimary: '#5a4050',
    textSecondary: '#8a7080',
    darkBg: '#2a151f',
    darkBgSecondary: '#462432',
    darkBgCard: '#603142',
    darkTextPrimary: '#f7e5ec',
    darkTextSecondary: '#ddb2c0'
  },
  lavender: {
    name: '薰衣草',
    primary: '#8a8ac4',
    bg: '#f5f5fa',
    bgSecondary: '#eaeaf5',
    bgCard: '#ffffff',
    textPrimary: '#404060',
    textSecondary: '#707090',
    darkBg: '#171623',
    darkBgSecondary: '#26233a',
    darkBgCard: '#383454',
    darkTextPrimary: '#ecebfb',
    darkTextSecondary: '#bbb8e3'
  },
  sunset: {
    name: '日落',
    primary: '#c48a6a',
    bg: '#faf8f5',
    bgSecondary: '#f5ece5',
    bgCard: '#ffffff',
    textPrimary: '#5a4a40',
    textSecondary: '#8a7060',
    darkBg: '#261712',
    darkBgSecondary: '#3d241c',
    darkBgCard: '#573329',
    darkTextPrimary: '#f7e9e1',
    darkTextSecondary: '#ddb49d'
  },
  custom: {
    name: '自定义'
  }
}

export const borderRadiusOptions = {
  small: { radius: '8px', label: '紧凑' },
  medium: { radius: '16px', label: '标准' },
  large: { radius: '24px', label: '圆润' }
}

export const cardSizeOptions = {
  small: { width: '90px', iconSize: '32px', label: '紧凑' },
  medium: { width: '110px', iconSize: '44px', label: '标准' },
  large: { width: '130px', iconSize: '56px', label: '宽松' }
}

const config = ref(clone(defaultConfig))
const customSearchEngines = ref([])
let initialized = false
let watchInitialized = false
let saveTimeout = null

function canUseBackendSettings() {
  return shouldUseBackendSettings() && Boolean(getCurrentUserId())
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function mergeDeep(target, source) {
  const output = { ...target }

  for (const key in source) {
    const sourceValue = source[key]
    if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
      output[key] = mergeDeep(target[key] || {}, sourceValue)
    } else if (sourceValue !== undefined) {
      output[key] = sourceValue
    }
  }

  return output
}

function updateFavicon(favicon) {
  let link = document.querySelector("link[rel*='icon']")

  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }

  link.href = favicon
}

function adjustColor(hex, amount) {
  const value = (hex || '#a08060').replace('#', '')
  const num = parseInt(value, 16)
  const r = Math.min(255, Math.max(0, (num >> 16) + amount))
  const g = Math.min(255, Math.max(0, ((num >> 8) & 255) + amount))
  const b = Math.min(255, Math.max(0, (num & 255) + amount))
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

function mixColors(colorA, colorB, weight = 0.5) {
  const parse = (hex) => {
    const value = (hex || '#000000').replace('#', '')
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    }
  }

  const a = parse(colorA)
  const b = parse(colorB)
  const ratio = Math.min(1, Math.max(0, weight))
  const red = Math.round(a.r + (b.r - a.r) * ratio)
  const green = Math.round(a.g + (b.g - a.g) * ratio)
  const blue = Math.round(a.b + (b.b - a.b) * ratio)

  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

function ensureConfigShape() {
  config.value = mergeDeep(clone(defaultConfig), config.value)

  if (!Array.isArray(config.value.search.quickAccessEngineIds) || !config.value.search.quickAccessEngineIds.length) {
    config.value.search.quickAccessEngineIds = [...defaultConfig.search.quickAccessEngineIds]
  }

  if (!config.value.style.customTheme) {
    config.value.style.customTheme = { ...defaultCustomTheme }
  }
}

function getResolvedColorScheme(style = config.value.style) {
  if (style?.colorScheme === 'custom') {
    return {
      name: '自定义',
      ...defaultCustomTheme,
      ...(style.customTheme || {})
    }
  }

  return colorSchemes[style?.colorScheme] || colorSchemes.cream
}

function syncStyleConfig() {
  ensureConfigShape()
  const scheme = getResolvedColorScheme(config.value.style)
  config.value.style.accentColor = scheme.primary
}

export async function loadCustomSearchEngines() {
  if (shouldUseBackendSearchEngines() && !getCurrentUserId()) {
    customSearchEngines.value = []
    return
  }

  try {
    customSearchEngines.value = shouldUseBackendSearchEngines()
      ? await fetchBackendCustomSearchEngines()
      : await getCustomEngines()
  } catch (error) {
    console.error('Failed to load custom search engines:', error)
    customSearchEngines.value = []
  }
}

export function applyStyleConfig() {
  const root = document.documentElement
  const style = config.value.style || {}
  const scheme = getResolvedColorScheme(style)
  const isDark = root.classList.contains('dark')
  const accentColor = scheme.primary

  root.style.setProperty('--accent-color', accentColor, 'important')
  root.style.setProperty('--accent-hover', adjustColor(accentColor, isDark ? 18 : -15), 'important')
  root.style.setProperty('--accent-light', adjustColor(accentColor, isDark ? -28 : 40), 'important')
  root.style.setProperty('--accent-bg', `${adjustColor(accentColor, isDark ? -12 : 45)}${isDark ? '38' : '20'}`, 'important')

  if (isDark) {
    root.style.setProperty('--bg-primary', scheme.darkBg, 'important')
    root.style.setProperty('--bg-secondary', scheme.darkBgSecondary, 'important')
    root.style.setProperty('--bg-card', scheme.darkBgCard, 'important')
    root.style.setProperty('--bg-hover', mixColors(scheme.darkBgSecondary, accentColor, 0.24), 'important')
    root.style.setProperty('--bg-active', mixColors(scheme.darkBgCard, accentColor, 0.3), 'important')
    root.style.setProperty('--bg-tertiary', mixColors(scheme.darkBgSecondary, '#ffffff', 0.08), 'important')
    root.style.setProperty('--text-primary', scheme.darkTextPrimary, 'important')
    root.style.setProperty('--text-secondary', scheme.darkTextSecondary, 'important')
    root.style.setProperty('--text-muted', mixColors(scheme.darkTextSecondary, scheme.darkBg, 0.72), 'important')
    root.style.setProperty('--border-color', mixColors(scheme.darkBgCard, accentColor, 0.38), 'important')
    root.style.setProperty('--border-light', mixColors(scheme.darkBgSecondary, accentColor, 0.3), 'important')
    root.style.setProperty('--success-color', mixColors('#7fbf90', accentColor, 0.2), 'important')
    root.style.setProperty('--warning-color', mixColors('#d4b87a', accentColor, 0.25), 'important')
    root.style.setProperty('--info-color', mixColors('#7aaed4', accentColor, 0.3), 'important')
  } else {
    root.style.setProperty('--bg-primary', scheme.bg, 'important')
    root.style.setProperty('--bg-secondary', scheme.bgSecondary, 'important')
    root.style.setProperty('--bg-card', scheme.bgCard, 'important')
    root.style.setProperty('--bg-hover', mixColors(scheme.bgSecondary, accentColor, 0.12), 'important')
    root.style.setProperty('--bg-active', mixColors(scheme.bgSecondary, accentColor, 0.2), 'important')
    root.style.setProperty('--bg-tertiary', mixColors(scheme.bgSecondary, accentColor, 0.08), 'important')
    root.style.setProperty('--text-primary', scheme.textPrimary, 'important')
    root.style.setProperty('--text-secondary', scheme.textSecondary, 'important')
    root.style.setProperty('--text-muted', adjustColor(scheme.textSecondary, 40), 'important')
    root.style.setProperty('--border-color', mixColors(scheme.bgSecondary, accentColor, 0.22), 'important')
    root.style.setProperty('--border-light', mixColors(scheme.bgSecondary, accentColor, 0.12), 'important')
    root.style.setProperty('--success-color', '#7a9f7a', 'important')
    root.style.setProperty('--warning-color', '#c9a86c', 'important')
    root.style.setProperty('--info-color', '#7a9fc9', 'important')
  }

  root.style.setProperty('--radius-md', borderRadiusOptions[style.borderRadius]?.radius || '16px', 'important')

  if (style.animationsEnabled === false) {
    root.classList.add('reduce-motion')
  } else {
    root.classList.remove('reduce-motion')
  }

  if (style.backgroundImage) {
    root.style.setProperty('--bg-image', `url(${style.backgroundImage})`)
  } else {
    root.style.removeProperty('--bg-image')
  }

  if (config.value.site?.name) {
    document.title = config.value.site.name
  }

  if (config.value.site?.favicon) {
    updateFavicon(config.value.site.favicon)
  }
}

function getAllSearchEngineList() {
  return [
    ...Object.values(searchEngines),
    ...customSearchEngines.value.map((engine) => ({
      ...engine,
      type: 'web',
      isBuiltIn: false
    }))
  ]
}

function isAiSearchEngine(engineId) {
  return engineId === 'brave' || engineId === 'chatgpt' || engineId === 'openclaw'
}

function isAiSearchEnabled(engineId) {
  if (!shouldUseBackendAiSearch() || !isAiSearchEngine(engineId)) {
    return false
  }

  if (engineId === 'openclaw') {
    return Boolean(config.value.search?.providers?.openclaw?.enabled)
  }

  if (engineId === 'brave') {
    return Boolean(config.value.search?.providers?.brave?.enabled)
  }

  if (engineId === 'chatgpt') {
    return Boolean(config.value.search?.providers?.chatgpt?.enabled)
  }

  return false
}

function scheduleSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout)
  }

  saveTimeout = setTimeout(async () => {
    await persistConfigNow()
  }, 300)
}

export async function persistConfigNow() {
  if (!getCurrentUserId()) {
    return
  }

  try {
    if (canUseBackendSettings()) {
      await saveBackendSetting('appConfig', clone(config.value))
      return
    }

    await setSetting('appConfig', clone(config.value))
  } catch (error) {
    console.error('Failed to persist config:', error)
  }
}

export async function loadConfig() {
  try {
    const savedConfig = canUseBackendSettings()
      ? await fetchBackendSetting('appConfig')
      : await getSetting('appConfig')

    config.value = savedConfig
      ? mergeDeep(clone(defaultConfig), savedConfig)
      : clone(defaultConfig)
  } catch (error) {
    console.error('Failed to load config:', error)
    config.value = clone(defaultConfig)
  }

  ensureConfigShape()
  syncStyleConfig()
  applyStyleConfig()
}

if (!watchInitialized) {
  watchInitialized = true
  watch(
    config,
    () => {
      applyStyleConfig()
      scheduleSave()
    },
    { deep: true }
  )
}

export function useConfig() {
  onMounted(async () => {
    if (!initialized) {
      initialized = true
      await loadConfig()
      await loadCustomSearchEngines()
    }
  })

  function updateConfig(path, value) {
    const keys = path.split('.')
    let target = config.value

    for (let index = 0; index < keys.length - 1; index += 1) {
      const key = keys[index]
      if (!target[key]) {
        target[key] = {}
      }
      target = target[key]
    }

    target[keys[keys.length - 1]] = value
  }

  async function setColorScheme(schemeId) {
    updateConfig('style.colorScheme', schemeId)
    syncStyleConfig()
    applyStyleConfig()
    await persistConfigNow()
  }

  async function applyCurrentConfigNow() {
    syncStyleConfig()
    applyStyleConfig()
    await persistConfigNow()
  }

  async function resetConfig() {
    config.value = clone(defaultConfig)
    syncStyleConfig()
    applyStyleConfig()
    await persistConfigNow()
  }

  function getAllSearchEngines() {
    return getAllSearchEngineList()
  }

  function getQuickAccessSearchEngines() {
    const allEngines = getAllSearchEngineList()
    const visibleIds = config.value.search?.quickAccessEngineIds || defaultConfig.search.quickAccessEngineIds

    return visibleIds
      .map((engineId) => allEngines.find((engine) => engine.id === engineId))
      .filter(Boolean)
  }

  function getSearchEngine() {
    const allEngines = getAllSearchEngineList()
    return allEngines.find((engine) => engine.id === config.value.searchEngine) || searchEngines.baidu
  }

  async function search(query) {
    const allEngines = getAllSearchEngineList()
    const { search } = config.value

    const runSingleEngine = async (engineId, forceExternal = false) => {
      const engine = allEngines.find((item) => item.id === engineId)
      if (!engine) return

      if (!forceExternal && isAiSearchEnabled(engine.id)) {
        const result = await runBackendAiSearch(engine.id, query)
        return {
          mode: 'ai',
          result
        }
      }

      window.open(engine.url + encodeURIComponent(query), '_blank', 'noopener,noreferrer')
      return {
        mode: 'external'
      }
    }

    if (search?.aggregate?.enabled && search.aggregate.engines?.length) {
      for (const engineId of search.aggregate.engines) {
        await runSingleEngine(engineId, true)
      }
      return {
        mode: 'external'
      }
    }

    return runSingleEngine(config.value.searchEngine)
  }

  function isModuleEnabled(moduleName) {
    return config.value.modules?.[moduleName] !== false
  }

  function getCardStyle() {
    return cardSizeOptions[config.value.style?.cardSize] || cardSizeOptions.medium
  }

  function getSiteName() {
    return config.value.site?.name || 'DOMO NAV'
  }

  function getSiteIcon() {
    return config.value.site?.icon || 'D'
  }

  function getColorScheme() {
    return getResolvedColorScheme(config.value.style)
  }

  return {
    config,
    customSearchEngines,
    loadConfig,
    loadCustomSearchEngines,
    updateConfig,
    setColorScheme,
    resetConfig,
    persistConfigNow: applyCurrentConfigNow,
    getAllSearchEngines,
    getQuickAccessSearchEngines,
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

export const appConfig = config
