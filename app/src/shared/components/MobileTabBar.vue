<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import { useConfig } from '@/shared/composables/useConfig'
import {
  isPrimaryNavigationActive,
  PRIMARY_NAV_ITEMS
} from '@/shared/navigation/appNavigation'
import { resolveMobileDock } from '@/shared/navigation/mobileDock'

const route = useRoute()
const { isModuleEnabled } = useConfig()
const navigationItems = computed(() => (
  PRIMARY_NAV_ITEMS.filter((item) => !item.module || isModuleEnabled(item.module))
))
const dock = ref(null), viewportProbe = ref(null), layout = ref(null)
let observer, frame = 0, settleTimer = 0, disposed = false
const viewport = window.visualViewport
function updateDock() {
  frame = 0
  if (!dock.value || !viewportProbe.value) return
  const height = dock.value.getBoundingClientRect().height
  if (!height) {
    layout.value = null
    document.documentElement.style.removeProperty('--mobile-tabs-space')
    return
  }
  const active = document.activeElement
  const editable = active?.isContentEditable || (
    active?.matches('textarea, input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color])')
    && !active.readOnly && !active.disabled
  )
  layout.value = resolveMobileDock({
    layoutHeight: viewportProbe.value.getBoundingClientRect().height,
    visualHeight: viewport?.height, visualTop: viewport?.offsetTop, scale: viewport?.scale,
    editable, height, gap: parseFloat(getComputedStyle(viewportProbe.value).paddingBottom)
  })
  document.documentElement.style.setProperty('--mobile-tabs-space', `${layout.value.space}px`)
}
function schedule() {
  if (!disposed && !frame) frame = window.requestAnimationFrame(updateDock)
}
function settle() {
  if (disposed) return
  schedule()
  window.clearTimeout(settleTimer)
  // A credential sheet / soft keyboard may finish its animation after focusout.
  settleTimer = window.setTimeout(schedule, 400)
}
watch(() => route.fullPath, () => nextTick(settle))
onMounted(() => {
  observer = new ResizeObserver(schedule)
  observer.observe(dock.value)
  observer.observe(viewportProbe.value)
  window.addEventListener('resize', settle)
  window.addEventListener('orientationchange', settle)
  window.addEventListener('pageshow', settle)
  window.addEventListener('focus', settle)
  document.addEventListener('visibilitychange', settle)
  document.addEventListener('focusin', settle)
  document.addEventListener('focusout', settle)
  viewport?.addEventListener('resize', settle)
  viewport?.addEventListener('scroll', schedule, { passive: true })
  schedule()
})
onBeforeUnmount(() => {
  disposed = true
  observer?.disconnect()
  window.cancelAnimationFrame(frame)
  window.clearTimeout(settleTimer)
  window.removeEventListener('resize', settle)
  window.removeEventListener('orientationchange', settle)
  window.removeEventListener('pageshow', settle)
  window.removeEventListener('focus', settle)
  document.removeEventListener('visibilitychange', settle)
  document.removeEventListener('focusin', settle)
  document.removeEventListener('focusout', settle)
  viewport?.removeEventListener('resize', settle)
  viewport?.removeEventListener('scroll', schedule)
  document.documentElement.style.removeProperty('--mobile-tabs-space')
})
</script>

<template>
  <Teleport to="body">
  <span ref="viewportProbe" class="mobile-tabs-viewport" aria-hidden="true" />
  <nav ref="dock" class="mobile-tabs" :class="{ 'mobile-tabs--keyboard': layout?.keyboard }"
    :style="layout ? { '--mobile-tabs-top': `${layout.top}px` } : undefined"
    :inert="layout?.keyboard || undefined" :aria-hidden="layout?.keyboard || undefined" aria-label="主要页面">
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
  </Teleport>
</template>

<style scoped>
.mobile-tabs-viewport {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 100vh;
  height: 100dvh;
  padding-bottom: max(10px, env(safe-area-inset-bottom));
  visibility: hidden;
  pointer-events: none;
}
.mobile-tabs {
  position: fixed;
  right: max(10px, env(safe-area-inset-right));
  /* Avoid WebKit's stale bottom-anchored fixed viewport after keyboard dismiss. */
  top: calc(100vh - 64px - max(10px, env(safe-area-inset-bottom)));
  top: var(--mobile-tabs-top, calc(100dvh - 64px - max(10px, env(safe-area-inset-bottom))));
  bottom: auto;
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
.mobile-tabs--keyboard { visibility: hidden; pointer-events: none; }

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
