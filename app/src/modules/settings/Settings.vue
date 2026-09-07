<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import { useConfig } from '@/shared/composables/useConfig'
import { useAuth } from '@/shared/composables/useAuth'

const route = useRoute()
const router = useRouter()
const saving = ref(false)
const saveMessage = ref('')
const activeCategoryId = ref('basic')
const pendingSectionId = ref('')
const pendingCategoryScroll = ref(false)
const settingsContentRef = ref(null)

const { persistConfigNow } = useConfig()
const { currentUser, backendAuthEnabled, logout, initAuth } = useAuth()

const categoryComponents = {
  basic: defineAsyncComponent(() => import('./categories/BasicAppearanceCategory.vue')),
  search: defineAsyncComponent(() => import('./categories/SearchAiCategory.vue')),
  integrations: defineAsyncComponent(() => import('./categories/BrowserMobileCategory.vue')),
  users: defineAsyncComponent(() => import('./categories/UserManagementCategory.vue')),
  system: defineAsyncComponent(() => import('./categories/SystemIntegrationsCategory.vue')),
  security: defineAsyncComponent(() => import('./categories/SecurityAuditCategory.vue')),
  data: defineAsyncComponent(() => import('./categories/DataAboutCategory.vue'))
}

const allCategories = [
  { id: 'basic', label: '基础与外观', shortLabel: '基础', icon: 'settings', description: '站点名称、布局、主题与背景' },
  { id: 'search', label: '搜索与 AI', shortLabel: '搜索 AI', icon: 'sparkles', description: '搜索引擎、模型与联网能力' },
  { id: 'integrations', label: '浏览器与手机', shortLabel: '集成', icon: 'extension', description: '扩展、快速添加与移动端入口' },
  { id: 'users', label: '用户管理', shortLabel: '用户', icon: 'users', description: '注册审批、邮箱验证与邮件通知', adminOnly: true },
  { id: 'system', label: '登录与系统集成', shortLabel: '系统集成', icon: 'cloud', description: '外部账号登录、系统通知与加密云备份', adminOnly: true, backendOnly: true },
  { id: 'security', label: '账号安全与审计', shortLabel: '安全', icon: 'shield', description: '资料、会话、恢复码与审计', backendOnly: true },
  { id: 'data', label: '数据与关于', shortLabel: '数据', icon: 'database', description: '导入、导出、恢复与版本信息' }
]

const categories = computed(() => allCategories.filter((category) => {
  if (category.adminOnly && currentUser.value?.role !== 'admin') return false
  if (category.backendOnly && !backendAuthEnabled.value) return false
  return true
}))

const activeCategory = computed(() => (
  categories.value.find((category) => category.id === activeCategoryId.value)
  || categories.value[0]
))

const activeCategoryComponent = computed(() => (
  categoryComponents[activeCategory.value?.id] || categoryComponents.basic
))
const showsGlobalSave = computed(() => ['basic', 'search'].includes(activeCategory.value?.id))
const globalSaveLabel = computed(() => (
  activeCategory.value?.id === 'search' ? '保存搜索设置' : '保存基础设置'
))

function requestedCategoryId() {
  const explicit = String(route.query.category || '').trim()
  if (explicit && categoryComponents[explicit]) return explicit

  const section = String(route.query.section || '').trim()
  if (section === 'search') return 'search'
  if (section === 'browser') return 'integrations'
  if (section === 'data') return 'data'
  if (section === 'security' || section === 'security-audit') return 'security'
  if (section === 'users') return 'users'
  if (section === 'system' || section === 'mail' || section === 'cloud-backup') return 'system'
  return 'basic'
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

async function completePendingNavigation({ categoryResolved = false } = {}) {
  await nextTick()

  if (pendingSectionId.value) {
    const target = document.getElementById(`settings-${pendingSectionId.value}`)
    if (!target && !categoryResolved) return false

    if (!target) {
      settingsContentRef.value?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start'
      })
      document.getElementById('settings-category-title')?.focus({ preventScroll: true })
      pendingSectionId.value = ''
      pendingCategoryScroll.value = false
      return false
    }

    target.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start'
    })
    target.focus({ preventScroll: true })
    pendingSectionId.value = ''
    pendingCategoryScroll.value = false
    return true
  }

  if (!pendingCategoryScroll.value || !settingsContentRef.value) return false

  settingsContentRef.value.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'start'
  })
  document.getElementById('settings-category-title')?.focus({ preventScroll: true })
  pendingCategoryScroll.value = false
  return true
}

async function activateRequestedCategory() {
  const section = String(route.query.section || '').trim()
  const requested = requestedCategoryId()
  const nextCategoryId = categories.value.some((category) => category.id === requested)
    ? requested
    : categories.value[0]?.id || 'basic'

  if (section) {
    pendingSectionId.value = section
    pendingCategoryScroll.value = false
  } else {
    pendingSectionId.value = ''
    if (nextCategoryId !== activeCategoryId.value) {
      pendingCategoryScroll.value = true
    }
  }

  activeCategoryId.value = nextCategoryId
  await completePendingNavigation()
}

onMounted(async () => {
  await initAuth()
  await activateRequestedCategory()
})

onBeforeUnmount(() => {
  pendingSectionId.value = ''
  pendingCategoryScroll.value = false
})

watch(
  () => [route.query.category, route.query.section, currentUser.value?.role, backendAuthEnabled.value],
  () => activateRequestedCategory()
)

async function chooseCategory(categoryId) {
  if (categoryId === activeCategoryId.value && !route.query.section) return

  pendingSectionId.value = ''
  pendingCategoryScroll.value = true
  activeCategoryId.value = categoryId
  saveMessage.value = ''
  const query = { ...route.query, category: categoryId }
  delete query.section
  await router.replace({ query })
  await completePendingNavigation()
}

async function handleSave() {
  saving.value = true
  saveMessage.value = ''
  try {
    await persistConfigNow()
    saveMessage.value = '设置已保存并立即生效。'
  } catch (error) {
    saveMessage.value = error.message || '设置保存失败。'
  } finally {
    saving.value = false
  }
}

async function handleExit() {
  await logout()
  window.location.assign('/auth')
}
</script>

<template>
  <div class="page">
    <div class="settings-toolbar">
      <div>
        <p class="settings-toolbar__eyebrow">工作台设置</p>
        <h1>设置</h1>
        <p>当前用户：{{ currentUser?.username || '未登录' }}</p>
      </div>
      <div class="settings-toolbar__actions">
        <button
          v-if="showsGlobalSave"
          class="toolbar-button toolbar-button--primary"
          type="button"
          :disabled="saving"
          @click="handleSave"
        >
          <Icon name="check" :size="17" />
          <span>{{ saving ? '保存中' : globalSaveLabel }}</span>
        </button>
        <button class="toolbar-button" type="button" @click="handleExit">
          <Icon name="logout" :size="17" />
          <span>退出</span>
        </button>
      </div>
    </div>

    <main class="main">
      <div v-if="saveMessage" class="save-message" role="status" aria-live="polite">{{ saveMessage }}</div>

      <nav class="category-tabs" aria-label="设置分类">
        <button
          v-for="category in categories"
          :key="category.id"
          type="button"
          :class="{ 'is-active': activeCategory?.id === category.id }"
          :aria-current="activeCategory?.id === category.id ? 'page' : undefined"
          @click="chooseCategory(category.id)"
        >
          <Icon :name="category.icon" :size="17" />
          <span>{{ category.shortLabel }}</span>
        </button>
      </nav>

      <div class="settings-layout">
        <aside class="category-sidebar" aria-label="设置分类">
          <button
            v-for="category in categories"
            :key="category.id"
            type="button"
            :class="{ 'is-active': activeCategory?.id === category.id }"
            :aria-current="activeCategory?.id === category.id ? 'page' : undefined"
            @click="chooseCategory(category.id)"
          >
            <Icon :name="category.icon" :size="18" />
            <span>
              <strong>{{ category.label }}</strong>
              <small>{{ category.description }}</small>
            </span>
          </button>
        </aside>

        <section ref="settingsContentRef" class="settings-content" aria-labelledby="settings-category-title">
          <header class="settings-content__header">
            <p>{{ activeCategory?.shortLabel }}</p>
            <h2 id="settings-category-title" tabindex="-1">{{ activeCategory?.label }}</h2>
            <span>{{ activeCategory?.description }}</span>
          </header>

          <Suspense @resolve="completePendingNavigation({ categoryResolved: true })">
            <KeepAlive
              :max="7"
              :exclude="['SecurityAuditCategory', 'UserManagementCategory', 'SystemIntegrationsCategory']"
            >
              <component :is="activeCategoryComponent" :key="activeCategory?.id" />
            </KeepAlive>
            <template #fallback>
              <div class="category-loading" role="status">
                <span aria-hidden="true"></span>
                正在加载设置
              </div>
            </template>
          </Suspense>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
.page {
  min-height: calc(100vh - var(--app-shell-header-height, 64px));
  min-height: calc(100dvh - var(--app-shell-header-height, 64px));
  background: var(--bg-primary);
}
.settings-toolbar {
  position: sticky;
  top: var(--app-shell-header-height, 64px);
  z-index: 32;
  display: flex;
  min-height: 94px;
  padding: 17px clamp(18px, 4vw, 48px);
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  background: color-mix(in srgb, var(--bg-primary) 90%, transparent);
  border-bottom: 1px solid var(--border-light);
  backdrop-filter: blur(18px);
}
.settings-toolbar__eyebrow { margin: 0 0 3px; color: var(--accent-color); font-size: .7rem; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }
.settings-toolbar h1 { margin: 0; color: var(--text-primary); font-size: 1.5rem; letter-spacing: -.035em; }
.settings-toolbar > div > p:last-child { margin: 5px 0 0; color: var(--text-muted); font-size: .78rem; }
.settings-toolbar__actions { display: flex; gap: 9px; }
.toolbar-button {
  display: inline-flex;
  min-height: 44px;
  padding: 0 16px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  cursor: pointer;
}
.toolbar-button--primary { color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: var(--accent-color); }
.toolbar-button:disabled { cursor: wait; opacity: .65; }
.main { width: min(1240px, 100%); margin: 0 auto; padding: 26px clamp(14px, 3vw, 36px) 118px; }
.save-message { margin-bottom: 16px; padding: 13px 16px; color: var(--text-secondary); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; }
.settings-layout { display: grid; grid-template-columns: 238px minmax(0, 1fr); gap: clamp(20px, 3vw, 38px); align-items: start; }
.category-sidebar { position: sticky; top: calc(var(--app-shell-header-height, 64px) + 120px); display: grid; gap: 7px; }
.category-sidebar button {
  display: grid;
  min-height: 64px;
  padding: 10px 12px;
  grid-template-columns: 28px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 14px;
  cursor: pointer;
}
.category-sidebar button:hover, .category-sidebar button:focus-visible { color: var(--text-primary); background: var(--bg-hover); border-color: var(--border-light); }
.category-sidebar button.is-active { color: var(--text-primary); background: var(--bg-card); border-color: color-mix(in srgb, var(--accent-color) 46%, var(--border-color)); box-shadow: inset 3px 0 0 var(--accent-color); }
.category-sidebar button > span { display: grid; gap: 3px; min-width: 0; }
.category-sidebar strong { font-size: .86rem; }
.category-sidebar small { overflow: hidden; color: var(--text-muted); font-size: .67rem; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.settings-content { min-width: 0; scroll-margin-top: 176px; }
:deep([id^="settings-"]) { scroll-margin-top: 176px; }
.settings-content__header { margin-bottom: 18px; }
.settings-content__header p { margin: 0 0 4px; color: var(--accent-color); font-size: .7rem; font-weight: 750; letter-spacing: .13em; }
.settings-content__header h2 { margin: 0; color: var(--text-primary); font-size: clamp(1.45rem, 3vw, 2rem); letter-spacing: -.045em; outline: none; }
.settings-content__header span { display: block; margin-top: 7px; color: var(--text-muted); font-size: .82rem; }
.category-tabs { display: none; }
.category-loading { display: flex; min-height: 220px; align-items: center; justify-content: center; gap: 10px; color: var(--text-muted); }
.category-loading span { width: 18px; height: 18px; border: 2px solid var(--border-color); border-top-color: var(--accent-color); border-radius: 50%; animation: category-spin .8s linear infinite; }
@keyframes category-spin { to { transform: rotate(360deg); } }
button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent-color) 30%, transparent); outline-offset: 2px; }

@media (max-width: 860px) {
  .settings-toolbar { min-height: 82px; }
  .category-sidebar { display: none; }
  .category-tabs {
    position: sticky;
    top: calc(var(--app-shell-header-height, 58px) + 82px);
    z-index: 25;
    display: flex;
    margin: -26px -14px 22px;
    padding: 10px 14px;
    gap: 8px;
    overflow-x: auto;
    background: color-mix(in srgb, var(--bg-primary) 92%, transparent);
    border-bottom: 1px solid var(--border-light);
    scrollbar-width: none;
    backdrop-filter: blur(16px);
  }
  .category-tabs::-webkit-scrollbar { display: none; }
  .category-tabs button { display: inline-flex; min-width: max-content; min-height: 44px; padding: 0 13px; align-items: center; gap: 7px; color: var(--text-secondary); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 13px; }
  .category-tabs button.is-active { color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: var(--accent-color); }
  .settings-layout { display: block; }
  .settings-content,
  :deep([id^="settings-"]) { scroll-margin-top: 218px; }
}

@media (max-width: 560px) {
  .settings-toolbar { align-items: flex-end; }
  .settings-toolbar__actions { gap: 6px; }
  .toolbar-button { width: 44px; padding: 0; }
  .toolbar-button span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  .settings-content__header { margin-bottom: 14px; }
}

@media (prefers-reduced-motion: reduce) {
  .category-loading span { animation-duration: .01ms; }
}
</style>
