<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import { useConfig } from '@/shared/composables/useConfig'
import {
  isPrimaryNavigationActive,
  PRIMARY_NAV_ITEMS
} from '@/shared/navigation/appNavigation'

const route = useRoute()
const { isModuleEnabled } = useConfig()
const navigationItems = computed(() => (
  PRIMARY_NAV_ITEMS.filter((item) => !item.module || isModuleEnabled(item.module))
))
</script>

<template>
  <nav class="mobile-tabs" aria-label="主要页面">
    <router-link
      v-for="item in navigationItems"
      :key="item.id"
      :to="item.path"
      :class="{ 'is-active': isPrimaryNavigationActive(route.path, item.path) }"
      :aria-current="isPrimaryNavigationActive(route.path, item.path) ? 'page' : undefined"
    >
      <Icon :name="item.icon" :size="20" />
      <span>{{ item.label }}</span>
    </router-link>
  </nav>
</template>

<style scoped>
.mobile-tabs {
  position: fixed;
  right: max(10px, env(safe-area-inset-right));
  bottom: max(10px, env(safe-area-inset-bottom));
  left: max(10px, env(safe-area-inset-left));
  z-index: 640;
  display: none;
  min-height: 64px;
  padding: 5px;
  align-items: stretch;
  justify-content: space-around;
  background: color-mix(in srgb, var(--bg-card) 92%, transparent);
  border: 1px solid color-mix(in srgb,var(--border-color) 70%,transparent);
  border-radius: 25px;
  box-shadow: 0 4px 24px #00000010, 0 1px 3px #00000006;
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
}

.mobile-tabs a {
  display: inline-flex;
  min-width: 0;
  min-height: 50px;
  padding: 6px 8px;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--text-muted);
  font-size: 0.68rem;
  font-weight: 670;
  text-decoration: none;
  border-radius: 20px;
}

@media (max-width: 420px) {
  .mobile-tabs a {
    min-width: 0;
    padding-inline: 4px;
    font-size: 0.63rem;
  }
}

.mobile-tabs a.is-active {
  color: var(--text-primary);
  background: var(--accent-bg);
}

@media(prefers-reduced-transparency:reduce) {.mobile-tabs{background:var(--bg-card);backdrop-filter:none;-webkit-backdrop-filter:none}}
@supports not (backdrop-filter:blur(1px)) {.mobile-tabs{background:var(--bg-card)}}

@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .mobile-tabs {
    display: flex;
  }
}
</style>
