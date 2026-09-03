<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import NotificationCenter from '@/shared/components/NotificationCenter.vue'
import { useCommandPalette } from '@/shared/composables/useCommandPalette'
import { useConfig } from '@/shared/composables/useConfig'
import { useTheme } from '@/shared/composables/useTheme'
import {
  isPrimaryNavigationActive,
  PRIMARY_NAV_ITEMS
} from '@/shared/navigation/appNavigation'

const route = useRoute()
const { getSiteName, isModuleEnabled } = useConfig()
const { isDark, toggleTheme } = useTheme()
const { openCommandPalette } = useCommandPalette()

const navigationItems = computed(() => (
  PRIMARY_NAV_ITEMS.filter((item) => !item.module || isModuleEnabled(item.module))
))
</script>

<template>
  <header class="primary-header">
    <router-link class="primary-header__brand" to="/" aria-label="返回导航首页">
      <span class="primary-header__logo" aria-hidden="true">
        <img src="/icons/cristsau-mark-512-v2.png" alt="">
      </span>
      <span>{{ getSiteName() }}</span>
    </router-link>

    <nav class="primary-header__nav" aria-label="主要页面">
      <router-link
        v-for="item in navigationItems"
        :key="item.id"
        :to="item.path"
        :class="{ 'is-active': isPrimaryNavigationActive(route.path, item.path) }"
        :aria-current="isPrimaryNavigationActive(route.path, item.path) ? 'page' : undefined"
      >
        <Icon :name="item.icon" :size="17" />
        <span>{{ item.label }}</span>
      </router-link>
    </nav>

    <div class="primary-header__actions">
      <button
        class="primary-header__command"
        type="button"
        aria-label="打开搜索与命令面板"
        @click="openCommandPalette($event.currentTarget)"
      >
        <Icon name="search" :size="17" />
        <span>搜索</span>
        <kbd aria-hidden="true">Ctrl K</kbd>
      </button>
      <NotificationCenter />
      <button
        type="button"
        :aria-label="isDark ? '切到亮色模式' : '切到暗色模式'"
        :title="isDark ? '切到亮色模式' : '切到暗色模式'"
        @click="toggleTheme"
      >
        <Icon :name="isDark ? 'sun' : 'moon'" :size="18" />
      </button>
      <router-link class="primary-header__action-link" to="/settings" aria-label="打开设置" title="设置">
        <Icon name="settings" :size="18" />
      </router-link>
    </div>
  </header>
</template>

<style scoped>
.primary-header {
  position: sticky;
  top: 0;
  z-index: 620;
  display: grid;
  grid-template-columns: minmax(170px, auto) minmax(0, 1fr) auto;
  min-height: var(--app-shell-header-height, 64px);
  padding: 0 max(20px, calc((100vw - 1200px) / 2));
  align-items: center;
  gap: 24px;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
  border-bottom: 1px solid var(--border-light);
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
}

.primary-header__brand {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  gap: 10px;
  color: var(--text-primary);
  font-size: 0.9rem;
  font-weight: 760;
  letter-spacing: 0.07em;
  text-decoration: none;
}

.primary-header__logo {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  overflow: hidden;
  background: #fff;
  border: 1px solid var(--border-light);
  border-radius: 10px;
}

.primary-header__logo img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.primary-header__nav {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
}

.primary-header__nav a {
  display: inline-flex;
  min-height: 44px;
  padding: 0 14px;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 0.84rem;
  font-weight: 650;
  text-decoration: none;
  border-radius: 12px;
  transition: color 0.16s ease, background 0.16s ease;
}

.primary-header__nav a:hover,
.primary-header__nav a:focus-visible {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.primary-header__nav a.is-active {
  color: var(--accent-color);
  background: var(--accent-bg);
}

.primary-header__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.primary-header__actions > button,
.primary-header__actions :deep(.notification-center__trigger),
.primary-header__action-link {
  display: inline-flex;
  min-width: 44px;
  min-height: 44px;
  padding: 0 12px;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
  text-decoration: none;
}

.primary-header__actions > button:hover,
.primary-header__actions > button:focus-visible,
.primary-header__actions :deep(.notification-center__trigger:hover),
.primary-header__actions :deep(.notification-center__trigger:focus-visible),
.primary-header__action-link:hover,
.primary-header__action-link:focus-visible {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.primary-header__command {
  gap: 8px;
}

.primary-header__command kbd {
  display: inline-flex;
  min-height: 25px;
  padding: 0 7px;
  align-items: center;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 0.67rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 7px;
}

@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .primary-header {
    grid-template-columns: minmax(0, 1fr) auto;
    padding: 0 max(14px, env(safe-area-inset-right)) 0 max(14px, env(safe-area-inset-left));
  }

  .primary-header__nav {
    display: none;
  }

  .primary-header__command > span,
  .primary-header__command kbd {
    display: none;
  }

  .primary-header__brand {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .primary-header__logo {
    width: 32px;
    height: 32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .primary-header__nav a {
    transition-duration: 0.01ms;
  }
}
</style>
