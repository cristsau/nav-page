function formatDateTime(value) {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return date.toLocaleString('zh-CN', { hour12: false })
}

export function buildFullNoteText(note = {}) {
  const lines = [
    `ID: ${note.numberId ? `#${note.numberId}` : note.id || '-'}`,
    `类型: ${note.type === 'diary' ? '日记' : '备忘录'}`,
    `标题: ${note.title || '无标题'}`
  ]

  if (note.updatedAt) {
    lines.push(`更新时间: ${formatDateTime(note.updatedAt)}`)
  }
  if (note.type === 'diary' && note.entryDate) {
    lines.push(`记录日期: ${note.entryDate}`)
  }
  if (note.type === 'diary' && note.mood) {
    lines.push(`心情: ${note.mood}`)
  }
  if (note.type === 'memo' && note.dueAt) {
    lines.push(`截止时间: ${formatDateTime(note.dueAt)}`)
  }
  if (note.type === 'memo') {
    lines.push(`状态: ${note.completed ? '已完成' : '待完成'}`)
  }
  if (note.tags?.length) {
    lines.push(`标签: ${note.tags.join(', ')}`)
  }

  lines.push('', String(note.content || ''))
  return lines.join('\n')
}
