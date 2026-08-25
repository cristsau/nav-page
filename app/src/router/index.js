import { createRouter, createWebHistory } from 'vue-router'
import { useAuth } from '@/shared/composables/useAuth'
import {
  finishRouteProgress,
  startRouteProgress
} from '@/shared/services/routeProgress'

const routes = [
  {
    path: '/auth',
    name: 'Auth',
    component: () => import('@/modules/auth/AuthView.vue'),
    meta: { title: '登录', public: true }
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
    component: () => import('@/modules/mail/MailView.vue'),
    meta: { title: '邮件' }
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
    document.title = to.meta.title
      ? `${to.meta.title} - DOMO NAV`
      : 'DOMO NAV - 个人导航工作台'
  }
  finishRouteProgress()
})

router.onError(() => {
  finishRouteProgress()
})

export default router
