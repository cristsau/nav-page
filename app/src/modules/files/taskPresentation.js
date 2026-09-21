// Presentation only: never infer completion from bytes or hide uncertain work.
export const taskFilters = [['all', '全部'], ['active', '进行中'], ['attention', '待处理'], ['finished', '已结束']]
export function taskGroup(job) {
  if (['complete', 'cancelled'].includes(job.state)) return 'finished'
  if (['queued', 'checking', 'downloading', 'uploading', 'committing'].includes(job.state)) return 'active'
  return 'attention'
}
export function taskCounts(jobs) {
  return jobs.reduce((counts, job) => { counts.all++; counts[taskGroup(job)]++; return counts }, { all: 0, active: 0, attention: 0, finished: 0 })
}
export function taskProgress(value, total, completed = false) {
  if (completed) return 100
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.floor(value / total * 100)))
}
export function transferBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '待获取'
  if (value < 1024) return `${value} B`
  const unit = value < 1024 ** 2 ? ['KB', 1024] : value < 1024 ** 3 ? ['MB', 1024 ** 2] : ['GB', 1024 ** 3]
  return `${(value / unit[1]).toFixed(1)} ${unit[0]}`
}
export function remainingTime(bytes, rate) {
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(rate) || rate <= 0) return ''
  const seconds = Math.ceil(bytes / rate)
  return seconds < 60 ? `约 ${seconds} 秒` : seconds < 3600 ? `约 ${Math.ceil(seconds / 60)} 分钟` : `约 ${(seconds / 3600).toFixed(1)} 小时`
}
export function uploadLabel(job) {
  if (job.cancel && !['complete', 'cancelled', 'review'].includes(job.state)) return '正在取消…'
  if (job.pause && ['checking', 'uploading'].includes(job.state)) return '正在暂停…'
  if (job.state === 'uploading' && job.size === job.offset) return '提交校验中'
  return ({ queued: '等待上传', checking: '核对文件内容', awaiting_file: '等待重选原文件', uploading: '上传中', paused: '已暂停', error: '等待重试', complete: '上传完成', cancelled: '已取消', review: '请核对云端结果' })[job.state] || '状态待核对'
}
