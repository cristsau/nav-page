import { createRouter, createWebHistory } from 'vue-router'
import { useAuth } from '@/shared/composables/useAuth'
import {
  finishRouteProgress,
  startRouteProgress
} from '@/shared/services/routeProgress'

const DEFAULT_DESCRIPTION = 'DOMO NAV 自托管网址导航与个人工作入口'
const PUBLIC_CANONICAL_ORIGIN = 'https://nav.cristsau.cn'

function updateDocumentMetadata(route) {
  document.title = route.meta.title
    ? `${route.meta.title} - DOMO NAV`
    : 'DOMO NAV - 个人导航工作台'

  const description = document.querySelector('meta[name="description"]')
  description?.setAttribute('content', route.meta.description || DEFAULT_DESCRIPTION)

  document.querySelector('link[data-domo-public-canonical]')?.remove()
  if (!route.meta.canonicalPath) return

  const canonical = document.createElement('link')
  canonical.rel = 'canonical'
  canonical.href = `${PUBLIC_CANONICAL_ORIGIN}${route.meta.canonicalPath}`
  canonical.dataset.domoPublicCanonical = 'true'
  document.head.append(canonical)
}

const routes = [
  {
    path: '/auth/oauth-complete',
    name: 'OauthComplete',
    component: () => import('@/modules/auth/OauthCompleteView.vue'),
    meta: { title: '返回应用', public: true, publicShell: true, skipSession: true }
  },
  {
    path: '/auth',
    name: 'Auth',
    component: () => import('@/modules/auth/AuthView.vue'),
    meta: { title: '登录', public: true }
  },
  {
    path: '/about',
    name: 'About',
    component: () => import('@/modules/public/AboutView.vue'),
    meta: {
      title: '关于',
      description: '了解 DOMO NAV 自托管网址导航、个人工作入口与 Google 登录的数据边界。',
      canonicalPath: '/about',
      public: true,
      publicShell: true,
      skipSession: true
    }
  },
  {
    path: '/privacy',
    name: 'Privacy',
    component: () => import('@/modules/public/PrivacyView.vue'),
    meta: {
      title: '隐私政策',
      description: 'DOMO NAV 隐私政策：Google 登录数据的收集、用途、存储、保留、解除绑定与删除方式。',
      canonicalPath: '/privacy',
      public: true,
      publicShell: true,
      skipSession: true
    }
  },
  {
    path: '/',
    name: 'Navigation',
    component: () => import('@/modules/navigation/Navigation.vue'),
    meta: { title: '导航' }
  },
  {
    path: '/quick-add',
    name: 'QuickAdd',
    component: () => import('@/modules/navigation/QuickAddView.vue'),
    meta: { title: '快速添加', appShell: false }
  },
  {
    path: '/whisper',
    name: 'Whisper',
    component: () => import('@/modules/whisper/Whisper.vue'),
    meta: { title: '时光' }
  },
  {
    path: '/media',
    name: 'MediaLibrary',
    component: () => import('@/modules/media/MediaLibrary.vue'),
    meta: { title: '图片库' }
  },
  {
    path: '/mail',
    name: 'Mail',
    component: () => import('@/modules/public/MailRetiredView.vue'),
    meta: { title: '邮箱已下线' }
  },
  {
    path: '/assistant',
    name: 'Assistant',
    component: () => import('@/modules/assistant/AssistantView.vue'),
    meta: { title: '助理' }
  },
  {
    path: '/share/:code',
    name: 'ShareView',
    component: () => import('@/modules/whisper/ShareView.vue'),
    meta: {
      title: '分享',
      public: true,
      publicShell: true,
      skipSession: true
    }
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('@/modules/settings/Settings.vue'),
    meta: { title: '设置' }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/'
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})
const { initAuth } = useAuth()

router.beforeEach(async (to) => {
  startRouteProgress()
  const isPublic = Boolean(to.meta.public)

  const shouldResolveSession = !to.meta.skipSession
  if (!shouldResolveSession) {
    return true
  }

  const currentUser = await initAuth()

  if (!currentUser && !isPublic) {
    return {
      path: '/auth',
      query: { redirect: to.fullPath }
    }
  }

  if (currentUser && to.path === '/auth') {
    return '/'
  }

  return true
})

router.afterEach((to, _from, failure) => {
  if (!failure) {
    updateDocumentMetadata(to)
  }
  finishRouteProgress()
})

router.onError(() => {
  finishRouteProgress()
})

export default router
