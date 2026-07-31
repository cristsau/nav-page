<script setup>
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useTheme } from '@/shared/composables/useTheme'
import { applyStyleConfig, useConfig } from '@/shared/composables/useConfig'

const route = useRoute()
const publicShell = computed(() => Boolean(route.meta.publicShell))

const { isDark } = useTheme({ defer: publicShell })
const { config } = useConfig({ defer: publicShell })

const PUBLIC_SHELL_TOKENS = {
  '--bg-primary': '#f7f3ee',
  '--bg-secondary': '#eee7df',
  '--bg-tertiary': '#e4dbd1',
  '--bg-card': '#fffdf9',
  '--bg-hover': '#e9dfd5',
  '--bg-active': '#ded1c5',
  '--text-primary': '#332d29',
  '--text-secondary': '#6f655e',
  '--text-muted': '#988b82',
  '--border-color': '#ded4ca',
  '--border-light': '#e9e1d9',
  '--accent-color': '#927052',
  '--accent-hover': '#76563e',
  '--accent-light': '#d8c4b2',
  '--accent-bg': '#efe4d8',
  '--success-color': '#66886e',
  '--warning-color': '#a87b42',
  '--error-color': '#ac6666',
  '--info-color': '#66859c',
  '--radius-md': '16px',
  '--bg-image': 'none'
}

let publicShellSnapshot = null

function enterPublicShell() {
  if (publicShellSnapshot) return

  const root = document.documentElement
  publicShellSnapshot = {
    dark: root.classList.contains('dark'),
    tokens: Object.fromEntries(
      Object.keys(PUBLIC_SHELL_TOKENS).map((name) => [
        name,
        {
          value: root.style.getPropertyValue(name),
          priority: root.style.getPropertyPriority(name)
        }
      ])
    )
  }

  root.classList.add('public-shell')
  root.classList.remove('dark')

  for (const [name, value] of Object.entries(PUBLIC_SHELL_TOKENS)) {
    root.style.setProperty(name, value, 'important')
  }
}

function leavePublicShell({ reapply = true } = {}) {
  if (!publicShellSnapshot) {
    document.documentElement.classList.remove('public-shell')
    return
  }

  const root = document.documentElement
  const snapshot = publicShellSnapshot
  publicShellSnapshot = null

  root.classList.remove('public-shell')

  for (const [name, state] of Object.entries(snapshot.tokens)) {
    if (state.value) {
      root.style.setProperty(name, state.value, state.priority)
    } else {
      root.style.removeProperty(name)
    }
  }

  root.classList.toggle('dark', reapply ? isDark.value : snapshot.dark)

  if (reapply) {
    applyStyleConfig()
  }
}

watch(
  publicShell,
  (enabled) => {
    if (enabled) {
      enterPublicShell()
    } else {
      leavePublicShell()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  leavePublicShell({ reapply: false })
})

const bgStyle = computed(() => {
  if (publicShell.value) return {}

  const bgImage = config.value.style?.backgroundImage

  if (bgImage) {
    return {
      backgroundImage: `url(${bgImage})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundAttachment: 'fixed'
    }
  }

  return {}
})
</script>

<template>
  <div class="app" :class="{ 'app--public-shell': publicShell }" :style="bgStyle">
    <router-view />
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background-color: var(--bg-primary);
  color: var(--text-primary);
  transition: background-color 0.3s ease, color 0.3s ease;
}

.app--public-shell {
  background-color: #f7f3ee !important;
  background-image: none !important;
  color: #332d29;
}
</style>
