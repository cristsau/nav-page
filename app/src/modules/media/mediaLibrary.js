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

export function mediaDeletionMessage(value = {}) {
  const deletion = value?.deletion || value
  const disposition = String(deletion?.disposition || '').trim().toLowerCase()
  const base = {
    source_deleted: '图床源文件已删除',
    detached: '图床引用已解除，源文件未物理删除',
    legacy_detached: '旧图床记录已解除引用，源文件无法物理删除',
    already_missing: '原文件此前已不存在，图床记录已清理'
  }[disposition]
  if (!base) return '图片清理已完成，但未收到源文件删除明细'

  if (deletion?.cachePurgeSucceeded === true) {
    return `${base}，全局缓存已清理，公开链接已失效`
  }
  return deletion?.localCacheInvalidated === true
    ? `${base}；当前节点缓存已清理，其他节点可能短暂可访问`
    : `${base}；缓存清理不完整，公开链接可能短暂可访问`
}

export function mediaCleanupMessage(results = []) {
  const successful = (Array.isArray(results) ? results : [])
    .filter((result) => result?.state === 'deleted')
  const failedCount = (Array.isArray(results) ? results : [])
    .filter((result) => result?.state === 'delete_failed').length
  if (!successful.length && !failedCount) return ''

  const counts = successful.reduce((summary, result) => {
    const disposition = String(result?.deletion?.disposition || 'unknown')
    summary[disposition] = (summary[disposition] || 0) + 1
    if (result?.deletion?.cachePurgeSucceeded !== true) {
      if (result?.deletion?.localCacheInvalidated === true) summary.localCacheOnly += 1
      else summary.cacheIncomplete += 1
    }
    return summary
  }, { cacheIncomplete: 0, localCacheOnly: 0 })
  const parts = []
  if (counts.source_deleted) parts.push(`源文件已删除 ${counts.source_deleted} 张`)
  if (counts.detached) parts.push(`仅解除图床引用 ${counts.detached} 张`)
  if (counts.legacy_detached) parts.push(`旧记录仅解除引用 ${counts.legacy_detached} 张`)
  if (counts.already_missing) parts.push(`原文件已不存在 ${counts.already_missing} 张`)
  if (counts.unknown) parts.push(`清理结果未明 ${counts.unknown} 张`)
  if (failedCount) parts.push(`清理失败 ${failedCount} 张，可在图片库重试`)
  if (counts.localCacheOnly) {
    parts.push(`仅当前节点缓存已清理 ${counts.localCacheOnly} 张，其他节点可能短暂可访问`)
  }
  if (counts.cacheIncomplete) {
    parts.push(`缓存未完全清理 ${counts.cacheIncomplete} 张，链接可能短暂可访问`)
  }
  return `图片清理：${parts.join('；')}`
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
