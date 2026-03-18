import { createRouter, createWebHistory } from 'vue-router'

const routes = [
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
    meta: { title: '分享' }
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

router.beforeEach((to, from, next) => {
  document.title = to.meta.title
    ? `${to.meta.title} - NAV`
    : 'NAV - 个人导航页'
  next()
})

export default router
