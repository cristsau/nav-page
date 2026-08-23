export const NOTE_MARKDOWN_IMPORT_LIMIT = 200
export const NOTE_MARKDOWN_MARKER = 'DOMO-NAV-NOTE'

function normalizeImportedNote(value = {}) {
  const type = value.type === 'diary' ? 'diary' : 'memo'
  return {
    type,
    title: String(value.title || '导入的笔记').trim().slice(0, 200) || '导入的笔记',
    content: String(value.content || '').replace(/^\s+|\s+$/g, ''),
    encrypted: false,
    password: '',
    pinned: Boolean(value.pinned),
    tags: Array.isArray(value.tags)
      ? value.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 12)
      : [],
    entryDate: type === 'diary' ? String(value.entryDate || '').slice(0, 10) : '',
    mood: type === 'diary' ? String(value.mood || '').slice(0, 40) : '',
    dueAt: type === 'memo' && value.dueAt ? String(value.dueAt) : null,
    remindBeforeMinutes: type === 'memo'
      ? Math.min(43200, Math.max(0, Number(value.remindBeforeMinutes) || 0))
      : 0,
    completed: type === 'memo' && Boolean(value.completed),
    attachments: []
  }
}

export function exportNotesToMarkdown(notes) {
  const exportable = (Array.isArray(notes) ? notes : []).filter((note) => !note.encrypted)
  const skippedEncrypted = (Array.isArray(notes) ? notes : []).length - exportable.length
  const markdown = exportable.map((note) => {
    const metadata = JSON.stringify({
      type: note.type === 'diary' ? 'diary' : 'memo',
      title: String(note.title || '无标题'),
      pinned: Boolean(note.pinned),
      tags: Array.isArray(note.tags) ? note.tags : [],
      entryDate: note.entryDate || '',
      mood: note.mood || '',
      dueAt: note.dueAt || null,
      remindBeforeMinutes: Number(note.remindBeforeMinutes || 0),
      completed: Boolean(note.completed)
    }).replace(/-->/g, '--\\u003e')
    return `<!-- ${NOTE_MARKDOWN_MARKER} ${metadata} -->\n# ${String(note.title || '无标题').trim()}\n\n${String(note.content || '').trim()}\n<!-- /${NOTE_MARKDOWN_MARKER} -->`
  }).join('\n\n---\n\n')
  return { markdown: `${markdown}${markdown ? '\n' : ''}`, exported: exportable.length, skippedEncrypted }
}

export function parseNotesMarkdown(source, { maxEntries = NOTE_MARKDOWN_IMPORT_LIMIT } = {}) {
  const limit = Math.min(NOTE_MARKDOWN_IMPORT_LIMIT, Math.max(1, Number(maxEntries) || 1))
  const input = String(source || '')
  const pattern = new RegExp(
    `<!--\\s*${NOTE_MARKDOWN_MARKER}\\s+([\\s\\S]*?)\\s*-->\\s*([\\s\\S]*?)<!--\\s*\\/${NOTE_MARKDOWN_MARKER}\\s*-->`,
    'gi'
  )
  const notes = []
  const warnings = []
  let total = 0
  let match
  while ((match = pattern.exec(input))) {
    total += 1
    if (notes.length >= limit) continue
    try {
      const metadata = JSON.parse(match[1])
      const body = match[2].replace(/^\s*#\s+[^\n]+\n?/, '')
      notes.push(normalizeImportedNote({ ...metadata, content: body }))
    } catch {
      warnings.push(`第 ${total} 条 DOMO NAV 笔记的元数据无效，已跳过。`)
    }
  }

  if (!total && input.trim()) {
    const title = input.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || '导入的 Markdown'
    notes.push(normalizeImportedNote({ title, content: input.replace(/^\s*#\s+[^\n]+\n?/, '') }))
    total = 1
  }
  if (total > limit) warnings.push(`文件包含 ${total} 条笔记，本次最多导入 ${limit} 条。`)
  return { notes, total, skipped: Math.max(0, total - notes.length), warnings }
}
