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

export function visibleTasks(jobs, filter = 'all', query = '') {
  const normalize = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase() : ''
  const terms = normalize(query).slice(0, 160).trim().split(/\s+/).filter(Boolean)
  return jobs.filter(job => (filter === 'all' || taskGroup(job) === filter) && terms.every(term =>
    [job.name, job.path, job.destination].some(value => normalize(value).includes(term))))
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

// A transfer can reach 100% before provider commit succeeds; stages are not job completion.
export function offlineTransferStages(job) {
  const completed = job.state === 'complete'
  const transcoding = job.kind === 'video' && ['inspecting', 'transcoding', 'verifying'].includes(job.stage)
    && !['uploading', 'committing', 'complete'].includes(job.state)
  const percent = (value, total) => completed ? 100 : Number.isFinite(total) && total > 0 && Number.isFinite(value) ? taskProgress(value, total) : null
  const downloaded = percent(job.downloaded, job.kind === 'video' ? job.sourceSize : job.size)
  const uploaded = transcoding ? null : percent(job.uploaded, job.size)
  return [
    { key: 'download', label: job.kind === 'video' ? '读取原视频' : '下载到节点', progress: downloaded,
      text: downloaded === null ? '大小待获取' : `${downloaded}%` },
    { key: 'upload', label: '上传到网盘', progress: uploaded,
      text: transcoding ? '等待兼容副本' : uploaded === null ? '大小待获取' : `${uploaded}%` }
  ]
}
export function taskGuidance(job) {
  if (job.state === 'complete') return '网盘已确认完成，可以打开所在文件夹。'
  if (job.state === 'cancelled') return '任务已取消，不会删除已有的网盘文件。'
  if (job.state === 'review') return '结果尚未确认，请先核对网盘中的文件，不要重复创建任务。'
  if (job.intent === 'cancel') return '已请求取消，等待节点确认；当前仍可能有在途传输。'
  if (job.intent === 'pause' && !['paused', 'error'].includes(job.state)) return '已请求暂停，等待节点确认。'
  if (job.state === 'paused') return '任务已暂停；继续或取消后，队列才能处理后续任务。'
  if (job.state === 'error') return '请先检查失败原因；重试会继续当前任务，不会创建重复任务。'
  if (job.state === 'committing') return '传输已结束，正在确认网盘结果。此时还不能算完成。'
  if (job.state === 'selecting') return '选择一个文件后才开始下载，不会自动下载整个种子。'
  if (job.state === 'queued') return '等待节点按顺序处理；可以关闭网页。'
  return ''
}
export function taskParentDirectory(destination) {
  if (typeof destination !== 'string' || !destination.startsWith('/') || destination.endsWith('/') || /[\\\x00-\x1f\x7f]/.test(destination)) return null
  const parts = destination.slice(1).split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return null
  return destination.slice(0, destination.lastIndexOf('/'))
}
