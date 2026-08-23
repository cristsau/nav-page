export const NOTE_VERSION_RETENTION_LIMIT = 50

export function isNoteVersionId(value) {
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(value || ''))
}

export async function archiveNoteVersion(client, note) {
  if (!note?.id || !note?.user_id) {
    throw new TypeError('A persisted note is required')
  }

  await client.query(
    `
      INSERT INTO note_versions (
        user_id,
        note_id,
        revision,
        type,
        title,
        content,
        encrypted,
        password_hash,
        pinned,
        tags,
        entry_date,
        mood,
        due_at,
        remind_before_minutes,
        completed
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10::jsonb, $11, $12, $13, $14, $15
      )
      ON CONFLICT (note_id, revision) DO NOTHING
    `,
    [
      note.user_id,
      note.id,
      Number(note.revision || 1),
      note.type,
      note.title,
      note.content,
      Boolean(note.encrypted),
      String(note.password_hash || ''),
      Boolean(note.pinned),
      JSON.stringify(Array.isArray(note.tags) ? note.tags : []),
      note.entry_date || null,
      String(note.mood || ''),
      note.due_at || null,
      Number(note.remind_before_minutes || 0),
      Boolean(note.completed)
    ]
  )
}

export async function pruneNoteVersions(
  client,
  userId,
  noteId,
  limit = NOTE_VERSION_RETENTION_LIMIT
) {
  await client.query(
    `
      DELETE FROM note_versions
      WHERE id IN (
        SELECT id
        FROM note_versions
        WHERE user_id = $1
          AND note_id = $2
        ORDER BY revision DESC, created_at DESC, id DESC
        OFFSET $3
      )
    `,
    [userId, noteId, limit]
  )
}

export function mapNoteVersion(record) {
  if (!record) return null
  const encrypted = Boolean(record.encrypted)
  return {
    id: record.id,
    revision: Number(record.revision || 1),
    type: record.type,
    title: record.title,
    content: encrypted ? '' : String(record.content || ''),
    contentAvailable: !encrypted,
    encrypted,
    pinned: Boolean(record.pinned),
    tags: Array.isArray(record.tags) ? record.tags : [],
    entryDate: record.entry_date || '',
    mood: record.mood || '',
    dueAt: record.due_at || null,
    remindBeforeMinutes: Number(record.remind_before_minutes || 0),
    completed: Boolean(record.completed),
    createdAt: record.created_at
  }
}
