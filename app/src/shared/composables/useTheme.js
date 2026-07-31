import { ref, watch, onMounted, unref } from 'vue'
import { getCurrentUserId, getSetting, setSetting } from '@/shared/db/database'
import { applyStyleConfig } from '@/shared/composables/useConfig'
import { fetchBackendSetting, saveBackendSetting, shouldUseBackendSettings } from '@/shared/services/settingsApi'

const isDark = ref(false)
let initialized = false
let stopWatchingSystemTheme = null

function canUseBackendSettings() {
  return shouldUseBackendSettings() && Boolean(getCurrentUserId())
}

function getSystemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function applyTheme(dark) {
  const root = document.documentElement
  if (root.classList.contains('public-shell')) return

  root.classList.toggle('dark', dark)
  applyStyleConfig()
}

function startWatchingSystemTheme() {
  if (stopWatchingSystemTheme) return

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (event) => {
    const savedTheme = localStorage.getItem('nav-theme')

    if (savedTheme === 'system' || !savedTheme) {
      isDark.value = event.matches
      applyTheme(event.matches)
    }
  }

  mediaQuery.addEventListener('change', handler)
  stopWatchingSystemTheme = () => mediaQuery.removeEventListener('change', handler)
}

export async function loadTheme() {
  try {
    const savedTheme = canUseBackendSettings()
      ? await fetchBackendSetting('theme')
      : await getSetting('theme')

    if (savedTheme === 'dark') {
      isDark.value = true
    } else if (savedTheme === 'light') {
      isDark.value = false
    } else {
      isDark.value = getSystemPrefersDark()
    }

    localStorage.setItem('nav-theme', savedTheme || 'system')
  } catch (error) {
    console.error('Failed to load theme:', error)
    isDark.value = getSystemPrefersDark()
    localStorage.setItem('nav-theme', 'system')
  }

  applyTheme(isDark.value)
}

watch(isDark, (value) => {
  applyTheme(value)
})

async function initializeTheme() {
  if (initialized) return

  initialized = true
  await loadTheme()
  startWatchingSystemTheme()
}

export function useTheme(options = {}) {
  const initializeIfReady = async () => {
    if (unref(options.defer)) return
    await initializeTheme()
  }

  onMounted(initializeIfReady)

  if (options.defer !== undefined) {
    watch(
      () => Boolean(unref(options.defer)),
      (deferred) => {
        if (!deferred) {
          initializeTheme()
        }
      }
    )
  }

  async function toggleTheme() {
    await setTheme(isDark.value ? 'light' : 'dark')
  }

  async function setTheme(theme) {
    if (theme === 'system') {
      isDark.value = getSystemPrefersDark()
    } else {
      isDark.value = theme === 'dark'
    }

    try {
      if (canUseBackendSettings()) {
        await saveBackendSetting('theme', theme)
      } else if (getCurrentUserId()) {
        await setSetting('theme', theme)
      }
    } catch (error) {
      console.error('Failed to persist theme:', error)
    }

    localStorage.setItem('nav-theme', theme)
    applyTheme(isDark.value)
  }

  return {
    isDark,
    toggleTheme,
    setTheme
  }
}

export const $isDark = isDark
