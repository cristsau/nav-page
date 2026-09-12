<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { appUpdates } from '@/shared/services/appUpdates'
const state = ref(appUpdates.snapshot())
const dismissed = ref('')
const unsubscribe = appUpdates.subscribe((next) => { state.value = next })
// Once per mounted app shell; no polling, forced refresh, or persisted dismissal.
onMounted(() => { if (state.value.status === 'idle') void appUpdates.check() })
onBeforeUnmount(unsubscribe)
</script>

<template>
  <aside v-if="state.status === 'available' && state.latest?.buildId !== dismissed" class="app-update-notice" aria-label="网页版本更新">
    <div><strong>DOMO NAV 有可用更新</strong><p>新版本 {{ state.latest?.version }}；请先保存内容。</p><p v-if="state.error" role="status">{{ state.error }}</p></div>
    <div class="app-update-notice__actions">
      <button class="btn btn--primary" :disabled="state.busy" @click="appUpdates.apply()">更新并刷新</button>
      <button class="btn btn--secondary" :disabled="state.busy" @click="dismissed = state.latest.buildId">稍后</button>
    </div>
  </aside>
</template>

<style scoped>
.app-update-notice { margin: 12px auto; padding: 16px; width: calc(100% - 32px); max-width: 1200px; box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 18px; font-size: 14px; }
.app-update-notice p { margin: 5px 0 0; color: var(--text-secondary); line-height: 1.5; }
.app-update-notice__actions { display: flex; flex-wrap: wrap; gap: 8px; }
button { min-height: 44px; white-space: normal; border-radius: 12px; padding: 10px 14px; font: inherit; font-weight: 600; cursor: pointer; }
.btn--primary { background: var(--accent-color); color: #fff; border: 1px solid transparent; }
.btn--secondary { background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); }
button:disabled { opacity: .6; cursor: wait; }
button:focus-visible { outline: 2px solid var(--accent-color); outline-offset: 3px; }
</style>
