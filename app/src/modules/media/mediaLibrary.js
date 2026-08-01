export const MEDIA_FILTERS = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'referenced', label: '引用中' },
  { id: 'unreferenced', label: '未关联' },
  { id: 'pending', label: '待清理' },
  { id: 'missing', label: '缺失' }
])

export function mediaStatus(image = {}) {
  const raw = String(image.status || '').toLowerCase()
  if (raw === 'missing' || image.missing) return 'missing'
  if (
    raw === 'cleanup_pending'
    || raw === 'delete_pending'
    || raw === 'delete_failed'
    || image.cleanupPending
  ) {
    return 'cleanup_pending'
  }
  return Number(image.referenceCount || image.references?.length || 0) > 0
    ? 'referenced'
    : 'unreferenced'
}

export function mediaStatusLabel(image = {}) {
  return {
    referenced: '引用中',
    unreferenced: '未关联',
    cleanup_pending: '待清理',
    missing: '原图缺失'
  }[mediaStatus(image)] || '未关联'
}

export function mediaCanDelete(image = {}) {
  return mediaStatus(image) !== 'referenced'
}

export function mediaCanShare(image = {}) {
  return mediaStatus(image) !== 'missing' && /^https:\/\//.test(String(image.url || ''))
}

export function mediaNeedsRetention(image = {}) {
  return String(image.retention || 'auto') !== 'keep'
}

export function formatMediaBytes(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return '大小未知'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function formatMediaDimensions(image = {}) {
  const width = Number(image.width || image.metadata?.width || 0)
  const height = Number(image.height || image.metadata?.height || 0)
  return width > 0 && height > 0 ? `${width} × ${height}` : '尺寸未知'
}

export function mediaMarkdown(image = {}) {
  const alt = String(image.name || image.alt || '图片').replace(/[\[\]]/g, '')
  return `![${alt}](${image.url || ''})`
}

export function upsertMediaImage(items, incoming) {
  if (!incoming?.id) return [...items]
  const index = items.findIndex((item) => String(item.id) === String(incoming.id))
  if (index < 0) return [incoming, ...items]
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...incoming } : item)
}
