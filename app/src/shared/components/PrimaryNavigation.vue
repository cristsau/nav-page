<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import NotificationCenter from '@/shared/components/NotificationCenter.vue'
import { useCommandPalette } from '@/shared/composables/useCommandPalette'
import { useConfig } from '@/shared/composables/useConfig'
import { useTheme } from '@/shared/composables/useTheme'
import { useAuth } from '@/shared/composables/useAuth'
import { isPrimaryNavigationActive, PRIMARY_NAV_ITEMS } from '@/shared/navigation/appNavigation'

defineProps({ collapsed: Boolean })
defineEmits(['toggle-sidebar'])
const route = useRoute()
const { getSiteName, isModuleEnabled } = useConfig()
const { isDark, toggleTheme } = useTheme()
const { openCommandPalette } = useCommandPalette()
const { isAdmin, currentUser } = useAuth()
const commandShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
const navigationItems = computed(() => PRIMARY_NAV_ITEMS.filter(item =>
  (!item.adminOnly || isAdmin.value) && (!item.module || isModuleEnabled(item.module))))
</script>

<template>
  <header class="primary-header" :class="{ 'is-collapsed': collapsed }">
    <router-link class="primary-header__brand" to="/" aria-label="返回导航首页">
      <span class="primary-header__logo" aria-hidden="true"><img src="/icons/cristsau-mark-64-v2.png" alt="" width="32" height="32"></span>
      <span class="primary-header__brand-name">{{ getSiteName() }}</span>
    </router-link>
    <button class="primary-header__command" type="button" aria-label="打开搜索与命令面板" title="搜索与命令"
      @click="openCommandPalette($event.currentTarget)">
      <Icon name="search" :size="17" /><span>搜索与命令</span><kbd aria-hidden="true">{{ commandShortcut }}</kbd>
    </button>
    <p class="primary-header__section" aria-hidden="true">工作区</p>
    <nav class="primary-header__nav" aria-label="主要页面">
      <router-link v-for="item in navigationItems" :key="item.id" :to="item.path" :title="item.label"
        :aria-label="item.label" :class="{ 'is-active': isPrimaryNavigationActive(route.path, item.path) }"
        :aria-current="isPrimaryNavigationActive(route.path, item.path) ? 'page' : undefined">
        <Icon :name="item.icon" :size="19" /><span>{{ item.label }}</span>
      </router-link>
    </nav>
    <div class="primary-header__bottom">
      <router-link class="primary-header__settings" to="/settings" title="设置"
        :aria-current="route.path === '/settings' ? 'page' : undefined" :class="{ 'is-active': route.path === '/settings' }">
        <Icon name="settings" :size="18" /><span>设置</span>
      </router-link>
      <div class="primary-header__actions">
        <NotificationCenter />
        <button type="button" :aria-label="isDark ? '切到亮色模式' : '切到暗色模式'" :title="isDark ? '切到亮色模式' : '切到暗色模式'" @click="toggleTheme">
          <Icon :name="isDark ? 'sun' : 'moon'" :size="18" />
        </button>
        <button class="primary-header__collapse" type="button" :aria-expanded="!collapsed"
          :aria-label="collapsed ? '展开侧栏' : '收起侧栏'" :title="collapsed ? '展开侧栏' : '收起侧栏'" @click="$emit('toggle-sidebar')">
          <Icon :name="collapsed ? 'chevron-right' : 'chevron-left'" :size="18" />
        </button>
      </div>
      <div class="primary-header__account" v-if="currentUser">
        <span class="primary-header__avatar" aria-hidden="true">{{ (currentUser.username || 'U').slice(0, 1).toUpperCase() }}</span>
        <span class="primary-header__identity"><strong>{{ currentUser.username }}</strong><small>{{ isAdmin ? '个人工作台 · 管理员' : '个人工作台' }}</small></span>
      </div>
    </div>
  </header>
</template>

<style scoped>
.primary-header {
  position:fixed; inset:0 auto 0 0; z-index:620; width:var(--workspace-sidebar,216px);
  display:flex; flex-direction:column; gap:8px; padding:20px 12px 14px;
  color:var(--text-primary); background:var(--bg-primary); border-right:1px solid var(--border-light);
}
.primary-header__brand { display:flex; align-items:center; gap:10px; min-height:40px; padding:0 6px 10px; font-weight:750; font-size:14px; white-space:nowrap; }
.primary-header__logo { width:32px; height:32px; display:grid; place-items:center; background:#fff; border:1px solid var(--border-color); border-radius:9px; flex-shrink:0; overflow:hidden; }
.primary-header__logo img { width:32px; height:32px; }
.primary-header__command { display:flex; align-items:center; gap:8px; min-height:38px; padding:8px; font-size:13px; border:1px solid var(--border-color); border-radius:8px; background:var(--bg-card); color:var(--text-secondary); text-align:left; }
.primary-header__command span { flex:1; white-space:nowrap; }
.primary-header__command kbd { font-family:inherit; font-size:10px; white-space:nowrap; color:var(--text-muted); }
.primary-header__section { color:var(--text-muted); padding:18px 10px 2px; font-size:12px; font-weight:600; }
.primary-header__nav { display:flex; flex-direction:column; gap:4px; min-height:0; overflow-y:auto; }
.primary-header__nav a, .primary-header__settings { display:flex; align-items:center; gap:12px; padding:10px 12px; min-height:42px; border-radius:8px; color:var(--text-secondary); font-weight:550; transition:background 140ms ease,color 140ms ease; }
.primary-header__nav a:hover, .primary-header__settings:hover { background:var(--bg-hover); color:var(--text-primary); }
.primary-header__nav a.is-active, .primary-header__settings.is-active { background:var(--accent-bg); color:var(--accent-text); font-weight:650; }
.primary-header__bottom { margin-top:auto; padding-top:16px; }
.primary-header__actions { display:flex; gap:4px; align-items:center; padding:8px 4px; }
.primary-header__actions > button, .primary-header__actions :deep(.notification-center__trigger) { display:grid; place-items:center; min-width:36px; min-height:36px; padding:8px; color:var(--text-secondary); background:transparent; border:0; border-radius:8px; }
.primary-header__actions > button:hover { color:var(--text-primary); background:var(--bg-hover); }
.primary-header__account { display:flex; gap:10px; align-items:center; padding:14px 8px 0; border-top:1px solid var(--border-light); min-width:0; }
.primary-header__avatar { display:grid; place-items:center; flex-shrink:0; width:30px; height:30px; background:var(--accent-bg); color:var(--accent-text); border-radius:8px; font-weight:650; }
.primary-header__identity { display:grid; min-width:0; gap:2px; }
.primary-header__identity strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; }
.primary-header__identity small { font-size:11px; color:var(--text-muted); }
.primary-header.is-collapsed .primary-header__brand-name,
.primary-header.is-collapsed .primary-header__command span,
.primary-header.is-collapsed .primary-header__command kbd,
.primary-header.is-collapsed .primary-header__section,
.primary-header.is-collapsed .primary-header__nav span,
.primary-header.is-collapsed .primary-header__settings span,
.primary-header.is-collapsed .primary-header__identity { display:none; }
.primary-header.is-collapsed .primary-header__actions { flex-direction:column; }
.primary-header.is-collapsed .primary-header__command { justify-content:center; }
@media (min-width:821px) and (max-width:1100px) {
  .primary-header__brand-name,.primary-header__command span,.primary-header__command kbd,.primary-header__section,.primary-header__nav span,.primary-header__settings span,.primary-header__identity,.primary-header__collapse { display:none; }
  .primary-header__actions { flex-direction:column; }
  .primary-header__actions > .primary-header__collapse { display:none; }
  .primary-header__command { justify-content:center; }
}
@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .primary-header { position:sticky; inset:auto; top:0; width:auto; height:56px; flex-direction:row; align-items:center; padding: 0 max(14px, env(safe-area-inset-right)) 0 max(14px, env(safe-area-inset-left)); gap:4px; border-right:0; border-bottom:1px solid var(--border-light); }
  .primary-header__brand { margin-right:auto; padding:0; gap:8px; }
  .primary-header__brand-name { display:block !important; font-size:13px; }
  .primary-header__nav,.primary-header__section,.primary-header__account,.primary-header__settings,.primary-header__collapse { display:none; }
  .primary-header__command { border:0; background:transparent; min-width:44px; justify-content:center; }
  .primary-header__command span,.primary-header__command kbd { display:none; }
  .primary-header__bottom { margin:0; padding:0; }
  .primary-header__actions,.primary-header.is-collapsed .primary-header__actions { padding:0; flex-direction:row; }
  .primary-header__actions > .primary-header__collapse { display:none; }
}
</style>
