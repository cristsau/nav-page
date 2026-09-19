// Presentation-only helpers. Never fetch file bodies or persist paths/metadata.
export const fileFilters = [
  ['all', '全部类型'], ['folder', '文件夹'], ['image', '图片'], ['video', '视频'],
  ['audio', '音频'], ['document', '文档'], ['archive', '压缩包'], ['other', '其他文件']
]
export const fileSorts = [
  ['name-asc', '名称 A → Z'], ['name-desc', '名称 Z → A'], ['modified-desc', '最近修改'],
  ['modified-asc', '最早修改'], ['size-desc', '大小：从大到小'], ['size-asc', '大小：从小到大']
]
const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
export function fileCategory(item) {
  if (item.type === 'folder') return 'folder'
  if (['image', 'video', 'audio'].includes(item.kind)) return item.kind
  if (['text', 'office', 'pdf'].includes(item.kind)) return 'document'
  if (/\.(zip|7z|rar|tar|gz|bz2|xz|tgz|zst)$/i.test(item.name)) return 'archive'
  return 'other'
}
export function fileTypeLabel(item) {
  return fileFilters.find(([key]) => key === fileCategory(item))?.[1] || '其他文件'
}
export function presentFiles(entries, filter = 'all', sort = 'name-asc') {
  if (!fileFilters.some(([key]) => key === filter)) filter = 'all'
  if (!fileSorts.some(([key]) => key === sort)) sort = 'name-asc'
  const [field, direction] = sort.split('-'), sign = direction === 'desc' ? -1 : 1
  const number = item => field === 'modified' ? Date.parse(item.modified) : item.size
  const byName = (a, b) => names.compare(a.name, b.name) || String(a.id).localeCompare(String(b.id))
  return entries.filter(item => filter === 'all' || fileCategory(item) === filter).sort((a, b) => {
    if ((a.type === 'folder') !== (b.type === 'folder')) return a.type === 'folder' ? -1 : 1
    if (field === 'name') return sign * byName(a, b)
    if (a.type === 'folder') return byName(a, b) // Folders have no aggregate size/date.
    const an = number(a), bn = number(b), av = Number.isFinite(an), bv = Number.isFinite(bn)
    if (av !== bv) return av ? -1 : 1 // Unknown values stay last in either direction.
    return (av && bv ? sign * (an - bn) : 0) || byName(a, b)
  })
}
export function hasFileDrag(transfer) {
  return Array.from(transfer?.types || []).includes('Files') || Array.from(transfer?.items || []).some(item => item.kind === 'file')
}
export function droppedFiles(transfer) {
  const items = Array.from(transfer?.items || []).filter(item => item.kind === 'file')
  if (!items.length) throw Error('请拖入本机文件；链接和网页内容不能作为文件上传。')
  if (items.length > 50) throw Error('一次最多拖入 50 个文件，请分批上传。')
  return items.map(item => {
    const getEntry = item.getAsEntry || item.webkitGetAsEntry
    // Fail closed if the browser cannot distinguish directories from ordinary files.
    let entry
    try { entry = getEntry?.call(item) } catch { /* use the safe file picker instead */ }
    if (entry?.isDirectory) throw Error('暂不支持拖入文件夹，本次未加入队列。请进入文件夹选择其中的文件。')
    if (!entry?.isFile) throw Error('无法识别拖入项目，请使用“上传文件”按钮选择。')
    const file = item.getAsFile()
    if (!file || file.webkitRelativePath) throw Error('无法按原目录结构上传，本次未加入队列。请单独选择文件。')
    return file
  })
}
