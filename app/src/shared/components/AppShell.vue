<script setup>
import PrimaryNavigation from '@/shared/components/PrimaryNavigation.vue'
import MobileTabBar from '@/shared/components/MobileTabBar.vue'
</script>

<template>
  <div class="app-shell">
    <PrimaryNavigation />
    <div class="app-shell__content">
      <slot />
    </div>
    <MobileTabBar />
  </div>
</template>

<style scoped>
.app-shell {
  --app-shell-header-height: 64px;
  min-height: 100vh;
  min-height: 100dvh;
}

.app-shell__content {
  min-width: 0;
  min-height: calc(100vh - var(--app-shell-header-height));
  min-height: calc(100dvh - var(--app-shell-header-height));
}

@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .app-shell {
    --app-shell-header-height: 58px;
  }

  .app-shell__content {
    padding-bottom: calc(86px + env(safe-area-inset-bottom));
  }
}
</style>
