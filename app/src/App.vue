<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useTheme } from '@/shared/composables/useTheme'
import { applyStyleConfig, useConfig } from '@/shared/composables/useConfig'
import {
  dispatchCommandAction,
  useCommandPalette
} from '@/shared/composables/useCommandPalette'
import CommandPalette from '@/shared/components/CommandPalette.vue'
import AppShell from '@/shared/components/AppShell.vue'
import Icon from '@/shared/components/Icon.vue'

const route = useRoute()
const router = useRouter()
const publicShell = computed(() => Boolean(route.meta.publicShell))
const commandPaletteEnabled = computed(() => !route.meta.public)
const appShellEnabled = computed(() => (
  !route.meta.public
  && route.meta.appShell !== false
))
const commandStatus = ref({ message: '', type: '' })
let commandStatusTimer = null

const {
  isOpen: commandPaletteOpen,
  openCommandPalette,
  closeCommandPalette,
  handleCommandPaletteShortcut
} = useCommandPalette()

const { isDark } = useTheme({ defer: publicShell })
const {
  config,
  updateConfig,
  setColorScheme,
  persistConfigNow
} = useConfig({ defer: publicShell })

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

watch(commandPaletteEnabled, (enabled) => {
  if (!enabled && commandPaletteOpen.value) {
    closeCommandPalette({ restoreFocus: false })
  }
})

function handleGlobalCommandPaletteKeydown(event) {
  if (!commandPaletteEnabled.value) return
  handleCommandPaletteShortcut(event)
}

async function handleCommandExecute(command) {
  if (!command) return

  if (command.action === 'set-theme' && command.value) {
    await closeCommandPalette({ restoreFocus: true })
    const persisted = await setColorScheme(command.value)
    setCommandStatus(
      persisted ? '主题已切换并保存' : '主题已切换，但保存失败；刷新后可能恢复原设置',
      persisted ? 'success' : 'error'
    )
    return
  }

  if (command.action === 'set-ai-model' && command.value) {
    await closeCommandPalette({ restoreFocus: true })
    updateConfig('search.providers.chatgpt.modelMode', command.mode === 'pinned' ? 'pinned' : 'latest')
    updateConfig('search.providers.chatgpt.model', command.value)
    const persisted = await persistConfigNow()
    setCommandStatus(
      persisted ? 'AI 模型设置已保存' : 'AI 模型已临时切换，但保存失败；刷新后可能恢复原设置',
      persisted ? 'success' : 'error'
    )
    return
  }

  await closeCommandPalette({ restoreFocus: false })
  if (!command.path) return
  await router.push(command.path)

  if (!command.action || route.path !== command.path) return

  await nextTick()
  window.requestAnimationFrame(() => {
    dispatchCommandAction(command.action)
  })
}

function setCommandStatus(message, type = 'success') {
  commandStatus.value = { message, type }
  if (commandStatusTimer) window.clearTimeout(commandStatusTimer)
  commandStatusTimer = window.setTimeout(() => {
    commandStatus.value = { message: '', type: '' }
    commandStatusTimer = null
  }, 3600)
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalCommandPaletteKeydown, true)
})

onBeforeUnmount(() => {
  if (commandStatusTimer) window.clearTimeout(commandStatusTimer)
  window.removeEventListener('keydown', handleGlobalCommandPaletteKeydown, true)
  closeCommandPalette({ restoreFocus: false })
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
  <div
    class="app"
    :class="{
      'app--public-shell': publicShell,
      'app--primary-shell': appShellEnabled
    }"
    :style="bgStyle"
  >
    <router-view v-slot="{ Component }">
      <AppShell v-if="appShellEnabled">
        <component :is="Component" />
      </AppShell>
      <component :is="Component" v-else />
    </router-view>

    <button
      v-if="commandPaletteEnabled && !appShellEnabled"
      class="command-launcher"
      type="button"
      aria-label="打开命令面板"
      title="打开命令面板（Ctrl 或 Cmd + K）"
      @click="openCommandPalette($event.currentTarget)"
    >
      <span class="command-launcher__icon"><Icon name="command" :size="17" /></span>
      <span>命令</span>
      <kbd>Ctrl K</kbd>
    </button>

    <CommandPalette
      :show="commandPaletteEnabled && commandPaletteOpen"
      @close="closeCommandPalette()"
      @execute="handleCommandExecute"
    />
    <p
      v-if="commandStatus.message"
      class="command-status"
      :class="`is-${commandStatus.type}`"
      role="status"
      aria-live="polite"
    >
      {{ commandStatus.message }}
    </p>
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

.command-launcher {
  position: fixed;
  right: max(18px, env(safe-area-inset-right));
  bottom: max(18px, env(safe-area-inset-bottom));
  z-index: 680;
  display: inline-flex;
  min-height: 44px;
  padding: 6px 8px 6px 7px;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
  font: inherit;
  font-size: 0.78rem;
  font-weight: 680;
  background: color-mix(in srgb, var(--bg-card) 92%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 84%, var(--accent-color));
  border-radius: 15px;
  box-shadow:
    0 14px 34px rgba(34, 24, 17, 0.14),
    0 2px 8px rgba(34, 24, 17, 0.08);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  cursor: pointer;
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}

.command-launcher:hover,
.command-launcher:focus-visible {
  border-color: color-mix(in srgb, var(--accent-color) 58%, var(--border-color));
  box-shadow:
    0 18px 42px rgba(34, 24, 17, 0.17),
    0 0 0 4px color-mix(in srgb, var(--accent-color) 10%, transparent);
  transform: translateY(-2px);
}

.command-launcher:focus-visible {
  outline: none;
}

.command-launcher__icon {
  display: grid;
  width: 31px;
  height: 31px;
  place-items: center;
  color: var(--accent-color);
  background: var(--accent-bg);
  border-radius: 10px;
}

.command-launcher kbd {
  display: inline-flex;
  height: 25px;
  padding: 0 7px;
  align-items: center;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 0.64rem;
  font-weight: 600;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 7px;
}

.command-status {
  position: fixed;
  right: max(18px, env(safe-area-inset-right));
  bottom: max(76px, calc(env(safe-area-inset-bottom) + 76px));
  z-index: 690;
  max-width: min(420px, calc(100vw - 36px));
  margin: 0;
  padding: 12px 15px;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--success-color);
  border-radius: 13px;
  box-shadow: var(--shadow-lg);
  font-size: 0.78rem;
  line-height: 1.55;
}

.command-status.is-error { border-color: var(--error-color); }

@media (max-width: 640px), (pointer: coarse) {
  .command-launcher {
    right: max(12px, env(safe-area-inset-right));
    bottom: max(12px, env(safe-area-inset-bottom));
    min-width: 48px;
    min-height: 48px;
    padding: 7px;
    justify-content: center;
    border-radius: 16px;
  }

  .command-launcher > span:not(.command-launcher__icon),
  .command-launcher kbd {
    display: none;
  }

  .command-launcher__icon {
    width: 33px;
    height: 33px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .app,
  .command-launcher {
    transition-duration: 0.01ms !important;
  }
}
</style>
