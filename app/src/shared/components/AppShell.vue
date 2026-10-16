<script setup>
import { ref } from 'vue'
import PrimaryNavigation from '@/shared/components/PrimaryNavigation.vue'
import MobileTabBar from '@/shared/components/MobileTabBar.vue'
import AppUpdateNotice from '@/shared/components/AppUpdateNotice.vue'

function readCollapsed() {
  try { return localStorage.getItem('nav-sidebar-collapsed') === 'true' } catch { return false }
}
const collapsed = ref(readCollapsed())
function toggleSidebar() {
  collapsed.value = !collapsed.value
  try { localStorage.setItem('nav-sidebar-collapsed', String(collapsed.value)) } catch { /* Optional preference. */ }
}
</script>

<template>
  <div class="app-shell" :class="{ 'is-sidebar-collapsed': collapsed }">
    <a class="app-shell__skip" href="#workspace-content">跳到主要内容</a>
    <PrimaryNavigation :collapsed="collapsed" @toggle-sidebar="toggleSidebar" />
    <div id="workspace-content" class="app-shell__content" tabindex="-1">
      <AppUpdateNotice />
      <slot />
    </div>
    <MobileTabBar />
  </div>
</template>

<style scoped>
.app-shell {
  --app-shell-header-height:0px;
  --workspace-sidebar:216px;
  min-height:100vh; min-height:100dvh;
}
.app-shell.is-sidebar-collapsed { --workspace-sidebar:76px; }
.app-shell__content {
  margin-left:var(--workspace-sidebar);
  min-width:0; min-height:100vh; min-height:100dvh;
}
.app-shell__skip {
  position:fixed; top:8px; left:16px; z-index:2000;
  transform:translateY(-200%); padding:10px 16px;
  background:var(--bg-card); border:1px solid var(--accent-color); border-radius:8px;
}
.app-shell__skip:focus { transform:none; }
@media (min-width:821px) and (max-width:1100px) { .app-shell { --workspace-sidebar:76px; } }
@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .app-shell { --app-shell-header-height:56px; --workspace-sidebar:0px; }
  .app-shell__content {
    margin-left:0;
    min-height:calc(100dvh - var(--app-shell-header-height));
    padding-bottom:var(--mobile-tabs-space,calc(86px + env(safe-area-inset-bottom)));
  }
}
</style>
