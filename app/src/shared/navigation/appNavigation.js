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
  }
])

export function isPrimaryNavigationActive(routePath, itemPath) {
  if (itemPath === '/') return routePath === '/'
  return routePath === itemPath || routePath.startsWith(`${itemPath}/`)
}
