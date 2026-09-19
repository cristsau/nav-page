// Browser directory selection supplies relative names, never trusted absolute paths.
export function planFolderUpload(files, directory, limit) {
  if (!files.length || files.length > 50) throw Error('文件夹每批支持 1–50 个文件，请拆分较大的目录。')
  const seen = new Set(), directories = new Set(), paths = []
  let root = ''
  for (const file of files) {
    const relative = file.webkitRelativePath?.normalize('NFC')
    const parts = relative?.split('/') || []
    if (parts.length < 2 || parts.length > 11 || parts.some(p => !p || p !== p.trim() || ['.', '..'].includes(p) || /[\x00-\x1f\x7f\\]/.test(p) || /%(?:2e|2f|5c|00)/i.test(p))
      || parts.at(-1) !== file.name.normalize('NFC') || `${directory}/${relative}`.length > 2048) throw Error('文件夹包含不支持的路径，未创建或上传。')
    if (file.size > limit) throw Error('文件夹包含超过单文件上限的文件，未创建或上传。')
    root ||= parts[0]
    if (parts[0] !== root || seen.has(relative.toLowerCase())) throw Error('包含多个根目录或大小写重名文件，未创建或上传。')
    seen.add(relative.toLowerCase()); paths.push(`${directory}/${relative}`)
    for (let i = 1; i < parts.length; i++) directories.add(`${directory}/${parts.slice(0, i).join('/')}`)
  }
  const ordered = [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  if (ordered.length > 50 || ordered.some(p => seen.has(p.slice(directory.length + 1).toLowerCase()))
    || new Set(ordered.map(p => p.toLowerCase())).size !== ordered.length) throw Error('目录过多或路径冲突，请拆分或重命名后上传。')
  return { root, paths, directories: ordered }
}
