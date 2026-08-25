export const PRIMARY_NAV_ITEMS = Object.freeze([
  {
    id: 'navigation',
    label: '导航',
    description: '导航首页',
    icon: 'compass',
    path: '/'
  },
  {
    id: 'whisper',
    label: '时光',
    description: '笔记、备忘录与日记',
    icon: 'note',
    path: '/whisper',
    module: 'whisper'
  },
  {
    id: 'media',
    label: '图片库',
    description: '图片、引用与分享',
    icon: 'image',
    path: '/media'
  },
  {
    id: 'mail',
    label: '邮件',
    description: '智能收件与重要邮件',
    icon: 'mail',
    path: '/mail'
  },
  {
    id: 'assistant',
    label: '助理',
    description: '带来源的个人资料助理',
    icon: 'sparkles',
    path: '/assistant'
  }
])

export function isPrimaryNavigationActive(routePath, itemPath) {
  if (itemPath === '/') return routePath === '/'
  return routePath === itemPath || routePath.startsWith(`${itemPath}/`)
}
