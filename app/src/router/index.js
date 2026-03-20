import { createRouter, createWebHistory } from 'vue-router'
import { bootstrapSystem, getCurrentUser } from '@/shared/db/database'

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
    path: '/whisper',
    name: 'Whisper',
    component: () => import('@/modules/whisper/Whisper.vue'),
    meta: { title: '时光' }
  },
  {
    path: '/share/:code',
    name: 'ShareView',
    component: () => import('@/modules/whisper/ShareView.vue'),
    meta: { title: '分享', public: true }
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

router.beforeEach(async (to) => {
  await bootstrapSystem()
  const currentUser = await getCurrentUser()
  const isPublic = Boolean(to.meta.public)

  document.title = to.meta.title ? `${to.meta.title} - NAV` : 'NAV - 个人导航页'

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

export default router
