import { ref, watch, onMounted, onUnmounted } from 'vue'
import { getSetting, setSetting } from '@/shared/db/database'

// 全局主题状态
const isDark = ref(false)
let initialized = false

// 获取系统主题偏好
function getSystemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

// 应用主题到 DOM
function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark)
}

// 监听系统主题变化
function watchSystemTheme() {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

  const handler = (e) => {
    const savedTheme = localStorage.getItem('nav-theme')
    if (savedTheme === 'system' || !savedTheme) {
      isDark.value = e.matches
      applyTheme(e.matches)
    }
  }

  mediaQuery.addEventListener('change', handler)

  return () => mediaQuery.removeEventListener('change', handler)
}

export function useTheme() {
  let cleanup = null

  onMounted(async () => {
    if (!initialized) {
      initialized = true

      // 从数据库读取主题设置
      const savedTheme = await getSetting('theme')

      if (savedTheme === 'dark') {
        isDark.value = true
      } else if (savedTheme === 'light') {
        isDark.value = false
      } else {
        // 默认跟随系统
        isDark.value = getSystemPrefersDark()
      }

      applyTheme(isDark.value)
      localStorage.setItem('nav-theme', savedTheme || 'system')

      // 监听系统主题变化
      cleanup = watchSystemTheme()
    }
  })

  onUnmounted(() => {
    cleanup?.()
  })

  // 监听 isDark 变化，更新 DOM
  watch(isDark, (value) => {
    applyTheme(value)
  })

  // 切换主题
  async function toggleTheme() {
    isDark.value = !isDark.value
    const theme = isDark.value ? 'dark' : 'light'
    await setSetting('theme', theme)
    localStorage.setItem('nav-theme', theme)
  }

  // 设置主题
  async function setTheme(theme) {
    if (theme === 'system') {
      isDark.value = getSystemPrefersDark()
    } else {
      isDark.value = theme === 'dark'
    }
    await setSetting('theme', theme)
    localStorage.setItem('nav-theme', theme)
  }

  return {
    isDark,
    toggleTheme,
    setTheme
  }
}

// 提供给 App.vue 使用
export const $isDark = isDark
