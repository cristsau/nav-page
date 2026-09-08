export function resolveNoteSaveState(note, backend = true) {
  if (note?.syncState === 'conflict') return { state: 'conflict', message: '本地修改存在冲突，尚未同步；请先保留草稿，不要覆盖其他设备的内容。' }
  if (note?.syncState === 'failed') return { state: 'error', message: '已保存在本机，但同步失败；请检查同步状态后重试。' }
  if (note?.syncState === 'pending') return { state: 'offline', message: '已保存在本机，待同步到云端' }
  if (!backend) return { state: 'saved', message: '已保存在本机（本地模式）' }
  return { state: 'saved', message: '已保存到云端' }
}
