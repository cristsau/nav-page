<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { appUpdates } from '@/shared/services/appUpdates'

const state = ref(appUpdates.snapshot())
const unsubscribe = appUpdates.subscribe((next) => { state.value = next })
onBeforeUnmount(unsubscribe)
const message = computed(() => ({
  idle: '尚未检查更新', checking: '正在连接站点检查版本…',
  current: '当前网页已是本站发布版本', available: '发现本站其他发布版本，可查看说明后更新',
  error: '暂时无法确认是否有更新'
}[state.value.status]))
const formatBuild = (build) => build ? `${build.version} · ${build.buildId}` : '当前构建无版本信息'
</script>

<template>
  <section class="app-update-panel" aria-labelledby="app-update-title">
    <div class="app-update-panel__heading">
      <div><p class="app-update-panel__eyebrow">DOMO NAV</p><h3 id="app-update-title">版本与更新</h3></div>
      <span class="app-update-panel__badge">网页 / PWA</span>
    </div>
    <p class="app-update-panel__version">当前版本 {{ formatBuild(state.current) }}</p>
    <div class="app-update-panel__status" role="status" aria-live="polite">
      <p>{{ message }}</p>
      <p v-if="state.error" class="app-update-panel__error">{{ state.error }}</p>
    </div>
    <div v-if="state.status === 'available' && state.latest" class="app-update-panel__notes">
      <p>站点版本 {{ formatBuild(state.latest) }}</p>
      <ul><li v-for="note in state.latest.notes" :key="note">{{ note }}</li></ul>
    </div>
    <div class="app-update-panel__actions">
      <button class="btn btn--secondary" :disabled="state.busy" @click="appUpdates.check()">{{ state.busy ? '请稍候…' : '检查网页更新' }}</button>
      <button v-if="state.status === 'available'" class="btn btn--primary" :disabled="state.busy" @click="appUpdates.apply()">应用更新并刷新</button>
    </div>
    <p class="app-update-panel__hint">请先保存表单并确认同步完成。普通更新不主动退出登录，也不清除书签、设置或本机数据。扩展程序的版本由浏览器商店单独管理。</p>
  </section>
</template>

<style scoped>
.app-update-panel { min-width: 0; padding: 20px; border: 1px solid var(--border-light); border-radius: 22px; background: var(--bg-card); margin-bottom: 24px; }
.app-update-panel__heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.app-update-panel__eyebrow { color: var(--text-muted); font-size: 11px; letter-spacing: .12em; margin: 0 0 5px; }
h3 { margin: 0; font-size: 20px; }
.app-update-panel__badge { border-radius: 20px; background: var(--bg-secondary); padding: 7px 11px; font-size: 12px; }
.app-update-panel__version, .app-update-panel__notes { overflow-wrap: anywhere; font-size: 13px; line-height: 1.6; }
.app-update-panel__version, .app-update-panel__hint { color: var(--text-secondary); }
.app-update-panel__status { font-size: 14px; line-height: 1.6; }
.app-update-panel__status p { margin: 8px 0; }
.app-update-panel__error { color: var(--danger-color, #b42318); }
.app-update-panel__notes { background: var(--bg-secondary); border-radius: 14px; padding: 12px 16px; }
.app-update-panel__notes p { margin: 0; }
ul { padding-inline-start: 20px; margin-bottom: 0; }
.app-update-panel__actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.app-update-panel__actions button { min-height: 44px; flex: 1 1 160px; white-space: normal; overflow-wrap: anywhere; }
.app-update-panel__actions .btn { padding: 12px 16px; border-radius: 14px; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.app-update-panel__actions .btn--secondary { background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); }
.app-update-panel__actions .btn--primary { background: var(--accent-color); color: #fff; border: 1px solid transparent; }
.app-update-panel__actions button:disabled { opacity: .6; cursor: wait; }
.app-update-panel__actions button:focus-visible { outline: 2px solid var(--accent-color); outline-offset: 3px; }
.app-update-panel__hint { font-size: 13px; line-height: 1.7; margin: 14px 0 0; }
</style>
