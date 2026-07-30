export function mapShare(record) {
  if (!record) return null

  return {
    id: record.id,
    noteId: record.note_id,
    code: record.code,
    expireAt: record.expire_at,
    viewCount: record.view_count,
    createdAt: record.created_at
  }
}

export function mapNote(record) {
  if (!record) return null

  const shareEnabled = Boolean(record.share_id || record.share_code)

  return {
    id: record.id,
    numberId: record.number_id === null || record.number_id === undefined
      ? null
      : Number(record.number_id),
    type: record.type,
    title: record.title,
    content: record.content,
    encrypted: record.encrypted,
    password: '',
    pinned: record.pinned,
    tags: Array.isArray(record.tags) ? record.tags : [],
    entryDate: record.entry_date || '',
    mood: record.mood || '',
    dueAt: record.due_at || null,
    completed: Boolean(record.completed),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    share: {
      enabled: shareEnabled,
      id: record.share_id || '',
      code: record.share_code || '',
      expireAt: record.share_expire_at || null,
      viewCount: record.share_view_count || 0
    }
  }
}
